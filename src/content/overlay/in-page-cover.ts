/**
 * In-page covers for stickers whose underlying pixels are not DOM text.
 *
 * The sticker overlay is a fixed layer repositioned from script on the next
 * animation frame. Chrome scrolls the document and overflow boxes on the
 * compositor thread, ahead of script, so during a scroll the overlay trails
 * the content by a frame or more. Text under a sticker is masked in the DOM
 * (bullets) and is safe in that gap; pixels are not: a canvas-drawn page,
 * an `<img>`, `<video>`, `<svg>` or a background image under a rect sticker.
 *
 * For those, an `<aibs-cover>` box in the sticker colour is put INTO the
 * page, inside the anchor's nearest containing block that scrolls with it, in
 * coordinates relative to that block. The compositor then moves it with the
 * content in the same frame. The fixed overlay stays on top (edit chrome,
 * labels, peeking); the cover only closes the lag.
 *
 * Page scripts can see, remove or restyle a cover. Removal and attribute
 * changes are undone from the MutationHub's synchronous listener, in the
 * same microtask; page stylesheets lose to the inline `!important`
 * declarations. If a cover is defeated anyway, the overlay still covers from
 * the next frame on.
 */
import type { RenderingMode, ViewRect } from '@/shared/types';
import type { MutationHub } from '../mask/guard';
import { intersect } from '../anchor/geometry';

export const COVER_TAG = 'aibs-cover';

/** One rect sticker that may need a cover: its anchor (container) and padded, unclipped viewport rect. */
export interface CoverItem {
  id: string;
  anchor: Element;
  rect: ViewRect;
}

export interface InPageCoversOptions {
  hub: MutationHub;
  color: () => string;
  mode: () => RenderingMode;
  /** False in extension pages (the PDF viewer paints its own page-local layer). */
  enabled: boolean;
}

/** Elements whose content is pixels rather than DOM text. */
const PIXEL_SELECTOR = 'canvas, img, video, svg, object, embed';
const PIXEL_TAGS = new Set(['CANVAS', 'IMG', 'VIDEO', 'SVG', 'OBJECT', 'EMBED']);
/** Elements that cannot hold a rendered child box. */
const REPLACED = new Set(['CANVAS', 'IMG', 'VIDEO', 'SVG', 'OBJECT', 'EMBED', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'PICTURE', 'AUDIO', 'BR', 'HR']);
const SCROLLING = new Set(['auto', 'scroll', 'hidden', 'overlay']);
const BLOCK_LEVEL = /^(block|flow-root|list-item|flex|grid|table)$/;
/** Applicability is re-evaluated this often per sticker (ms). */
const APPLIES_TTL = 1000;
/** Descendants inspected before making a static scroll box `position:relative`. */
const PROMOTE_SCAN_CAP = 1500;

interface Entry {
  el: HTMLElement;
  parent: Element;
  style: string;
}

interface Placement {
  parent: Element;
  left: number;
  top: number;
  width: number;
  height: number;
}

export class InPageCovers {
  private entries = new Map<string, Entry>();
  private ours = new WeakSet<Node>();
  private applies = new Map<string, { anchor: Element; ok: boolean; at: number }>();
  /** Static scroll boxes we made `position:relative`, with their previous inline value. */
  private promoted = new Map<Element, { value: string; priority: string }>();
  private promoteOk = new WeakMap<Element, boolean>();
  private unlisten: (() => void) | null = null;
  private destroyed = false;

  constructor(private o: InPageCoversOptions) {
    if (!o.enabled) return;
    // Same pattern as the host watchdog: undo removal or restyling in the
    // microtask that delivered the record, before the next frame is painted.
    this.unlisten = o.hub.addListener((records) => this.onRecords(records));
  }

  /** True for our cover elements (identity, not tag name: a page can make its own `<aibs-cover>`). */
  isOurs(node: Node | null | undefined): boolean {
    return !!node && this.ours.has(node);
  }

