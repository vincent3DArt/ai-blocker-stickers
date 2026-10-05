/**
 * README screenshots. Skipped unless AIBS_SCREENSHOTS=1:
 *   AIBS_SCREENSHOTS=1 playwright test screenshots
 * Writes docs/screenshots/*.png from the development build.
 */
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { test, expect, boxOf, ORIGIN, type Ext } from './fixtures';

const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));

test.skip(!process.env.AIBS_SCREENSHOTS, 'set AIBS_SCREENSHOTS=1 to regenerate the README screenshots');

const extId = (ext: Ext) => new URL(ext.worker.url()).host;

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}${name}.png`, clip, animations: 'disabled' });
}

test.describe('screenshots', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`popup (${scheme})`, async ({ ext }) => {
      const p = await ext.context.newPage();
      await p.emulateMedia({ colorScheme: scheme });
      await p.setViewportSize({ width: 340, height: 900 });
      await p.goto(`chrome-extension://${extId(ext)}/popup.html?demo=1`);
      await expect(p.locator('#cover-element')).toBeVisible();
      const h = await p.evaluate(() => { const a = document.getElementById('app')!; a.style.maxHeight = 'none'; return a.scrollHeight; });
      await p.setViewportSize({ width: 340, height: Math.min(900, h) });
      await shot(p, `popup-${scheme}`);
      if (scheme === 'light') {
        await p.goto(`chrome-extension://${extId(ext)}/popup.html?demo=locked`);
        await expect(p.getByRole('button', { name: 'End session' })).toBeVisible();
        const h2 = await p.evaluate(() => { const a = document.getElementById('app')!; a.style.maxHeight = 'none'; return a.scrollHeight; });
        await p.setViewportSize({ width: 340, height: Math.min(900, h2) });
        await shot(p, 'popup-locked');
      }
      await p.close();
    });
  }

  test('overlay: edit mode with the picker highlight', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#hdr-account');
    await ext.send(page, { type: 'SET_EDIT_MODE', enabled: true });
    await ext.send(page, { type: 'START_PICK' });
    const b = await boxOf(page, '#identity');
    await page.mouse.move(b.x + 20, b.y + b.h / 2);
    await page.mouse.move(b.x + 30, b.y + b.h / 2 + 2);
    await page.waitForTimeout(300);
    await shot(page, 'overlay-picker', { x: 0, y: 0, width: 1000, height: 420 });
  });

  test('overlay: hover action bar in edit mode', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    await ext.send(page, { type: 'SET_EDIT_MODE', enabled: true });
    const b = await boxOf(page, '#ssn-cell');
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    await page.mouse.move(b.x + b.w / 2 + 2, b.y + b.h / 2);
    await page.waitForTimeout(300);
    await shot(page, 'overlay-edit', { x: 0, y: 0, width: 1000, height: 420 });
  });

  test('overlay: a lost sticker', async ({ page, ext }) => {
    await page.goto('/layout-shift.html');
    await ext.cover(page, '#rows tr[data-key="9876543210"] td.col-ssn');
    await page.evaluate(() => (window as unknown as { __fx: { run(n: string): void } }).__fx.run('delete-row'));
    await expect.poll(async () => (await ext.state(page)).stickers[0]?.status, { timeout: 8000 }).toBe('lost');
    await page.waitForTimeout(300);
    await shot(page, 'overlay-lost', { x: 0, y: 0, width: 1000, height: 460 });
  });

  test('overlay: suggestion chips', async ({ page, ext }) => {
    await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoScan'));
    await page.goto('/static.html');
    await expect.poll(async () => (await ext.state(page)).scan?.chips ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(300);
    await shot(page, 'overlay-suggestions', { x: 0, y: 0, width: 1000, height: 460 });
  });

  test('PDF viewer', async ({ page, ext }) => {
    test.setTimeout(90_000);
    await page.goto(`chrome-extension://${extId(ext)}/pdf.html?src=${encodeURIComponent(`${ORIGIN}/sample.pdf`)}`);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    const i = await page.evaluate(() => Array.from(document.querySelectorAll('#page-1 .textLayer > *')).findIndex((k) => k.textContent?.includes('123-45-6789')));
    await ext.cover(page, `#page-1 > .textLayer > :nth-child(${i + 1})`);
    await page.waitForTimeout(400);
    await shot(page, 'pdf-viewer');
  });

  test('PDF viewer: empty state', async ({ page, ext }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`chrome-extension://${extId(ext)}/pdf.html`);
    await page.waitForTimeout(300);
    await shot(page, 'pdf-empty-dark');
  });
});
