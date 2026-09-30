/**
 * Strict input masking: a covered text field's live `.value` holds bullets,
 * the real value lives in the content script and is handed back to FormData
 * and form submission only. On while the tab is locked (default setting
 * `locked`), always (`always`) or never (`never`).
 */
import type { Page } from '@playwright/test';
import { test, expect, boxOf, type Ext } from './fixtures';

const SSN = '123-45-6789';
const BULLETS = '•'.repeat(SSN.length);
const CTRL = '222-33-4444';

type Mode = 'locked' | 'always' | 'never';

async function setStrict(ext: Ext, mode: Mode) {
  await ext.worker.evaluate(async (m) => {
    const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({ settings: { ...cur, strictInputs: m } });
  }, mode);
}

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

const formValue = (page: Page, name: string) =>
  page.evaluate((n) => new FormData(document.getElementById('intake') as HTMLFormElement).get(n), name);

/** Only #ssn (and #ctrl) should hold anything secret: the rest of the page is neutralised. */
async function openForms(page: Page) {
  await page.goto('/forms.html');
  await page.evaluate(() => {
    document.getElementById('react-ish')!.remove();
    document.getElementById('photo')!.remove();
    // The page's own <script> source mentions the SSN; its listeners stay.
    document.querySelectorAll('script').forEach((s) => s.remove());
  });
}

test.describe('strict input masking', () => {
  test("(a) 'always': .value reads bullets, FormData and submit get the real value", async ({ page, ext }) => {
    await setStrict(ext, 'always');
    await openForms(page);
    await ext.cover(page, '#ssn');
    await ext.cover(page, '#ctrl');
    await expect.poll(async () => (await ext.state(page)).strict).toEqual({ on: true, count: 2 });

    // Any reader of the live value gets bullets: Playwright (a CDP utility world), the page's own world.
    expect(await page.locator('#ssn').inputValue()).toBe(BULLETS);
    expect(await page.evaluate(() => (document.getElementById('ssn') as HTMLInputElement).value)).toBe(BULLETS);
    expect(await page.getAttribute('#ssn', 'data-aibs-strict')).toBe('1');
    // The default stays blanked, as in plain input mode.
    expect(await page.evaluate(() => (document.getElementById('ssn') as HTMLInputElement).defaultValue)).toBe('');

    // FormData gets the real value (the formdata event); the DOM stays masked.
    expect(await formValue(page, 'ssn')).toBe(SSN);
    expect(await page.locator('#ssn').inputValue()).toBe(BULLETS);

    // A real submission gets the real value too.
    await page.evaluate(() => (document.getElementById('intake') as HTMLFormElement).requestSubmit());
    const submitted = await page.evaluate(() => (window as unknown as { __submitted: Record<string, string> }).__submitted);
    expect(submitted.ssn).toBe(SSN);
    expect(submitted.ctrl).toBe(CTRL);
    expect(await page.locator('#ssn').inputValue()).toBe(BULLETS);

    // Documented residual for that pattern: a fetch-style submit that reads .value directly gets bullets.
    await page.evaluate(() => (document.getElementById('send-fetch') as HTMLButtonElement).click());
    const sent = await page.evaluate(() => (window as unknown as { __submitted2: Record<string, string> }).__submitted2);
    expect(sent.ssn).toBe(BULLETS);

    // Nothing else the page exposes has the SSN either.
    const snapshot = await page.locator('body').ariaSnapshot();
    expect(snapshot).not.toContain(SSN);
    expect(snapshot).not.toContain(CTRL);
    const text = await page.evaluate(() => document.body.innerText + document.body.outerHTML);
    expect(text).not.toContain(SSN);
    expect(text).not.toContain(CTRL);
  });

  test("(a) 'always': a controlled input's own writes are adopted as the real value", async ({ page, ext }) => {
    await setStrict(ext, 'always');
    await openForms(page);
    await ext.cover(page, '#ctrl');
    await expect.poll(() => page.locator('#ctrl').inputValue()).toBe('•'.repeat(CTRL.length));

    // A re-render writes the page's state (a new value) into the field.
    await page.evaluate(() => (window as unknown as { __rerenderCtrl: (v: string) => void }).__rerenderCtrl('444-55-6666'));
    await expect.poll(() => page.locator('#ctrl').inputValue(), { timeout: 2000 }).toBe('•'.repeat(11));
    expect(await formValue(page, 'ctrl')).toBe('444-55-6666');

    // Documented caveat: a handler that reads .value and stores it takes the bullets into its state.
    await page.evaluate(() => document.getElementById('ctrl')!.dispatchEvent(new Event('input', { bubbles: true })));
    expect(await page.evaluate(() => (window as unknown as { __ctrlState: () => string }).__ctrlState())).toBe('•'.repeat(11));
    // The form itself still submits the real value.
    expect(await formValue(page, 'ctrl')).toBe('444-55-6666');
  });

  test('(b) peek: the real value is in the field while held, bullets after release', async ({ page, ext }) => {
    await setStrict(ext, 'always');
    await openForms(page);
    await ext.cover(page, '#ssn');
    await expect.poll(() => page.locator('#ssn').inputValue()).toBe(BULLETS);

    const b = await boxOf(page, '#ssn');
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.mouse.move(c.x + 1, c.y);
    await expect.poll(() => page.locator('#ssn').inputValue(), { timeout: 2000 }).toBe(SSN);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await expect.poll(() => page.locator('#ssn').inputValue(), { timeout: 2000 }).toBe(BULLETS);
    expect(await formValue(page, 'ssn')).toBe(SSN);
  });

  test("(c) 'locked' (default): strict while the AI session lock is on, off again after", async ({ page, ext }) => {
    await openForms(page);
    await ext.cover(page, '#ssn');
    // Unlocked, default setting: plain input mode.
    expect((await ext.state(page)).strict).toEqual({ on: false, count: 0 });
    expect(await page.locator('#ssn').inputValue()).toBe(SSN);

    const ctl = await controlPage(ext);
    await testSession(ctl, true);
    await expect.poll(async () => (await ext.state(page)).lock?.locked, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => (await ext.state(page)).strict).toEqual({ on: true, count: 1 });
    expect(await page.locator('#ssn').inputValue()).toBe(BULLETS);
    expect(await formValue(page, 'ssn')).toBe(SSN);

    // Weakening the setting while locked is deferred until the lock ends.
    await setStrict(ext, 'never');
    await page.waitForTimeout(300);
    expect((await ext.state(page)).strict?.on).toBe(true);
    expect(await page.locator('#ssn').inputValue()).toBe(BULLETS);

    await testSession(ctl, false);
    await expect.poll(async () => (await ext.state(page)).lock?.locked, { timeout: 3000 }).toBe(false);
    await expect.poll(() => page.locator('#ssn').inputValue()).toBe(SSN);
    expect((await ext.state(page)).strict).toEqual({ on: false, count: 0 });
    expect(await page.getAttribute('#ssn', 'data-aibs-strict')).toBeNull();

    // Back to the default: the next lock turns it on again.
    await setStrict(ext, 'locked');
    await testSession(ctl, true);
    await expect.poll(() => page.locator('#ssn').inputValue(), { timeout: 3000 }).toBe(BULLETS);
    await testSession(ctl, false);
    await expect.poll(() => page.locator('#ssn').inputValue(), { timeout: 3000 }).toBe(SSN);
    await ctl.close();
  });
});