  get count(): number {
    return this.entries.size;
  }

  /** Bring the covers in line with `items` (stickers peeked at or paused are simply absent). */
  sync(items: CoverItem[]) {
    if (!this.o.enabled || this.destroyed) return;
    const want = new Map<string, Placement>();
    const now = Date.now();
    const live = new Set<string>();
    for (const it of items) {
      live.add(it.id);
      if (!it.anchor.isConnected || it.rect.w <= 0 || it.rect.h <= 0) continue;
      if (!this.appliesTo(it, now)) continue;
      const p = this.place(it.anchor, it.rect);
      if (p) want.set(it.id, p);
    }
    for (const id of Array.from(this.applies.keys())) if (!live.has(id)) this.applies.delete(id);
    for (const [id, e] of this.entries) {
      if (!want.has(id)) this.removeEntry(id, e);
    }
    const color = this.o.color() || '#1f2937';
    for (const [id, p] of want) {
      const style = coverStyle(p, color);
      let e = this.entries.get(id);
      if (!e) {
        e = { el: this.create(), parent: p.parent, style };
        this.entries.set(id, e);
      }
      e.parent = p.parent;
      e.style = style;
      this.enforce(e);
    }
    this.releasePromotions();
  }

  destroy() {
    this.destroyed = true;
    this.unlisten?.();
    this.unlisten = null;
    for (const [id, e] of this.entries) this.removeEntry(id, e);
    this.releasePromotions();
  }

  // ---- internals ----

  private create(): HTMLElement {
    const el = document.createElement(COVER_TAG);
    this.ours.add(el);
    return el;
  }

  /** Put the cover where it belongs, with exactly our attributes and style. */
  private enforce(e: Entry) {
    if (e.el.firstChild) {
      // The page put content into our cover. Leave it to the page (and to the
      // scanner, which skips our elements) and use a fresh cover.
      this.ours.delete(e.el);
      e.el = this.create();
    }
    const el = e.el;
    if (el.getAttribute('style') !== e.style) el.setAttribute('style', e.style);
    if (el.getAttribute('aria-hidden') !== 'true') el.setAttribute('aria-hidden', 'true');
    if (el.getAttribute('data-aibs') !== '') el.setAttribute('data-aibs', '');
    for (const a of Array.from(el.attributes)) {
      if (a.name !== 'style' && a.name !== 'aria-hidden' && a.name !== 'data-aibs') el.removeAttribute(a.name);
    }
    if (el.parentNode !== e.parent && e.parent.isConnected) e.parent.appendChild(el);
  }

  private removeEntry(id: string, e: Entry) {
    this.entries.delete(id);
    this.ours.delete(e.el);
    e.el.remove();
  }

  private onRecords(records: MutationRecord[]) {
    if (this.destroyed || !this.entries.size) return;
    let touched = false;
    for (const r of records) {
      if (r.type === 'attributes' ? this.ours.has(r.target) : r.type === 'childList' && (r.removedNodes.length > 0 || this.ours.has(r.target))) {
        touched = true;
        break;
      }
    }
    if (!touched) return;
    for (const e of this.entries.values()) {
      if (e.el.parentNode !== e.parent || e.el.firstChild || e.el.getAttribute('style') !== e.style || e.el.attributes.length !== 3) this.enforce(e);
    }
  }

  /**
   * Rect stickers over pixels: the page is canvas-drawn (or partly), the
   * container is or holds a pixel element under the rect, or the container
   * paints a background image. Plain text needs no cover: it is bullets.
   */
  private appliesTo(it: CoverItem, now: number): boolean {
    const mode = this.o.mode();
    if (mode === 'canvas' || mode === 'mixed') return true;
    const c = this.applies.get(it.id);
    if (c && c.anchor === it.anchor && now - c.at < APPLIES_TTL) return c.ok;
    const ok = overPixels(it.anchor, it.rect);
    this.applies.set(it.id, { anchor: it.anchor, ok, at: now });
    return ok;
  }

