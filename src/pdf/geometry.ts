/**
 * Pure helpers for the PDF viewer: sticker geometry in page coordinates,
 * fill rectangles for the flattened redaction, file naming and the
 * per-document scope key. No DOM, no pdf.js: unit-tested in Node.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One rendered page: its on-screen box (CSS px, viewport-relative) and its size in PDF points. */
export interface PageBox {
  /** `getBoundingClientRect()` of the page's canvas wrapper. */
  box: Rect;
  /** Page width and height in PDF points at scale 1, rotation applied (pdf.js viewport at scale 1). */
  width: number;
  height: number;
}

/** A sticker rectangle on one page, in PDF points from the page's top-left corner. */
export interface PageRect extends Rect {
  page: number;
}

/**
 * A live text edit on one page, in PDF points: x, y, w are the original text
 * span's box and h is its font size. The new words are drawn on the span's
 * baseline in its stand-in font family, scaled horizontally like pdf.js did.
 */
export interface PageEdit extends PageRect {
  text: string;
  family: string;
  scaleX: number;
  /** Cover padding in points (top, right, bottom, left); without it, a fixed share of the font size. */
  pad?: { t: number; r: number; b: number; l: number };
}

/**
 * Cover padding for an edit (PDF points), a share of the font size `h`,
 * cut short where another text box on the page is closer: in tightly leaded
 * text a full pad would erase parts of the neighbouring lines.
 */
export function editPad(box: Rect, h: number, others: Rect[]): { t: number; r: number; b: number; l: number } {
  const pad = { t: 0.1 * h, r: 0.05 * h, b: 0.1 * h, l: 0.05 * h };
  for (const o of others) {
    const xOverlap = o.x < box.x + box.w + pad.r && o.x + o.w > box.x - pad.l;
    const yOverlap = o.y < box.y + h && o.y + o.h > box.y;
    if (xOverlap && o.y + o.h <= box.y + 0.5 * h && !yOverlap) pad.t = Math.min(pad.t, Math.max(0, box.y - (o.y + o.h)));
    if (xOverlap && o.y >= box.y + 0.5 * h && !yOverlap) pad.b = Math.min(pad.b, Math.max(0, o.y - (box.y + h)));
    if (yOverlap && o.x >= box.x + box.w) pad.r = Math.min(pad.r, o.x - (box.x + box.w));
    if (yOverlap && o.x + o.w <= box.x) pad.l = Math.min(pad.l, box.x - (o.x + o.w));
  }
  return pad;
}

/**
 * Colours for painting an edit, from rendered RGBA pixels (`w` × `h`) around
 * and under the original text. `bg` is the most common colour of the ring
 * outside `inner` (quantised to 4 bits per channel, then averaged); `fg` is
 * the inner pixel farthest from it, or black/white by bg's lightness when
 * nothing inside stands out (no ink to match).
 */
export function inkColors(px: Uint8ClampedArray, w: number, h: number, inner: Rect): { bg: string; fg: string } {
  const buckets = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h) continue;
      const i = (y * w + x) * 4;
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      const b = buckets.get(key) ?? [0, 0, 0, 0];
      b[0] += px[i];
      b[1] += px[i + 1];
      b[2] += px[i + 2];
      b[3]++;
      buckets.set(key, b);
    }
  }
  let bg: [number, number, number] = [255, 255, 255];
  let best = 0;
  for (const b of buckets.values()) {
    if (b[3] <= best) continue;
    best = b[3];
    bg = [Math.round(b[0] / b[3]), Math.round(b[1] / b[3]), Math.round(b[2] / b[3])];
  }
  let fg: [number, number, number] | null = null;
  let far = 0;
  for (let y = Math.max(0, inner.y); y < Math.min(h, inner.y + inner.h); y++) {
    for (let x = Math.max(0, inner.x); x < Math.min(w, inner.x + inner.w); x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
      if (d <= far) continue;
      far = d;
      fg = [px[i], px[i + 1], px[i + 2]];
    }
  }
  if (!fg || far < 96) fg = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2] > 128 ? [0, 0, 0] : [255, 255, 255];
  const css = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  return { bg: css(bg), fg: css(fg) };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

