/**
 * The extension's PDF viewer: pdf.js pages with a text layer, the sticker
 * engine running in the viewer page, the redacted download, and stickers
 * scoped per document (by a hash of its bytes).
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, expect, boxOf, coverage, ORIGIN, type Ext } from './fixtures';

const SSN = '123-45-6789';

function viewerUrl(ext: Ext, file: string): string {
  const id = new URL(ext.worker.url()).host;
  return `chrome-extension://${id}/pdf.html?src=${encodeURIComponent(`${ORIGIN}/${file}`)}`;
}

async function openViewer(page: Page, ext: Ext, file: string) {
  await page.goto(viewerUrl(ext, file));
  await waitReady(page);
}

async function waitReady(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
}

/** CSS selector of the text-layer span holding the SSN. */
async function ssnSelector(page: Page): Promise<string> {
  const i = await page.evaluate((needle) => {
    const kids = Array.from(document.querySelectorAll('#page-1 .textLayer > *'));
    return kids.findIndex((k) => k.textContent?.includes(needle));
  }, SSN);
  expect(i).toBeGreaterThanOrEqual(0);
  return `#page-1 > .textLayer > :nth-child(${i + 1})`;
}

/** Text of every page of a PDF, extracted with pdf.js in Node. */
async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string[] }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
  const text: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    text.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { pages, text };
}

