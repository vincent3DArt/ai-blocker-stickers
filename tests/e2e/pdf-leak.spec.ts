/**
 * Every read channel of the PDF viewer with two rectangle stickers on a
 * resume (fixtures/resume.pdf, scripts/make-fixture-pdf.mjs): one over the
 * large bold name line, one over the "EDUCATION" heading. The covered words
 * must not come back through the DOM, the accessibility tree, the clipboard,
 * the downloaded PDF, a reload, zoom, resize, a rebuilt text layer, or the
 * pixels on screen while <main> scrolls.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, expect, boxOf, decodePng, pixelAt, ORIGIN, type Ext } from './fixtures';

const NAME = 'JANE Q. EXAMPLE';
const HEADING = 'EDUCATION';
/** Words that only occur under the stickers (case-sensitive: the email has "jane.example"). */
const COVERED = ['JANE', 'EXAMPLE', 'EDUCATION'];
/** Text outside the stickers, which must stay readable. */
const KEPT = 'EXPERIENCE';

function viewerUrl(ext: Ext): string {
  const id = new URL(ext.worker.url()).host;
  return `chrome-extension://${id}/pdf.html?src=${encodeURIComponent(`${ORIGIN}/resume.pdf`)}`;
}

async function waitReady(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
}

function leaks(s: string): string[] {
  return COVERED.filter((w) => s.includes(w));
}

/** Index of the text-layer span on page 1 holding `needle` (before masking). */
async function spanIndex(page: Page, needle: string): Promise<number> {
  const i = await page.evaluate((n) => Array.from(document.querySelectorAll('#page-1 .textLayer span')).findIndex((s) => s.textContent === n), needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
}

async function spanBox(page: Page, i: number) {
  return page.evaluate((i) => {
    const r = document.querySelectorAll('#page-1 .textLayer span')[i].getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, i);
}

/** Every DOM text channel of the viewer page. */
async function domChannels(page: Page) {
  return page.evaluate(() => ({
    innerText: document.body.innerText,
    textContent: document.body.textContent ?? '',
    spans: Array.from(document.querySelectorAll('.textLayer span'), (s) => s.textContent).join('\n'),
    outerHTML: document.documentElement.outerHTML,
  }));
}

async function expectDomMasked(page: Page) {
  const d = await domChannels(page);
  for (const [k, v] of Object.entries(d)) expect(leaks(v), k).toEqual([]);
  expect(d.innerText).toContain(KEPT);
}

/** Sticker-dark: the default sticker colour is #1f2937, glyphs are black, paper is white. */
const DARK = 90;

/** Max channel over a grid of viewport points inside `r` (inset by 2px), from one screenshot. */
async function maxChannelIn(page: Page, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) pts.push([r.x + 2 + ((r.w - 4) * (i + 0.5)) / 7, r.y + 2 + ((r.h - 4) * (j + 0.5)) / 3]);
  let max = 0;
  for (const [x, y] of pts) max = Math.max(max, ...(await pixelAt(page, x, y)));
  return max;
}

/** Text of every page of a PDF, extracted with pdf.js in Node. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
  const text: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    text.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await doc.destroy();
  return text.join('\n');
}

interface PtRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Overlay pieces in PDF points from page 1's top-left corner. */
async function piecesInPoints(page: Page, ext: Ext): Promise<PtRect[]> {
  const p1 = await boxOf(page, '#page-1');
  const s = 612 / p1.w;
  return (await ext.state(page)).pieces.map((p) => ({ x: (p.x - p1.x) * s, y: (p.y - p1.y) * s, w: p.w * s, h: p.h * s }));
}

/**
 * Rasterise page 1 of `file` with pdf.js (it is opened in the viewer, where
 * it has no stickers: a different file) and return the max channel over a
 * grid inside each rectangle, plus the brightest pixel of a control point.
 */
async function rasterMax(page: Page, ext: Ext, file: string, rects: PtRect[]): Promise<{ inside: number[]; control: number; ink: number }> {
  const before = await page.locator('body').getAttribute('data-doc-key');
  await page.setInputFiles('#file', file);
  await expect(page.locator('body')).not.toHaveAttribute('data-doc-key', before!, { timeout: 20_000 });
  await waitReady(page);
  expect((await ext.state(page)).stickers).toHaveLength(0);
  // The canvas renders asynchronously (paper first, then the page image): wait for kept text to show.
  await expect.poll(async () => (await page.evaluate(sampleCanvas, rects)).ink, { timeout: 10_000 }).toBeLessThan(100);
  return page.evaluate(sampleCanvas, rects);
}

/** Max channel over a grid inside each rect (PDF points) of page 1's canvas, and of a blank-paper control point. */
function sampleCanvas(rects: PtRect[]): { inside: number[]; control: number; ink: number } {
  const c = document.querySelector<HTMLCanvasElement>('#page-1 canvas')!;
  const k = c.width / 612;
  const ctx = c.getContext('2d')!;
  const px = (x: number, y: number) => Math.max(...Array.from(ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)));
  const inside = rects.map((r) => {
    let m = 0;
    for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) m = Math.max(m, px(r.x + 1 + ((r.w - 2) * (i + 0.5)) / 9, r.y + 1 + ((r.h - 2) * (j + 0.5)) / 3));
    return m;
  });
  // The EXPERIENCE heading (kept text, so drawn once the page image is in) and blank paper right of it.
  let ink = 255;
  for (let x = 72; x < 160; x += 1) ink = Math.min(ink, px(x, 207));
  return { inside, control: px(400, 205), ink };
}

