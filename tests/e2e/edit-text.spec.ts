/**
 * Edit text: change page text live, until reload. Clicks on the page are
 * swallowed while the tool is on, edits survive framework re-renders, and
 * while a tab is locked the original text never comes back (re-render, undo)
 * and nothing can revert the edits.
 */
import type { Page } from '@playwright/test';
import { test, expect, boxOf, type Ext } from './fixtures';

const bullets = (s: string) => s.replace(/\S/g, '•');

/** An extension page to send popup-only messages from (TEST_SESSION). */
async function lockTab(ext: Ext, page: Page) {
  const id = new URL(ext.worker.url()).host;
  const ctl = await ext.context.newPage();
  await ctl.goto(`chrome-extension://${id}/popup.html`);
  expect(await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_SESSION', active: true }))).toMatchObject({ ok: true });
  await expect.poll(async () => (await ext.state(page)).lock?.locked, { timeout: 3000 }).toBe(true);
}

/** Viewport rect of the first text node under `selector`. */
const textBox = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const t = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && /\S/.test(n.textContent ?? ''))!;
    const r = document.createRange();
    r.selectNodeContents(t);
    const b = r.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, selector);

/** Run one of the fixture's re-render functions, let mutation callbacks run, and read #app. */
const rerender = (page: Page, fx: string) =>
  page.evaluate(async (name) => {
    (window as unknown as { __fx: Record<string, () => void> }).__fx[name]();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return document.getElementById('app')!.textContent;
  }, fx);

