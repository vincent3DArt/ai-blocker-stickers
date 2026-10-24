import './pdf.css';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { boot, type BootApi } from '@/content/index';
import { docPath, editPad, fileNameFromUrl, parseSrc, redactedFileName, sha256Hex, viewRectsToPageRects, type PageBox, type PageEdit, type Rect } from '@/pdf/geometry';
import { loadPdfBytes, SourceError } from '@/pdf/source';
import { buildFlattened, buildVector, paintEdits, saveBytes } from '@/pdf/redact';
import { icon, type IconName } from '@/shared/icons';

/*
 * The extension's own PDF viewer. Chrome's built-in viewer cannot be
 * scripted, so PDFs are opened here instead: pdf.js draws each page to a
 * canvas and lays its text layer on top, and the ordinary sticker engine
 * (the content script's boot()) runs in this page against that DOM.
 *
 * Privacy: the only request this page makes is for the PDF the user opened.
 * pdf.js loads its worker, CMaps, standard fonts and decoders from the
 * extension package. Nothing about the document is stored except the
 * scope key (16 hex digits of its SHA-256, spelled as letters) and the
 * stickers' geometry.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pagesEl = $<HTMLDivElement>('pages');
const statusEl = $<HTMLParagraphElement>('status');
const titleEl = $<HTMLElement>('title');
const fileInput = $<HTMLInputElement>('file');
const btnPick = $<HTMLButtonElement>('pick');
const btnRect = $<HTMLButtonElement>('rect');
const btnEdit = $<HTMLButtonElement>('edit');
const btnDone = $<HTMLButtonElement>('done');
const btnClear = $<HTMLButtonElement>('clear');
const btnDownload = $<HTMLButtonElement>('download');
const chkVector = $<HTMLInputElement>('vector');
const drop = $<HTMLDivElement>('drop');
const viewerEl = $<HTMLElement>('viewer');
const btnZoomIn = $<HTMLButtonElement>('zoom-in');
const btnZoomOut = $<HTMLButtonElement>('zoom-out');
const zoomLevel = $<HTMLSpanElement>('zoom-level');
const pageIndicator = $<HTMLSpanElement>('page-indicator');

// Icons for the toolbar controls (data-icon in index.html).
for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.prepend(icon(el.dataset.icon as IconName));

const asset = (p: string) => chrome.runtime.getURL(`pdfjs/${p}`);
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PageView {
  index: number;
  page: PDFPageProxy;
  /** Scale 1, rotation applied: the page in PDF points. */
  base: PageViewport;
  view: PageViewport;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  rendered: boolean;
  /** Canvas px per PDF point of what the canvas shows now (0 before its first render). */
  drawnScale: number;
}

interface Loaded {
  doc: PDFDocumentProxy;
  bytes: Uint8Array;
  name: string;
  key: string;
  pages: PageView[];
}

let current: Loaded | null = null;
/** Scope path stickers match against: `/pdf/<key>` once a document is shown. */
let scopePath = '/pdf';
let engine: BootApi | undefined;
let observer: IntersectionObserver | null = null;
let loadSeq = 0;
/** Scale that fits the first page to the window; `zoom` multiplies it. */
let fitScale = 1;
let zoom = 1;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function setState(s: 'empty' | 'loading' | 'ready' | 'error') {
  document.body.dataset.state = s;
  const ready = s === 'ready';
  btnPick.disabled = btnRect.disabled = btnEdit.disabled = btnDone.disabled = btnClear.disabled = btnDownload.disabled = !ready;
  updateZoomUi();
  updatePageIndicator();
}

