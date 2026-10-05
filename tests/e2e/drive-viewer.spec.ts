import type { Page } from '@playwright/test';
import { test, expect, type Ext, type TestState } from './fixtures';

/**
 * Google Drive's built-in preview: the file opens in an overlay dialog over
 * the home page and the URL never changes. Stickers placed in the viewer must
 * follow the file (view identity), not the URL, and must re-anchor although
 * the viewer's class names and position change between page loads.
 */

const SSN = '123-45-6789';

type Drive = { open(id: 'A' | 'B'): void; close(): void; ssnSelector(): string | null; lineSelector(page: number, n: number): string | null };


async function open(page: Page, id: 'A' | 'B') {
  await page.evaluate((f) => (window as unknown as { __drive: Drive }).__drive.open(f), id);
}

async function close(page: Page) {
  await page.evaluate(() => (window as unknown as { __drive: Drive }).__drive.close());
}

/** Text of a viewer line (page 1-based, line 1-based), or null while it is not rendered. */
async function lineText(page: Page, pageNo: number, n: number): Promise<string | null> {
  return page.evaluate(
    ([p, k]) => document.querySelectorAll('[role="document"] > div')[p]?.querySelectorAll('p')[k - 1]?.textContent ?? null,
    [pageNo, n] as const,
  );
}

async function ssnText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('[role="document"] p'));
    return ps[ps.length > 0 ? 38 : 0]?.textContent ?? null;
  });
}

const state = (ext: Ext, page: Page) => ext.state(page).catch(() => undefined as TestState | undefined);

/** Both stickers resolved, the SSN line masked and the rect's line partly masked. */
async function bothMasked(ext: Ext, page: Page): Promise<string> {
  const st = await state(ext, page);
  const statuses = (st?.stickers ?? []).map((s) => s.status).sort().join(',');
  const ssn = await ssnText(page);
  const line = await lineText(page, 1, 2);
  return `${statuses}|ssn:${ssn !== null && !ssn.includes(SSN) && ssn.includes('•')}|rect:${!!line?.includes('•')}`;
}

const MASKED = 'resolved,resolved|ssn:true|rect:true';

test.describe('in-page viewer (Drive preview over an unchanged URL)', () => {
  test('stickers belong to the previewed file, not the home URL', async ({ page, ext }) => {
    test.setTimeout(90_000);
    await page.goto('/drive-home');
    await open(page, 'A');
    await expect.poll(() => ssnText(page)).toBe('SSN ' + SSN);

    // Element sticker on the SSN line, rect over the left half of formula line 2.
    const ssnSel = await page.evaluate(() => (window as unknown as { __drive: Drive }).__drive.ssnSelector());
    expect(ssnSel).toBeTruthy();
    await ext.cover(page, ssnSel!);
    const box = await page.evaluate(() => {
      const p = document.querySelectorAll('[role="document"] > div')[1].querySelectorAll('p')[1];
      const r = p.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const r = await ext.rect(page, { x: box.x + 1, y: box.y, w: box.w * 0.45, h: box.h });
    expect(r.kind).toBe('rect');
    await expect.poll(() => bothMasked(ext, page)).toBe(MASKED);

    // Stored with a view identity, never the text.
    const json = await ext.worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    expect(json.match(/"viewHmac":"[0-9a-f]{64}"/g)?.length).toBe(2);
    expect(json).not.toContain('Formula');

    // Close: the home page has no active sticker and no ghost, even after the lost budget.
    await close(page);
    await expect.poll(async () => (await state(ext, page))?.stickers.length).toBe(0);
    await page.waitForTimeout(5500);
    let st = (await state(ext, page))!;
    expect(st.stickers).toHaveLength(0);
    expect(st.pieces).toHaveLength(0);
    expect(st.state.otherViews).toBe(2);
    expect(st.state.stickerCount).toBe(0);
    expect(await page.locator('body').innerText()).not.toContain('•');

    // Another file in the same viewer at the same URL: nothing applies.
    await open(page, 'B');
    await expect.poll(() => lineText(page, 1, 2)).toContain('Formula 1.2');
    await page.waitForTimeout(800);
    st = (await state(ext, page))!;
    expect(st.stickers).toHaveLength(0);
    expect(st.pieces).toHaveLength(0);
    expect(st.state.otherViews).toBe(2);
    expect(await page.locator('[role="document"]').innerText()).not.toContain('•');

    // Back to A: both re-anchor and mask within 1.5 s of opening, although
    // page 1's text layer only renders 300 ms after the dialog.
    await close(page);
    await open(page, 'A');
    await expect.poll(() => bothMasked(ext, page), { timeout: 1500 }).toBe(MASKED);
    st = (await state(ext, page))!;
    expect(st.state.otherViews).toBe(0);
    expect(st.pieces.some((p) => p.lost)).toBe(false);

    // New page load: new class names, the viewer lands at another position.
    await page.reload();
    await expect(page.locator('#open-a')).toBeVisible();
    await expect.poll(async () => (await state(ext, page))?.state.otherViews).toBe(2);
    expect((await state(ext, page))!.pieces).toHaveLength(0);
    await open(page, 'A');
    await expect.poll(() => bothMasked(ext, page), { timeout: 1500 }).toBe(MASKED);
  });
});