/** RGB of the rendered canvas of `page` at a point given in PDF points from the top-left. */
async function canvasPixel(page: Page, pageNo: number, xPt: number, yPt: number): Promise<number[]> {
  return page.evaluate(
    ({ pageNo, xPt, yPt }) => {
      const el = document.getElementById(`page-${pageNo}`)!;
      const c = el.querySelector('canvas')!;
      const sx = c.width / 612;
      const sy = c.height / 792;
      const d = c.getContext('2d')!.getImageData(Math.round(xPt * sx), Math.round(yPt * sy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { pageNo, xPt, yPt },
  );
}

test.describe('PDF viewer', () => {
  test('cover text and a region, download a flattened redacted PDF, stickers follow the document', async ({ page, ext }, info) => {
    test.setTimeout(120_000);
    await openViewer(page, ext, 'sample.pdf');
    await expect(page.locator('#page-1 .textLayer')).toContainText(SSN);
    await expect(page.locator('#page-2 .textLayer')).toContainText('engagement letter');

    // Element sticker on the SSN span of the text layer.
    await ext.cover(page, await ssnSelector(page));
    // Rectangle sticker over page 2's paragraph (canvas + text layer).
    await page.evaluate(() => document.getElementById('page-2')!.scrollIntoView({ block: 'start' }));
    const p2 = await boxOf(page, '#page-2');
    const s = p2.w / 612;
    const r = await ext.rect(page, { x: p2.x + 60 * s, y: p2.y + 125 * s, w: 420 * s, h: 90 * s });
    expect(r.kind).toBe('rect');

    const st = await ext.state(page);
    expect(st.stickers).toHaveLength(2);
    expect(st.stickers.every((x) => x.status === 'resolved')).toBe(true);
    // Scoped to this document, never the viewer's own path.
    expect(st.stickers[0].pathPattern).toMatch(/^\/pdf\/[g-v]{16}$/);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(SSN);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('engagement letter');

    // Download: flattened by default.
    await expect(page.locator('#vector')).not.toBeChecked();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(dl.suggestedFilename()).toBe('sample-redacted.pdf');
    const path = info.outputPath('sample-redacted.pdf');
    await dl.saveAs(path);
    const bytes = new Uint8Array(await readFile(path));
    const out = await pdfText(bytes);
    expect(out.pages).toBe(2);
    expect(out.text[0]).not.toContain(SSN);
    expect(out.text.join(' ')).not.toContain('engagement');
    // Flattened: no text layer at all.
    expect(out.text.join('').trim()).toBe('');

    // Same file after a reload: both stickers come back.
    await page.reload();
    await waitReady(page);
    await expect.poll(async () => (await ext.state(page)).stickers.filter((x) => x.status === 'resolved').length, { timeout: 10_000 }).toBe(2);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(SSN);

    // A different PDF in the same viewer: none of them.
    await openViewer(page, ext, 'other.pdf');
    await expect(page.locator('#page-1 .textLayer')).toContainText('A different document');
    expect((await ext.state(page)).stickers).toHaveLength(0);

    // The redacted file itself, opened in the viewer: the SSN's place on
    // page 1 is solid black in the pixels, the rest of the page is not.
    const otherKey = await page.locator('body').getAttribute('data-doc-key');
    await page.setInputFiles('#file', path);
    await expect(page.locator('body')).not.toHaveAttribute('data-doc-key', otherKey!, { timeout: 20_000 });
    await waitReady(page);
    await expect(page.locator('#title')).toHaveText('sample-redacted.pdf');
    expect((await ext.state(page)).stickers).toHaveLength(0);
    // "SSN 123-45-6789" is drawn at x=72pt, baseline 620pt from the bottom (14pt type).
    await expect
      .poll(async () => {
        // Start, middle and the last digit of the string (Helvetica 14pt: it ends near x=179pt).
        const px = await Promise.all([74, 150, 176].map((x) => canvasPixel(page, 1, x, 792 - 620 - 4)));
        return Math.max(...px.flat());
      }, { timeout: 10_000 })
      .toBeLessThan(40);
    const white = await canvasPixel(page, 1, 400, 400);
    expect(Math.min(...white)).toBeGreaterThan(200);
    expect(await page.locator('.textLayer').first().innerText()).not.toContain(SSN);
  });

  test('vector mode keeps the text: labelled as not a redaction', async ({ page, ext }) => {
    await openViewer(page, ext, 'sample.pdf');
    await ext.cover(page, await ssnSelector(page));
    await expect(page.locator('label.vector')).toContainText('not a true redaction');
    await page.check('#vector');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const out = await pdfText(new Uint8Array(await readFile(await dl.path())));
    expect(out.pages).toBe(2);
    // The box is drawn, but the text under it is still extractable.
    expect(out.text[0]).toContain(SSN);
    await expect(page.locator('#status')).toContainText('Not a redaction');

    // Remove stickers clears this document's stickers.
    page.once('dialog', (d) => void d.accept());
    await page.click('#clear');
    await expect.poll(async () => (await ext.state(page)).stickers.length).toBe(0);
    expect(await page.locator('#page-1 .textLayer').innerText()).toContain(SSN);
  });

  test('zoom: stickers stay on their text and region', async ({ page, ext }) => {
    await openViewer(page, ext, 'sample.pdf');
    const sel = await ssnSelector(page);
    await ext.cover(page, sel);
    const p1 = await boxOf(page, '#page-1');
    const s = p1.w / 612;
    await ext.rect(page, { x: p1.x + 300 * s, y: p1.y + 60 * s, w: 200 * s, h: 40 * s });
    const before = (await ext.state(page)).pieces;
    await expect(page.locator('#zoom-level')).toHaveText('100%');
    await page.click('#zoom-in');
    await page.click('#zoom-in');
    await expect(page.locator('#zoom-level')).toHaveText('125%');
    await page.evaluate(() => document.getElementById('viewer')!.scrollTo(0, 0));
    await expect
      .poll(async () => coverage(await boxOf(page, sel), (await ext.state(page)).pieces), { timeout: 5000 })
      .toBeGreaterThanOrEqual(0.98);
    const p1z = await boxOf(page, '#page-1');
    expect(p1z.w / p1.w).toBeCloseTo(1.25, 2);
    const wide = (ps: { w: number }[]) => Math.max(...ps.map((p) => p.w));
    await expect.poll(async () => wide((await ext.state(page)).pieces) / wide(before), { timeout: 5000 }).toBeGreaterThan(1.2);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(SSN);
    await page.click('#zoom-out');
    await expect(page.locator('#zoom-level')).toHaveText('110%');
  });

  test('auto-suggest scans the text layer', async ({ page, ext }) => {
    await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoScan'));
    await openViewer(page, ext, 'sample.pdf');
    await expect
      .poll(async () => (await ext.state(page)).scan?.suggestions.map((x) => x.pattern) ?? [], { timeout: 10_000 })
      .toContain('ssn');
  });

  test('popup offers the viewer on a PDF tab; no PDF stickers leak into storage', async ({ page, ext }) => {
    // Headless browsers download a PDF instead of showing it, so the popup
    // is shown a real tab that claims the PDF's URL.
    await page.goto('/static.html');
    const tab = await ext.worker.evaluate(async (origin) => {
      const [t] = await chrome.tabs.query({ url: origin + '/static.html' });
      return { id: t.id, url: origin + '/sample.pdf', index: t.index };
    }, ORIGIN);
    const id = new URL(ext.worker.url()).host;
    const popup = await ext.context.newPage();
    await popup.addInitScript((t) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      c.tabs.query = (async () => [t]) as unknown as typeof c.tabs.query;
    }, tab);
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#open-pdf-viewer')).toBeVisible();
    await expect(popup.locator('#pdf-redirect')).toHaveCount(1);
    await popup.close();

    // What the viewer stores for a document: geometry and the scope key only.
    const viewer = await ext.context.newPage();
    await openViewer(viewer, ext, 'sample.pdf');
    await ext.cover(viewer, await ssnSelector(viewer));
    const stored = await ext.worker.evaluate(async (key) => JSON.stringify((await chrome.storage.local.get(key))[key] ?? null), `site:chrome-extension://${id}`);
    expect(stored).toContain('/pdf/');
    expect(stored).not.toContain(SSN);
    expect(stored).not.toContain('sample');
    expect(stored).not.toContain('127.0.0.1');
    await viewer.close();
  });
});