function status(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

// ---- rendering ----

const renderQueue: PageView[] = [];
let rendering = false;

async function pumpRender() {
  if (rendering) return;
  rendering = true;
  try {
    while (renderQueue.length) {
      const pv = renderQueue.shift()!;
      if (pv.rendered || !pv.el.isConnected) continue;
      pv.rendered = true;
      const dpr = window.devicePixelRatio || 1;
      const vp = pv.page.getViewport({ scale: pv.view.scale * dpr });
      // Rendered off screen, live edits painted in, then swapped in within one task: the original glyphs
      // under an edit never reach the screen, not even half-drawn. On failure the old canvas stays.
      const scratch = document.createElement('canvas');
      scratch.width = Math.ceil(vp.width);
      scratch.height = Math.ceil(vp.height);
      const ctx = scratch.getContext('2d')!;
      try {
        await pv.page.render({ canvas: scratch, canvasContext: ctx, viewport: vp }).promise;
      } catch (e) {
        console.warn('[aibs] page render failed', pv.index + 1, e);
        continue;
      }
      if (!pv.el.isConnected) continue;
      paintEdits(ctx, editsOn(pv), vp.scale);
      pv.canvas.width = scratch.width;
      pv.canvas.height = scratch.height;
      pv.canvas.getContext('2d')!.drawImage(scratch, 0, 0);
      pv.drawnScale = vp.scale;
      scratch.width = scratch.height = 0;
    }
  } finally {
    rendering = false;
  }
}

/**
 * Text layer for one page. Rendered into a detached element first (pdf.js
 * measures text on a canvas, not through layout), then every span gets a
 * fixed width matching its glyphs on the canvas. Masking turns covered text
 * into bullets, which are narrower than digits; without the fixed width a
 * covered span, and the sticker drawn over it, would shrink and leave part
 * of the canvas glyphs showing.
 */
async function renderTextLayer(pv: PageView): Promise<void> {
  const content = await pv.page.getTextContent();
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  const tl = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport: pv.view });
  await tl.render();
  const minFont = Number(layer.style.getPropertyValue('--min-font-size')) || 1;
  const items = content.items.filter((it): it is (typeof content.items)[number] & { str: string; width: number; height: number } => 'str' in it);
  tl.textDivs.forEach((div, i) => {
    const it = items[i];
    if (!it || !it.str) return;
    // For live edits: the font pdf.js loaded for this text (its FontFace family) and the baseline in page points.
    const { fontName, transform } = it as { fontName?: string; transform?: number[] };
    if (fontName) div.dataset.font = fontName;
    if (transform) div.dataset.baseline = pv.base.convertToViewportPoint(transform[4], transform[5])[1].toFixed(2);
    const scaleX = Number(div.style.getPropertyValue('--scale-x')) || 0;
    if (!(scaleX > 0)) return;
    const vertical = content.styles[(it as { fontName?: string }).fontName ?? '']?.vertical;
    const w = ((vertical ? it.height : it.width) * pv.view.scale * minFont) / scaleX;
    if (w > 0 && Number.isFinite(w)) div.style.width = `${w}px`;
  });
  pv.el.appendChild(layer);
}

function clearPages() {
  coverKey = '';
  editKeys = [];
  observer?.disconnect();
  observer = null;
  renderQueue.length = 0;
  pagesEl.replaceChildren();
  // Synchronously, before show()'s first await: the old pages' removal records then find no edits,
  // so neither the locked freeze nor the follow rule can latch onto the next document.
  engine?.dropEdits();
}

async function show(bytes: Uint8Array, name: string) {
  const seq = ++loadSeq;
  setState('loading');
  status('Opening…');
  // Stickers of the previous document stop applying before its pages go.
  scopePath = '/pdf';
  engine?.refresh();
  if (current) {
    void current.doc.destroy();
    current = null;
  }
  clearPages();

  const hash = await sha256Hex(bytes);
  // pdf.js transfers the buffer it is given to its worker: keep our own copy.
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
    enableXfa: false,
    isOffscreenCanvasSupported: true,
  }).promise;
  if (seq !== loadSeq) {
    void doc.destroy();
    return;
  }

  const pages: PageView[] = [];
  const first = await doc.getPage(1);
  const firstBase = first.getViewport({ scale: 1 });
  const avail = Math.max(320, (document.getElementById('viewer')?.clientWidth ?? innerWidth) - 48);
  const scale = Math.min(1.5, Math.max(0.5, avail / firstBase.width));
  fitScale = scale;
  zoom = 1;
  for (let i = 0; i < doc.numPages; i++) {
    const page = i === 0 ? first : await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const view = page.getViewport({ scale });
    const el = document.createElement('div');
    el.className = 'page';
    el.id = `page-${i + 1}`;
    el.dataset.pageNumber = String(i + 1);
    el.style.width = `${view.width}px`;
    el.style.height = `${view.height}px`;
    el.style.setProperty('--scale-factor', String(scale));
    el.style.setProperty('--total-scale-factor', String(scale));
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);
    pagesEl.appendChild(el);
    pages.push({ index: i, page, base, view, el, canvas, rendered: false, drawnScale: 0 });
  }

  // Canvases render lazily, nearest pages first.
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const pv = pages.find((p) => p.el === e.target);
        if (pv && !pv.rendered) renderQueue.push(pv);
      }
      void pumpRender();
    },
    { rootMargin: '800px 0px' },
  );
  pages.forEach((p) => observer!.observe(p.el));

  // Text layers for every page, one after another, before the document's
  // stickers are applied: the masker and the scanner need the text, and an
  // element sticker on page 9 must find its span.
  for (const pv of pages) {
    if (seq !== loadSeq) return;
    status(`Reading text… page ${pv.index + 1} of ${pages.length}`);
    await renderTextLayer(pv);
  }
  if (seq !== loadSeq) return;

  const key = docPath(hash);
  current = { doc, bytes, name, key, pages };
  scopePath = key;
  const src = parseSrc(location.search);
  history.replaceState(null, '', `${location.pathname}${src ? location.search : ''}#doc=${key.slice(5)}`);
  document.body.dataset.docKey = key.slice(5);
  titleEl.textContent = name;
  titleEl.title = name;
  document.title = `${name} - Sticker PDF viewer`;
  engine?.refresh();
  syncCover();
  setState('ready');
  status(`${pages.length} page${pages.length === 1 ? '' : 's'}`);
}