/** Open the resume, draw the two rectangles like a user would (a few px around the text). */
async function setup(page: Page, ext: Ext) {
  await page.goto(viewerUrl(ext));
  await waitReady(page);
  await expect(page.locator('#page-1 .textLayer')).toContainText(NAME);
  const iName = await spanIndex(page, NAME);
  const iHead = await spanIndex(page, HEADING);
  const originals = await page.evaluate(() => Array.from(document.querySelectorAll('#page-1 .textLayer span'), (s) => s.textContent ?? ''));
  for (const i of [iName, iHead]) {
    const b = await spanBox(page, i);
    const r = await ext.rect(page, { x: b.x - 4, y: b.y - 3, w: b.w + 8, h: b.h + 6 });
    expect(r.id).toBeTruthy();
  }
  await expect.poll(async () => (await ext.state(page)).stickers.filter((s) => s.status === 'resolved').length).toBe(2);
  return { iName, iHead, originals };
}

test.describe('PDF viewer: nothing under a rectangle sticker leaks', () => {
  test('DOM, accessibility tree and clipboard (channels 1-3)', async ({ page, ext }) => {
    await setup(page, ext);
    await expectDomMasked(page);

    // 2: accessibility tree, through Playwright and through CDP.
    const aria = await page.locator('body').ariaSnapshot();
    expect(leaks(aria)).toEqual([]);
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: unknown[] };
    expect(leaks(JSON.stringify(nodes))).toEqual([]);
    await cdp.detach();

    // 3: select all + copy.
    await page.locator('#page-1 .textLayer span').nth(5).click();
    await page.keyboard.press('Control+A');
    const sel = await page.evaluate(() => getSelection()?.toString() ?? '');
    expect(sel).toContain(KEPT);
    expect(leaks(sel)).toEqual([]);
    const copied = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener(
            'copy',
            () => {
              // What the browser puts on the clipboard for a plain-text copy is the selection's text.
              setTimeout(() => resolve(getSelection()?.toString() ?? ''), 0);
            },
            { once: true },
          );
          document.execCommand('copy');
        }),
    );
    expect(leaks(copied)).toEqual([]);
    await page.keyboard.press('Control+C');
    try {
      await ext.context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(leaks(clip)).toEqual([]);
    } catch (e) {
      // Some channels refuse clipboard permissions for extension origins; the copy-event check above stands.
      if (e instanceof Error && /expect/i.test(e.message)) throw e;
    }
  });

  test('downloaded PDFs: flattened is a redaction, vector boxes are in place (channel 4)', async ({ page, ext }, info) => {
    test.setTimeout(120_000);
    await setup(page, ext);
    const rects = await piecesInPoints(page, ext);
    expect(rects).toHaveLength(2);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const flat = info.outputPath('resume-redacted.pdf');
    await dl.saveAs(flat);
    const flatText = await pdfText(new Uint8Array(await readFile(flat)));
    expect(leaks(flatText)).toEqual([]);
    // No hidden text layer at all.
    expect(flatText.trim()).toBe('');

    await page.check('#vector');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const vec = info.outputPath('resume-vector.pdf');
    await dl2.saveAs(vec);
    // Vector mode keeps the text (it says so); only the boxes are checked.
    expect(await pdfText(new Uint8Array(await readFile(vec)))).toContain(NAME);

    const f = await rasterMax(page, ext, flat, rects);
    expect(f.control).toBeGreaterThan(240);
    expect(f.inside.every((m) => m < DARK), `flattened ${f.inside}`).toBe(true);
    const v = await rasterMax(page, ext, vec, rects);
    expect(v.control).toBeGreaterThan(240);
    expect(v.inside.every((m) => m < DARK), `vector ${v.inside}`).toBe(true);
  });

  test('reload, zoom, resize and a rebuilt text layer re-mask the DOM (channels 5-7)', async ({ page, ext }) => {
    test.setTimeout(120_000);
    const { iName, iHead, originals } = await setup(page, ext);

    // 5: reload. The DOM is masked within 1.5 s of the text layer appearing.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#page-1 .textLayer span').length > 0, null, { timeout: 20_000 });
    const t0 = Date.now();
    await expect.poll(async () => leaks((await domChannels(page)).textContent), { timeout: 1500, intervals: [25] }).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
    await waitReady(page);
    await expect.poll(async () => (await ext.state(page)).stickers.filter((s) => s.status === 'resolved').length).toBe(2);
    await expectDomMasked(page);

    const covers = async () => {
      const pieces = (await ext.state(page)).pieces;
      const out: number[] = [];
      for (const i of [iName, iHead]) {
        const b = await spanBox(page, i);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        out.push(pieces.some((p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h && p.x <= b.x + 1 && p.x + p.w >= b.x + b.w - 1) ? 1 : 0);
      }
      return out;
    };

    // 6: zoom with the viewer's buttons, then a window resize.
    for (const btn of ['#zoom-in', '#zoom-in', '#zoom-out', '#zoom-out', '#zoom-out']) {
      await page.click(btn);
      await page.evaluate(() => document.getElementById('viewer')!.scrollTo(0, 0));
      await expect.poll(covers, { timeout: 5000 }).toEqual([1, 1]);
      await expectDomMasked(page);
    }
    await page.setViewportSize({ width: 760, height: 620 });
    await expect.poll(covers, { timeout: 5000 }).toEqual([1, 1]);
    await expectDomMasked(page);
    await page.setViewportSize({ width: 1000, height: 700 });

    // 7: the text layer is rebuilt from scratch (as pdf.js does when it
    // re-renders): a fresh layer with the raw strings replaces the masked one.
    await page.evaluate((originals) => {
      const old = document.querySelector('#page-1 .textLayer')!;
      const fresh = old.cloneNode(true) as HTMLElement;
      fresh.querySelectorAll('span').forEach((s, i) => (s.textContent = originals[i] ?? s.textContent));
      old.replaceWith(fresh);
    }, originals);
    await expect.poll(async () => leaks((await domChannels(page)).textContent), { timeout: 1500, intervals: [25] }).toEqual([]);
    await expect.poll(covers, { timeout: 5000 }).toEqual([1, 1]);
    await expectDomMasked(page);
  });

  test('rectangles that stay rectangles (tight band, loose box) mask the pdf.js spans too', async ({ page, ext }) => {
    await page.goto(viewerUrl(ext));
    await waitReady(page);
    const a = await spanBox(page, await spanIndex(page, NAME));
    const b = await spanBox(page, await spanIndex(page, HEADING));
    // A band over the capitals of the 26pt name only, and a loose box around the heading.
    await ext.rect(page, { x: a.x + 2, y: a.y + a.h * 0.2, w: a.w - 4, h: a.h * 0.6 });
    await ext.rect(page, { x: b.x - 20, y: b.y - 10, w: b.w + 60, h: b.h + 20 });
    const st = await ext.state(page);
    expect(st.stickers.map((s) => [s.kind, s.status])).toEqual([
      ['rect', 'resolved'],
      ['rect', 'resolved'],
    ]);
    await expectDomMasked(page);
  });

  test('scrolling <main>: the pixels under each sticker stay covered at every step', async ({ page, ext }) => {
    test.setTimeout(120_000);
    const { iName, iHead } = await setup(page, ext);
    const viewer = await boxOf(page, '#viewer');
    await page.mouse.move(viewer.x + viewer.w / 2, viewer.y + viewer.h / 2);

    /** The on-screen part of each target span (inside the scroll box). */
    const targets = async () => {
      const vr = await boxOf(page, '#viewer');
      const out: Array<{ i: number; x: number; y: number; w: number; h: number }> = [];
      for (const i of [iName, iHead]) {
        const b = await spanBox(page, i);
        const top = Math.max(b.y, vr.y + 2);
        const bottom = Math.min(b.y + b.h, vr.y + vr.h - 2);
        if (bottom - top >= 6) out.push({ i, x: b.x, y: top, w: b.w, h: bottom - top });
      }
      return out;
    };
    const check = async (label: string, shot: Buffer) => {
      // The frame captured right after the wheel event, before anything else ran in the test.
      const img = decodePng(shot);
      for (const t of await targets()) {
        let max = 0;
        for (let a = 0; a < 9; a++)
          for (let b = 0; b < 3; b++) max = Math.max(max, ...img.at(t.x + 2 + ((t.w - 4) * (a + 0.5)) / 9, t.y + 2 + ((t.h - 4) * (b + 0.5)) / 3));
        expect(max, `${label}: span ${t.i} in the immediate screenshot`).toBeLessThan(DARK);
        expect(await maxChannelIn(page, t), `${label}: span ${t.i}`).toBeLessThan(DARK);
      }
      expect(leaks(await page.evaluate(() => document.body.innerText)), label).toEqual([]);
    };

    await check('before', await page.screenshot({ animations: 'disabled' }));
    let moved = 0;
    for (const dir of [1, -1]) {
      for (let step = 0; step < 10; step++) {
        const top0 = await page.evaluate(() => document.getElementById('viewer')!.scrollTop);
        await page.mouse.wheel(0, 40 * dir);
        // Immediately, without waiting for anything: the frame on screen right now.
        const shot = await page.screenshot({ animations: 'disabled' });
        await check(`${dir > 0 ? 'down' : 'up'} ${step + 1}`, shot);
        if ((await page.evaluate(() => document.getElementById('viewer')!.scrollTop)) !== top0) moved++;
      }
    }
    // The wheel really scrolled <main> (not the document).
    expect(moved).toBeGreaterThanOrEqual(15);

    // The overlay is repositioned from script after scroll events, while
    // Chrome scrolls <main> on the compositor thread: on a real screen it
    // trails the page by a frame or more. Freeze it outright (no frames, no
    // slow tick: the viewer's own script world is the engine's) to stand for
    // that lag. Whatever covers the text must move with the page itself.
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0;
      const last = window.setInterval(() => {}, 1e6);
      for (let i = 1; i <= last; i++) clearInterval(i);
    });
    for (let step = 0; step < 6; step++) {
      await page.mouse.wheel(0, 40);
      await expect.poll(() => page.evaluate(() => document.getElementById('viewer')!.scrollTop)).toBeGreaterThan(step * 40);
      const shot = await page.screenshot({ animations: 'disabled' });
      await check(`overlay frozen, down ${step + 1}`, shot);
    }
  });
});
