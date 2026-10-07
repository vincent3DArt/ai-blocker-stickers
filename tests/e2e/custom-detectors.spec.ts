/**
 * User-defined detectors ("teach a pattern"): derived from an example on the
 * page, typed as a format, or picked from the catalogue. Only the shape is
 * stored; matches become suggestions, or are auto-covered while locked.
 */
import type { Page } from '@playwright/test';
import { test, expect, ORIGIN, type Ext, type TestState } from './fixtures';
import { templateToRegex } from '../../src/content/detect/template';

type Scan = NonNullable<TestState['scan']>;

const POLICIES = ['pol1', 'pol2', 'pol3'];
const DECOYS = ['ord1', 'ord2', 'date1', 'date2', 'ref1', 'ref2', 'mem1', 'mem2', 'dl'];

async function scanOn(ext: Ext) {
  await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoScan'));
}

async function scanState(ext: Ext, page: Page): Promise<Scan> {
  return (await ext.state(page)).scan!;
}

/** Wait until the suggestions of `pattern` (prefix match) sit on exactly `ids`. */
async function expectSuggested(ext: Ext, page: Page, pattern: RegExp, ids: string[], timeout = 6000) {
  await expect
    .poll(
      async () => {
        const s = await scanState(ext, page);
        if (s.scanning) return 'scanning';
        return s.suggestions
          .filter((x) => pattern.test(x.pattern))
          .map((x) => x.elId ?? x.tag)
          .sort()
          .join(',');
      },
      { timeout },
    )
    .toBe([...ids].sort().join(','));
}

async function siteRecord(ext: Ext) {
  return ext.worker.evaluate(async (origin) => {
    const k = 'site:' + origin;
    return (await chrome.storage.local.get(k))[k] as { customDetectors?: { id: string; regex: string; labels: string[]; name: string; strength: string }[] } | undefined;
  }, ORIGIN);
}

async function controlPage(ext: Ext): Promise<Page> {
  const id = new URL(ext.worker.url()).host;
  const p = await ext.context.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  return p;
}

async function testSession(ctl: Page, active: boolean) {
  const r = await ctl.evaluate((a) => chrome.runtime.sendMessage({ type: 'TEST_SESSION', active: a, keepAuto: false }), active);
  expect(r).toMatchObject({ ok: true });
}

/** Teach the policy shape from #pol1 and save it for this site. */
async function teachPolicy(ext: Ext, page: Page) {
  const r = await ext.send<{ ok: boolean; info: { description: string; label?: string; count: number; strength: string; name: string } }>(page, {
    type: 'TEST_TEACH',
    selector: '#pol1',
  });
  expect(r.ok).toBe(true);
  const saved = await ext.send<{ ok: boolean; id: string }>(page, { type: 'TEST_TEACH_SAVE', scope: 'site', name: 'Policy number' });
  expect(saved.ok).toBe(true);
  return { info: r.info, id: saved.id };
}