// ---- cover painted into the pages ----

/*
 * The sticker overlay is a fixed layer above the page, repositioned from
 * script after every scroll event. The pages scroll inside <main>, and Chrome
 * scrolls that box on the compositor thread: frames reach the screen before
 * the overlay has caught up, so for a frame or more while scrolling the
 * canvas glyphs under a sticker are visible next to it. (Masking the text
 * layer does nothing for this: it is transparent, the canvas draws the text.)
 *
 * So the cover is also painted INTO each page, as boxes positioned in
 * percentages of the page inside the scroll container. They move with the
 * page in the same composited frame, scroll and zoom included, and are only
 * rewritten when a sticker's place on its page changes. The overlay still
 * draws on top (edit chrome, labels, peeking).
 */
const COVER_TAG = 'pdf-cover';
let coverKey = '';

function syncCover() {
  const cur = current;
  if (!cur || !engine) return;
  const boxes: PageBox[] = cur.pages.map((p) => {
    const r = p.el.getBoundingClientRect();
    return { box: { x: r.left, y: r.top, w: r.width, h: r.height }, width: 100, height: 100 };
  });
  const pct = viewRectsToPageRects(engine.coverRects(), boxes);
  const color = engine.color;
  const key = color + '|' + pct.map((r) => [r.page, r.x, r.y, r.w, r.h].map((v) => v.toFixed(3)).join(',')).join(';');
  if (key === coverKey) return;
  coverKey = key;
  for (const pv of cur.pages) {
    const mine = pct.filter((r) => r.page === pv.index);
    let layer = pv.el.querySelector<HTMLElement>(':scope > ' + COVER_TAG);
    if (!mine.length) {
      layer?.replaceChildren();
      continue;
    }
    if (!layer) {
      layer = document.createElement(COVER_TAG);
      layer.setAttribute('aria-hidden', 'true');
      pv.el.appendChild(layer);
    }
    layer.style.setProperty('--cover', color);
    const pieces = mine.map((r) => {
      const b = document.createElement('b');
      // Edges pushed out by a hair, so anti-aliasing never leaves a glyph column.
      b.style.left = `calc(${r.x}% - 0.5px)`;
      b.style.top = `calc(${r.y}% - 0.5px)`;
      b.style.width = `calc(${r.w}% + 1px)`;
      b.style.height = `calc(${r.h}% + 1px)`;
      return b;
    });
    layer.replaceChildren(...pieces);
  }
}

// ---- live text edits painted into the pages ----

/*
 * The text layer is transparent: the canvas draws the words. A live edit
 * changes the span's text (what page readers see); here the original glyphs
 * under it are covered and the new words drawn, into the canvas pixels
 * themselves, so screenshots, getImageData and printing all show the edit.
 */
let editKeys: string[] = [];

