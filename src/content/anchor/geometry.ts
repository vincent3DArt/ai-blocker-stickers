import type { DocRect, ViewRect } from '@/shared/types';

export function toViewRect(r: DOMRect | DOMRectReadOnly): ViewRect {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function viewToDoc(r: ViewRect): DocRect {
  return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.w, h: r.h };
}

export function docToView(r: DocRect): ViewRect {
  return { x: r.x - window.scrollX, y: r.y - window.scrollY, w: r.w, h: r.h };
}

export function intersect(a: ViewRect, b: ViewRect): ViewRect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function union(rects: ViewRect[]): ViewRect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function area(r: ViewRect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function contains(outer: ViewRect, inner: ViewRect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

export function expand(r: ViewRect, pad: number): ViewRect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function center(r: ViewRect | DocRect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Client rects of an element, merged when they overlap heavily (inline
 * elements produce one rect per line box, sometimes duplicated by nested
 * inline children). Capped so a huge wrapped paragraph can't create hundreds
 * of pieces.
 */
export function clientRects(el: Element, cap = 24): ViewRect[] {
  const raw = Array.from(el.getClientRects(), toViewRect).filter((r) => r.w > 0 && r.h > 0);
  if (raw.length <= 1) return raw;
  const out: ViewRect[] = [];
  for (const r of raw) {
    const hit = out.find((o) => {
      const i = intersect(o, r);
      return i && area(i) > 0.8 * Math.min(area(o), area(r));
    });
    if (hit) {
      const u = union([hit, r])!;
      hit.x = u.x; hit.y = u.y; hit.w = u.w; hit.h = u.h;
    } else {
      out.push({ ...r });
    }
  }
  if (out.length > cap) return [union(out)!];
  return out;
}

/** True when the element has no layout boxes (display:none, detached, or an empty inline). */
export function isRendered(el: Element): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

const CLIPPING = new Set(['hidden', 'auto', 'scroll', 'clip']);

/** Ancestors whose overflow clips descendants. Used to clip sticker pieces. */
export function clipChain(el: Element): Element[] {
  const chain: Element[] = [];
  let node: Element | null = el.parentElement;
  while (node && node !== document.documentElement && node !== document.body) {
    const cs = getComputedStyle(node);
    if (CLIPPING.has(cs.overflowX) || CLIPPING.has(cs.overflowY) || cs.contain.includes('paint') || cs.clipPath !== 'none') {
      chain.push(node);
    }
    node = node.parentElement;
  }
  return chain;
}

export function clipTo(rect: ViewRect, chain: Element[]): ViewRect | null {
  let r: ViewRect | null = rect;
  for (const c of chain) {
    if (!r) return null;
    r = intersect(r, toViewRect(c.getBoundingClientRect()));
  }
  return r;
}
