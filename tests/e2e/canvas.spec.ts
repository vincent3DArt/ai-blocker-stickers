/**
 * Canvas-drawn pages (Google Docs, Figma, PDF viewers): the visible text is
 * pixels, not DOM text. The scanner and the element picker have nothing to
 * work on; a rectangle sticker's pixel overlay is what still protects.
 */
import type { Page } from '@playwright/test';
import { test, expect, pixelAt, type Ext, type TestState } from './fixtures';

const STICKER: [number, number, number] = [0x1f, 0x29, 0x37];
const near = (a: [number, number, number], b: [number, number, number], tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

type CanvasState = TestState & {
  rendering?: string;
  maskRetry?: boolean;
  anchors?: { id: string; kind: string; tag?: string }[];
  state: TestState['state'] & { rendering?: string };
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ssnBox = (page: Page) => page.evaluate(() => (window as unknown as { ssnBox: Box }).ssnBox);

/** Collect page errors and console errors (from every world, ours included). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function canvasState(ext: Ext, page: Page): Promise<CanvasState> {
  return (await ext.state(page)) as CanvasState;
}

async function waitCanvas(ext: Ext, page: Page) {
  await expect.poll(async () => (await canvasState(ext, page)).rendering, { timeout: 8000 }).toBe('canvas');
}

/** Every sampled point of the drawn SSN shows the sticker, not black text on white. */
async function expectSsnCovered(page: Page) {
  const b = await ssnBox(page);
  // Keep away from the top-right corner, where a low-confidence piece carries its marker.
  for (const fx of [0.1, 0.3, 0.5, 0.7, 0.85]) {
    for (const fy of [0.3, 0.6, 0.9]) {
      const px = await pixelAt(page, b.x + b.w * fx, b.y + b.h * fy);
      expect(near(px, STICKER), `pixel at ${fx},${fy} is ${px}`).toBe(true);
    }
  }
}

async function controlPage(ext: Ext): Promise<Page> {
  const id = new URL(ext.worker.url()).host;
  const p = await ext.context.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  return p;
}

test.describe('canvas pages', () => {
  test('detected as canvas; rect sticker covers the drawn SSN across reload and resize; nothing masked, no errors', async ({ page, ext }) => {
    await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoScan'));
    const errors = watchErrors(page);
    await page.goto('/canvas.html');
    await waitCanvas(ext, page);
    const before = await page.evaluate(() => document.body.innerText);

    // Visible text really is not in the DOM, and the scanner finds nothing.
    expect(before).not.toContain('123-45-6789');
    await expect.poll(async () => (await canvasState(ext, page)).scan?.stats?.finishedAt ?? 0, { timeout: 8000 }).toBeGreaterThan(0);
    let st = await canvasState(ext, page);
    expect(st.scan?.suggestions).toHaveLength(0);
    expect(st.state.rendering).toBe('canvas');
    // What the popup reads.
    const popupView = await ext.send<{ state: { rendering?: string } }>(page, { type: 'GET_STICKERS' });
    expect(popupView.state.rendering).toBe('canvas');
    const sugg = await ext.send<{ suggestions: unknown[] }>(page, { type: 'GET_SUGGESTIONS' });
    expect(sugg.suggestions).toHaveLength(0);

    // Draw a rectangle over the drawn SSN.
    const b = await ssnBox(page);
    const r = await ext.rect(page, { x: b.x - 10, y: b.y - 8, w: b.w + 20, h: b.h + 16 });
    expect(r.kind).toBe('rect');
    st = await canvasState(ext, page);
    expect(st.anchors?.find((a) => a.id === r.id)?.tag).toBe('canvas');
    await expectSsnCovered(page);
    // Nothing to mask in the DOM, and the masking retry does not spin.
    expect(await page.evaluate(() => document.body.innerText)).toBe(before);
    await page.waitForTimeout(800);
    expect((await canvasState(ext, page)).maskRetry).toBe(false);

    // Reload: the sticker comes back over the same pixels.
    await page.reload();
    await expect.poll(async () => (await canvasState(ext, page)).stickers.map((s) => s.status), { timeout: 8000 }).toEqual(['resolved']);
    await waitCanvas(ext, page);
    await page.waitForTimeout(200);
    await expectSsnCovered(page);
    expect(await page.evaluate(() => document.body.innerText)).toBe(before);

    // Resize: the canvas re-lays out (and the page redraws), the sticker follows.
    await page.setViewportSize({ width: 600, height: 500 });
    await page.waitForTimeout(400);
    await expectSsnCovered(page);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForTimeout(400);
    await expectSsnCovered(page);

    st = await canvasState(ext, page);
    expect(st.maskRetry).toBe(false);
    expect(st.scan?.suggestions).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test('a DOM page reads dom', async ({ page, ext }) => {
    await page.goto('/static.html');
    await expect.poll(async () => (await canvasState(ext, page)).rendering, { timeout: 8000 }).toBe('dom');
    // Measured, not just the default: the flag is in the tab state too.
    expect((await canvasState(ext, page)).state.rendering).toBe('dom');
  });

  test('popup: canvas note, Cover element and the site switch disabled, Draw rectangle primary', async ({ page, ext }) => {
    await page.goto('/canvas.html');
    await waitCanvas(ext, page);
    const tab = await ext.worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/canvas.html' });
      return { id: tabs[0].id, url: tabs[0].url };
    });
    const id = new URL(ext.worker.url()).host;
    const popup = await ext.context.newPage();
    // The popup asks for the active tab, which here would be the popup itself.
    await popup.addInitScript((t) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      c.tabs.query = (async () => [t]) as unknown as typeof c.tabs.query;
    }, tab);
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#canvas-note')).toContainText('draws its content on a canvas');
    await expect(popup.locator('#cover-element')).toBeDisabled();
    await expect(popup.locator('#suggest-site')).toBeDisabled();
    await expect(popup.locator('#draw-rect')).toBeEnabled();
    await expect(popup.locator('#draw-rect')).toHaveClass(/primary/);
    await expect(popup.getByText('No suggestions on this page')).toHaveCount(0);
    await popup.close();
  });

  test('locked on a canvas page: one canvas-page audit entry, origin only', async ({ page, ext }) => {
    await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoScan'));
    const ctl = await controlPage(ext);
    expect(await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_SESSION', active: true }))).toMatchObject({ ok: true });
    await page.goto('/canvas.html?doc=abc');
    await waitCanvas(ext, page);
    const st = await canvasState(ext, page);
    expect(st.state.locked).toBe(true);
    expect(st.stickers).toHaveLength(0);
    const entries = async () =>
      ext.worker.evaluate(async () => ((await chrome.storage.local.get('audit')).audit ?? []) as { action: string; origin?: string; reason?: string }[]);
    await expect.poll(async () => (await entries()).filter((e) => e.action === 'canvas-page').length).toBe(1);
    const e = (await entries()).find((x) => x.action === 'canvas-page')!;
    expect(e.origin).toBe('http://127.0.0.1:4173');
    expect(JSON.stringify(e)).not.toContain('canvas.html');
    expect(JSON.stringify(e)).not.toContain('abc');
    // The lock badge still applies.
    const badge = await ext.worker.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/canvas.html*' });
      return chrome.action.getBadgeText({ tabId: t.id });
    });
    expect(badge).toBe('\u{1F512}');
    // A reload in the same session does not log again.
    await page.reload();
    await waitCanvas(ext, page);
    await page.waitForTimeout(300);
    expect((await entries()).filter((x) => x.action === 'canvas-page')).toHaveLength(1);
    await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_SESSION', active: false }));
    await ctl.close();
  });
});
