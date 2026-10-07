import type {
  AnchorStatus,
  RectText,
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
import { scopeApplies, type PathHmacs } from '@/shared/url-match';
import { scopeKindOf, type BackstopDetector, type ScopeKind } from '@/shared/types';
import { defaultScope, frameDescriptor, makeScope, pathHmacs, pathHmacsSync } from './scope';
import type { OverlayHost } from '../overlay/host';
import { StickerView } from '../overlay/sticker-view';
import type { Positioner } from '../overlay/positioner';
import type { Masker } from '../mask/masker';
import { defaultMaskMode } from '../mask/masker';
import { collectTextNodes, coveredTextRanges, type TextRange } from '../mask/text-mask';
import { coveredKey, coveredTokens, locateByHash, locateExact, rangesForSpan, startOf, stripped } from '../anchor/text-anchor';
import { buildFingerprint, coveredHmacSync, fingerprintText, hasSyncKey, keyHmacSync, textHmacSync, tokenHmacSync } from '../anchor/fingerprint';
import { LOCKED_RESOLVE, resolveFingerprint, scopeRootOf } from '../anchor/resolve';
import { headingContext, labelInfo, tableContext } from '../anchor/context';
import { HIGH_IDS, findMatches } from '../detect/patterns';
import { allBlocks } from '../detect/block-text';
import { detectBlock, detectInputs, matchRect } from '../detect/scanner';
import { normalizeText } from '@/shared/hmac';
import { anchorRect, projectRect } from '../anchor/rect-anchor';
import { clientRects, clipChain, clipTo, docToView, intersect, isRendered, toViewRect, union, area } from '../anchor/geometry';
import type { SiteStore } from './store';
import { pageLoc, pagePath } from './page-path';
import { presentViews, viewIdentityOf, viewKey, type ViewOptions } from './view';

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
  /** Last time a lost sticker was given another resolve attempt. */
  lostTriedAt: number;
  /**
   * Rect stickers: the covered characters (whitespace removed), in memory
   * only, and where they were last found in the container's text. The mask
   * follows these characters, not the projected rectangle.
   */
  anchorKey?: string;
  anchorAt: number;
  /** Rect stickers: the container the current mask was made in. */
  maskedIn: Element | null;
  /** Rect stickers: form fields under the rectangle, masked whole (mask id `<id>::field<n>`). */
  fields: Element[];
  /** Identity drift (see checkDrift): what the anchor held when last re-checked, and when. */
  driftSig: string;
  driftAt: number;
  /** Re-attached by the text-HMAC backstop (not proven by the resolver): shown in the banner. */
  auto: boolean;
  /** Session-only backstop stickers this lost sticker created (ids). */
  backstops: Set<string>;
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
/** A lost sticker is re-resolved at most this often (content can come back: lazy pages, viewers). */
const LOST_RETRY_MS = 2_000;
/** A rect side drawn within this many pixels of its text hugs the text; a looser side keeps its drawn edge. */
const TIGHT_PX = 8;

/** Form fields a rect sticker masks whole when it covers part of them. */
const FIELD_SELECTOR = 'input:not([type=hidden]),textarea,select,[contenteditable]:not([contenteditable="false"])';

/** Backstop covers one lost sticker may create, at most. */
const MAX_BACKSTOPS = 20;
/** Elements the text-HMAC backstop and the sync fast path look at, at most. */
const BACKSTOP_SWEEP_CAP = 5000;
const NO_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);

/** The high-strength detector `text` matches, if any (only its name is ever stored). */
function detectorOf(text: string): BackstopDetector | undefined {
  if (!text || !/\d/.test(text)) return undefined;
  return findMatches(text, { ids: HIGH_IDS })[0]?.id as BackstopDetector | undefined;
}

/** `el` or its nearest ancestor (within six levels) with tag `tag`. */
function containerAbove(el: Element, tag: string): Element | null {
  let a: Element | null = el;
  for (let i = 0; a && i <= 6; i++, a = a.parentElement) if (a.tagName.toLowerCase() === tag) return a;
  return null;
}

/** Deepest element holding every range, or null. */
function commonElement(ranges: TextRange[]): Element | null {
  let el: Element | null = ranges[0]?.node.parentElement ?? null;
  while (el && !ranges.every((r) => el!.contains(r.node))) el = el.parentElement;
  return el;
}

/** Viewport rects of text ranges. */
function rangeRects(ranges: TextRange[]): ViewRect[] {
  const out: ViewRect[] = [];
  for (const r of ranges) {
    const range = r.node.ownerDocument.createRange();
    range.setStart(r.node, r.start);
    range.setEnd(r.node, r.end);
    for (const c of Array.from(range.getClientRects())) if (c.width > 0 && c.height > 0) out.push({ x: c.left, y: c.top, w: c.width, h: c.height });
  }
  return out;
}

