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
