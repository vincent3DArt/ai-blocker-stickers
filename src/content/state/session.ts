import type {
  AnchorStatus,
  Confidence,
  ElementSticker,
  RectSticker,
  Settings,
  Sticker,
  StickerSource,
  TabState,
  ViewRect,
} from '@/shared/types';
import type { StickerSummary } from '@/shared/messages';
import { defaultPathPattern, matchesPath, sanitizePathPattern } from '@/shared/url-match';
import type { OverlayHost } from '../overlay/host';
import { StickerView } from '../overlay/sticker-view';
import type { Positioner } from '../overlay/positioner';
import type { Masker } from '../mask/masker';
import { defaultMaskMode } from '../mask/masker';
import { coveredTextRanges } from '../mask/text-mask';
import { buildFingerprint } from '../anchor/fingerprint';
import { LOCKED_RESOLVE, resolveFingerprint } from '../anchor/resolve';
import { anchorRect, projectRect } from '../anchor/rect-anchor';
import { clientRects, clipChain, clipTo, docToView, isRendered, toViewRect, union, area } from '../anchor/geometry';
import type { SiteStore } from './store';
import { pagePath } from './page-path';

interface Runtime {
  sticker: Sticker;
  view: StickerView;
  status: AnchorStatus;
  confidence: Confidence;
  /** Resolved anchor element (element sticker) or container (rect sticker). */
  el: Element | null;
  clip: Element[];
  unresolvedSince: number;
  /** For rect stickers: last rect we masked text under, to avoid re-walking every frame. */
  lastRectKey: string;
  /** For rect stickers: the last projected rect (viewport coords). */
  lastRect: ViewRect | null;
  /**
   * Element stickers while locked: candidates that tied with `el`. Each is
   * masked too (mask id `<id>::tie<n>`) and drawn as part of the sticker.
   */
  ties: Element[];
  /** Resolve again even though attached: the lock came on over a low-confidence match. */
  recheck: boolean;
}

export interface SessionOptions {
  host: OverlayHost;
  store: SiteStore;
  settings: () => Settings;
  masker: Masker;
  positioner: Positioner;
  frameDepth: number;
  isOurs: (n: Node | null) => boolean;
  onState: (state: Partial<TabState>) => void;
  onGhostClick: (sticker: Sticker) => void;
}

/** `el` holds at least one non-blank text node of the page's own (stops at the first). */
function hasText(el: Element, isOurs: (n: Node | null) => boolean): boolean {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (/\S/.test((n as Text).data) && !isOurs(n)) return true;
  }
  return false;
}

const LOST_AFTER_MS = 30_000;
const LOST_AFTER_LOAD_MS = 5_000;
const DETACH_GRACE_MS = 5_000;
/** How often the visibility-independent masking retry runs, and for how long. */
const MASK_RETRY_MS = 500;
const MASK_RETRY_WINDOW_MS = 30_000;

export class Session {
  private runtimes = new Map<string, Runtime>();
  private paused = false;
  private editing = false;
  private loadedAt = Date.now();
  private resolving = false;
  private resolveAgain = false;
  private maskTimer = 0;
  private maskRetryUntil = 0;
  private peeking = new Set<string>();
  /** AI-session lock: no pause, weaker matches accepted, ties over-masked. */
  private locked = false;

  private disposers: Array<() => void> = [];

  constructor(private o: SessionOptions) {
    this.watchSettling();
    this.watchVisibility();
    this.o.masker.onRebind = (id, el) => this.onMaskRebind(id, el);
    this.o.masker.onStale = (id) => this.onMaskStale(id);
  }

  /**
   * The masker already moved an element sticker's mask onto the page's fresh
   * copy of its anchor (or, for a rect, found the fresh copy of its
   * container). Adopt it as the anchor right away, in the same mutation
   * callback, instead of detaching and waiting for the resolver.
   */
  private onMaskRebind(id: string, el: Element) {
    const rt = this.runtimes.get(id);
    if (!rt || this.paused) return;
    if (rt.el && rt.el !== el) this.o.positioner.unobserve(rt.el);
    rt.el = el;
    rt.status = 'resolved';
    rt.clip = clipChain(el);
    rt.lastRectKey = '';
    this.o.positioner.observe(el);
    if (rt.sticker.kind === 'rect') this.maskRect(rt);
    this.o.positioner.markDirty();
  }