  /**
   * Where a cover for `rect` (viewport) over `anchor` goes: the anchor's
   * nearest containing block that moves with it, so that a scroll of any box
   * in between moves the cover in the same composited frame.
   */
  private place(anchor: Element, rect: ViewRect): Placement | null {
    let target = rect;
    const anchorCs = getComputedStyle(anchor);
    // The anchor itself, when it is a positioned box that can hold a child and
    // does not scroll (a cover inside a scroller would scroll away from a rect
    // projected from the scroller's own border box).
    let el: Element | null =
      !REPLACED.has(anchor.tagName.toUpperCase()) && anchorCs.position !== 'static' && !scrolls(anchorCs) && anchorCs.display !== 'contents' ? anchor : anchor.parentElement;
    let cb: Element | null = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = el === anchor ? anchorCs : getComputedStyle(el);
      if (cs.display !== 'contents') {
        if (isContainingBlock(cs)) {
          cb = el;
          break;
        }
        if (scrolls(cs)) {
          if (this.promote(el, cs)) {
            cb = el;
            break;
          }
          // Cannot anchor inside this box without risking its layout: the
          // cover goes further out (it will not track this box's compositor
          // scroll; the overlay still does after a frame), clipped to it.
          const c = intersect(target, viewBox(el));
          if (!c) return null;
          target = c;
        } else if (cs.overflowX === 'clip' || cs.overflowY === 'clip' || cs.clipPath !== 'none') {
          const c = intersect(target, viewBox(el));
          if (!c) return null;
          target = c;
        }
      }
      el = el.parentElement;
    }
    if (!cb) {
      const body = document.body;
      const html = document.documentElement;
      const parent = body ?? html;
      if (body && isContainingBlock(getComputedStyle(body))) cb = body;
      else if (isContainingBlock(getComputedStyle(html))) cb = html;
      else {
        // The initial containing block: document coordinates.
        return { parent, left: target.x + window.scrollX, top: target.y + window.scrollY, width: target.w, height: target.h };
      }
      return { parent, ...relativeTo(cb, target) };
    }
    return { parent: cb, ...relativeTo(cb, target) };
  }

  /**
   * Make a static scroll box `position:relative` so it contains the cover.
   * Only when that cannot change layout: a block-level box with no offsets
   * and no z-index (which only take effect once positioned), and no
   * absolutely positioned descendant whose containing block is further out.
   */
  private promote(el: Element, cs: CSSStyleDeclaration): boolean {
    if (cs.position !== 'static') return false;
    let ok = this.promoteOk.get(el);
    if (ok === undefined) {
      ok =
        el instanceof HTMLElement &&
        BLOCK_LEVEL.test(cs.display) &&
        cs.zIndex === 'auto' &&
        [cs.top, cs.right, cs.bottom, cs.left].every((v) => v === 'auto') &&
        !hasOuterAbsDescendant(el);
      this.promoteOk.set(el, ok);
    }
    if (!ok) return false;
    const h = el as HTMLElement;
    if (!this.promoted.has(el)) this.promoted.set(el, { value: h.style.getPropertyValue('position'), priority: h.style.getPropertyPriority('position') });
    h.style.setProperty('position', 'relative', 'important');
    return true;
  }

  /** Put back the `position` of scroll boxes no cover lives in any more. */
  private releasePromotions() {
    if (!this.promoted.size) return;
    const used = new Set<Element>();
    for (const e of this.entries.values()) used.add(e.parent);
    for (const [el, prev] of this.promoted) {
      if (used.has(el) && !this.destroyed) continue;
      this.promoted.delete(el);
      const h = el as HTMLElement;
      if (prev.value) h.style.setProperty('position', prev.value, prev.priority);
      else h.style.removeProperty('position');
      if (h.getAttribute('style') === '') h.removeAttribute('style');
    }
  }
}

