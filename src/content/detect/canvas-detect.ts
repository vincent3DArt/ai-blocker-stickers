/**
 * Canvas-page detection.
 *
 * Some apps (Google Docs, Sheets and Slides, Figma, PDF viewers, whiteboards)
 * draw their content on a `<canvas>` or into a plugin, so the text a person
 * reads is not DOM text at all. The scanner, the element picker and text
 * masking have nothing to work on there; only the pixel overlay of a
 * rectangle sticker still helps. This module tells the two kinds of page
 * apart so the UI can say so instead of reporting "No suggestions".
 *
 * Cheap by design: a handful of `getBoundingClientRect` calls for the
 * canvas-like elements and a capped TreeWalker over text nodes, stopping as
 * soon as enough visible text has been seen to call the page DOM-rendered.
 */

import type { RenderingMode, ViewRect } from '@/shared/types';

export type { RenderingMode };

/**
 * Known canvas apps. The hostname must match exactly; `path`, when present,
 * must match `location.pathname` (Google Drive's other pages are ordinary DOM).
 */
export const CANVAS_APPS: ReadonlyArray<{ host: string; path?: RegExp }> = [
  { host: 'docs.google.com', path: /^\/(document|presentation|spreadsheets)(\/|$)/ },
  { host: 'www.figma.com' },
  { host: 'excalidraw.com' },
  { host: 'miro.com' },
  { host: 'lucid.app' },
];

export function knownCanvasApp(hostname: string, pathname: string): boolean {
  const host = hostname.toLowerCase();
  return CANVAS_APPS.some((a) => a.host === host && (!a.path || a.path.test(pathname)));
}

/** Elements whose content is pixels or a plugin, not DOM text. WebGL draws into a canvas too. */
export const CANVAS_SELECTOR = 'canvas, embed[type="application/pdf"], object';

/** Canvas-like elements smaller than this (CSS px, either side) are icons and sparklines. */
const MIN_SIDE = 48;
/** Text nodes the walker looks at, at most. */
const WALK_CAP = 4000;
/** Canvas share of the viewport at which a page counts as drawn. */
export const CANVAS_MAJOR = 0.4;
/** Canvas share of the viewport at which a page counts as partly drawn. */
export const CANVAS_MINOR = 0.15;
/** Visible DOM characters below which a mostly-canvas page counts as 'canvas'. */
export const TEXT_FEW = 300;

const SKIP_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);

export interface RenderingSample {
  /** Share of the viewport covered by canvas-like elements, 0..1 (overlaps may over-count; clamped). */
  canvasFraction: number;
  /** Visible, non-blank text nodes inside the viewport (stops counting once the page is clearly DOM). */
  textNodes: number;
  /** Their characters, whitespace excluded. */
  textChars: number;
}

export interface MeasureOptions {
  doc?: Document;
  viewport?: { w: number; h: number };
  /** Our own overlay and anything else that must not count. */
  skip?: (n: Node) => boolean;
  /** Box of an element (default `getBoundingClientRect`). */
  rectOf?: (el: Element) => ViewRect;
  /** Client rects of a text node (default `Range.getClientRects`). */
  textRectsOf?: (t: Text) => ViewRect[];
}

function intersectArea(r: ViewRect, vw: number, vh: number): number {
  const w = Math.min(r.x + r.w, vw) - Math.max(r.x, 0);
  const h = Math.min(r.y + r.h, vh) - Math.max(r.y, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

function defaultRectOf(el: Element): ViewRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

let sharedRange: Range | null = null;
function defaultTextRectsOf(t: Text): ViewRect[] {
  const doc = t.ownerDocument;
  if (!sharedRange || sharedRange.startContainer.ownerDocument !== doc) sharedRange = doc.createRange();
  const range = sharedRange;
  range.selectNodeContents(t);
  if (typeof range.getClientRects !== 'function') return [];
  return Array.from(range.getClientRects()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
}

export function measureRendering(o: MeasureOptions = {}): RenderingSample {
  const doc = o.doc ?? document;
  const view = doc.defaultView;
  const vw = o.viewport?.w ?? view?.innerWidth ?? 0;
  const vh = o.viewport?.h ?? view?.innerHeight ?? 0;
  const rectOf = o.rectOf ?? defaultRectOf;
  const textRectsOf = o.textRectsOf ?? defaultTextRectsOf;
  const skip = o.skip ?? (() => false);
  const sample: RenderingSample = { canvasFraction: 0, textNodes: 0, textChars: 0 };
  const viewArea = vw * vh;
  const root = doc.body ?? doc.documentElement;
  if (!root || viewArea <= 0) return sample;

  let covered = 0;
  for (const el of Array.from(doc.querySelectorAll(CANVAS_SELECTOR))) {
    if (skip(el)) continue;
    // An <object> showing an image or HTML is not a drawn surface.
    if (el.tagName === 'OBJECT' && !/^application\//i.test(el.getAttribute('type') ?? '') && !/\.pdf([?#]|$)/i.test(el.getAttribute('data') ?? '')) continue;
    const r = rectOf(el);
    if (r.w < MIN_SIDE || r.h < MIN_SIDE) continue;
    covered += intersectArea(r, vw, vh);
  }
  sample.canvasFraction = Math.min(1, covered / viewArea);

  // Visible text: stop once there is clearly more than a caption's worth.
  const enough = TEXT_FEW * 4;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let walked = 0;
  for (let n = walker.nextNode(); n && walked < WALK_CAP && sample.textChars < enough; n = walker.nextNode()) {
    walked++;
    const t = n as Text;
    const chars = t.data.replace(/\s+/g, '').length;
    if (!chars) continue;
    const p = t.parentElement;
    if (!p || SKIP_TEXT_PARENTS.has(p.tagName.toUpperCase()) || skip(t)) continue;
    if (!textRectsOf(t).some((r) => intersectArea(r, vw, vh) > 0)) continue;
    sample.textNodes++;
    sample.textChars += chars;
  }
  return sample;
}

/** 'canvas': mostly drawn with little DOM text. 'mixed': a sizeable drawn area beside DOM text. */
export function classifyRendering(s: RenderingSample): RenderingMode {
  if (s.canvasFraction >= CANVAS_MAJOR && s.textChars < TEXT_FEW) return 'canvas';
  if (s.canvasFraction >= CANVAS_MINOR) return 'mixed';
  return 'dom';
}

export interface RenderingOptions extends MeasureOptions {
  hostname?: string;
  pathname?: string;
}

/** How the page in view is rendered. Known canvas apps short-circuit to 'canvas'. */
export function pageRenderingMode(o: RenderingOptions = {}): RenderingMode {
  const loc = (o.doc ?? document).defaultView?.location;
  if (knownCanvasApp(o.hostname ?? loc?.hostname ?? '', o.pathname ?? loc?.pathname ?? '')) return 'canvas';
  return classifyRendering(measureRendering(o));
}
