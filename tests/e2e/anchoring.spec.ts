import { test, expect, boxOf, coverage } from './fixtures';

const TARGET = '#rows tr[data-key="9876543210"] td.col-ssn';

async function run(page: import('@playwright/test').Page, action: string) {
  await page.evaluate((a) => (window as unknown as { __fx: { run(n: string): void } }).__fx.run(a), action);
  await page.waitForTimeout(250);
}

async function expectCovered(page: import('@playwright/test').Page, ext: import('./fixtures').Ext, selector = TARGET) {
  const st = await ext.state(page);
  const box = await boxOf(page, selector);
  expect(st.stickers[0].status, 'sticker status').toBe('resolved');
  expect(coverage(box, st.pieces), `coverage of ${selector}`).toBeGreaterThanOrEqual(0.98);
  // Nothing else: every piece must lie inside the target's padded box.
  for (const p of st.pieces) {
    expect(p.x).toBeGreaterThanOrEqual(box.x - 5);
    expect(p.y).toBeGreaterThanOrEqual(box.y - 5);
    expect(p.x + p.w).toBeLessThanOrEqual(box.x + box.w + 5);
    expect(p.y + p.h).toBeLessThanOrEqual(box.y + box.h + 5);
  }
}

test.describe('M2 anchoring: the sticker stays on its content', () => {
  test.beforeEach(async ({ page, ext }) => {
    await page.goto('/layout-shift.html');
    await ext.cover(page, TARGET);
    await expectCovered(page, ext);
  });

  test('content inserted above', async ({ page, ext }) => {
    await run(page, 'insert-above');
    await expectCovered(page, ext);
  });

  test('row inserted above (index shift)', async ({ page, ext }) => {
    await run(page, 'insert-row-above');
    await expectCovered(page, ext);
  });

  test('columns reordered', async ({ page, ext }) => {
    await run(page, 'reorder-columns');
    await expectCovered(page, ext);
  });

  test('font swapped', async ({ page, ext }) => {
    await run(page, 'swap-font');
    await expectCovered(page, ext);
  });

  test('responsive cards layout', async ({ page, ext }) => {
    await run(page, 'toggle-cards');
    await expectCovered(page, ext);
    await run(page, 'toggle-cards');
    await expectCovered(page, ext);
  });

  test('re-rendered with new class hashes', async ({ page, ext }) => {
    await run(page, 'rehash-classes');
    await expectCovered(page, ext);
  });

  test('moved into a modal dialog', async ({ page, ext }) => {
    await run(page, 'move-into-modal');
    await page.waitForTimeout(400);
    await expectCovered(page, ext, '#modal-slot td');
  });

  test('hidden then shown again', async ({ page, ext }) => {
    await run(page, 'hide-toggle');
    let st = await ext.state(page);
    expect(st.pieces).toHaveLength(0);
    await run(page, 'hide-toggle');
    st = await ext.state(page);
    await expectCovered(page, ext);
  });

  test('scaled container', async ({ page, ext }) => {
    await run(page, 'scale');
    await expectCovered(page, ext);
  });

  test('viewport resize', async ({ page, ext }) => {
    await page.setViewportSize({ width: 600, height: 500 });
    await page.waitForTimeout(200);
    await expectCovered(page, ext);
  });

  test('survives reload and applies before the first read', async ({ page, ext }) => {
    await page.reload({ waitUntil: 'commit' });
    // Immediately after commit the DOM may not exist yet; poll briefly.
    await expect
      .poll(async () => {
        const st = await ext.state(page).catch(() => null);
        return st?.stickers[0]?.status ?? 'none';
      }, { timeout: 5000 })
      .toBe('resolved');
    await expectCovered(page, ext);
  });

  test('deleted row -> lost state, no mask elsewhere', async ({ page, ext }) => {
    await run(page, 'delete-row');
    await expect
      .poll(async () => (await ext.state(page)).stickers[0].status, { timeout: 8000 })
      .toBe('lost');
    const st = await ext.state(page);
    expect(st.state.lostCount).toBe(1);
    // No page text was masked.
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('•');
    for (const p of st.pieces) expect(p.lost).toBe(true);
  });

  test('a rect over two cells still covers both after the table reflows', async ({ page, ext }) => {
    await page.reload();
    const a = await boxOf(page, '#rows tr:nth-child(1) td.col-ssn');
    const b = await boxOf(page, '#rows tr:nth-child(2) td.col-ssn');
    const rect = { x: a.x + 1, y: a.y + 1, w: a.w - 2, h: b.y + b.h - a.y - 2 };
    const r = await ext.rect(page, rect);
    expect(r.kind).toBe('rect');
    await run(page, 'swap-font');
    const st = await ext.state(page);
    const a2 = await boxOf(page, '#rows tr:nth-child(1) td.col-ssn');
    const b2 = await boxOf(page, '#rows tr:nth-child(2) td.col-ssn');
    expect(coverage(a2, st.pieces)).toBeGreaterThanOrEqual(0.9);
    expect(coverage(b2, st.pieces)).toBeGreaterThanOrEqual(0.9);
  });
});

test.describe('M2 persistence and scope', () => {
  test('default scope generalises an id-like last segment', async ({ page, ext }) => {
    await page.goto('/app/clients/123');
    await ext.cover(page, '#client-ssn');
    const st = await ext.state(page);
    expect(st.stickers[0].pathPattern).toBe('/app/clients/*');
    await page.evaluate(() => (window as unknown as { __spa: { go(p: string): void } }).__spa.go('/app/clients/456'));
    await expect.poll(async () => (await ext.state(page)).stickers[0]?.status, { timeout: 5000 }).toBe('resolved');
    const box = await boxOf(page, '#client-ssn');
    expect(coverage(box, (await ext.state(page)).pieces)).toBeGreaterThanOrEqual(0.98);
    await page.evaluate(() => (window as unknown as { __spa: { go(p: string): void } }).__spa.go('/app/settings'));
    await expect.poll(async () => (await ext.state(page)).stickers.length, { timeout: 5000 }).toBe(0);
  });
});