function scrolls(cs: CSSStyleDeclaration): boolean {
  return SCROLLING.has(cs.overflowX) || SCROLLING.has(cs.overflowY);
}

/** The box establishes a containing block for absolutely positioned descendants. */
function isContainingBlock(cs: CSSStyleDeclaration): boolean {
  if (cs.position !== 'static') return true;
  if (cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none') return true;
  const bf = (cs as CSSStyleDeclaration & { backdropFilter?: string }).backdropFilter;
  if (bf && bf !== 'none') return true;
  if (/\b(layout|paint|strict|content)\b/.test(cs.contain)) return true;
  if (/\b(transform|perspective|filter)\b/.test(cs.willChange)) return true;
  if (cs.containerType && cs.containerType !== 'normal') return true;
  return false;
}

function hasOuterAbsDescendant(el: Element): boolean {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
  let n = 0;
  for (let d = w.nextNode() as Element | null; d; d = w.nextNode() as Element | null) {
    if (++n > PROMOTE_SCAN_CAP) return true;
    if (!(d instanceof HTMLElement)) continue;
    if (getComputedStyle(d).position !== 'absolute') continue;
    const op = d.offsetParent;
    // Its containing block is el itself or something inside: unaffected.
    if (op && op !== el && el.contains(op)) continue;
    return true;
  }
  return false;
}

function viewBox(el: Element): ViewRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** `rect` (viewport) in the padding-box coordinates of containing block `cb`, scroll offset included. */
function relativeTo(cb: Element, rect: ViewRect): Omit<Placement, 'parent'> {
  const r = cb.getBoundingClientRect();
  const ow = (cb as HTMLElement).offsetWidth;
  const oh = (cb as HTMLElement).offsetHeight;
  const sx = ow > 0 && r.width > 0 ? r.width / ow : 1;
  const sy = oh > 0 && r.height > 0 ? r.height / oh : 1;
  return {
    left: (rect.x - r.left) / sx - cb.clientLeft + cb.scrollLeft,
    top: (rect.y - r.top) / sy - cb.clientTop + cb.scrollTop,
    width: rect.w / sx,
    height: rect.h / sy,
  };
}

/** Is there anything but DOM text under `rect` in `anchor`? */
function overPixels(anchor: Element, rect: ViewRect): boolean {
  if (PIXEL_TAGS.has(anchor.tagName.toUpperCase())) return true;
  const cs = getComputedStyle(anchor);
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  const found = anchor.querySelectorAll(PIXEL_SELECTOR);
  const n = Math.min(found.length, 200);
  for (let i = 0; i < n; i++) {
    if (intersect(viewBox(found[i]), rect)) return true;
  }
  return false;
}

function coverStyle(p: Placement, color: string): string {
  // Edges pushed out by half a pixel, so anti-aliasing never leaves a column.
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;
  return [
    'position:absolute',
    `left:${px(p.left - 0.5)}`,
    `top:${px(p.top - 0.5)}`,
    `width:${px(p.width + 1)}`,
    `height:${px(p.height + 1)}`,
    'right:auto',
    'bottom:auto',
    `background:${color}`,
    'pointer-events:none',
    'z-index:2147483646',
    'contain:strict',
    'display:block',
    'visibility:visible',
    'opacity:1',
    'margin:0',
    'padding:0',
    'border:0',
    'box-sizing:border-box',
    'min-width:0',
    'min-height:0',
    'max-width:none',
    'max-height:none',
    'transform:none',
    'translate:none',
    'scale:none',
    'rotate:none',
    'filter:none',
    'clip-path:none',
    'mask:none',
    'mix-blend-mode:normal',
    'zoom:1',
    'content-visibility:visible',
    'float:none',
    'user-select:none',
  ]
    .map((d) => `${d} !important`)
    .join(';');
}
