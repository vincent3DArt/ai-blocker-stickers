import type { Page } from '@playwright/test';
import { test, expect, type Ext, type TestState } from './fixtures';

const DOC_A = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123';
const DOC_B = '9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876';
const SSN = '123-45-6789';

async function sendToFrame<T>(ext: Ext, page: Page, pathname: string, msg: Record<string, unknown>): Promise<T> {
  await page.bringToFront();
  return ext.worker.evaluate(
    async ({ p, m }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, func: () => location.pathname });
      const hit = res.find((r) => r.result === p);
      if (!hit) throw new Error(`no frame ${p}`);
      return chrome.tabs.sendMessage(tab.id!, m, { frameId: hit.frameId });
    },
    { p: pathname, m: msg },
  ) as Promise<T>;
}

/** Everything the extension stored, serialised. */
async function storedJson(ext: Ext): Promise<string> {
  return ext.worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
}

/** Sticker count once the content script answers, held for a moment so a late match would show. */
async function settledCount(read: () => Promise<TestState | undefined>): Promise<number> {
  await expect.poll(async () => (await read().catch(() => undefined))?.stickers?.length, { timeout: 5000 }).not.toBeUndefined();
  await new Promise((r) => setTimeout(r, 600));
  return (await read())!.stickers.length;
}

test.describe('scope: document URLs are this-page-only', () => {
  test('a sticker on one Drive file does not appear on another', async ({ page, ext }) => {
    await page.goto(`/drive/file/d/${DOC_A}/view`);
    await expect(page.locator('#doc-title')).toHaveText(`Document ${DOC_A}`);
    await ext.cover(page, '#doc-ssn');
    const st = await ext.state(page);
    expect(st.stickers).toHaveLength(1);
    expect(st.stickers[0].scopeKind).toBe('exact');
    expect(st.stickers[0].pathPattern).toBe('/drive/file/d/*/view');
    await expect(page.locator('#doc-ssn')).not.toHaveText(SSN);

    // Nothing stored names the document.
    await expect.poll(async () => (await storedJson(ext)).includes('"pathHmac"'), { timeout: 3000 }).toBe(true);
    const json = await storedJson(ext);
    expect(json).not.toContain(DOC_A);

    await page.goto(`/drive/file/d/${DOC_B}/view`);
    await expect(page.locator('#doc-title')).toHaveText(`Document ${DOC_B}`);
    expect(await settledCount(() => ext.state(page))).toBe(0);
    await expect(page.locator('#doc-ssn')).toHaveText(SSN);

    await page.goBack();
    await page.reload();
    await expect(page.locator('#doc-title')).toHaveText(`Document ${DOC_A}`);
    await expect.poll(async () => (await ext.state(page).catch(() => undefined))?.stickers?.[0]?.status, { timeout: 5000 }).toBe('resolved');
    await expect(page.locator('#doc-ssn')).not.toHaveText(SSN);
  });

  test('record paths keep the generalised default', async ({ page, ext }) => {
    await page.goto('/app/clients/123');
    await ext.cover(page, '#client-ssn');
    const st = await ext.state(page);
    expect(st.stickers[0].scopeKind).toBe('pattern');
    expect(st.stickers[0].pathPattern).toBe('/app/clients/*');
  });

  test('popup can switch between this page only and a pattern', async ({ page, ext }) => {
    await page.goto(`/drive/file/d/${DOC_A}/view`);
    const id = await ext.cover(page, '#doc-ssn');
    expect(await ext.send(page, { type: 'SET_SCOPE', id, kind: 'pattern', pathPattern: `/drive/file/d/${DOC_A}/view` })).toMatchObject({ ok: true });
    let st = await ext.state(page);
    expect(st.stickers[0]).toMatchObject({ scopeKind: 'pattern', pathPattern: '/drive/file/d/*/view' });
    await page.goto(`/drive/file/d/${DOC_B}/view`);
    expect(await settledCount(() => ext.state(page))).toBe(1);
    // Back to this page only, chosen on document B: A no longer has it.
    expect(await ext.send(page, { type: 'SET_SCOPE', id, kind: 'exact' })).toMatchObject({ ok: true });
    st = await ext.state(page);
    expect(st.stickers[0]).toMatchObject({ scopeKind: 'exact' });
    await page.goto(`/drive/file/d/${DOC_A}/view`);
    expect(await settledCount(() => ext.state(page))).toBe(0);
    expect(await storedJson(ext)).not.toContain(DOC_A);
  });

  test('stickers in one preview iframe do not appear in another document preview', async ({ page, ext }) => {
    const pathA = `/drive/file/d/${DOC_A}/preview`;
    const pathB = `/drive/file/d/${DOC_B}/preview`;
    await page.goto('/drive-shell.html');
    const frameA = page.frameLocator('#preview-a');
    const frameB = page.frameLocator('#preview-b');
    await expect(frameA.locator('#doc-ssn')).toHaveText(SSN);
    await expect(frameB.locator('#doc-ssn')).toHaveText(SSN);

    const r = await sendToFrame<{ ok: boolean }>(ext, page, pathA, { type: 'TEST_COVER', selector: '#doc-ssn' });
    expect(r.ok).toBe(true);
    await expect(frameA.locator('#doc-ssn')).not.toHaveText(SSN);
    expect(await settledCount(() => sendToFrame<TestState>(ext, page, pathB, { type: 'TEST_STATE' }))).toBe(0);
    await expect(frameB.locator('#doc-ssn')).toHaveText(SSN);

    const json = await storedJson(ext);
    expect(json).toContain('"urlHmac"');
    expect(json).not.toContain(DOC_A);

    await page.reload();
    await expect(frameB.locator('#doc-ssn')).toHaveText(SSN);
    await expect
      .poll(async () => (await sendToFrame<TestState>(ext, page, pathA, { type: 'TEST_STATE' }).catch(() => undefined))?.stickers?.[0]?.status, { timeout: 5000 })
      .toBe('resolved');
    await expect(frameA.locator('#doc-ssn')).not.toHaveText(SSN);
    expect(await settledCount(() => sendToFrame<TestState>(ext, page, pathB, { type: 'TEST_STATE' }))).toBe(0);
    await expect(frameB.locator('#doc-ssn')).toHaveText(SSN);
  });
});