test.describe('Edit text', () => {
  test('real mouse and keyboard: the edit lands in place, keeps formatting, and the page is never clicked', async ({ page, ext }) => {
    await page.goto('/edit.html');
    await ext.send(page, { type: 'START_EDIT_TEXT' });
    await expect.poll(async () => (await ext.state(page)).edits?.tool).not.toBeNull();

    const b = await boxOf(page, '#link b');
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
    await expect.poll(async () => (await ext.state(page)).edits?.tool?.open).toBe(true);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Jane');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.textContent('#link')).toBe('Hello Jane Quarry');
    expect(await page.innerHTML('#link')).toContain('<b>Jane</b>');
    expect(await page.getAttribute('#link', 'title')).toBe('Open Jane Quarry');
    expect(await page.getAttribute('#link', 'aria-label')).not.toContain('Zelda');
    expect(page.url()).not.toContain('#navigated');

    // The tool stays on: a second edit, on the button's label, never clicks the button.
    const t = await textBox(page, '#btn');
    await page.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
    await expect.poll(async () => (await ext.state(page)).edits?.tool?.open).toBe(true);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Clicks:');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.textContent('#btn')).toBe('Clicks: 0');
    expect((await ext.state(page)).edits?.count).toBe(2);

    // Esc with no editor open ends the tool; the page works again.
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await ext.state(page)).edits?.tool).toBeNull();
    await page.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
    await expect.poll(() => page.textContent('#count')).toBe('1');
  });

  test('Esc in the editor cancels only that edit', async ({ page, ext }) => {
    await page.goto('/edit.html');
    await ext.send(page, { type: 'START_EDIT_TEXT' });
    const t = await textBox(page, '#name');
    await page.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
    await expect.poll(async () => (await ext.state(page)).edits?.tool?.open).toBe(true);
    await page.keyboard.type('Nobody');
    await page.keyboard.press('Escape');
    const st = await ext.state(page);
    expect(st.edits?.tool).toEqual({ open: false });
    expect(st.edits?.count).toBe(0);
    expect(await page.textContent('#name')).toBe('Zelda Quarry');
  });

  test('copies: warned by default, rewritten with Every copy (tab title too); reload reverts', async ({ page, ext }) => {
    await page.goto('/edit.html');
    // The title, the label, #copy and #react show the same run as #name.
    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#name', value: 'Jane Doe' })).toMatchObject({ ok: true, remaining: 4 });
    expect(await page.textContent('#copy')).toContain('Zelda Quarry');
    expect(await ext.send(page, { type: 'TEST_REVERT_EDITS' })).toMatchObject({ ok: true });
    expect(await page.textContent('#name')).toBe('Zelda Quarry');

    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#name', value: 'Jane Doe', everywhere: true })).toMatchObject({ ok: true, copies: 4 });
    for (const sel of ['#name', '#copy', '#react', 'label']) expect(await page.textContent(sel), sel).not.toContain('Zelda Quarry');
    expect(await page.title()).toBe('Jane Doe · Client file');

    await page.reload();
    await expect.poll(async () => (await ext.state(page).catch(() => undefined))?.edits?.count).toBe(0);
    expect(await page.textContent('#name')).toBe('Zelda Quarry');
  });

  test('unlocked: re-renders keep the edit; unrelated new text releases it', async ({ page, ext }) => {
    await page.goto('/edit.html');
    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#react', value: 'Jane Doe' })).toMatchObject({ ok: true });
    for (const fx of ['setData', 'textContent', 'innerHTML', 'replaceClone']) expect(await rerender(page, fx), fx).toBe('Jane Doe');
    expect(await rerender(page, 'partial')).toBe('Ms. Zelda Q.');
  });

  test('locked: re-renders and undo never bring the original back, and nothing can revert or edit', async ({ page, ext }) => {
    await page.goto('/edit.html');
    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#react', value: 'Jane Doe' })).toMatchObject({ ok: true });
    await lockTab(ext, page);

    for (const type of ['START_EDIT_TEXT', 'TEST_REVERT_EDITS']) expect(await ext.send(page, { type }), type).toMatchObject({ ok: false, locked: true });
    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#name', value: 'X' })).toMatchObject({ ok: false, locked: true });
    expect(await page.textContent('#name')).toBe('Zelda Quarry');

    for (const fx of ['setData', 'textContent', 'innerHTML', 'replaceClone', 'partial']) expect(await rerender(page, fx), fx).toBe('Jane Doe');

    // The undo stack: every editing-command route an agent could try.
    const afterUndo = await page.evaluate(async () => {
      document.designMode = 'on';
      for (let i = 0; i < 20; i++) document.execCommand('undo');
      for (let i = 0; i < 20; i++) document.execCommand('redo');
      document.designMode = 'off';
      const el = document.getElementById('react')!;
      el.contentEditable = 'true';
      el.focus();
      for (let i = 0; i < 5; i++) document.execCommand('undo');
      el.contentEditable = 'false';
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return document.getElementById('app')!.textContent;
    });
    expect(afterUndo).toBe('Jane Doe');
    await page.keyboard.press('ControlOrMeta+Z');
    expect(await page.textContent('#app')).toBe('Jane Doe');
  });

  test('control: native editing is undoable in this browser, so the undo attack above is real', async ({ page }) => {
    await page.goto('/edit.html');
    await page.click('#native');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Changed');
    expect(await page.textContent('#native')).toBe('Changed');
    const back = await page.evaluate(() => {
      for (let i = 0; i < 10 && document.getElementById('native')!.textContent !== 'Native editor text'; i++) document.execCommand('undo');
      return document.getElementById('native')!.textContent;
    });
    expect(back).toBe('Native editor text');
  });

  test('a sticker over an edit keeps the edit through a re-render and its removal; covered text is not editable', async ({ page, ext }) => {
    await page.goto('/edit.html');
    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#react', value: 'Jane Doe' })).toMatchObject({ ok: true });
    const id = await ext.cover(page, '#react');
    expect(await page.textContent('#react')).toBe(bullets('Jane Doe'));
    expect(await rerender(page, 'setData')).not.toContain('Zelda');

    await ext.send(page, { type: 'START_EDIT_TEXT' });
    const b = await boxOf(page, '#react');
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
    expect((await ext.state(page)).edits?.tool).toEqual({ open: false });
    await page.keyboard.press('Escape');

    await ext.send(page, { type: 'DELETE_STICKER', id });
    await expect.poll(() => page.textContent('#react')).toBe('Jane Doe');
  });

  test('nothing about an edit is stored', async ({ page, ext }) => {
    await page.goto('/edit.html');
    expect(await ext.send(page, { type: 'TEST_EDIT', selector: '#react', value: 'Jane Doe' })).toMatchObject({ ok: true });
    await page.waitForTimeout(300);
    const dump = await ext.worker.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]));
    expect(dump).not.toContain('Jane Doe');
    expect(dump).not.toContain('Zelda');
  });
});