  /** The page rewrote text under a rect: rescan now, not on the next batch. */
  private onMaskStale(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt || this.paused || rt.sticker.kind !== 'rect' || rt.status !== 'resolved' || !rt.el?.isConnected) return;
    rt.lastRectKey = '';
    this.maskRect(rt);
  }

  /**
   * Layout milestones after which a rect's text scan must run again.
   *
   * A rect sticker masks whatever its projected rectangle covers, and at
   * document_start that rectangle is projected from a container whose box is
   * not final and measured against text laid out in a fallback font. Both move
   * under the rect afterwards without necessarily moving the rect itself, so
   * the cached `lastRectKey` would otherwise suppress the only scan that would
   * notice. Every milestone simply forgets the cached key.
   *
   * The re-scan runs synchronously here rather than through
   * `positioner.markDirty()` (a requestAnimationFrame): frames never arrive in
   * a background tab, and masking must not wait for one. `markDirty` is still
   * called, but only so the overlay pieces get repainted whenever painting is
   * possible.
   */
  private watchSettling() {
    const again = () => {
      for (const rt of this.runtimes.values()) if (rt.sticker.kind === 'rect') rt.lastRectKey = '';
      this.maskRects();
      this.o.positioner.markDirty();
    };
    let live = true;
    this.disposers.push(() => (live = false));
    document.fonts?.ready.then(() => live && again()).catch(() => {});
    const onLoad = () => again();
    window.addEventListener('load', onLoad);
    this.disposers.push(() => window.removeEventListener('load', onLoad));
    if (document.readyState !== 'complete') {
      const onReady = () => {
        if (document.readyState !== 'complete') return;
        document.removeEventListener('readystatechange', onReady);
        again();
      };
      document.addEventListener('readystatechange', onReady);
      this.disposers.push(() => document.removeEventListener('readystatechange', onReady));
    }
  }

  /**
   * Masking already ran while the tab was hidden; the overlay could not be
   * painted, because `Positioner` schedules through requestAnimationFrame and
   * skips its slow tick while `document.hidden`. Flush once the tab is shown so
   * the pieces catch up with the text they cover.
   */
  private watchVisibility() {
    const onVis = () => {
      if (document.hidden) return;
      this.o.positioner.flush();
    };
    document.addEventListener('visibilitychange', onVis);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  /**
   * Mask under every rect sticker right now, without a frame, a paint or a
   * visibility check.
   *
   * This is the "mask" half of the mask/paint split: it only rewrites text and
   * only needs layout (`getBoundingClientRect` / `Range.getClientRects`), both
   * of which keep working in a background tab. Painting the overlay pieces
   * stays in `recompute()`, which may keep skipping while hidden.
   */
  maskRects() {
    if (this.paused) return;
    for (const rt of this.runtimes.values()) {
      if (rt.sticker.kind !== 'rect') continue;
      if (rt.status !== 'resolved' || !rt.el?.isConnected) continue;
      this.maskRect(rt);
    }
  }

  private maskRect(rt: Runtime) {
    const el = rt.el;
    if (!el || rt.sticker.kind !== 'rect' || !isRendered(el)) return;
    const box = toViewRect(el.getBoundingClientRect());
    const p = projectRect(rt.sticker, box);
    rt.lastRect = p.rect;
    this.maskUnderRect(rt, el, p.rect);
  }

  /**
   * True while some rect sticker that wants text masked has none applied.
   *
   * A rect whose resolved container holds no text at all (a `<canvas>`, a
   * PDF plugin, an image) has nothing to mask and never will until the page
   * adds text, which arrives as a mutation and re-arms the retry; it does not
   * count, so the retry timer does not spin on canvas pages.
   */
  private maskPending(): boolean {
    if (this.paused) return false;
    for (const rt of this.runtimes.values()) {
      const s = rt.sticker;
      if (s.kind !== 'rect' || !s.maskUnderlyingText) continue;
      if (this.o.masker.has(s.id)) continue;
      if (rt.status === 'resolved' && rt.el?.isConnected && !hasText(rt.el, this.o.isOurs)) continue;
      return true;
    }
    return false;
  }

  /** The masking retry timer is running (tests). */
  get maskRetryActive(): boolean {
    return this.maskTimer !== 0;
  }

  /** Tag of each sticker's resolved anchor or container (tests). */
  anchorTags(): Array<{ id: string; kind: Sticker['kind']; tag?: string }> {
    return Array.from(this.runtimes.values()).map((rt) => ({ id: rt.sticker.id, kind: rt.sticker.kind, tag: rt.el?.tagName.toLowerCase() }));
  }

  /**
   * Keep retrying the rect scan on a plain timer.
   *
   * `coveredTextRanges` can legitimately come up empty right after the
   * container resolves — the box is not final, fonts have not swapped, the text
   * has not reflowed yet — and the events that would normally notice
   * (rAF, the slow tick) never fire in a background tab. A `setInterval` does,
   * so it is the one signal that works everywhere. It stops as soon as every
   * rect sticker holds a mask, or after `MASK_RETRY_WINDOW_MS`; each mutation
   * batch restarts the window.
   */
  private armMaskRetry() {
    this.maskRetryUntil = Date.now() + MASK_RETRY_WINDOW_MS;
    if (this.maskTimer || !this.maskPending()) return;
    this.maskTimer = window.setInterval(() => {
      if (Date.now() > this.maskRetryUntil || !this.maskPending()) {
        this.stopMaskRetry();
        return;
      }
      // Forget the cached rect key: the whole point of a retry is to re-scan a
      // rectangle that has not moved but whose text may finally have settled.
      for (const rt of this.runtimes.values()) if (rt.sticker.kind === 'rect') rt.lastRectKey = '';
      this.maskRects();
      if (!this.maskPending()) this.stopMaskRetry();
    }, MASK_RETRY_MS);
  }

  private stopMaskRetry() {
    if (!this.maskTimer) return;
    clearInterval(this.maskTimer);
    this.maskTimer = 0;
  }

  /** Apply every sticker that matches the current path. */
  async load() {
    this.loadedAt = Date.now();
    const active = this.o.store.active(pagePath(), this.o.frameDepth);
    const activeIds = new Set(active.map((s) => s.id));
    for (const id of Array.from(this.runtimes.keys())) if (!activeIds.has(id)) this.drop(id);
    for (const s of active) if (!this.runtimes.has(s.id)) this.track(s);
    // Deliberately not awaited: at document_start the resolver keeps being
    // re-armed by the parser's mutation batches, and boot must not wait for
    // that to settle before it can answer messages.
    void this.resolveAll();
    this.maskRects();
    this.armMaskRetry();
    this.o.positioner.flush();
    this.reportState();
  }

  /** Path changed inside an SPA. */
  async handleNavigation() {
    await this.load();
  }

  /**
   * Called on debounced mutation batches.
   *
   * Deliberately does NOT compare the container's text against what we left
   * behind: masking legitimately changes that text, so the comparison fired on
   * our own writes and re-masked on every batch. A rect is re-masked only when
   * the masker reports its split was disturbed (`isStale`) or the projected
   * rect moved; both are checked in `maskUnderRect`.
   */
  async onMutationBatch() {
    await this.resolveAll();
    // Masking runs here, on a setTimeout-driven batch, rather than waiting for
    // the frame `resolveAll` asks for: batches still fire in a hidden tab.
    this.maskRects();
    this.armMaskRetry();
  }

  get isPaused() {
    return this.paused;
  }

  setPaused(paused: boolean) {
    // Defence in depth: the message handler already refuses this while locked.
    if (paused && this.locked) return;
    this.paused = paused;
    for (const rt of this.runtimes.values()) {
      if (paused) {
        this.o.masker.restore(rt.sticker.id);
        this.clearTies(rt);
        rt.view.hide();
      } else {
        this.applyMask(rt);
      }
    }
    if (paused) this.stopMaskRetry();
    else this.armMaskRetry();
    this.o.positioner.flush();
    this.reportState();
  }

  get isLocked() {
    return this.locked;
  }

  /**
   * Lock or unlock. Locking forces protection back on and re-resolves every
   * low-confidence element sticker with the locked options, so its ties get
   * masked too. Unlocking drops the ties: the unlocked resolver masks one
   * candidate and flags the sticker low confidence instead.
   */
  setLocked(on: boolean) {
    if (this.locked === on) return;
    this.locked = on;
    if (on) {
      if (this.paused) this.setPaused(false);
      for (const rt of this.runtimes.values()) {
        if (rt.sticker.kind === 'element' && rt.status === 'resolved' && rt.confidence === 'low') rt.recheck = true;
      }
      void this.resolveAll();
    } else {
      for (const rt of this.runtimes.values()) this.clearTies(rt);
    }
    this.o.positioner.markDirty();
    this.reportState();
  }

  setEditing(on: boolean) {
    this.editing = on;
    for (const rt of this.runtimes.values()) rt.view.setEditing(on);
    this.reportState();
  }

  summaries(): StickerSummary[] {
    return Array.from(this.runtimes.values()).map((rt) => ({
      id: rt.sticker.id,
      kind: rt.sticker.kind,
      label: rt.sticker.label,
      source: rt.sticker.source,
      status: rt.status,
      pathPattern: rt.sticker.scope.pathPattern,
      currentPath: pagePath(),
    }));
  }

  state(): Omit<TabState, 'locked' | 'lockReason' | 'rendering'> {
    const rts = Array.from(this.runtimes.values());
    return {
      editMode: this.editing,
      paused: this.paused,
      stickerCount: rts.length,
      lostCount: rts.filter((r) => r.status === 'lost').length,
      peeking: this.peeking.size > 0,
      saveError: this.o.store.saveError,
      strictInputs: this.o.masker.strictCount(),
      autoCount: this.o.store.ephemeralIds.length,
    };
  }

  /**
   * `opts.id`: the element was already masked under this id (the scanner's
   * pre-paint auto-cover), and the sticker takes that mask over instead of
   * re-applying it. If the page re-rendered the element meanwhile, the mask
   * followed the fresh copy, and so does the sticker.
   * `opts.ephemeral`: session-scoped, held in memory only (see SiteStore).
   */
  async addElementSticker(el: Element, source: StickerSource, opts: { id?: string; ephemeral?: boolean } = {}): Promise<Sticker> {
    const now = Date.now();
    const premasked = opts.id ? this.o.masker.rootOf(opts.id) : undefined;
    if (premasked?.isConnected) el = premasked;
    const anchor = await buildFingerprint(el);
    const moved = opts.id ? this.o.masker.rootOf(opts.id) : undefined;
    if (moved?.isConnected && moved !== el) el = moved;
    const sticker: ElementSticker = {
      kind: 'element',
      id: opts.id ?? crypto.randomUUID(),
      scope: { pathPattern: defaultPathPattern(pagePath()) },
      frame: this.frameInfo(),
      source,
      padding: 3,
      createdAt: now,
      updatedAt: now,
      anchor,
      maskMode: defaultMaskMode(el),
    };
    if (opts.ephemeral) this.o.store.addEphemeral(sticker);
    else this.o.store.upsert(sticker);
    const rt = this.track(sticker);
    this.attach(rt, el, 'high');
    this.o.positioner.flush();
    this.reportState();
    return sticker;
  }

  async addRectSticker(rect: ViewRect): Promise<Sticker> {
    // A rectangle that is really one text element becomes an element sticker.
    const single = this.singleElementUnder(rect);
    if (single) return this.addElementSticker(single, 'rect');
    const now = Date.now();
    const a = await anchorRect(rect, (e) => this.o.isOurs(e));
    const sticker: RectSticker = {
      kind: 'rect',
      id: crypto.randomUUID(),
      scope: { pathPattern: defaultPathPattern(pagePath()) },
      frame: this.frameInfo(),
      source: 'rect',
      padding: 0,
      createdAt: now,
      updatedAt: now,
      container: a.container,
      containerKind: a.containerKind,
      frac: a.frac,
      px: a.px,
      maskUnderlyingText: true,
    };
    this.o.store.upsert(sticker);
    const rt = this.track(sticker);
    const container = await resolveFingerprint(a.container, { exclude: (e) => this.o.isOurs(e), ...(this.locked ? LOCKED_RESOLVE : {}) });
    this.attach(rt, container?.el ?? document.body, 'high');
    this.o.positioner.flush();
    this.reportState();
    return sticker;
  }

  /** Frame descriptor for a new sticker: origin plus a generalised path, never the raw URL. */
  private frameInfo(): Sticker['frame'] {
    const depth = this.o.frameDepth;
    return { depth, urlPattern: depth > 0 ? location.origin + defaultPathPattern(pagePath()) : undefined };
  }

  /**
   * Change a sticker's URL scope. Drops the runtime when it no longer applies
   * here. The pattern goes through the same sanitiser as the default scope, so
   * the popup's "exact path" option cannot store a record id.
   */
  setScope(id: string, rawPattern: string) {
    const rt = this.runtimes.get(id);
    if (!rt || typeof rawPattern !== 'string') return;
    const pathPattern = sanitizePathPattern(rawPattern);
    const updated = { ...rt.sticker, scope: { ...rt.sticker.scope, pathPattern }, updatedAt: Date.now() } as Sticker;
    rt.sticker = updated;
    rt.view.setSticker(updated);
    this.o.store.upsert(updated);
    if (!matchesPath(pathPattern, pagePath())) {
      this.drop(id);
      this.o.positioner.flush();
    }
    this.reportState();
  }

  remove(id: string) {
    this.drop(id);
    this.o.store.remove(id);
    this.o.positioner.flush();
    this.reportState();
  }

  /** Session-scoped (auto-covered) stickers currently held in memory. */
  get ephemeralCount(): number {
    return this.o.store.ephemeralIds.length;
  }

  /** End of an AI session: keep the auto-covered stickers as ordinary stored ones. */
  keepEphemeral(): number {
    const ids = this.o.store.keepEphemeral();
    this.reportState();
    return ids.length;
  }

  /** End of an AI session, not kept: unmask and forget them. Refused while locked. */
  dropEphemeral(): number {
    if (this.locked) return 0;
    const ids = this.o.store.ephemeralIds;
    for (const id of ids) {
      this.drop(id);
      this.o.store.remove(id);
    }
    this.o.positioner.flush();
    this.reportState();
    return ids.length;
  }

  /** Re-anchor a lost sticker to a user-picked element. */
  async reattach(id: string, el: Element) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const anchor = await buildFingerprint(el);
    const updated: ElementSticker = {
      ...(rt.sticker.kind === 'element'
        ? rt.sticker
        : { ...rt.sticker, kind: 'element', maskMode: defaultMaskMode(el), anchor, padding: 3 }),
      kind: 'element',
      anchor,
      maskMode: defaultMaskMode(el),
      updatedAt: Date.now(),
    } as ElementSticker;
    rt.sticker = updated;
    rt.view.setSticker(updated);
    this.o.store.upsert(updated);
    this.attach(rt, el, 'high');
    this.o.positioner.flush();
    this.reportState();
  }

  locate(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt?.el) return;
    rt.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    rt.view.setEditing(true);
    setTimeout(() => rt.view.setEditing(this.editing), 1200);
  }

  /** Sticker whose pieces contain the viewport point. */
  stickerAt(x: number, y: number): { sticker: Sticker; rect: ViewRect; el: Element | null } | null {
    for (const rt of this.runtimes.values()) {
      for (const r of rt.view.rects) {
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          return { sticker: rt.sticker, rect: union(rt.view.rects)!, el: rt.el };
        }
      }
    }
    return null;
  }

  visible(): { sticker: Sticker; rect: ViewRect; el: Element | null }[] {
    const out: { sticker: Sticker; rect: ViewRect; el: Element | null }[] = [];
    for (const rt of this.runtimes.values()) {
      const u = union(rt.view.rects);
      if (u && rt.status === 'resolved') out.push({ sticker: rt.sticker, rect: u, el: rt.el });
    }
    return out;
  }

  /**
   * Every applied sticker's full geometry in viewport coordinates, NOT
   * clipped to the viewport or scroll ancestors (offscreen parts included),
   * padding included. Used by the PDF viewer's redacted download. `lost`
   * counts stickers that have no geometry because their anchor is missing.
   */
  geometry(): { rects: ViewRect[]; lost: number } {
    const rects: ViewRect[] = [];
    let lost = 0;
    for (const rt of this.runtimes.values()) {
      if (rt.status !== 'resolved' || !rt.el?.isConnected) {
        lost++;
        continue;
      }
      const pad = rt.sticker.padding;
      const grow = (r: ViewRect): ViewRect => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
      if (rt.sticker.kind === 'element') {
        rects.push(...clientRects(rt.el).filter((r) => r.w > 0 && r.h > 0).map(grow));
      } else {
        rects.push(grow(projectRect(rt.sticker, toViewRect(rt.el.getBoundingClientRect())).rect));
      }
      for (const t of rt.ties) if (t.isConnected) rects.push(...clientRects(t).filter((r) => r.w > 0 && r.h > 0).map(grow));
    }
    return { rects, lost };
  }

  originals(id: string): string {
    return this.o.masker.originals(id);
  }

  setPeek(ids: string[], on: boolean) {
    for (const id of ids) {
      const rt = this.runtimes.get(id);
      if (!rt) continue;
      rt.view.setPeeking(on);
      this.o.masker.setPeek(id, on);
      if (on) this.peeking.add(id);
      else this.peeking.delete(id);
    }
    this.o.onState({ peeking: on && ids.length > 0 });
  }

  /** Reposition every sticker. Runs once per frame while dirty and on the slow tick. */
  recompute() {
    const now = Date.now();
    for (const rt of this.runtimes.values()) {
      if (this.paused) continue;
      if (rt.status === 'resolved' && rt.el && !rt.el.isConnected) {
        // Framework probably re-created it; give the resolver a grace period.
        this.detach(rt, now);
      }
      if (rt.status === 'resolving' && now - rt.unresolvedSince > this.lostBudget()) {
        this.markLost(rt);
      }
      if (rt.status === 'resolved' && rt.el) {
        this.position(rt);
      } else if (rt.status === 'lost') {
        this.positionGhost(rt);
      } else {
        rt.view.hide();
      }
    }
  }

  destroy() {
    this.stopMaskRetry();
    for (const id of Array.from(this.runtimes.keys())) this.drop(id);
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  // ---- internals ----

  private track(sticker: Sticker): Runtime {
    const view = new StickerView(this.o.host, sticker, {
      showLabel: this.o.settings().appearance.showLabel,
      onGhostClick: (s) => this.o.onGhostClick(s),
    });
    view.setEditing(this.editing);
    const rt: Runtime = {
      sticker,
      view,
      status: 'resolving',
      confidence: 'high',
      el: null,
      clip: [],
      unresolvedSince: Date.now(),
      lastRectKey: '',
      lastRect: null,
      ties: [],
      recheck: false,
    };
    this.runtimes.set(sticker.id, rt);
    return rt;
  }

  private drop(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.peeking.delete(id);
    this.o.masker.restore(id);
    this.clearTies(rt);
    if (rt.el) this.o.positioner.unobserve(rt.el);
    rt.view.destroy();
    this.runtimes.delete(id);
  }

  private attach(rt: Runtime, el: Element, confidence: Confidence) {
    if (rt.el && rt.el !== el) this.o.positioner.unobserve(rt.el);
    this.clearTies(rt);
    rt.el = el;
    rt.status = 'resolved';
    rt.confidence = confidence;
    rt.recheck = false;
    rt.clip = clipChain(el);
    rt.lastRectKey = '';
    this.o.positioner.observe(el);
    // Already masked under this id (pre-paint auto-cover): re-applying would
    // write the raw text back for a moment.
    if (rt.sticker.kind === 'element' && this.o.masker.rootOf(rt.sticker.id) === el) return;
    if (!this.paused) this.applyMask(rt);
  }

  private detach(rt: Runtime, now: number) {
    if (rt.el) this.o.positioner.unobserve(rt.el);
    this.o.masker.restore(rt.sticker.id);
    this.clearTies(rt);
    rt.el = null;
    rt.status = 'resolving';
    rt.unresolvedSince = now - (this.lostBudget() - DETACH_GRACE_MS);
    rt.view.hide();
    this.reportState();
  }

  private markLost(rt: Runtime) {
    if (rt.status === 'lost') return;
    this.o.masker.restore(rt.sticker.id);
    this.clearTies(rt);
    if (rt.el) this.o.positioner.unobserve(rt.el);
    rt.el = null;
    rt.status = 'lost';
    this.reportState();
  }

  private lostBudget(): number {
    const sinceLoad = Date.now() - this.loadedAt;
    return document.readyState === 'complete' && sinceLoad > LOST_AFTER_LOAD_MS ? LOST_AFTER_LOAD_MS : LOST_AFTER_MS;
  }

  /**
   * Locked only: mask every candidate that tied with the winner, so an
   * ambiguous anchor over-masks instead of leaving the other record bare.
   * Rect stickers are not handled: their container ties would each need a
   * projected rectangle of their own.
   */
  private setTies(rt: Runtime, ties: Element[]) {
    this.clearTies(rt);
    const s = rt.sticker;
    if (!this.locked || s.kind !== 'element' || this.paused) return;
    rt.ties = ties.filter((t) => t !== rt.el && !this.o.isOurs(t));
    rt.ties.forEach((t, i) => this.o.masker.apply(`${s.id}::tie${i}`, t, s.maskMode));
  }

  /** What `el` said before this sticker (or one of its ties) masked it. */
  private maskedText(rt: Runtime, el: Element): string | undefined {
    const id = rt.sticker.id;
    if (el === rt.el && this.o.masker.has(id)) return this.o.masker.originals(id);
    const i = rt.ties.indexOf(el);
    if (i >= 0 && this.o.masker.has(`${id}::tie${i}`)) return this.o.masker.originals(`${id}::tie${i}`);
    return undefined;
  }

  private clearTies(rt: Runtime) {
    rt.ties.forEach((_, i) => this.o.masker.restore(`${rt.sticker.id}::tie${i}`));
    rt.ties = [];
  }

  private applyMask(rt: Runtime) {
    const s = rt.sticker;
    if (!rt.el) return;
    if (s.kind === 'element') {
      this.o.masker.apply(s.id, rt.el, s.maskMode);
    } else {
      // Rect stickers mask whatever their projected rectangle covers. Do it now
      // and synchronously: `attach` is the earliest moment the container is
      // known, and nothing that follows (rAF, the slow tick) is guaranteed to
      // run in a background tab. Retries are handled by the mask timer.
      rt.lastRectKey = '';
      this.maskRect(rt);
    }
  }

  private async resolveAll() {
    if (this.resolving) {
      this.resolveAgain = true;
      return;
    }
    this.resolving = true;
    try {
      let passes = 0;
      do {
        this.resolveAgain = false;
        passes++;
        for (const rt of this.runtimes.values()) {
          if (rt.status === 'resolved' && rt.el?.isConnected && !rt.recheck) continue;
          // A lost sticker never masks, and edit mode (its only way back) is
          // refused while locked; the lower locked threshold may still find it.
          if (rt.status === 'lost' && !this.editing && !this.locked) continue;
          rt.recheck = false;
          const fp = rt.sticker.kind === 'element' ? rt.sticker.anchor : rt.sticker.container;
          const locked = this.locked;
          const res = await resolveFingerprint(fp, {
            exclude: (e) => this.o.isOurs(e) || this.anchoredByOther(e, rt),
            textOf: (e) => this.maskedText(rt, e),
            ...(locked ? LOCKED_RESOLVE : {}),
          });
          if (res) {
            this.attach(rt, res.el, res.confidence);
            if (locked && this.locked && res.ties.length) this.setTies(rt, res.ties);
            this.o.positioner.markDirty();
          }
        }
      } while (this.resolveAgain && passes < 3);
    } finally {
      this.resolving = false;
    }
    // Mutations arrived while we were resolving and we ran out of passes:
    // retry off the hot path instead of starving the event loop.
    if (this.resolveAgain) setTimeout(() => void this.resolveAll(), 50);
    this.reportState();
  }

  private anchoredByOther(el: Element, self: Runtime): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt !== self && rt.sticker.kind === 'element' && rt.el === el) return true;
    }
    return false;
  }

  private position(rt: Runtime) {
    const el = rt.el!;
    if (!isRendered(el)) {
      rt.view.update([], 'resolved', rt.confidence);
      return;
    }
    let rects: ViewRect[];
    let confidence = rt.confidence;
    if (rt.sticker.kind === 'element') {
      rects = clientRects(el);
    } else {
      const box = toViewRect(el.getBoundingClientRect());
      const p = projectRect(rt.sticker, box);
      rects = [p.rect];
      if (p.confidence === 'low') confidence = 'low';
      rt.lastRect = p.rect;
      this.maskUnderRect(rt, el, p.rect);
    }
    // Recompute the clip chain occasionally: ancestors can change overflow.
    if (rt.clip.some((c) => !c.isConnected)) rt.clip = clipChain(el);
    const clipped = rects.map((r) => clipTo(r, rt.clip)).filter((r): r is ViewRect => !!r && area(r) > 0);
    // Locked over-mask: the ties are drawn as part of this sticker, each
    // clipped by its own scroll ancestors.
    for (const t of rt.ties) {
      if (!t.isConnected || !isRendered(t)) continue;
      const chain = clipChain(t);
      for (const r of clientRects(t)) {
        const c = clipTo(r, chain);
        if (c && area(c) > 0) clipped.push(c);
      }
    }
    rt.view.update(clipped, 'resolved', confidence);
  }

  private maskUnderRect(rt: Runtime, container: Element, rect: ViewRect) {
    const s = rt.sticker as RectSticker;
    if (!s.maskUnderlyingText) return;
    const key = `${Math.round(rect.x + scrollX)}:${Math.round(rect.y + scrollY)}:${Math.round(rect.w)}:${Math.round(rect.h)}`;
    // Re-scan when the rect moved, when the masker says the page disturbed our
    // split, or while nothing is masked at all. That last case is the retry
    // loop: the text can slide under a rect whose own projection never changes
    // (a rect over a scroll container, or prose re-flowing as fonts arrive),
    // and the scan is the only thing that would notice. `masker.has` is false
    // whenever the masker holds no split for this id, including when the scan
    // found ranges but every node was already cut up by another sticker, so
    // this keeps retrying until something is really masked or the sticker goes.
    if (key === rt.lastRectKey && this.o.masker.has(s.id) && !this.o.masker.isStale(s.id)) return;
    rt.lastRectKey = key;
    // Measure the page's own text: put anything we masked back first, so the
    // character rects are the real ones and the scan stays idempotent.
    this.o.masker.restore(s.id);
    const ranges = coveredTextRanges(container, rect);
    if (ranges.length) this.o.masker.applyTextRanges(s.id, container, ranges);
  }

  private positionGhost(rt: Runtime) {
    const fp = rt.sticker.kind === 'element' ? rt.sticker.anchor : rt.sticker.container;
    const similar =
      this.o.settings().ghostAnchors &&
      Math.abs(window.innerWidth - fp.viewportW) / Math.max(fp.viewportW, 1) < 0.25 &&
      Math.abs(document.documentElement.scrollHeight - fp.docH) / Math.max(fp.docH, 1) < 0.4;
    if (!similar) {
      rt.view.update([], 'lost');
      return;
    }
    let rect = docToView(fp.rect);
    if (rt.sticker.kind === 'rect') {
      rect = projectRect(rt.sticker, rect).rect;
    }
    rt.view.update([rect], 'lost');
  }

  private singleElementUnder(rect: ViewRect): Element | null {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const els = document.elementsFromPoint(cx, cy).filter((e) => !this.o.isOurs(e));
    for (const el of els) {
      if (el === document.body || el === document.documentElement) break;
      if (!/\S/.test(el.textContent ?? '') && !(el instanceof HTMLInputElement)) continue;
      const box = union(clientRects(el));
      if (!box) continue;
      const inter = {
        x: Math.max(box.x, rect.x),
        y: Math.max(box.y, rect.y),
        w: Math.min(box.x + box.w, rect.x + rect.w) - Math.max(box.x, rect.x),
        h: Math.min(box.y + box.h, rect.y + rect.h) - Math.max(box.y, rect.y),
      };
      if (inter.w <= 0 || inter.h <= 0) continue;
      const coverElement = area(inter) / area(box);
      const coverRect = area(inter) / area(rect);
      if (coverElement >= 0.9 && coverRect >= 0.6) return el;
      return null;
    }
    return null;
  }

  private reportState() {
    this.o.onState(this.state());
  }
}