/** Edits on one page, in PDF points, from the live edits the engine reports. */
function editsOn(pv: PageView, all = engine?.editedText() ?? []): PageEdit[] {
  const mine = all.filter(({ node }) => pv.el.contains(node));
  const layer = pv.el.querySelector<HTMLElement>('.textLayer');
  if (!mine.length || !layer) return [];
  // Spans are laid out in the text layer's box, which pdf.js rounds to whole pixels (the page box is not).
  const lr = layer.getBoundingClientRect();
  if (lr.width <= 0 || lr.height <= 0) return [];
  const toPt = (r: DOMRect): Rect => ({ x: ((r.left - lr.left) * pv.base.width) / lr.width, y: ((r.top - lr.top) * pv.base.height) / lr.height, w: (r.width * pv.base.width) / lr.width, h: (r.height * pv.base.height) / lr.height });
  const edited = new Set(mine.map(({ node }) => node.parentElement));
  // The page's other text: a cover stops short of it.
  const others = Array.from(layer.querySelectorAll<HTMLElement>('span'))
    .filter((s) => !s.firstElementChild && !edited.has(s) && /\S/.test(s.textContent ?? ''))
    .map((s) => toPt(s.getBoundingClientRect()));
  return mine.map(({ node, text }) => {
    const span = node.parentElement!;
    const b = toPt(span.getBoundingClientRect());
    // --font-height is in PDF points; the box of a span edited to nothing has no height.
    const h = parseFloat(span.style.getPropertyValue('--font-height')) || b.h;
    const fallback = span.style.fontFamily || 'sans-serif';
    const font = documentFont(pv, span.dataset.font);
    const baseline = parseFloat(span.dataset.baseline ?? '');
    return {
      page: pv.index,
      x: b.x,
      y: b.y,
      w: b.w,
      h,
      text,
      // The document's own font when pdf.js loaded it; characters its subset lacks fall back per glyph.
      family: font.loaded ? `"${span.dataset.font}", ${fallback}` : fallback,
      style: font.style,
      // pdf.js's scale fits the stand-in font to the real glyph widths; the real font needs none.
      scaleX: font.loaded ? 1 : Number(span.style.getPropertyValue('--scale-x')) || 1,
      baseline: Number.isFinite(baseline) ? baseline : undefined,
      pad: editPad({ ...b, h }, h, others),
    };
  });
}

/**
 * The PDF font behind a text-layer span: whether pdf.js registered it as a
 * loaded FontFace in this page (Type3 and failed fonts are drawn by pdf.js
 * itself and are not), and its weight and slant for the fallback glyphs.
 */
