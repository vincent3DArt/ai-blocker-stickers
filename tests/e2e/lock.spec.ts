/**
 * AI-session lock. CDP-driven agents send TRUSTED input, so while a lock
 * signal is up nothing may lift a sticker: no peek, pause, delete or edit.
 *
 * Signals under Playwright: its own pipe connection is attached to every tab
 * from the start, so `chrome.debugger.getTargets()` already reports
 * `attached: true` before the test adds a CDP session, and keeps reporting it
 * after that session detaches. Playwright also sets `navigator.webdriver`.
 * The fixture turns auto-lock off (dev-only `aibsNoAutoLock`); test (a) turns
 * it back on and asserts the `debugger` signal fires.
 */
import type { Page } from '@playwright/test';
import { test, expect, boxOf, coverage, pixelAt, type Ext } from './fixtures';

const STICKER: [number, number, number] = [0x1f, 0x29, 0x37];
const BULLETS = '•'.repeat(11);
const TARGET = '#rows tr[data-key="9876543210"] td.col-ssn';

const near = (a: number[], b: number[], tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** An extension page to send popup-only messages from (TEST_SESSION). */
async function controlPage(ext: Ext): Promise<Page> {
  const id = new URL(ext.worker.url()).host;
  const p = await ext.context.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  return p;
}

async function testSession(ctl: Page, active: boolean) {
  const r = await ctl.evaluate((a) => chrome.runtime.sendMessage({ type: 'TEST_SESSION', active: a }), active);
  expect(r).toMatchObject({ ok: true });
}

async function auditActions(ext: Ext): Promise<string[]> {
  return ext.worker.evaluate(async () => {
    const a = (await chrome.storage.local.get('audit')).audit as { action: string }[] | undefined;
    return (a ?? []).map((e) => e.action);
  });
}

async function badge(ext: Ext, page: Page): Promise<string> {
  await page.bringToFront();
  return ext.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
}

/** How many SSN cells are masked in the page DOM. */
const maskedSsnCells = (page: Page) =>
  page.evaluate((b) => Array.from(document.querySelectorAll('#rows td.col-ssn')).filter((td) => td.textContent === b).length, BULLETS);

test.describe('AI-session lock', () => {
  test('(a) a CDP attach locks the tab: trusted peek and delete are refused', async ({ page, ext }) => {
    await page.goto('/static.html');
    const id = await ext.cover(page, '#ssn-cell');
    expect((await ext.state(page)).lock?.locked).toBe(false);

    await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoAutoLock'));
    const cdp = await page.context().newCDPSession(page);
    await expect.poll(async () => (await ext.state(page)).lock?.locked, { timeout: 3000 }).toBe(true);
    const st = await ext.state(page);
    expect(st.lock?.reason).toBe('debugger');
    expect(st.lock?.signals.debugger).toBe(true);
    // Also true under Playwright; recorded so a regression in either shows.
    expect(st.lock?.signals.webdriver).toBe(true);
    expect(st.state.locked).toBe(true);
    expect(await badge(ext, page)).toBe('\u{1F512}');

    // Real, trusted input over the sticker: no reveal.
    const cell = await boxOf(page, '#ssn-cell');
    const c = centre(cell);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.mouse.move(c.x + 1, c.y);
    await page.waitForTimeout(500);
    expect(near(await pixelAt(page, c.x, c.y), STICKER)).toBe(true);
    expect(await page.evaluate(() => document.getElementById('ssn-cell')!.innerText)).toBe(BULLETS);
    expect((await ext.state(page)).state.peeking).toBe(false);
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    expect(near(await pixelAt(page, c.x, c.y), STICKER)).toBe(true);
    expect((await ext.state(page)).state.peeking).toBe(false);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');

    // Lifting commands are refused and the sticker stays.
    expect(await ext.send(page, { type: 'DELETE_STICKER', id })).toMatchObject({ ok: false, locked: true, error: 'Automation detected' });
    expect(await ext.send(page, { type: 'SET_PAUSED', paused: true })).toMatchObject({ ok: false, locked: true });
    expect(await ext.send(page, { type: 'SET_EDIT_MODE', enabled: true })).toMatchObject({ ok: false, locked: true });
    const after = await ext.state(page);
    expect(after.stickers.map((s) => s.id)).toEqual([id]);
    expect(after.state).toMatchObject({ paused: false, editMode: false });
    expect(await page.textContent('#ssn-cell')).toBe(BULLETS);

    // Detaching our session does not unlock: Playwright's own connection is
    // still attached to the tab (and webdriver is still set).
    await cdp.detach();
    await page.waitForTimeout(3000);
    const still = await ext.state(page);
    expect(still.lock?.locked).toBe(true);
    expect(still.lock?.signals.debugger).toBe(true);

    const actions = await auditActions(ext);
    expect(actions).toContain('auto-lock');
    expect(actions).toContain('unlock-refused');

    // Auto-lock off again (as Playwright's attachment "goes away"): unlocks.
    await ext.worker.evaluate(() => chrome.storage.local.set({ aibsNoAutoLock: true }));
    await expect.poll(async () => (await ext.state(page)).lock?.locked, { timeout: 3000 }).toBe(false);
    expect(await auditActions(ext)).toContain('auto-unlock');
  });

  test('(b) a manual session locks every tab until it is ended', async ({ page, ext }) => {
    await page.goto('/static.html');
    const id = await ext.cover(page, '#ssn-cell');
    const ctl = await controlPage(ext);
    await testSession(ctl, true);

    await expect.poll(async () => (await ext.state(page)).lock?.reason, { timeout: 3000 }).toBe('manual');
    expect(await ext.send(page, { type: 'SET_PAUSED', paused: true })).toMatchObject({ ok: false, error: 'AI session active' });
    expect(await ext.send(page, { type: 'START_PICK' })).toMatchObject({ ok: false, locked: true });
    expect(await ext.send(page, { type: 'SET_SCOPE', id, pathPattern: '/**' })).toMatchObject({ ok: false, locked: true });
    expect((await ext.state(page)).state.paused).toBe(false);

    // A tab opened after the session started is locked too.
    const fresh = await ext.context.newPage();
    await fresh.goto('/layout-shift.html');
    await expect.poll(async () => (await ext.state(fresh)).lock?.locked, { timeout: 3000 }).toBe(true);
    expect(await ext.send(fresh, { type: 'START_RECT' })).toMatchObject({ ok: false, locked: true });

    // The popup shows the session.
    await ctl.reload();
    await expect(ctl.getByRole('button', { name: 'End session' })).toBeVisible();

    await testSession(ctl, false);
    await expect.poll(async () => (await ext.state(page)).lock?.locked, { timeout: 3000 }).toBe(false);
    expect(await ext.send(page, { type: 'SET_PAUSED', paused: true })).toBeFalsy();
    expect((await ext.state(page)).state.paused).toBe(true);
    await ext.send(page, { type: 'SET_PAUSED', paused: false });
    expect((await ext.state(fresh)).lock?.locked).toBe(false);

    const actions = await auditActions(ext);
    expect(actions).toContain('session-start');
    expect(actions).toContain('session-end');
    expect(actions).toContain('unlock-refused');
    // The audit never holds covered text.
    const raw = await ext.worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get('audit')).audit));
    expect(raw).not.toContain('123-45-6789');
    await fresh.close();
    await ctl.close();
  });

  test('(c) locked, an ambiguous anchor masks every tied row; unlocked, one row and low confidence', async ({ page, ext }) => {
    const ctl = await controlPage(ext);
    await page.goto('/layout-shift.html');
    await ext.cover(page, TARGET);
    const run = async (a: string) => {
      await page.evaluate((n) => (window as unknown as { __fx: { run(n: string): void } }).__fx.run(n), a);
      await page.waitForTimeout(400);
    };
    const dupCells = '#rows tr[data-key^="dup-"] td.col-ssn';

    // Unlocked: one row masked, flagged low confidence.
    await run('duplicate-target-row');
    let st = await ext.state(page);
    expect(st.stickers[0].status).toBe('resolved');
    expect(st.pieces.length).toBeGreaterThan(0);
    expect(st.pieces.every((p) => p.low)).toBe(true);
    expect(await maskedSsnCells(page)).toBe(1);

    // The lock comes on: the low-confidence sticker is re-resolved and both rows are masked.
    await testSession(ctl, true);
    await expect.poll(() => maskedSsnCells(page), { timeout: 3000 }).toBe(2);
    await page.bringToFront();
    st = await ext.state(page);
    const boxes = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }), dupCells);
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(coverage(b, st.pieces)).toBeGreaterThanOrEqual(0.98);

    // Fresh load while locked: the tie is found on the first resolve.
    await page.reload();
    await expect.poll(async () => (await ext.state(page)).stickers[0]?.status, { timeout: 3000 }).toBe('resolved');
    expect(await maskedSsnCells(page)).toBe(1);
    await run('duplicate-target-row');
    await expect.poll(() => maskedSsnCells(page), { timeout: 3000 }).toBe(2);

    // Ending the session drops the extra mask: back to one row, low confidence.
    await testSession(ctl, false);
    await expect.poll(() => maskedSsnCells(page), { timeout: 3000 }).toBe(1);
    st = await ext.state(page);
    expect(st.pieces.every((p) => p.low)).toBe(true);
    await ctl.close();
  });
});