/** The view stickers among `stickers`, as a comparable key (ids and lengths). */
function viewLens(stickers: Sticker[]): string {
  return stickers
    .filter((s) => s.scope.viewHmac)
    .map((s) => `${s.id}:${s.scope.viewLen ?? 0}`)
    .sort()
    .join(',');
}

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
  /** Path HMACs of `hmacsKey` (origin + path + search), for exact scopes. */
  private hmacs: PathHmacs = {};
  private hmacsKey = '';
  private loadGen = 0;
  /** Last time `recompute` kicked the resolver for a detached sticker. */
  private kickAt = 0;
  /** Stickers that apply to this URL, view stickers whose viewer is closed included. */
  private urlActive: Sticker[] = [];
  /**
   * In-page viewers (content/state/view.ts) open right now, by view key. A
   * sticker with a view identity is tracked only while its key is here.
   */
  private viewRoots = new Map<string, Element>();
  /** Stickers that apply to this URL but whose viewer is not open. */
  private otherViews = 0;
  private viewsBusy = false;
  private viewsAgain = false;

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
      if (this.o.masker.has(s.id) || rt.fields.length) continue;
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
   * container resolves â€” the box is not final, fonts have not swapped, the text
   * has not reflowed yet â€” and the events that would normally notice
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

  /**
   * Boot fast path, synchronous, right after the store and key are loaded:
   * track every sticker for this URL (view stickers excepted until their
   * viewer is seen) and attach each element sticker whose text HMAC matches
   * an element already in the DOM. Content parsed later is caught by
   * `onRecords` in the mutation callback that inserts it. The async
   * resolver (`load`) then re-checks every choice.
   */
  preMask() {
    if (!hasSyncKey() || this.paused) return;
    const loc = pageLoc();
    const hm = pathHmacsSync(loc, this.o.frameDepth);
    if (!hm.path) return;
    this.hmacs = hm;
    this.hmacsKey = loc.origin + loc.pathname + loc.search;
    this.urlActive = this.o.store.active(pagePath(), this.o.frameDepth, hm);
    for (const s of this.urlActive) if (!s.scope.viewHmac && !this.runtimes.has(s.id)) this.track(s);
    for (const rt of this.runtimes.values()) {
      const s = rt.sticker;
      if (s.kind !== 'element' || rt.status === 'resolved' || !s.anchor.textHmac) continue;
      const root = scopeRootOf(s.anchor);
      if (!root) continue;
      for (const c of Array.from(root.querySelectorAll(s.anchor.tag)).slice(0, BACKSTOP_SWEEP_CAP)) {
        if (this.o.isOurs(c) || this.o.masker.isMaskedNode(c) || this.anchoredByOther(c, rt) || !this.fastMatch(s.anchor, c)) continue;
        this.attach(rt, c, 'low');
        rt.recheck = true;
        break;
      }
    }
    this.o.positioner.markDirty();
  }

  /**
   * True while the boot cloak should stay: some sticker for this page is
   * still looking for its anchor and the mutation fast path cannot cover its
   * content when it appears (a rectangle, or an element without a text HMAC,
   * such as an image).
   */
  cloakHolds(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.status !== 'resolving') continue;
      const s = rt.sticker;
      if (s.kind === 'rect' || !s.anchor.textHmac) return true;
    }
    return false;
  }

  /** Apply every sticker that matches the current path. */
  async load() {
    const gen = ++this.loadGen;
    // Exact scopes match by HMAC, which is async: computed once per URL
    // (cached), before anything is resolved. A newer load supersedes this one.
    const hmacs = await this.currentHmacs();
    if (gen !== this.loadGen) return;
    const urlActive = this.o.store.active(pagePath(), this.o.frameDepth, hmacs);
    this.urlActive = urlActive;
    const views = await this.scanViews(urlActive);
    if (gen !== this.loadGen) return;
    this.loadedAt = Date.now();
    this.viewRoots = views;
    this.applyActive(urlActive);
    // Deliberately not awaited: at document_start the resolver keeps being
    // re-armed by the parser's mutation batches, and boot must not wait for
    // that to settle before it can answer messages.
    void this.resolveAll();
    this.maskRects();
    this.armMaskRetry();
    this.o.positioner.flush();
    this.reportState();
  }

  /**
   * Track exactly the stickers in `urlActive` that are not tied to a viewer,
   * or whose viewer is open; drop the rest. Returns true when anything changed.
   */
  private applyActive(urlActive: Sticker[]): boolean {
    const active = urlActive.filter((s) => !s.scope.viewHmac || this.viewRoots.has(viewKey(s.scope)));
    this.otherViews = urlActive.length - active.length;
    const activeIds = new Set(active.map((s) => s.id));
    let changed = false;
    for (const id of Array.from(this.runtimes.keys())) {
      if (!activeIds.has(id)) {
        this.drop(id);
        changed = true;
      }
    }
    for (const s of active) {
      if (!this.runtimes.has(s.id)) {
        this.track(s);
        changed = true;
      }
    }
    return changed;
  }

  private viewOptions(): ViewOptions {
    return { isOurs: (n) => this.o.isOurs(n), originalOf: (t) => this.o.masker.originalText(t) };
  }

  /** Viewers open now, hashed at the lengths the URL's view stickers need. */
  private scanViews(urlActive: Sticker[]): Promise<Map<string, Element>> {
    const lens = urlActive.filter((s) => s.scope.viewHmac).map((s) => s.scope.viewLen ?? 0);
    if (!lens.length) return Promise.resolve(new Map());
    return presentViews(lens, this.viewOptions());
  }

  /**
   * An in-page viewer opens and closes without a navigation, so the set of
   * open viewers is re-read on every (debounced) mutation batch. Costs nothing
   * on pages with no viewer sticker for this URL.
   */
  private async refreshViews() {
    if (this.viewsBusy) {
      this.viewsAgain = true;
      return;
    }
    this.viewsBusy = true;
    try {
      do {
        this.viewsAgain = false;
        const l = pageLoc();
        // The URL changed and load() has not caught up yet: it will do this.
        if (l.origin + l.pathname + l.search !== this.hmacsKey) return;
        const gen = this.loadGen;
        const urlActive = this.o.store.active(pagePath(), this.o.frameDepth, this.hmacs);
        if (!this.viewRoots.size && !urlActive.some((s) => s.scope.viewHmac)) {
          this.otherViews = 0;
          return;
        }
        const views = await this.scanViews(urlActive);
        if (gen !== this.loadGen) return;
        // A sticker added (or removed) during the scan: its viewer may not
        // have been hashed at the right length. Scan again rather than drop it.
        const fresh = this.o.store.active(pagePath(), this.o.frameDepth, this.hmacs);
        this.urlActive = fresh;
        if (viewLens(fresh) !== viewLens(urlActive)) {
          this.viewsAgain = true;
          continue;
        }
        this.viewRoots = views;
        const before = this.otherViews;
        if (this.applyActive(fresh) || before !== this.otherViews) {
          this.o.positioner.flush();
          this.reportState();
        }
      } while (this.viewsAgain);
    } finally {
      this.viewsBusy = false;
    }
  }

  /** The open viewer a sticker belongs to, if it has a view identity. */
  private viewRootOf(s: Sticker): Element | undefined {
    if (!s.scope.viewHmac) return undefined;
    const r = this.viewRoots.get(viewKey(s.scope));
    return r?.isConnected ? r : undefined;
  }

  /**
   * `scope` plus the view identity of the viewer `el` sits in, if any. The
   * viewer is registered as open right away, so the new sticker is not
   * dropped before the next scan sees it.
   */
  private async withView(scope: Sticker['scope'], el: Element | null): Promise<Sticker['scope']> {
    if (!el) return scope;
    const v = await viewIdentityOf(el, this.viewOptions());
    if (!v) return scope;
    const out = { ...scope, viewHmac: v.viewHmac, viewLen: v.viewLen };
    this.viewRoots.set(viewKey(out), v.root);
    return out;
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
    await this.refreshViews();
    this.checkDrift();
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
        this.clearFields(rt);
        rt.lastRectKey = '';
        rt.maskedIn = null;
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
      scopeKind: scopeKindOf(rt.sticker.scope),
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
      otherViews: this.otherViews,
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
    const detector = detectorOf(premasked?.isConnected && opts.id ? this.o.masker.originals(opts.id) : this.rawText(el));
    const [anchor, urlScope, frame] = await Promise.all([buildFingerprint(el), defaultScope(pageLoc()), this.frameInfo()]);
    const scope = await this.withView(urlScope, el);
    const moved = opts.id ? this.o.masker.rootOf(opts.id) : undefined;
    if (moved?.isConnected && moved !== el) el = moved;
    const sticker: ElementSticker = {
      kind: 'element',
      id: opts.id ?? crypto.randomUUID(),
      scope,
      frame,
      source,
      padding: 3,
      createdAt: now,
      updatedAt: now,
      anchor,
      maskMode: defaultMaskMode(el),
      ...(detector ? { detector } : {}),
    };
    if (opts.ephemeral) this.o.store.addEphemeral(sticker);
    else this.o.store.upsert(sticker);
    const rt = this.track(sticker);
    this.attach(rt, el, 'high');
    this.o.positioner.flush();
    this.reportState();
    return sticker;
  }

  async addRectSticker(rect: ViewRect, opts: { ephemeral?: boolean; source?: StickerSource } = {}): Promise<Sticker> {
    // A rectangle that is really one text element becomes an element sticker.
    const single = this.singleElementUnder(rect);
    if (single) return this.addElementSticker(single, opts.source ?? 'rect', { ephemeral: opts.ephemeral });
    const now = Date.now();
    const under = document.elementsFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2).find((e) => !this.o.isOurs(e)) ?? null;
    const [a, urlScope, frame] = await Promise.all([anchorRect(rect, (e) => this.o.isOurs(e)), defaultScope(pageLoc()), this.frameInfo()]);
    const scope = await this.withView(urlScope, under);
    const sticker: RectSticker = {
      kind: 'rect',
      id: crypto.randomUUID(),
      scope,
      frame,
      source: opts.source ?? 'rect',
      padding: 0,
      createdAt: now,
      updatedAt: now,
      container: a.container,
      containerKind: a.containerKind,
      frac: a.frac,
      px: a.px,
      maskUnderlyingText: true,
    };
    if (opts.ephemeral) this.o.store.addEphemeral(sticker);
    else this.o.store.upsert(sticker);
    const rt = this.track(sticker);
    const container = await resolveFingerprint(a.container, {
      exclude: (e) => this.o.isOurs(e),
      within: this.viewRootOf(sticker),
      ...(this.locked ? LOCKED_RESOLVE : {}),
    });
    const cEl = container?.el ?? document.body;
    // The page's own text under the rectangle, measured before it is masked.
    const raw = coveredTextRanges(cEl, rect);
    const rawKey = coveredKey(raw);
    const rawTokens = coveredTokens(raw);
    const rawBox = union(rangeRects(raw));
    const detector = detectorOf(rawTokens.join(' '));
    const innerEl = commonElement(raw);
    const inner = innerEl && innerEl !== cEl && cEl.contains(innerEl) ? await buildFingerprint(innerEl) : undefined;
    this.attach(rt, cEl, 'high');
    const text = rawBox ? this.rectTextAnchor(rt, rect, rawKey, rawTokens, rawBox) : undefined;
    if (text || inner || detector) {
      const withText: RectSticker = { ...sticker, ...(text ? { text } : {}), ...(inner ? { inner } : {}), ...(detector ? { detector } : {}), updatedAt: Date.now() };
      rt.sticker = withText;
      rt.view.setSticker(withText);
      this.o.store.upsert(withText);
    }
    this.o.positioner.flush();
    this.reportState();
    return rt.sticker;
  }

  /** Frame descriptor for a new sticker: origin plus a generalised path, never the raw URL. */
  private frameInfo(): Promise<Sticker['frame']> {
    return frameDescriptor(this.o.frameDepth, pageLoc());
  }

  /** HMACs of the current location, recomputed only when the URL changed. */
  private async currentHmacs(): Promise<PathHmacs> {
    const locKey = () => {
      const l = pageLoc();
      return l.origin + l.pathname + l.search;
    };
    const key = locKey();
    if (key !== this.hmacsKey) {
      const h = await pathHmacs(pageLoc(), this.o.frameDepth);
      // Another navigation may have finished first; only the latest URL is cached.
      if (key === locKey()) {
        this.hmacs = h;
        this.hmacsKey = key;
      }
      return h;
    }
    return this.hmacs;
  }

  /**
   * Change a sticker's URL scope. Drops the runtime when it no longer applies
   * here. `exact`: this page only; the HMAC of the current path is computed
   * here (the popup has no key). `pattern`: goes through the same sanitiser
   * as the default scope, so no record or document id can be stored.
   */
  async setScope(id: string, kind: ScopeKind, rawPattern?: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (kind !== 'exact' && typeof rawPattern !== 'string') return;
    const urlScope = await makeScope(kind === 'exact' ? 'exact' : 'pattern', pageLoc(), rawPattern);
    const cur = this.runtimes.get(id);
    if (!cur) return;
    // The URL part changes; the viewer the sticker lives in does not.
    const { viewHmac, viewLen } = cur.sticker.scope;
    const scope = viewHmac ? { ...urlScope, viewHmac, viewLen } : urlScope;
    const updated = { ...cur.sticker, scope, updatedAt: Date.now() } as Sticker;
    cur.sticker = updated;
    cur.view.setSticker(updated);
    this.o.store.upsert(updated);
    if (!scopeApplies(scope, pagePath(), await this.currentHmacs())) {
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
  geometry(include: (id: string) => boolean = () => true): { rects: ViewRect[]; lost: number } {
    const rects: ViewRect[] = [];
    let lost = 0;
    for (const rt of this.runtimes.values()) {
      if (!include(rt.sticker.id)) continue;
      if (rt.status !== 'resolved' || !rt.el?.isConnected) {
        lost++;
        continue;
      }
      const pad = rt.sticker.padding;
      const grow = (r: ViewRect): ViewRect => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
      if (rt.sticker.kind === 'element') {
        rects.push(...clientRects(rt.el).filter((r) => r.w > 0 && r.h > 0).map(grow));
      } else {
        rects.push(grow(this.rectGeometry(rt, rt.el).rect));
      }
      for (const t of rt.ties) if (t.isConnected) rects.push(...clientRects(t).filter((r) => r.w > 0 && r.h > 0).map(grow));
    }
    return { rects, lost };
  }

  /**
   * What is covered on screen right now: `geometry()` minus stickers being
   * peeked at, nothing while paused. The PDF viewer paints these into its
   * pages, inside the scroll container, so they move with the compositor.
   */
  coverGeometry(): ViewRect[] {
    if (this.paused) return [];
    return this.geometry((id) => !this.peeking.has(id)).rects;
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
    // A detached anchor waits for a mutation batch to be resolved again, but
    // its replacement can arrive in a tree nobody observes yet (a new shadow
    // root): retry on the tick as well.
    if (!this.paused && now - this.kickAt > 250) {
      for (const rt of this.runtimes.values()) {
        if (rt.status !== 'resolving') continue;
        this.kickAt = now;
        void this.resolveAll();
        break;
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
      lostTriedAt: 0,
      anchorAt: -1,
      maskedIn: null,
      fields: [],
      driftSig: '',
      driftAt: 0,
      auto: false,
      backstops: new Set(),
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
    this.clearFields(rt);
    if (rt.el) this.o.positioner.unobserve(rt.el);
    rt.view.destroy();
    this.runtimes.delete(id);
    this.dropBackstops(rt);
  }

  private attach(rt: Runtime, el: Element, confidence: Confidence) {
    if (rt.el && rt.el !== el) this.o.positioner.unobserve(rt.el);
    this.clearTies(rt);
    rt.el = el;
    rt.status = 'resolved';
    rt.confidence = confidence;
    rt.recheck = false;
    rt.auto = false;
    this.dropBackstops(rt);
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
    this.clearFields(rt);
    rt.el = null;
    rt.status = 'resolving';
    rt.unresolvedSince = now - (this.lostBudget() - DETACH_GRACE_MS);
    rt.view.hide();
    this.reportState();
  }

  private markLost(rt: Runtime) {
    if (rt.status === 'lost') return;
    // A backstop cover that lost its own content is simply dropped.
    if (rt.sticker.source === 'backstop' && this.o.store.isEphemeral(rt.sticker.id)) {
      this.drop(rt.sticker.id);
      this.o.store.remove(rt.sticker.id);
      this.reportState();
      return;
    }
    this.o.masker.restore(rt.sticker.id);
    this.clearTies(rt);
    this.clearFields(rt);
    if (rt.el) this.o.positioner.unobserve(rt.el);
    rt.el = null;
    rt.status = 'lost';
    this.reportState();
    // Fail closed: look for the content elsewhere right away, outside the frame loop.
    setTimeout(() => this.runBackstops(rt), 0);
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
    // Text masks: the exact textContent the page wrote (originals joined with
    // spaces would not hash like the fingerprint for a multi-node element).
    // Input masks: the real value (strict mode holds bullets in `.value`).
    const read = (maskId: string) => (rt.sticker.kind === 'element' && rt.sticker.maskMode !== 'text' ? this.o.masker.originals(maskId) : this.rawText(el));
    if (el === rt.el && this.o.masker.has(id)) return read(id);
    const i = rt.ties.indexOf(el);
    if (i >= 0 && this.o.masker.has(`${id}::tie${i}`)) return read(`${id}::tie${i}`);
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
          // A lost sticker is retried, but sparingly: its content can come back
          // (a lazily rendered page scrolled back into view). Edit mode and
          // the lock (lower threshold) retry it on every pass.
          if (rt.status === 'lost' && !this.editing && !this.locked) {
            const now = Date.now();
            if (now - rt.lostTriedAt < LOST_RETRY_MS) continue;
            rt.lostTriedAt = now;
          }
          rt.recheck = false;
          const fp = rt.sticker.kind === 'element' ? rt.sticker.anchor : rt.sticker.container;
          const locked = this.locked;
          const ropts = {
            exclude: (e: Element) => this.o.isOurs(e) || this.anchoredByOther(e, rt),
            textOf: (e: Element) => this.maskedText(rt, e),
            within: this.viewRootOf(rt.sticker),
            ...(locked ? LOCKED_RESOLVE : {}),
          };
          let res = await resolveFingerprint(fp, ropts);
          // A rect whose container cannot be proven any more: find the
          // labelled element that held its text, and take its container.
          if (!res && rt.sticker.kind === 'rect' && rt.sticker.inner) {
            const ir = await resolveFingerprint(rt.sticker.inner, ropts);
            const c = ir ? containerAbove(ir.el, rt.sticker.container.tag) : null;
            if (ir && c) res = { el: c, score: ir.score, confidence: ir.confidence, ties: [] };
          }
          if (res && res.el === rt.el && rt.status === 'resolved' && !res.ties.length) {
            // Re-checked and still the best match: keep the mask as it is.
            rt.confidence = res.confidence;
          } else if (res) {
            this.attach(rt, res.el, res.confidence);
            if (locked && this.locked && res.ties.length) this.setTies(rt, res.ties);
            this.o.positioner.markDirty();
          } else if (rt.status === 'lost') {
            this.runBackstops(rt);
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

  /**
   * Element stickers whose anchor node now holds another record: a
   * virtualised list recycled the row node, or a reused component shows the
   * next client. The mask keeps covering the node (fail closed), and the
   * sticker is re-resolved so it can follow its own record to whatever node
   * shows it now. Checked synchronously with the record key and text HMACs;
   * re-resolved when what the node shows changes, and at most once a second
   * while it stays drifted.
   */
  private checkDrift() {
    if (!hasSyncKey() || this.paused) return;
    const now = Date.now();
    for (const rt of this.runtimes.values()) {
      const s = rt.sticker;
      if (rt.status !== 'resolved' || !rt.el?.isConnected || rt.recheck) continue;
      const fp = s.kind === 'element' ? s.anchor : s.container;
      // Only elements identified by their own record: a page-level container
      // (a rect drawn on `body`) changes text all the time.
      if (s.kind === 'rect' && !fp.keyHmac) continue;
      const key = fp.keyHmac ? keyHmacSync(rt.el) : undefined;
      const text = fp.textHmac && s.kind === 'element' ? textHmacSync(this.maskedText(rt, rt.el) ?? this.rawText(rt.el)) : undefined;
      // The text is the record itself: while it still matches, a missing or
      // changed key (the cell moved into a dialog) is no reason to move.
      const drifted = fp.textHmac && s.kind === 'element' ? text !== fp.textHmac : !!fp.keyHmac && key !== fp.keyHmac;
      if (!drifted) {
        rt.driftSig = '';
        continue;
      }
      const sig = `${key}|${text}`;
      if (sig !== rt.driftSig || now - rt.driftAt > 1000) {
        rt.driftSig = sig;
        rt.driftAt = now;
        rt.recheck = true;
      }
    }
  }

  // ---- fail closed: backstops for lost stickers ----

  /**
   * A sticker is lost: before settling for a banner, look for its content
   * elsewhere. First an element whose text HMAC equals the sticker's (any
   * tag): re-attached, low confidence. Rect stickers: any text whose tokens
   * hash like the covered tokens. Then, if the covered text was a
   * high-strength pattern, every match of that pattern near the same label or
   * heading. Backstop covers are session-only and go away when the sticker
   * is found again.
   */
  private runBackstops(rt: Runtime) {
    if (this.paused || rt.status !== 'lost' || !hasSyncKey() || this.runtimes.get(rt.sticker.id) !== rt) return;
    const s = rt.sticker;
    if (s.source === 'backstop') return;
    if (s.kind === 'element') {
      const el = this.textBackstop(rt);
      if (el) {
        const moved: ElementSticker = { ...s, maskMode: defaultMaskMode(el) };
        rt.sticker = moved;
        rt.view.setSticker(moved);
        this.attach(rt, el, 'low');
        rt.auto = true;
        this.o.positioner.markDirty();
        this.reportState();
        return;
      }
    } else {
      this.tokenBackstop(rt);
    }
    this.patternBackstop(rt);
  }

  /** The element whose text HMAC equals a lost element sticker's, any tag; the deepest, nearest one. */
  private textBackstop(rt: Runtime): Element | null {
    const s = rt.sticker as ElementSticker;
    const fp = s.anchor;
    if (!fp.textHmac || !fp.textLen) return null;
    const root: ParentNode = this.viewRootOf(s) ?? scopeRootOf(fp) ?? document;
    const hits: Element[] = [];
    let n = 0;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (++n > BACKSTOP_SWEEP_CAP) break;
      if (NO_TEXT_TAGS.has(el.tagName) || this.o.isOurs(el) || this.o.masker.isMaskedNode(el) || this.anchoredByOther(el, rt)) continue;
      const t = el.textContent ?? '';
      if (t.length < fp.textLen || t.length > fp.textLen * 4 + 64) continue;
      if (normalizeText(t).length !== fp.textLen) continue;
      if (textHmacSync(t) === fp.textHmac) hits.push(el);
    }
    const deepest = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)));
    if (!deepest.length) return null;
    const c = { x: fp.rect.x + fp.rect.w / 2, y: fp.rect.y + fp.rect.h / 2 };
    const dist = (e: Element) => {
      const r = e.getBoundingClientRect();
      return Math.hypot(r.left + scrollX + r.width / 2 - c.x, r.top + scrollY + r.height / 2 - c.y);
    };
    return deepest.sort((a, b) => dist(a) - dist(b))[0];
  }

  /** Session-only cover for `el` (or for `rect` inside a long block), owned by the lost sticker `rt`. */
  private coverForBackstop(rt: Runtime, el: Element, rect: ViewRect | null) {
    if (rt.backstops.size >= MAX_BACKSTOPS) return;
    const p = rect ? this.addRectSticker(rect, { ephemeral: true, source: 'backstop' }) : this.addElementSticker(el, 'backstop', { ephemeral: true });
    rt.backstops.add('pending:' + Math.random());
    const pendingKey = Array.from(rt.backstops).pop()!;
    void p
      .then((st) => {
        rt.backstops.delete(pendingKey);
        // Found again meanwhile: the cover is no longer needed.
        if (rt.status !== 'lost' || this.runtimes.get(rt.sticker.id) !== rt) {
          this.drop(st.id);
          this.o.store.remove(st.id);
        } else {
          rt.backstops.add(st.id);
        }
        this.o.positioner.markDirty();
        this.reportState();
      })
      .catch((e) => {
        rt.backstops.delete(pendingKey);
        console.error('[aibs] backstop cover failed', e);
      });
  }

  /** Lost rect sticker: cover text whose tokens hash like the tokens it covered. */
  private tokenBackstop(rt: Runtime) {
    const s = rt.sticker as RectSticker;
    const want = new Set(s.text?.tokenHmacs ?? []);
    const body = document.body;
    if (!want.size || !body) return;
    const byParent = new Map<Element, TextRange[]>();
    let n = 0;
    for (const t of collectTextNodes(body)) {
      if (++n > 20_000) break;
      const parent = t.parentElement;
      if (!parent || this.o.isOurs(t) || this.o.masker.isMaskedNode(t)) continue;
      const re = /\S+/g;
      for (let m = re.exec(t.data); m; m = re.exec(t.data)) {
        const tok = m[0];
        // Short words ("SSN", "the") would match all over the page; numbers and longer tokens only.
        if (!/\d/.test(tok) && tok.length < 6) continue;
        if (!want.has(tokenHmacSync(tok) ?? '')) continue;
        const list = byParent.get(parent) ?? [];
        list.push({ node: t, start: m.index, end: m.index + tok.length });
        byParent.set(parent, list);
      }
    }
    for (const [parent, ranges] of byParent) {
      const covered = ranges.reduce((a, r) => a + (r.end - r.start), 0);
      // The element is (nearly) just the token: cover it whole; otherwise only the characters.
      const whole = normalizeText(parent.textContent ?? '').length <= covered + 4;
      const box = union(rangeRects(ranges));
      this.coverForBackstop(rt, parent, whole || !box ? null : { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 });
    }
  }

  /** Lost sticker whose text matched a high-strength pattern: cover that pattern near the same label or heading. */
  private patternBackstop(rt: Runtime) {
    const s = rt.sticker;
    const det = s.detector;
    const body = document.body;
    if (!det || !body || rt.backstops.size >= MAX_BACKSTOPS) return;
    const fp = s.kind === 'element' ? s.anchor : s.container;
    // "Near" means the same named field or the same section, never just the
    // same table column: every other row of the table shares that column,
    // and those are other people's numbers, not this one moved.
    const ownLabel = fp.labelContext && fp.labelSource !== 'column' ? fp.labelContext : undefined;
    const column = fp.tableContext?.header;
    const near = (el: Element) => {
      if (column && tableContext(el)?.header === column) return false;
      if (!ownLabel && !fp.headingContext) return true;
      const li = labelInfo(el);
      if (ownLabel && li?.source !== 'column' && li?.text === ownLabel) return true;
      return !!fp.headingContext && headingContext(el) === fp.headingContext;
    };
    const skip = (el: Element) => this.o.isOurs(el) || this.o.masker.isMaskRoot(el);
    const exclude = (el: Element) => this.o.isOurs(el) || this.o.masker.isMaskedNode(el);
    const opts = { sensitivity: 'aggressive' as const, ids: new Set([det]), exclude };
    const hits = allBlocks(body, { skip, cap: 20_000 }).flatMap((b) => detectBlock(b, opts));
    hits.push(...detectInputs(document, opts));
    for (const hit of hits) {
      if (rt.backstops.size >= MAX_BACKSTOPS) break;
      if (!hit.el.isConnected || !near(hit.el)) continue;
      this.coverForBackstop(rt, hit.el, hit.wide ? matchRect(hit) : null);
    }
  }

  private dropBackstops(rt: Runtime) {
    if (!rt.backstops.size) return;
    for (const id of Array.from(rt.backstops)) {
      if (id.startsWith('pending:')) continue;
      if (this.o.store.isEphemeral(id)) {
        this.drop(id);
        this.o.store.remove(id);
      }
      rt.backstops.delete(id);
    }
  }

  // ---- pre-paint fast path ----

  /**
   * Synchronous, inside the mutation callback: an element sticker that is
   * detached, lost, or whose node drifted to another record looks for its
   * content among the nodes this callback inserted or rewrote. A node whose
   * text HMAC (and record key, id, test id where stored) matches is masked
   * and attached before the page can paint it or a script can read it; the
   * next resolver pass re-checks the choice (low confidence until then).
   */
  onRecords(records: MutationRecord[]) {
    if (this.paused || !hasSyncKey()) return;
    const pending: Runtime[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.sticker.kind !== 'element' || rt.sticker.source === 'backstop') continue;
      if (rt.status !== 'resolved' || !rt.el?.isConnected || rt.driftSig || (rt.el && this.drifted(rt))) pending.push(rt);
    }
    // View stickers whose viewer is not registered yet (it opens without a
    // navigation, and the view hash waits for the next batch): an exact text
    // match is masked now; the next view scan keeps or drops it.
    const dormant = this.urlActive.filter((s) => s.kind === 'element' && s.scope.viewHmac && !this.runtimes.has(s.id)) as ElementSticker[];
    if (!pending.length && !dormant.length) return;
    const roots = new Set<Element>();
    for (const r of records) {
      if (r.type === 'childList') {
        if (r.target.nodeType === Node.ELEMENT_NODE) roots.add(r.target as Element);
        r.addedNodes.forEach((a) => a.nodeType === Node.ELEMENT_NODE && roots.add(a as Element));
      } else if (r.type === 'characterData') {
        const p = (r.target as Text).parentElement;
        if (p) roots.add(p);
      }
      if (roots.size > 64) break;
    }
    const work: Array<{ s: ElementSticker; rt?: Runtime }> = [...pending.map((rt) => ({ s: rt.sticker as ElementSticker, rt })), ...dormant.map((s) => ({ s }))];
    for (const { s, rt: known } of work) {
      const fp = s.anchor;
      // The text must match: a record key alone is shared by every cell of its row.
      if (!fp.textHmac) continue;
      let seen = 0;
      search: for (const root of roots) {
        if (!root.isConnected || this.o.isOurs(root)) continue;
        const cands = root.matches(fp.tag) ? [root] : [];
        cands.push(...Array.from(root.querySelectorAll(fp.tag)).slice(0, 200));
        for (const c of cands) {
          if (++seen > BACKSTOP_SWEEP_CAP) break search;
          if (c === known?.el || this.o.masker.isMaskedNode(c) || (known && this.anchoredByOther(c, known))) continue;
          if (!this.fastMatch(fp, c)) continue;
          const rt = known ?? this.track(s);
          this.attach(rt, c, 'low');
          rt.recheck = true;
          rt.driftSig = '';
          this.o.positioner.markDirty();
          break search;
        }
      }
    }
  }

  /** The anchor node no longer shows the sticker's record (key or text HMAC differ). */
  private drifted(rt: Runtime): boolean {
    const s = rt.sticker;
    if (s.kind !== 'element' || !rt.el) return false;
    const fp = s.anchor;
    if (!fp.textHmac) return false;
    return textHmacSync(this.maskedText(rt, rt.el) ?? this.rawText(rt.el)) !== fp.textHmac;
  }

  private fastMatch(fp: ElementSticker['anchor'], el: Element): boolean {
    if (fp.textHmac) {
      const t = fingerprintText(el);
      if (t.length < fp.textLen || t.length > fp.textLen * 4 + 64) return false;
      if (normalizeText(t).length !== fp.textLen || textHmacSync(t) !== fp.textHmac) return false;
    }
    if (fp.keyHmac && keyHmacSync(el) !== fp.keyHmac) return false;
    if (fp.id && el.id !== fp.id) return false;
    return true;
  }

  /** What the banner reports for this frame. */
  bannerState(): { lost: number; reattached: number; backstop: number; firstLost?: string } {
    let lost = 0;
    let reattached = 0;
    let backstop = 0;
    let firstLost: string | undefined;
    for (const rt of this.runtimes.values()) {
      if (rt.sticker.source === 'backstop') {
        if (rt.status === 'resolved') backstop++;
        continue;
      }
      if (rt.status === 'lost') {
        lost++;
        firstLost ??= rt.sticker.id;
      } else if (rt.status === 'resolved' && rt.auto) reattached++;
    }
    return { lost, reattached, backstop, firstLost };
  }

  /** `el.textContent` as the page wrote it: our bullets swapped back for the originals. */
  private rawText(el: Element): string {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return fingerprintText(el);
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let s = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) s += this.o.masker.originalText(n as Text) ?? (n as Text).data;
    return s;
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
      rt.lastRect = p.rect;
      this.maskUnderRect(rt, el, p.rect);
      const g = this.rectGeometry(rt, el);
      rects = [g.rect];
      if (g.confidence === 'low') confidence = 'low';
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
    //
    // Once something is masked, the mask belongs to those characters (text
    // anchoring): a projection that moves because a font arrived or the page
    // zoomed must not move the mask off them. Only a disturbed split, a new
    // container or "nothing masked" rescans.
    const masked = this.o.masker.has(s.id) || rt.fields.length > 0;
    if (masked && !this.o.masker.isStale(s.id) && (rt.maskedIn === container || key === rt.lastRectKey)) return;
    rt.lastRectKey = key;
    // Measure the page's own text: put anything we masked back first, so the
    // character rects are the real ones and the scan stays idempotent.
    this.o.masker.restore(s.id);
    rt.maskedIn = null;
    this.maskFieldsUnder(rt, container, rect);
    const ranges = this.locateRectText(rt, container, rect);
    if (ranges.length) this.o.masker.applyTextRanges(s.id, container, ranges);
    if (this.o.masker.has(s.id) || rt.fields.length) rt.maskedIn = container;
  }

  /**
   * Form fields under a rect sticker are masked whole, in input mode. Their
   * value is not DOM text, so the text scan never sees it, and the field
   * would otherwise stay readable in the accessibility tree.
   */
  private maskFieldsUnder(rt: Runtime, container: Element, rect: ViewRect) {
    const s = rt.sticker;
    const found: Element[] = [];
    const cands = [container, ...Array.from(container.querySelectorAll(FIELD_SELECTOR))].filter((e) => e.matches(FIELD_SELECTOR) && !this.o.isOurs(e));
    for (const f of cands.slice(0, 200)) {
      const b = toViewRect(f.getBoundingClientRect());
      const i = intersect(b, rect);
      if (i && area(i) >= 0.2 * Math.min(area(b), area(rect))) found.push(f);
    }
    if (found.length === rt.fields.length && found.every((f, i) => f === rt.fields[i])) return;
    this.clearFields(rt);
    rt.fields = found;
    found.forEach((f, i) => this.o.masker.apply(`${s.id}::field${i}`, f, 'input'));
  }

  private clearFields(rt: Runtime) {
    rt.fields.forEach((_, i) => this.o.masker.restore(`${rt.sticker.id}::field${i}`));
    rt.fields = [];
  }

  /**
   * The characters a rect sticker should mask in `container` now: the ones it
   * masked before (in memory), else the window hashing to its stored
   * `coverHmac` nearest to the projection, else (fail closed) whatever the
   * projected rectangle covers.
   */
  private locateRectText(rt: Runtime, container: Element, rect: ViewRect): TextRange[] {
    const s = rt.sticker as RectSticker;
    const proj = coveredTextRanges(container, rect);
    const want = s.text && hasSyncKey() ? s.text : undefined;
    if (!rt.anchorKey && !want) return proj;
    const st = stripped(container);
    if (!st) return proj;
    const guess = proj.length ? startOf(st, proj) : -1;
    const near = guess >= 0 ? guess : rt.anchorAt;
    if (rt.anchorKey) {
      const i = locateExact(st, rt.anchorKey, near);
      if (i >= 0) {
        rt.anchorAt = i;
        return rangesForSpan(st, i, rt.anchorKey.length);
      }
      // The page wrote our bullets back into its own text (`normalize()`
      // merged the split, a re-render copied the masked DOM): the secret is
      // gone from the page and the bullets stand where it was.
      const b = locateExact(st, '•'.repeat(rt.anchorKey.length), rt.anchorAt >= 0 ? rt.anchorAt : near);
      if (b >= 0) return rangesForSpan(st, b, rt.anchorKey.length);
    }
    if (want) {
      if (proj.length && coveredHmacSync(coveredKey(proj)) === want.coverHmac) {
        rt.anchorKey = coveredKey(proj);
        rt.anchorAt = guess;
        return proj;
      }
      const i = locateByHash(st, want.len, want.coverHmac, coveredHmacSync, near);
      if (i >= 0) {
        rt.anchorKey = st.s.slice(i, i + want.len);
        rt.anchorAt = i;
        return rangesForSpan(st, i, want.len);
      }
    }
    return proj;
  }

  /**
   * Where a rect sticker is drawn: around the characters it masked, wherever
   * they are now, grown by the margins recorded at creation; the projected
   * rectangle when it masks no text (or predates text anchoring).
   */
  private rectGeometry(rt: Runtime, el: Element): { rect: ViewRect; confidence: Confidence } {
    const s = rt.sticker as RectSticker;
    const p = projectRect(s, toViewRect(el.getBoundingClientRect()));
    const t = s.text;
    if (!t || !this.o.masker.has(s.id)) return p;
    const rs = this.o.masker.subsetRects(s.id);
    const bb = union(rs);
    if (!bb) return p;
    const lh = rs.reduce((a, r) => a + r.h, 0) / rs.length;
    const k = t.lh > 0 ? lh / t.lh : 1;
    const m = t.margin;
    return { rect: { x: bb.x - m.l * k, y: bb.y - m.t * k, w: bb.w + (m.l + m.r) * k, h: bb.h + (m.t + m.b) * k }, confidence: 'high' };
  }

  /**
   * Text anchor for a rect sticker that just masked `raw` (measured before
   * masking) under the drawn `rect`. A side drawn tight to the text (within
   * TIGHT_PX) keeps that gap around the text; a looser side keeps the drawn
   * edge, measured from the masked text (bullets are narrower than digits).
   */
  private rectTextAnchor(rt: Runtime, rect: ViewRect, key: string, tokens: string[], rawBox: ViewRect): RectText | undefined {
    const s = rt.sticker;
    if (s.kind !== 'rect' || !key || !hasSyncKey() || !this.o.masker.has(s.id)) return undefined;
    const coverHmac = coveredHmacSync(key);
    const now = this.o.masker.subsetRects(s.id);
    const nowBox = union(now);
    if (!coverHmac || !rawBox || !nowBox) return undefined;
    const side = (drawn: number, rawEdge: number, nowEdge: number) => {
      const tight = drawn - rawEdge;
      return Math.max(0, tight <= TIGHT_PX ? tight : drawn - nowEdge);
    };
    // Left/top edges are compared negated so "drawn beyond the text" is positive on every side.
    const margin = {
      l: side(-rect.x, -rawBox.x, -nowBox.x),
      t: side(-rect.y, -rawBox.y, -nowBox.y),
      r: side(rect.x + rect.w, rawBox.x + rawBox.w, nowBox.x + nowBox.w),
      b: side(rect.y + rect.h, rawBox.y + rawBox.h, nowBox.y + nowBox.h),
    };
    rt.anchorKey = key;
    const tokenHmacs = tokens
      .map((x) => tokenHmacSync(x))
      .filter((h): h is string => !!h)
      .slice(0, 32);
    return { coverHmac, len: key.length, tokenHmacs, margin, lh: now.reduce((a, r) => a + r.h, 0) / now.length };
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