/**
 * Convert overlay rectangles (viewport CSS px) into page rectangles (PDF
 * points, top-left origin). A rectangle that spans two pages yields one
 * piece per page; parts outside every page are dropped. Page indices are
 * zero-based positions in `pages`.
 */
export function viewRectsToPageRects(rects: Rect[], pages: PageBox[]): PageRect[] {
  const out: PageRect[] = [];
  pages.forEach((p, page) => {
    if (p.box.w <= 0 || p.box.h <= 0) return;
    const sx = p.width / p.box.w;
    const sy = p.height / p.box.h;
    for (const r of rects) {
      const i = intersect(r, p.box);
      if (!i) continue;
      out.push({ page, x: (i.x - p.box.x) * sx, y: (i.y - p.box.y) * sy, w: i.w * sx, h: i.h * sy });
    }
  });
  return out;
}

/**
 * Device-pixel fill rectangles for a page re-rendered at `scale` (canvas
 * px per PDF point). Edges are pushed outward to whole pixels, so
 * anti-aliasing can never leave a half-covered glyph column at a border,
 * and clamped to the canvas.
 */
export function fillRects(pageRects: Rect[], scale: number, canvasW: number, canvasH: number): Rect[] {
  const out: Rect[] = [];
  for (const r of pageRects) {
    const x1 = Math.max(0, Math.floor(r.x * scale));
    const y1 = Math.max(0, Math.floor(r.y * scale));
    const x2 = Math.min(canvasW, Math.ceil((r.x + r.w) * scale));
    const y2 = Math.min(canvasH, Math.ceil((r.y + r.h) * scale));
    if (x2 > x1 && y2 > y1) out.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }
  return out;
}

/** `report.pdf` -> `report-redacted.pdf`; anything unusable becomes `document-redacted.pdf`. */
export function redactedFileName(name: string | undefined | null): string {
  let base = (name ?? '').split(/[\\/]/).pop() ?? '';
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep it as it is */
  }
  base = base.replace(/\.pdf$/i, '');
  // Characters Windows and macOS refuse in file names, and control characters.
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  if (!base || /^\.+$/.test(base)) base = 'document';
  return `${base.slice(0, 120)}-redacted.pdf`;
}

/** File name part of a source URL, or undefined. */
export function fileNameFromUrl(src: string): string | undefined {
  try {
    const u = new URL(src);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || undefined;
  } catch {
    return undefined;
  }
}

/** First 16 hex digits of the document's SHA-256 (64 bits: plenty to tell documents apart). */
export const DOC_KEY_HEX = 16;

/**
 * The scope path for a document. The hex digest is spelled with the letters
 * g-v (0 -> g ... f -> v): the scope sanitiser generalises hex-looking and
 * digit-bearing path segments to `*`, which would make every PDF share its
 * stickers. A letters-only key stays a literal segment and needs no secret.
 */
export function docPath(sha256Hex: string): string {
  const hex = sha256Hex.toLowerCase().slice(0, DOC_KEY_HEX);
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('not a hex digest');
  const key = Array.from(hex, (c) => String.fromCharCode(103 + parseInt(c, 16))).join('');
  return `/pdf/${key}`;
}

/** Hex SHA-256 of a byte buffer (WebCrypto). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The PDF location from the viewer's query string. `?src=` normally holds an
 * encoded URL; the redirect rule substitutes the raw URL, which may carry its
 * own `?` and `&`, so everything after `src=` is taken when it is unencoded.
 */
export function parseSrc(search: string): string | null {
  const m = /^\?src=(.*)$/s.exec(search);
  if (!m || !m[1]) return null;
  let raw = m[1];
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u.href : null;
  } catch {
    return null;
  }
}

/** True for a URL whose path ends in `.pdf` (query and hash ignored). */
export function looksLikePdfUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /^(https?|file):$/.test(u.protocol) && /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}
