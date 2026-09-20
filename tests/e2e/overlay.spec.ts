import { test, expect, boxOf, coverage, pixelAt } from './fixtures';

const STICKER_RGB: [number, number, number] = [0x1f, 0x29, 0x37];

function near(a: [number, number, number], b: [number, number, number], tol = 6) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

test.describe('M1 overlay + placement', () => {
  test('covers a table cell and the screenshot shows the sticker colour', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    const st = await ext.state(page);
    expect(st.stickers).toHaveLength(1);
    expect(st.stickers[0].status).toBe('resolved');
    const box = await boxOf(page, '#ssn-cell');
    expect(coverage(box, st.pieces)).toBeGreaterThanOrEqual(0.98);
    const px = await pixelAt(page, box.x + box.w / 2, box.y + box.h / 2);
    expect(near(px, STICKER_RGB)).toBe(true);
  });

  test('follows window scroll and resize', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#bottom-account');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);
    let st = await ext.state(page);
    let box = await boxOf(page, '#bottom-account');
    expect(coverage(box, st.pieces)).toBeGreaterThanOrEqual(0.98);
    await page.setViewportSize({ width: 700, height: 500 });
    await page.waitForTimeout(150);
    st = await ext.state(page);
    box = await boxOf(page, '#bottom-account');
    expect(coverage(box, st.pieces)).toBeGreaterThanOrEqual(0.98);
  });

  test('follows a nested scroll container and is clipped by it', async ({ page, ext }) => {
    await page.goto('/static.html');
    await page.evaluate(() => document.getElementById('scroller')!.scrollIntoView());
    await ext.cover(page, '#dep-ssn');
    // Initially the element is below the fold of the scroller: pieces must be clipped away.
    let st = await ext.state(page);
    const scroller = await boxOf(page, '#scroller');
    for (const p of st.pieces) {
      expect(p.y + p.h).toBeLessThanOrEqual(scroller.y + scroller.h + 1);
      expect(p.y).toBeGreaterThanOrEqual(scroller.y - 1);
    }
    await page.evaluate(() => (document.getElementById('scroller')!.scrollTop = 150));
    await page.waitForTimeout(100);
    st = await ext.state(page);
    const box = await boxOf(page, '#dep-ssn');
    expect(coverage(box, st.pieces)).toBeGreaterThanOrEqual(0.98);
  });

  test('covers a sticky header value while scrolling', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#hdr-account');
    await page.evaluate(() => window.scrollTo(0, 800));
    await page.waitForTimeout(100);
    const st = await ext.state(page);
    const box = await boxOf(page, '#hdr-account');
    expect(box.y).toBeLessThan(60); // sticky
    expect(coverage(box, st.pieces)).toBeGreaterThanOrEqual(0.98);
  });

  test('covers every line box of a wrapped inline span', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#wrapped-span');
    const st = await ext.state(page);
    const box = await boxOf(page, '#wrapped-span');
    expect(box.rects.length).toBeGreaterThan(1);
    for (const r of box.rects) expect(coverage(r, st.pieces)).toBeGreaterThanOrEqual(0.95);
  });

  test('stays above a modal dialog opened later', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    await page.click('#open-modal');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400); // slow tick re-asserts the top layer
    expect(await page.evaluate(() => document.querySelector('dialog')!.open)).toBe(true);
    const box = await boxOf(page, '#ssn-cell');
    const px = await pixelAt(page, box.x + box.w / 2, box.y + box.h / 2);
    expect(near(px, STICKER_RGB)).toBe(true);
  });

  test('a free rectangle over two cells becomes an anchored rect sticker', async ({ page, ext }) => {
    await page.goto('/static.html');
    const a = await boxOf(page, '#identity tbody tr:nth-child(2) td');
    const b = await boxOf(page, '#identity tbody tr:nth-child(3) td');
    const rect = { x: a.x + 2, y: a.y + 2, w: Math.max(a.w, b.w) - 4, h: b.y + b.h - a.y - 4 };
    const r = await ext.rect(page, rect);
    expect(r.kind).toBe('rect');
    const st = await ext.state(page);
    expect(coverage(rect, st.pieces)).toBeGreaterThanOrEqual(0.98);
  });

  test('a rectangle over exactly one cell converts to an element sticker', async ({ page, ext }) => {
    await page.goto('/static.html');
    const box = await boxOf(page, '#ssn-cell');
    const r = await ext.rect(page, { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 });
    expect(r.kind).toBe('element');
  });
});