function documentFont(pv: PageView, id: string | undefined): { loaded: boolean; style: string } {
  if (!id) return { loaded: false, style: '' };
  let loaded = false;
  for (const f of document.fonts) if (f.status === 'loaded' && f.family.replace(/^["']|["']$/g, '') === id) loaded = true;
  const objs = pv.page.commonObjs;
  const info = objs.has(id) ? (objs.get(id) as { bold?: boolean; black?: boolean; italic?: boolean }) : null;
  const style = [info?.italic ? 'italic' : '', info?.bold || info?.black ? 'bold' : ''].filter(Boolean).join(' ');
  return { loaded, style };
}

/** Repaint pages whose edits changed: at once on the canvas shown, then a clean re-render drops anything an edit no longer covers. */
function syncEdits() {
  const cur = current;
  if (!cur || !engine) return;
  const all = engine.editedText();
  if (!all.length && !editKeys.some(Boolean)) return;
  // Runs on every reposition (each scroll frame): only pages with edits now or before are measured.
  const byPage = new Map<Element, typeof all>();
  for (const e of all) {
    const pg = e.node.parentElement?.closest('.page');
    if (pg) byPage.set(pg, [...(byPage.get(pg) ?? []), e]);
  }
  let changed = false;
  for (const pv of cur.pages) {
    const list = byPage.get(pv.el);
    if (!list && !editKeys[pv.index]) continue;
    const mine = list ? editsOn(pv, list) : [];
    const key = mine.map((e) => [e.x, e.y, e.w, e.h].map((v) => v.toFixed(1)).join(',') + '|' + e.text).join(';');
    if (key === (editKeys[pv.index] ?? '')) continue;
    editKeys[pv.index] = key;
    if (pv.drawnScale > 0) paintEdits(pv.canvas.getContext('2d')!, mine, pv.drawnScale);
    pv.rendered = false;
    changed = true;
  }
  if (changed) queueNearby();
}

/** Why a node in the viewer may not be edited: only document text in a sized, unrotated text-layer span. */
function viewerEditBlocked(n: Node): string | null {
  const cur = current;
  if (!cur) return 'The document is still loading';
  const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  if (!el || !pagesEl.contains(el)) return 'Only the document text can be edited';
  if (n.nodeType !== Node.TEXT_NODE) return null;
  const span = el.closest<HTMLElement>('.textLayer span');
  if (!span || !span.style.width) return 'This text cannot be edited here';
  // Rotation from the page model, never from a DOM attribute a script (or an edit) could rewrite.
  const pv = cur.pages.find((p) => p.el.contains(span));
  if (!pv || span.style.getPropertyValue('--rotate') || pv.view.rotation % 360) return 'Rotated text: cover it instead';
  return null;
}

/** Queue the not-yet-rendered pages near the viewport (pages already on screen get no new IntersectionObserver entry). */
function queueNearby() {
  const cur = current;
  if (!cur) return;
  const vr = viewerEl.getBoundingClientRect();
  for (const pv of cur.pages) {
    if (pv.rendered) continue;
    const r = pv.el.getBoundingClientRect();
    if (r.bottom > vr.top - 800 && r.top < vr.bottom + 800) renderQueue.push(pv);
  }
  void pumpRender();
}

// ---- zoom and page indicator ----

function updateZoomUi() {
  const ready = document.body.dataset.state === 'ready' && current !== null;
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  btnZoomOut.disabled = !ready || zoom <= ZOOMS[0];
  btnZoomIn.disabled = !ready || zoom >= ZOOMS[ZOOMS.length - 1];
}

/**
 * Resizes every page to `fitScale * next`. The text layer follows its CSS
 * scale variables; the fixed span widths set in renderTextLayer are scaled by
 * the same ratio, and canvases re-render (stretched meanwhile). Stickers are
 * re-measured afterwards, so they stay on their text.
 */
function setZoom(next: number) {
  const cur = current;
  if (!cur || next === zoom) return;
  const frac = viewerEl.scrollTop / Math.max(1, viewerEl.scrollHeight);
  zoom = next;
  const scale = fitScale * zoom;
  for (const pv of cur.pages) {
    const ratio = scale / pv.view.scale;
    pv.view = pv.page.getViewport({ scale });
    pv.el.style.width = `${pv.view.width}px`;
    pv.el.style.height = `${pv.view.height}px`;
    pv.el.style.setProperty('--scale-factor', String(scale));
    pv.el.style.setProperty('--total-scale-factor', String(scale));
    for (const span of pv.el.querySelectorAll<HTMLElement>('.textLayer span')) {
      const w = parseFloat(span.style.width);
      if (w > 0) span.style.width = `${w * ratio}px`;
    }
    pv.rendered = false;
  }
  viewerEl.scrollTop = frac * viewerEl.scrollHeight;
  queueNearby();
  engine?.refresh();
  updateZoomUi();
  updatePageIndicator();
}

function stepZoom(dir: 1 | -1) {
  const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 1e-6) : [...ZOOMS].reverse().find((z) => z < zoom - 1e-6);
  if (next !== undefined) setZoom(next);
}

let indicatorFrame = 0;
function updatePageIndicator() {
  const cur = current;
  if (!cur || document.body.dataset.state !== 'ready') {
    pageIndicator.textContent = '';
    return;
  }
  const vr = viewerEl.getBoundingClientRect();
  const probe = vr.top + vr.height * 0.35;
  let n = 1;
  for (const pv of cur.pages) {
    if (pv.el.getBoundingClientRect().top <= probe) n = pv.index + 1;
    else break;
  }
  pageIndicator.textContent = `Page ${n} of ${cur.pages.length}`;
}

viewerEl.addEventListener(
  'scroll',
  () => {
    if (indicatorFrame) return;
    indicatorFrame = requestAnimationFrame(() => {
      indicatorFrame = 0;
      updatePageIndicator();
    });
  },
  { passive: true },
);
btnZoomIn.onclick = () => stepZoom(1);
btnZoomOut.onclick = () => stepZoom(-1);

// ---- download ----

async function download() {
  const cur = current;
  if (!cur || !engine) return;
  const vector = chkVector.checked;
  if (vector && engine.locked) {
    status('Locked: vector mode keeps the text under the boxes, so only the flattened download is available.', true);
    return;
  }
  const { rects, lost } = engine.geometry();
  if (lost > 0 && !confirm(`${lost} sticker${lost === 1 ? ' is' : 's are'} not attached right now and will not be redacted. Download anyway?`)) return;
  const boxes: PageBox[] = cur.pages.map((p) => {
    const r = p.el.getBoundingClientRect();
    return { box: { x: r.left, y: r.top, w: r.width, h: r.height }, width: p.base.width, height: p.base.height };
  });
  const pageRects = viewRectsToPageRects(rects, boxes);
  const live = engine.editedText();
  const edits = cur.pages.flatMap((pv) => editsOn(pv, live));
  if (vector && edits.length) {
    status('Edited text: vector mode would keep the original words in the file under your edits. Untick "Keep text outside stickers" to download a flattened PDF, or revert the edits.', true);
    return;
  }
  btnDownload.disabled = true;
  try {
    status(vector ? 'Drawing boxes…' : 'Flattening pages…');
    const out = vector
      ? await buildVector(cur.doc, cur.bytes, pageRects)
      : await buildFlattened(cur.doc, pageRects, edits, (d, t) => status(`Flattening page ${d} of ${t}…`));
    saveBytes(out, redactedFileName(cur.name));
    status(
      vector
        ? `Saved with ${pageRects.length} box${pageRects.length === 1 ? '' : 'es'}. Not a redaction: the text under them is still in the file.`
        : `Saved ${cur.pages.length} flattened page${cur.pages.length === 1 ? '' : 's'} with ${pageRects.length} redaction${pageRects.length === 1 ? '' : 's'}.${edits.length ? ' Edited text is drawn into the pages.' : ''}`,
    );
  } catch (e) {
    status(`Could not build the PDF: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    btnDownload.disabled = current === null;
  }
}

// ---- sources ----

function explain(e: unknown, src: string) {
  setState('error');
  if (e instanceof SourceError) {
    const info = e.info;
    if (info.kind === 'permission') {
      status(`This extension needs access to ${info.origin} to open the PDF.`, true);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `Allow access to ${info.origin}`;
      b.onclick = async () => {
        let ok = false;
        try {
          ok = await chrome.permissions.request({ origins: [`${info.origin}/*`] });
        } catch {
          ok = false;
        }
        if (ok) void openSrc(src);
      };
      statusEl.append(' ', b);
      return;
    }
    if (info.kind === 'file-access') {
      status('To open files from this computer by link, turn on "Allow access to file URLs" for AI Blocker Stickers in chrome://extensions, or use Open file….', true);
      return;
    }
    if (info.kind === 'file-read') {
      status('Could not read this file from your computer. It may have been moved or deleted. Use Open file… to pick it.', true);
      return;
    }
    if (info.kind === 'status') {
      status(`The server answered ${info.status}.`, true);
      return;
    }
    status(`Could not download the PDF: ${info.message}`, true);
    return;
  }
  status(`Could not open the PDF: ${e instanceof Error ? e.message : String(e)}`, true);
}

async function openSrc(src: string) {
  setState('loading');
  status('Downloading…');
  try {
    const bytes = await loadPdfBytes(src);
    await show(bytes, fileNameFromUrl(src) ?? 'document.pdf');
  } catch (e) {
    explain(e, src);
  }
}

async function openFile(file: File) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A picked file has no URL to come back to: drop any ?src= from the address.
    history.replaceState(null, '', location.pathname);
    await show(bytes, file.name);
  } catch (e) {
    explain(e, '');
  }
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openFile(f);
  fileInput.value = '';
});
for (const t of ['dragenter', 'dragover'] as const) {
  window.addEventListener(t, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    drop.classList.add('over');
  });
}
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', (e) => {
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  void openFile(f);
});

btnPick.onclick = () => engine?.startPick();
btnRect.onclick = () => engine?.startRect();
btnEdit.onclick = () => engine?.startEditText();
btnDone.onclick = () => engine?.setEditing(false);
btnClear.onclick = () => {
  const n = engine?.stickerCount ?? 0;
  if (!engine || n === 0) return status('No stickers on this document.');
  if (!confirm(`Remove all ${n} sticker${n === 1 ? '' : 's'} on this document?`)) return;
  const r = engine.removeAll();
  status(r.ok ? `Removed ${r.removed} sticker${r.removed === 1 ? '' : 's'}.` : 'Locked: stickers stay on.', !r.ok);
};
btnDownload.onclick = () => void download();

async function main() {
  // pdf.html is web-accessible (the "always open PDFs here" redirect needs
  // that). Refuse to run framed, so no site can embed it.
  if (window.top !== window) {
    document.body.replaceChildren(document.createTextNode('The sticker PDF viewer cannot be embedded.'));
    return;
  }
  setState('empty');
  try {
    engine = await boot({ pagePath: () => scopePath, forceDom: true, editBlocked: viewerEditBlocked });
    engine?.onLayout(syncCover);
    engine?.onLayout(syncEdits);
  } catch (e) {
    console.error('[aibs] sticker engine failed to start', e);
  }
  const src = parseSrc(location.search);
  if (src) {
    titleEl.textContent = fileNameFromUrl(src) ?? 'Sticker PDF viewer';
    await openSrc(src);
  }
}

void main();
