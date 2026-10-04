import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import { fillRects, type PageRect } from './geometry';

/** Canvas px per PDF point for the flattened pages ("2x device scale"). */
export const FLATTEN_SCALE = 2;
const JPEG_QUALITY = 0.92;

function byPage(rects: PageRect[], page: number): PageRect[] {
  return rects.filter((r) => r.page === page);
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
export async function buildFlattened(doc: PDFDocumentProxy, rects: PageRect[], onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
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
