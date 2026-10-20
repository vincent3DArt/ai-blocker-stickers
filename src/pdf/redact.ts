import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import { editPad, fillRects, inkColors, type PageEdit, type PageRect } from './geometry';

/** Canvas px per PDF point for the flattened pages ("2x device scale"). */
export const FLATTEN_SCALE = 2;
const JPEG_QUALITY = 0.92;
/** Pixels sampled around the cover for the background colour. */
const RING = 2;

function byPage<T extends { page: number }>(items: T[], page: number): T[] {
  return items.filter((r) => r.page === page);
}

/**
 * Draw live text edits into a rendered page canvas (`scale` canvas px per
 * PDF point): each original span is covered with the background colour
 * sampled around it, then the new words are drawn on its baseline, squeezed
 * into its width when longer. The viewer and the flattened download both
 * paint through here, so the screen and the file show the same thing.
 */
export function paintEdits(ctx: CanvasRenderingContext2D, edits: PageEdit[], scale: number) {
  if (!edits.length) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Sample every edit before painting any, so neighbouring covers never sample each other.
  const jobs = edits.flatMap((e) => {
    // Glyph ink can reach past pdf.js's box: padded, but never into neighbouring text (see editPad).
    const p = e.pad ?? editPad(e, e.h, []);
    const cover = fillRects([{ x: e.x - p.l, y: e.y - p.t, w: e.w + p.l + p.r, h: e.h + p.t + p.b }], scale, W, H)[0];
    if (!cover) return [];
    const rx = Math.max(0, cover.x - RING);
    const ry = Math.max(0, cover.y - RING);
    const rw = Math.min(W, cover.x + cover.w + RING) - rx;
    const rh = Math.min(H, cover.y + cover.h + RING) - ry;
    const px = ctx.getImageData(rx, ry, rw, rh).data;
    return [{ e, cover, colors: inkColors(px, rw, rh, { x: cover.x - rx, y: cover.y - ry, w: cover.w, h: cover.h }) }];
  });
  // Every cover first, then every text: a neighbouring edit's cover must not erase new words.
  for (const { cover, colors } of jobs) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(cover.x, cover.y, cover.w, cover.h);
  }
  for (const { e, colors } of jobs) {
    if (!e.text.trim()) continue;
    ctx.save();
    ctx.font = `${e.style ? e.style + ' ' : ''}${e.h * scale}px ${e.family}`;
    let baseline = e.baseline;
    if (baseline === undefined) {
      // pdf.js places a span's top at baseline − ascent, with the ascent ratio of the same stand-in font.
      const m = ctx.measureText(e.text);
      const total = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
      baseline = e.y + (total > 0 ? m.fontBoundingBoxAscent / total : 0.8) * e.h;
    }
    const sx = e.scaleX > 0 ? e.scaleX : 1;
    ctx.fillStyle = colors.fg;
    ctx.textBaseline = 'alphabetic';
    ctx.translate(e.x * scale, baseline * scale);
    ctx.scale(sx, 1);
    ctx.fillText(e.text, 0, 0, (e.w * scale) / sx);
    ctx.restore();
  }
  ctx.restore();
}

async function canvasToBytes(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
      : await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', JPEG_QUALITY));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * True redaction: every page is re-rendered by pdf.js at FLATTEN_SCALE,
 * the sticker rectangles are painted opaque black into the pixels, and the
 * result is the only content of a brand-new page of the original size. The
 * new file has no text, fonts, annotations, links, metadata or attachments
 * from the original, so nothing can be extracted from under a sticker.
 */
export async function buildFlattened(
  doc: PDFDocumentProxy,
  rects: PageRect[],
  edits: PageEdit[] = [],
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer('AI Blocker Stickers');
  out.setCreator('AI Blocker Stickers');
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: FLATTEN_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Forms and annotations are drawn into the pixels as they appear.
    await page.render({ canvas, canvasContext: ctx, viewport: vp, annotationMode: 1 /* ENABLE */ }).promise;
    // Edits first, stickers last: a sticker over an edit always wins.
    paintEdits(ctx, byPage(edits, i), FLATTEN_SCALE);
    ctx.fillStyle = '#000';
    for (const f of fillRects(byPage(rects, i), FLATTEN_SCALE, canvas.width, canvas.height)) ctx.fillRect(f.x, f.y, f.w, f.h);
    const img = await out.embedJpg(await canvasToBytes(canvas));
    const p = out.addPage([base.width, base.height]);
    p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    canvas.width = canvas.height = 0;
    page.cleanup();
    onProgress?.(i + 1, doc.numPages);
  }
  return out.save();
}

/**
 * NOT a redaction: black rectangles are drawn on top of the original page
 * content, which stays in the file. Text under a rectangle can still be
 * selected, copied and extracted. Coordinates go through pdf.js's own
 * viewport transform, so crop boxes and page rotation are honoured.
 */
export async function buildVector(doc: PDFDocumentProxy, bytes: Uint8Array, rects: PageRect[]): Promise<Uint8Array> {
  const out = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = out.getPages();
  for (let i = 0; i < doc.numPages && i < pages.length; i++) {
    const list = byPage(rects, i);
    if (!list.length) continue;
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    for (const r of list) {
      const [ax, ay] = vp.convertToPdfPoint(r.x, r.y);
      const [bx, by] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
      pages[i].drawRectangle({
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
        color: rgb(0, 0, 0),
        borderWidth: 0,
      });
    }
  }
  return out.save();
}

/** Save bytes through an object URL and `<a download>`: no `downloads` permission. */
export function saveBytes(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
