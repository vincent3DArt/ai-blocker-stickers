/**
 * Fail closed, never silently uncovered: what happens when a sticker cannot
 * find its content, and when its record cannot be saved.
 */
import type { Page } from '@playwright/test';
import { test, expect, type Ext, type TestState } from './fixtures';

type Rect = { x: number; y: number; w: number; h: number };
type State = TestState & { banner?: string; bannerShown?: string[]; bannerButtons?: { reattach?: Rect; dismiss?: Rect } };
const state = (ext: Ext, page: Page) => ext.state(page) as Promise<State>;
const SSN = '123-45-6789';

async function storedStickers(ext: Ext): Promise<number> {
  return ext.worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('site:'))
      .reduce((n, [, v]) => n + ((v as { stickers?: unknown[] }).stickers?.length ?? 0), 0);
  });
}

test.describe('lost means visibly lost', () => {
  test('a lost sticker raises the banner; dismiss hides it for this page only', async ({ page, ext }) => {
    await page.goto('/layout-shift.html');
    await ext.cover(page, '#rows tr[data-key="9876543210"] td.col-ssn');
    expect((await state(ext, page)).banner).toBe('');
    await page.evaluate(() => (window as unknown as { __fx: { run(n: string): void } }).__fx.run('delete-row'));
    await expect.poll(async () => (await state(ext, page)).stickers[0].status, { timeout: 10_000 }).toBe('lost');
    await expect.poll(async () => (await state(ext, page)).banner).toBe("1 sticker couldn't find its content on this page. Click to re-attach.");
    // The banner lives in our closed shadow root: page readers never see it.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('find its content');
    expect(await page.locator('body').ariaSnapshot()).not.toContain('find its content');
    // At the top of the viewport, with a re-attach button that starts the picker.
    let st = await state(ext, page);
    expect(st.bannerButtons?.reattach?.y).toBeLessThan(40);
    expect(st.state.lostCount).toBe(1);
    // A real click on "Dismiss for this page" hides it; the badge count stays.
    const d = st.bannerButtons!.dismiss!;
    await page.mouse.click(d.x + d.w / 2, d.y + d.h / 2);
    await expect.poll(async () => (await state(ext, page)).banner).toBe('');
    st = await state(ext, page);
    expect(st.state.lostCount).toBe(1);
    // Reload: the row is back, so nothing is lost. Delete it again: the
    // banner comes back (a dismissal is never stored).
    await page.reload();
    await expect.poll(async () => (await state(ext, page).catch(() => undefined))?.stickers?.[0]?.status, { timeout: 5000 }).toBe('resolved');
    await page.evaluate(() => (window as unknown as { __fx: { run(n: string): void } }).__fx.run('delete-row'));
    await expect.poll(async () => (await state(ext, page)).banner, { timeout: 10_000 }).toContain("couldn't find its content");
    // "Re-attach" starts the picker (edit mode).
    st = await state(ext, page);
    const r = st.bannerButtons!.reattach!;
    await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
    await expect.poll(async () => (await state(ext, page)).state.editMode).toBe(true);
  });

  test('text-hash backstop: the same text under another tag is re-attached automatically', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    // The page re-renders the record: the table row goes, the number comes back in a <span> elsewhere.
    await page.evaluate((ssn) => {
      document.getElementById('ssn-cell')!.closest('tr')!.remove();
      const s = document.createElement('span');
      s.id = 'moved-ssn';
      s.textContent = ssn;
      document.querySelector('main p')!.after(s);
    }, SSN);
    await expect.poll(async () => (await state(ext, page)).stickers[0].status, { timeout: 12_000 }).toBe('resolved');
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(SSN);
    expect(await page.textContent('#moved-ssn')).toBe('•'.repeat(SSN.length));
    const st = await state(ext, page);
    expect(st.pieces.some((p) => p.low)).toBe(true);
    expect(st.banner).toContain('re-attached automatically');
  });

  test('pattern backstop: a moved SSN near the same heading is covered while the sticker is lost', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    await page.evaluate((ssn) => {
      document.getElementById('ssn-cell')!.closest('tr')!.remove();
      const p = document.createElement('p');
      p.id = 'moved-ssn';
      p.textContent = `Moved: ${ssn} is the number on file`;
      document.getElementById('identity')!.after(p);
    }, SSN);
    await expect.poll(async () => page.evaluate(() => document.body.innerText), { timeout: 12_000 }).not.toContain(SSN);
    const st = await state(ext, page);
    expect(st.stickers.find((s) => s.status === 'lost')).toBeTruthy();
    expect(st.banner).toContain("couldn't find its content");
    expect(st.banner).toContain('covered automatically');
    // Session-only: nothing new was stored.
    expect(await storedStickers(ext)).toBe(1);
  });

  test('rect token backstop: covered tokens that moved to another container are covered', async ({ page, ext }) => {
    await page.goto('/static.html');
    const rect = await page.evaluate(() => {
      const el = document.getElementById('wrapped-span')!;
      const node = el.firstChild as Text;
      const i = node.data.indexOf('987-65-4321');
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 11);
      const b = r.getBoundingClientRect();
      return { x: b.left - 1, y: b.top - 1, w: b.width + 2, h: b.height + 2 };
    });
    expect((await ext.rect(page, rect)).kind).toBe('rect');
    await page.evaluate(() => {
      document.querySelector('p.narrow')!.remove();
      const d = document.createElement('section');
      d.innerHTML = '<h3>Archive</h3><div>Spouse record: 987-65-4321 (old)</div>';
      document.getElementById('scroller')!.before(d);
    });
    await expect.poll(async () => page.evaluate(() => document.body.innerText), { timeout: 12_000 }).not.toContain('987-65-4321');
    expect(await page.evaluate(() => document.body.innerText)).toContain('Spouse record:');
  });
});

test.describe('persistence safety', () => {
  test('a sticker placed right before the page goes away is already stored', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    const t0 = Date.now();
    const nav = page.goto('/forms.html');
    expect(Date.now() - t0).toBeLessThan(50);
    await nav;
    expect(await storedStickers(ext)).toBe(1);
    await page.goto('/static.html');
    await expect.poll(async () => (await state(ext, page).catch(() => undefined))?.stickers?.[0]?.status, { timeout: 5000 }).toBe('resolved');
    await expect(page.locator('#ssn-cell')).not.toHaveText(SSN);
  });

  test('a failed storage write raises "Could not save" and is retried', async ({ page, ext }) => {
    await ext.worker.evaluate(() => chrome.storage.local.set({ aibsFailNextSave: true }));
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    // The failure was surfaced (the banner keeps a short history: the retry
    // lands about a second later and can beat a slow state round trip).
    await expect
      .poll(async () => ((await state(ext, page)).bannerShown ?? []).some((t) => t.startsWith('Could not save stickers on this site')), { timeout: 3000 })
      .toBe(true);
    // Still covered meanwhile.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(SSN);
    // The retry lands within a few seconds; the banner goes.
    await expect.poll(() => storedStickers(ext), { timeout: 8000 }).toBe(1);
    await expect.poll(async () => (await state(ext, page)).banner, { timeout: 3000 }).toBe('');
    expect((await state(ext, page)).state.saveError).toBe(false);
  });
});
