import type { Confidence, Fingerprint, RectFraction, ViewRect } from '@/shared/types';
import { contains, toViewRect } from './geometry';
import { buildFingerprint } from './fingerprint';

export interface RectAnchor {
  container: Fingerprint;
  frac: RectFraction;
  px: { w: number; h: number };
}

/**
 * The deepest element that fully contains `rect`, probing the centre and four
 * inset corners. Elements accepted by `skip` (our own host) are ignored.
 */
export function containerFor(rect: ViewRect, skip: (el: Element) => boolean): Element {
  const inset = Math.min(4, rect.w / 4, rect.h / 4);
  const points = [
    [rect.x + rect.w / 2, rect.y + rect.h / 2],
    [rect.x + inset, rect.y + inset],
    [rect.x + rect.w - inset, rect.y + inset],
    [rect.x + inset, rect.y + rect.h - inset],
    [rect.x + rect.w - inset, rect.y + rect.h - inset],
  ];
  // Candidate chain: ancestors of the deepest element under the centre.
  const stacks = points.map((p) => document.elementsFromPoint(p[0], p[1]).filter((e) => !skip(e)));
  const centreStack = stacks[0];
  for (const el of centreStack) {
    if (el === document.documentElement) break;
    const box = toViewRect(el.getBoundingClientRect());
    if (!contains(box, rect)) continue;
    // Must also be an ancestor-or-self of every corner's hit, otherwise the
    // rect spans siblings and we want their common parent.
    if (stacks.every((st) => st.some((hit) => hit === el || el.contains(hit)))) return el;
  }
  return document.body ?? document.documentElement;
}

export async function anchorRect(rect: ViewRect, skip: (el: Element) => boolean): Promise<RectAnchor> {
  const container = containerFor(rect, skip);
  const box = toViewRect(container.getBoundingClientRect());
  const frac: RectFraction = {
    fx: box.w > 0 ? (rect.x - box.x) / box.w : 0,
    fy: box.h > 0 ? (rect.y - box.y) / box.h : 0,
    fw: box.w > 0 ? rect.w / box.w : 0,
    fh: box.h > 0 ? rect.h / box.h : 0,
  };
  return { container: await buildFingerprint(container), frac, px: { w: rect.w, h: rect.h } };
}

/**
 * Rectangle for the current container box. When the container's aspect ratio
 * drifted (responsive reflow) the pixel size is kept and only the origin is
 * taken from the fractions, flagged as low confidence.
 */
export function projectRect(anchor: RectAnchor, containerBox: ViewRect): { rect: ViewRect; confidence: Confidence } {
  const { frac, px } = anchor;
  const storedAspect = px.h > 0 ? px.w / px.h : 1;
  const nowW = containerBox.w * frac.fw;
  const nowH = containerBox.h * frac.fh;
  const nowAspect = nowH > 0 ? nowW / nowH : 1;
  const drift = Math.abs(nowAspect - storedAspect) / Math.max(storedAspect, 1e-6);
  const x = containerBox.x + containerBox.w * frac.fx;
  const y = containerBox.y + containerBox.h * frac.fy;
  if (drift > 0.25) {
    return { rect: { x, y, w: px.w, h: px.h }, confidence: 'low' };
  }
  return { rect: { x, y, w: nowW, h: nowH }, confidence: 'high' };
}
