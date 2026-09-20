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
import { defaultPathPattern, matchesPath } from '@/shared/url-match';
import type { OverlayHost } from '../overlay/host';
import { StickerView } from '../overlay/sticker-view';
import type { Positioner } from '../overlay/positioner';
import type { Masker } from '../mask/masker';
import { defaultMaskMode } from '../mask/masker';
import { coveredTextRanges } from '../mask/text-mask';
import { buildFingerprint } from '../anchor/fingerprint';
import { resolveFingerprint } from '../anchor/resolve';
import { anchorRect, projectRect } from '../anchor/rect-anchor';
import { clientRects, clipChain, clipTo, docToView, isRendered, toViewRect, union, area } from '../anchor/geometry';
import type { SiteStore } from './store';

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

const LOST_AFTER_MS = 30_000;
const LOST_AFTER_LOAD_MS = 5_000;
const DETACH_GRACE_MS = 5_000;

export class Session {
  private runtimes = new Map<string, Runtime>();
  private paused = false;
  private editing = false;
  private loadedAt = Date.now();
  private resolving = false;
  private resolveAgain = false;

  constructor(private o: SessionOptions) {}

  /** Apply every sticker that matches the current path. */
  async load() {
    this.loadedAt = Date.now();
    const active = this.o.store.active(location.pathname, this.o.frameDepth);
    const activeIds = new Set(active.map((s) => s.id));
    for (const id of Array.from(this.runtimes.keys())) if (!activeIds.has(id)) this.drop(id);
    for (const s of active) if (!this.runtimes.has(s.id)) this.track(s);
    // Deliberately not awaited: at document_start the resolver keeps being
    // re-armed by the parser's mutation batches, and boot must not wait for
    // that to settle before it can answer messages.
    void this.resolveAll();
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
  }

