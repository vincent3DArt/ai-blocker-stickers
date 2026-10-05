/**
 * Auto-suggest scanner and the locked-session auto-cover.
 *
 * The shared fixture turns the scanner off (`aibsNoScan`) so the other suites
 * see no suggestion chips and no auto-covers; every test here turns it back on.
 */
import type { Page } from '@playwright/test';
import { test, expect, ORIGIN, type Ext, type TestState } from './fixtures';

const BULLETS = '•'.repeat(11);
const SPA_SSN = '987-65-4321';

async function scanOn(ext: Ext) {
  await ext.worker.evaluate(() => chrome.storage.local.remove('aibsNoScan'));
}

type Scan = NonNullable<TestState['scan']>;

/** Wait until the idle scan has finished and return the scanner state. */
async function scanned(ext: Ext, page: Page, timeout = 5000): Promise<Scan> {
  let last: Scan | undefined;
  await expect
    .poll(
      async () => {
        last = (await ext.state(page)).scan;
        return !!last && !last.scanning && (last.stats?.finishedAt ?? 0) > 0;
      },
      { timeout },
    )
    .toBe(true);
  return last!;
}

async function controlPage(ext: Ext): Promise<Page> {
  const id = new URL(ext.worker.url()).host;
  const p = await ext.context.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  return p;
}

async function testSession(ctl: Page, active: boolean, keepAuto?: boolean) {
  const r = await ctl.evaluate(([a, k]) => chrome.runtime.sendMessage({ type: 'TEST_SESSION', active: a, keepAuto: k }), [active, keepAuto] as const);
  expect(r).toMatchObject({ ok: true });
}

async function siteRecord(ext: Ext) {
  return ext.worker.evaluate(async (origin) => {
    const k = 'site:' + origin;
    return (await chrome.storage.local.get(k))[k] as
      | { stickers: { id: string; source: string }[]; dismissedSuggestions?: string[] }
      | undefined;
  }, ORIGIN);
}