test.describe('custom detectors', () => {
  test('(a) select an example: shape, label and live count; saved, all three policies are suggested, decoys are not', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/custom.html');
    await expect.poll(async () => (await scanState(ext, page)).stats?.finishedAt ?? 0).toBeGreaterThan(0);
    const { info, id } = await teachPolicy(ext, page);
    expect(info.description).toBe('2 letters, 4 digits, 4 digits');
    expect(info.label).toBe('policy');
    expect(info.count).toBe(3);
    expect(info.strength).toBe('high');

    await expectSuggested(ext, page, new RegExp(`^custom:${id}$`), POLICIES);
    const s = await scanState(ext, page);
    for (const d of DECOYS) expect(s.suggestions.map((x) => x.elId)).not.toContain(d);
    expect(s.suggestions.find((x) => x.elId === 'pol1')?.name).toBe('Policy number');

    const rec = await siteRecord(ext);
    expect(rec?.customDetectors).toHaveLength(1);
    expect(rec!.customDetectors![0]).toMatchObject({ regex: '\\b[A-Z]{2}-\\d{4}-\\d{4}\\b', labels: ['policy'], strength: 'high', name: 'Policy number' });

    // Suggestions are ordinary: Cover turns them into stickers.
    const covered = await ext.send<{ ok: boolean; covered: number }>(page, { type: 'TEST_COVER_SUGGESTIONS' });
    expect(covered.covered).toBe(3);
    expect(await page.textContent('#pol1')).toBe('•'.repeat(12));
  });

  test('(b) a typed format finds the same policies', async ({ page, ext }) => {
    await scanOn(ext);
    // The spec's "A##-####-####" is one letter and two digits; the policies are two letters: AA-####-####.
    const t = templateToRegex('AA-####-####');
    if (!t.ok) throw new Error(t.error);
    expect(t.description).toBe('2 letters, 4 digits, 4 digits');
    await ext.worker.evaluate(async (regex) => {
      const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({
        settings: {
          ...cur,
          customDetectors: [{ id: 'tpl-1', name: 'Policy', source: 'template', regex, labels: [], strength: 'high', scope: 'global', createdAt: Date.now() }],
        },
      });
    }, t.regex);
    await page.goto('/custom.html');
    await expectSuggested(ext, page, /^custom:tpl-1$/, POLICIES);
    // Preview from the popup path: counts without storing anything.
    const pv = await ext.send<{ ok: boolean; count: number }>(page, { type: 'PREVIEW_PATTERN', regex: t.regex, strength: t.strength, labels: [] });
    expect(pv).toEqual({ ok: true, count: 3 });
    const unsafe = await ext.send<{ ok: boolean; error: string }>(page, { type: 'PREVIEW_PATTERN', regex: '(a+)+$', strength: 'high', labels: [] });
    expect(unsafe.ok).toBe(false);
  });

  test('(c) catalogue: "driver license" entry on, a DL in California format is suggested', async ({ page, ext }) => {
    await scanOn(ext);
    await ext.worker.evaluate(async () => {
      const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({ settings: { ...cur, catalog: { 'dl-ca': true } } });
    });
    await page.goto('/custom.html');
    await expectSuggested(ext, page, /^catalog:dl-ca$/, ['dl']);
    const s = await scanState(ext, page);
    expect(s.suggestions.map((x) => x.elId)).not.toContain('pol1');
  });

  test('(d) storage holds the shape only: no digit or letter run of the example', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/custom.html');
    await teachPolicy(ext, page);
    await expect.poll(async () => (await siteRecord(ext))?.customDetectors?.length ?? 0).toBe(1);
    const all = JSON.stringify(await ext.worker.evaluate(() => chrome.storage.local.get(null)));
    for (const piece of ['2291', '4471', 'PX-', '"PX', 'PX2291']) expect(all).not.toContain(piece);
  });

  test('(e) locked: on reload, matches of a taught pattern are covered before the first paint', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/custom.html');
    await teachPolicy(ext, page);
    await expect.poll(async () => (await siteRecord(ext))?.customDetectors?.length ?? 0).toBe(1);
    const ctl = await controlPage(ext);
    await testSession(ctl, true);
    // Every animation frame (each one precedes a paint) checks the rendered text.
    await page.addInitScript(() => {
      const w = window as unknown as { __leaks: number; __frames: number };
      w.__leaks = 0;
      w.__frames = 0;
      const check = () => {
        w.__frames++;
        const t = document.documentElement?.innerText ?? '';
        // (The decoy PX-2291-44712 contains the first one: whole tokens only.)
        if (/PX-2291-4471(?!\d)|PX-3382-5562|QR-1029-3847/.test(t)) w.__leaks++;
        if (w.__frames < 120) requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    await page.reload();
    await expect.poll(() => page.textContent('#pol1'), { timeout: 3000 }).toBe('•'.repeat(12));
    await page.waitForTimeout(300);
    const { __leaks, __frames } = await page.evaluate(() => {
      const w = window as unknown as { __leaks: number; __frames: number };
      return { __leaks: w.__leaks, __frames: w.__frames };
    });
    expect(__frames).toBeGreaterThan(0);
    expect(__leaks).toBe(0);
    for (const id of POLICIES) expect(await page.textContent(`#${id}`)).toBe('•'.repeat(12));
    const st = await ext.state(page);
    expect(st.lock?.locked).toBe(true);
    expect(st.scan?.suggestions).toEqual([]);
    expect(st.scan?.chips).toBe(0);
    expect(st.scan?.autoCount).toBeGreaterThanOrEqual(3);
    // Refused while locked.
    const refused = await ext.send<{ ok: boolean; locked?: boolean }>(page, { type: 'TEACH_SELECTION' });
    expect(refused).toMatchObject({ ok: false, locked: true });
    // Decoys stay readable.
    expect(await page.textContent('#ord1')).toBe('ORD-558213');
    await testSession(ctl, false);
    await ctl.close();
  });

  test('(f) deleting the detector removes its suggestions', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/custom.html');
    const { id } = await teachPolicy(ext, page);
    await expectSuggested(ext, page, new RegExp(`^custom:${id}$`), POLICIES);
    // What the popup's delete button does: drop it from the site record.
    await ext.worker.evaluate(async (origin) => {
      const k = 'site:' + origin;
      const rec = (await chrome.storage.local.get(k))[k] as Record<string, unknown>;
      await chrome.storage.local.set({ [k]: { ...rec, customDetectors: [], updatedAt: Date.now() } });
    }, ORIGIN);
    await expectSuggested(ext, page, /^custom:/, []);
    expect((await scanState(ext, page)).suggestions).toEqual([]);
  });
});