  get isPaused() {
    return this.paused;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    for (const rt of this.runtimes.values()) {
      if (paused) {
        this.o.masker.restore(rt.sticker.id);
        rt.view.hide();
      } else {
        this.applyMask(rt);
      }
    }
    this.o.positioner.flush();
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
      status: rt.status,
      pathPattern: rt.sticker.scope.pathPattern,
      currentPath: location.pathname,
    }));
  }

  state(): TabState {
    const rts = Array.from(this.runtimes.values());
    return {
      editMode: this.editing,
      paused: this.paused,
      stickerCount: rts.length,
      lostCount: rts.filter((r) => r.status === 'lost').length,
      peeking: false,
    };
  }

  async addElementSticker(el: Element, source: StickerSource): Promise<Sticker> {
    const now = Date.now();
    const anchor = await buildFingerprint(el);
    const sticker: ElementSticker = {
      kind: 'element',
      id: crypto.randomUUID(),
      scope: { pathPattern: defaultPathPattern(location.pathname) },
      frame: { depth: this.o.frameDepth, urlPattern: this.o.frameDepth > 0 ? location.origin + location.pathname : undefined },
      source,
      padding: 3,
      createdAt: now,
      updatedAt: now,
      anchor,
      maskMode: defaultMaskMode(el),
    };
    this.o.store.upsert(sticker);
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
      scope: { pathPattern: defaultPathPattern(location.pathname) },
      frame: { depth: this.o.frameDepth, urlPattern: this.o.frameDepth > 0 ? location.origin + location.pathname : undefined },
      source: 'rect',
      padding: 0,
      createdAt: now,
      updatedAt: now,
      container: a.container,
      frac: a.frac,
      px: a.px,
      maskUnderlyingText: true,
    };
    this.o.store.upsert(sticker);
    const rt = this.track(sticker);
    const container = await resolveFingerprint(a.container, { exclude: (e) => this.o.isOurs(e) });
    this.attach(rt, container?.el ?? document.body, 'high');
    this.o.positioner.flush();
    this.reportState();
    return sticker;
  }

  /** Change a sticker's URL scope. Drops the runtime when it no longer applies here. */
  setScope(id: string, pathPattern: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const updated = { ...rt.sticker, scope: { ...rt.sticker.scope, pathPattern }, updatedAt: Date.now() } as Sticker;
    rt.sticker = updated;
    rt.view.setSticker(updated);
    this.o.store.upsert(updated);
    if (!matchesPath(pathPattern, location.pathname)) {
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

  originals(id: string): string {
    return this.o.masker.originals(id);
  }

  setPeek(ids: string[], on: boolean) {
    for (const id of ids) {
      const rt = this.runtimes.get(id);
      if (!rt) continue;
      rt.view.setPeeking(on);
      this.o.masker.setPeek(id, on);
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
    for (const id of Array.from(this.runtimes.keys())) this.drop(id);
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
    };
    this.runtimes.set(sticker.id, rt);
    return rt;
  }

  private drop(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.o.masker.restore(id);
    if (rt.el) this.o.positioner.unobserve(rt.el);
    rt.view.destroy();
    this.runtimes.delete(id);
  }

  private attach(rt: Runtime, el: Element, confidence: Confidence) {
    if (rt.el && rt.el !== el) this.o.positioner.unobserve(rt.el);
    rt.el = el;
    rt.status = 'resolved';
    rt.confidence = confidence;
    rt.clip = clipChain(el);
    rt.lastRectKey = '';
    this.o.positioner.observe(el);
    if (!this.paused) this.applyMask(rt);
  }

  private detach(rt: Runtime, now: number) {
    if (rt.el) this.o.positioner.unobserve(rt.el);
    this.o.masker.restore(rt.sticker.id);
    rt.el = null;
    rt.status = 'resolving';
    rt.unresolvedSince = now - (this.lostBudget() - DETACH_GRACE_MS);
    rt.view.hide();
    this.reportState();
  }

  private markLost(rt: Runtime) {
    if (rt.status === 'lost') return;
    this.o.masker.restore(rt.sticker.id);
    if (rt.el) this.o.positioner.unobserve(rt.el);
    rt.el = null;
    rt.status = 'lost';
    this.reportState();
  }

  private lostBudget(): number {
    const sinceLoad = Date.now() - this.loadedAt;
    return document.readyState === 'complete' && sinceLoad > LOST_AFTER_LOAD_MS ? LOST_AFTER_LOAD_MS : LOST_AFTER_MS;
  }

  private applyMask(rt: Runtime) {
    const s = rt.sticker;
    if (!rt.el) return;
    if (s.kind === 'element') {
      this.o.masker.apply(s.id, rt.el, s.maskMode);
    } else {
      // Rect stickers mask text lazily from position(), once the rect is known.
      rt.lastRectKey = '';
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
          if (rt.status === 'resolved' && rt.el?.isConnected) continue;
          if (rt.status === 'lost' && !this.editing) continue;
          const fp = rt.sticker.kind === 'element' ? rt.sticker.anchor : rt.sticker.container;
          const res = await resolveFingerprint(fp, { exclude: (e) => this.o.isOurs(e) || this.anchoredByOther(e, rt) });
          if (res) {
            this.attach(rt, res.el, res.confidence);
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
    rt.view.update(clipped, 'resolved', confidence);
  }

  private maskUnderRect(rt: Runtime, container: Element, rect: ViewRect) {
    const s = rt.sticker as RectSticker;
    if (!s.maskUnderlyingText) return;
    const key = `${Math.round(rect.x + scrollX)}:${Math.round(rect.y + scrollY)}:${Math.round(rect.w)}:${Math.round(rect.h)}`;
    // Re-scan when the rect moved, when the masker says the page disturbed our
    // split, or while nothing is masked at all: in that last case the text can
    // still slide under a rect whose own projection never changes (a rect over
    // a scroll container), and the scan is the only thing that would notice.
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