test.describe('auto-suggest', () => {
  test('static page: suggestions for the SSN cell, EIN, routing, spouse and dependent SSNs', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/static.html');
    const scan = await scanned(ext, page);
    const ids = scan.suggestions.map((s) => s.elId).filter(Boolean);
    expect(ids).toEqual(expect.arrayContaining(['ssn-cell', 'wrapped-span', 'dep-ssn']));
    const patterns = scan.suggestions.map((s) => s.pattern);
    expect(patterns).toContain('ein');
    expect(patterns).toContain('routing');
    const routing = scan.suggestions.find((s) => s.pattern === 'routing')!;
    // Label-gated at balanced: a routing number only counts next to its label.
    expect(routing.bonus).toBeGreaterThanOrEqual(1);
    // Drawn, and nothing is covered or masked by a suggestion.
    // (Chips are drawn in a task after the scan finishes, for the ones on screen.)
    await expect.poll(async () => (await ext.state(page)).scan?.chips).toBeGreaterThanOrEqual(5);
    expect((await ext.state(page)).scan!.chips).toBeLessThanOrEqual(scan.suggestions.length);
    expect(await page.textContent('#ssn-cell')).toBe('123-45-6789');
    expect((await ext.state(page)).stickers).toHaveLength(0);
    // The popup's count.
    const res = await ext.send<{ suggestions: unknown[]; total: number }>(page, { type: 'GET_SUGGESTIONS' });
    expect(res.suggestions.length).toBe(scan.suggestions.length);
  });

  test('false-positive corpus: no suggestions', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/fp-corpus.html');
    const scan = await scanned(ext, page);
    expect(scan.suggestions).toEqual([]);
    expect(scan.total).toBe(0);
    await page.waitForTimeout(100);
    expect((await ext.state(page)).scan?.chips).toBe(0);
  });

  test('"Cover all" produces stickers that survive a reload; a dismissal persists', async ({ page, ext }) => {
    await scanOn(ext);
    await page.goto('/static.html');
    const first = await scanned(ext, page);
    expect(first.suggestions.length).toBeGreaterThanOrEqual(5);

    // Dismiss the dependent SSN, then cover everything else.
    const dep = first.suggestions.find((s) => s.elId === 'dep-ssn')!;
    await ext.send(page, { type: 'DISMISS_SUGGESTION', id: dep.id });
    await expect.poll(async () => (await ext.state(page)).scan?.suggestions.length).toBe(first.suggestions.length - 1);
    const r = await ext.send<{ ok: boolean; covered: number }>(page, { type: 'TEST_COVER_SUGGESTIONS' });
    expect(r.ok).toBe(true);
    expect(r.covered).toBe(first.suggestions.length - 1);
    const st = await ext.state(page);
    expect(st.stickers).toHaveLength(first.suggestions.length - 1);
    expect(await page.textContent('#ssn-cell')).toBe(BULLETS);
    expect(st.scan?.chips).toBe(0);

    // Stored: the stickers (source "suggest") and the dismissal, never the text.
    await expect.poll(async () => (await siteRecord(ext))?.stickers.length).toBe(first.suggestions.length - 1);
    expect((await ext.state(page)).state.saveError).toBe(false);
    const rec = await siteRecord(ext);
    expect(rec!.stickers.every((s) => s.source === 'suggest')).toBe(true);
    expect(rec!.dismissedSuggestions).toHaveLength(1);
    expect(JSON.stringify(rec)).not.toContain('123-45-6789');

    await page.reload();
    await expect
      .poll(async () => (await ext.state(page)).stickers.filter((s) => s.status === 'resolved').length, { timeout: 5000 })
      .toBe(first.suggestions.length - 1);
    expect(await page.textContent('#ssn-cell')).toBe(BULLETS);
    const again = await scanned(ext, page);
    // Covered content is not suggested again, and the dismissed one stays dismissed.
    expect(again.suggestions.map((s) => s.elId)).not.toContain('dep-ssn');
    expect(again.suggestions).toHaveLength(0);
    expect(await page.textContent('#dep-ssn')).toBe('111-22-3333');
  });

  test('locked: an SPA route is auto-covered before it can be read, with no chips; End session keeps them', async ({ page, ext }) => {
    await scanOn(ext);
    const ctl = await controlPage(ext);
    await testSession(ctl, true);

    await page.goto('/app/clients/456', { waitUntil: 'commit' });
    await expect
      .poll(
        async () => {
          const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          return text.includes('Client 456') && !text.includes(SPA_SSN);
        },
        { timeout: 3000, intervals: [25] },
      )
      .toBe(true);
    const aria = await page.locator('body').ariaSnapshot();
    expect(aria).not.toContain(SPA_SSN);
    expect(await page.textContent('#client-ssn')).toBe(BULLETS);

    const st = await ext.state(page);
    expect(st.lock?.locked).toBe(true);
    expect(st.stickers.length).toBeGreaterThanOrEqual(1);
    expect(st.scan?.suggestions).toEqual([]);
    expect(st.scan?.chips).toBe(0);
    expect(st.scan?.autoCount).toBeGreaterThanOrEqual(1);
    // Session-scoped: nothing stored while the session runs.
    expect((await siteRecord(ext))?.stickers ?? []).toHaveLength(0);

    // SPA navigation while locked: the next client is covered too.
    await page.evaluate(() => (window as unknown as { __spa: { go(p: string): void } }).__spa.go('/app/clients/123'));
    await expect.poll(() => page.textContent('#client-ssn'), { timeout: 3000, intervals: [25] }).toBe(BULLETS);

    // End the session, keeping them: stored, and still there after a reload.
    await testSession(ctl, false, true);
    await expect.poll(async () => (await siteRecord(ext))?.stickers.filter((s) => s.source === 'session-auto').length ?? 0).toBeGreaterThanOrEqual(1);
    await page.goto('/app/clients/456');
    await expect.poll(() => page.textContent('#client-ssn'), { timeout: 5000 }).toBe(BULLETS);
    expect((await ext.state(page)).lock?.locked).toBe(false);
    await ctl.close();
  });

  test('locked: End session without keeping drops the auto-covers', async ({ page, ext }) => {
    await scanOn(ext);
    const ctl = await controlPage(ext);
    await testSession(ctl, true);
    await page.goto('/app/clients/456');
    await expect.poll(() => page.textContent('#client-ssn'), { timeout: 1500 }).toBe(BULLETS);
    expect((await ext.state(page)).scan?.chips).toBe(0);

    await testSession(ctl, false, false);
    await expect.poll(() => page.textContent('#client-ssn'), { timeout: 3000 }).toBe(SPA_SSN);
    const rec = await siteRecord(ext);
    expect((rec?.stickers ?? []).filter((s) => s.source === 'session-auto')).toHaveLength(0);
    // Unlocked again: the number is offered as a suggestion instead.
    await expect.poll(async () => (await ext.state(page)).scan?.chips ?? 0, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await ctl.close();
  });

  test('performance: a 5000-row table scans without long tasks, in under 2 s', async ({ page, ext }) => {
    await scanOn(ext);
    await page.addInitScript(() => {
      const w = window as unknown as { __longtasks: { start: number; duration: number }[] };
      w.__longtasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__longtasks.push({ start: e.startTime, duration: e.duration });
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* unsupported */
      }
    });
    await page.goto('/big-table.html');
    const scan = await scanned(ext, page, 15_000);
    const stats = scan.stats!;
    const duration = stats.finishedAt - stats.startedAt;
    const long = await page.evaluate(
      ([from, to]) =>
        (window as unknown as { __longtasks: { start: number; duration: number }[] }).__longtasks.filter(
          (t) => t.start + t.duration >= from && t.start <= to,
        ),
      [stats.startedAt, stats.finishedAt] as const,
    );
    console.info(
      `[big-table] scan ${Math.round(duration)} ms, ${stats.textNodes} text nodes, ${stats.blocks} blocks, ${stats.chunks} chunks, ` +
        `max chunk ${stats.maxChunkMs.toFixed(1)} ms, ${scan.total} detections, ${long.length} long task(s) during the scan ` +
        `(scan ${Math.round(stats.startedAt)}-${Math.round(stats.finishedAt)} ms; ${JSON.stringify(long)})`,
    );
    expect(stats.textNodes).toBeGreaterThanOrEqual(10_000);
    expect(scan.total).toBeGreaterThanOrEqual(5000);
    expect(scan.suggestions.length).toBeLessThanOrEqual(200);
    expect(long.filter((t) => t.duration > 50)).toEqual([]);
    expect(duration).toBeLessThan(2000);
  });
});
