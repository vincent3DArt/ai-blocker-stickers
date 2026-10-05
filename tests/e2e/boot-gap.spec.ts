/**
 * Boot gap: how long, after the covered element exists in the DOM, its
 * secret can still be read from the page's own (MAIN) world before the mask
 * lands. A script injected at document start polls `innerText` every 10 ms
 * (the way an agent's polling reader would) and records:
 *   - `seen`: the first sample where the secret's characters, raw or masked,
 *     are in the DOM (the element exists),
 *   - `leak`: the last sample where `innerText` holds the secret raw.
 * The gap is `leak - seen` (0 when it never leaked). Budget: 50 ms.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, type Ext } from './fixtures';

const SECRET = '123-45-6789';
const BUDGET_MS = 50;

interface Gap {
  seen: number;
  leak: number;
  samples: number;
}

async function installProbe(page: Page) {
  await page.addInitScript((secret) => {
    const bullets = 'â€¢'.repeat(secret.length);
    const g = { seen: -1, leak: -1, samples: 0 };
    (window as unknown as { __gap: typeof g }).__gap = g;
    const sample = () => {
      const b = document.body;
      if (!b) return;
      g.samples++;
      const now = performance.now();
      const tc = b.textContent ?? '';
      if (g.seen < 0 && (tc.includes(secret) || tc.includes(bullets))) g.seen = now;
      if (b.innerText.includes(secret)) g.leak = now;
    };
    setInterval(sample, 10);
  }, SECRET);
}

const gapOf = (g: Gap) => (g.seen < 0 ? NaN : g.leak < 0 ? 0 : Math.max(0, g.leak - g.seen));

async function measureReload(page: Page): Promise<Gap> {
  await page.reload({ waitUntil: 'commit' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
  return page.evaluate(() => (window as unknown as { __gap: Gap }).__gap);
}

async function resolved(ext: Ext, page: Page) {
  await expect.poll(async () => (await ext.state(page).catch(() => undefined))?.stickers?.[0]?.status, { timeout: 8000 }).toBe('resolved');
}

function report(name: string, g: Gap) {
  const gap = gapOf(g);
  test.info().annotations.push({ type: 'boot-gap', description: `${name}: ${Number.isNaN(gap) ? 'n/a' : gap.toFixed(1) + ' ms'} (${g.samples} samples)` });
  console.log(`[boot-gap] ${name}: ${Number.isNaN(gap) ? 'n/a' : gap.toFixed(1) + ' ms'} (${g.samples} samples)`);
  expect(g.seen, `${name}: the probe never saw the element`).toBeGreaterThanOrEqual(0);
  expect(gap, `${name}: secret readable ${gap} ms after the element existed`).toBeLessThanOrEqual(BUDGET_MS);
}

/** CSS files registered for the fixture origin: `['cloak.css']` once it has stickers. */
const cloakCss = (ext: Ext) =>
  ext.worker.evaluate(async () => {
    const all = await chrome.scripting.getRegisteredContentScripts();
    return all.filter((s) => s.matches?.some((m) => m.startsWith('http://127.0.0.1:'))).flatMap((s) => s.css ?? []);
  });

/** The first sticker on an origin turns the cloak on for its next load (registration is async). */
async function cloakOn(ext: Ext) {
  await expect.poll(() => cloakCss(ext)).toEqual(['cloak.css']);
}

test.describe('boot gap (MAIN-world innerText polled every 10 ms)', () => {
  for (const c of [
    { name: 'static.html', url: '/static.html', sel: '#ssn-cell' },
    { name: 'layout-shift.html', url: '/layout-shift.html', sel: '#rows tr[data-key="9876543210"] td.col-ssn' },
    { name: 'spa.html', url: '/app/clients/123', sel: '#client-ssn' },
  ]) {
    test(`${c.name}: reload`, async ({ page, ext }) => {
      await page.goto(c.url);
      await ext.cover(page, c.sel);
      await cloakOn(ext);
      await installProbe(page);
      report(c.name, await measureReload(page));
      await resolved(ext, page);
    });
  }

  test('spa.html: in-app navigation back to the record', async ({ page, ext }) => {
    await page.goto('/app/clients/123');
    await ext.cover(page, '#client-ssn');
    await installProbe(page);
    await page.goto('/app/settings');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const g = (window as unknown as { __gap: Gap }).__gap;
      g.seen = -1;
      g.leak = -1;
      (window as unknown as { __spa: { go(p: string): void } }).__spa.go('/app/clients/123');
    });
    await page.waitForTimeout(1500);
    report('spa.html (pushState)', await page.evaluate(() => (window as unknown as { __gap: Gap }).__gap));
  });

  test('drive viewer: opening the previewed file again', async ({ page, ext }) => {
    type Drive = { open(id: 'A' | 'B'): void; close(): void; ssnSelector(): string | null };
    await page.goto('/drive-home');
    await page.evaluate(() => (window as unknown as { __drive: Drive }).__drive.open('A'));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __drive: Drive }).__drive.ssnSelector())).not.toBeNull();
    const sel = await page.evaluate(() => (window as unknown as { __drive: Drive }).__drive.ssnSelector());
    await ext.cover(page, sel!);
    await page.evaluate(() => (window as unknown as { __drive: Drive }).__drive.close());
    await installProbe(page);
    await page.reload();
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const g = (window as unknown as { __gap: Gap }).__gap;
      g.seen = -1;
      g.leak = -1;
      (window as unknown as { __drive: Drive }).__drive.open('A');
    });
    await page.waitForTimeout(2000);
    report('drive viewer (open)', await page.evaluate(() => (window as unknown as { __gap: Gap }).__gap));
  });
});

/**
 * Boot cloak (public/cloak.css): the page is `visibility:hidden` from
 * document start until the content script has placed what applies here. A
 * MAIN-world probe samples the root's computed visibility at document start
 * (as soon as the root element exists) and then every 5 ms; `hiddenFor` is the
 * time from the first sample to the first visible one.
 */
interface Cloak {
  first: string;
  start: number;
  visibleAt: number;
  samples: number;
}

async function installCloakProbe(page: Page) {
  await page.addInitScript(() => {
    const c = { first: '', start: -1, visibleAt: -1, samples: 0 };
    (window as unknown as { __cloak: typeof c }).__cloak = c;
    const sample = () => {
      // An init script can run before the root element exists.
      if (!document.documentElement) return;
      const v = getComputedStyle(document.documentElement).visibility;
      if (!c.samples++) {
        c.first = v;
        c.start = performance.now();
      }
      if (c.visibleAt < 0 && v === 'visible') {
        c.visibleAt = performance.now();
        clearInterval(t);
      }
    };
    const t = setInterval(sample, 5);
    sample();
  });
}

async function cloakOf(page: Page, url: string): Promise<Cloak & { hiddenFor: number }> {
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForLoadState('load');
  const read = () => page.evaluate(() => (window as unknown as { __cloak: Cloak }).__cloak);
  await expect
    .poll(async () => (await read()).visibleAt, {
      timeout: 5000,
      message: `page never became visible: ${JSON.stringify(await read().catch(() => null))}`,
    })
    .toBeGreaterThan(0);
  const c = await read();
  return { ...c, hiddenFor: c.visibleAt - c.start };
}

function cloakReport(name: string, c: Cloak & { hiddenFor: number }) {
  const d = `${name}: first sample ${c.first}, hidden for ${c.hiddenFor.toFixed(1)} ms (${c.samples} samples)`;
  test.info().annotations.push({ type: 'cloak', description: d });
  console.log(`[cloak] ${d}`);
}

test.describe('boot cloak', () => {
  test('no flash when nothing to cover', async ({ page, ext }) => {
    await ext.worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('site:')));
    });
    await installCloakProbe(page);
    // The first load also creates the per-install secret: held to the failsafe only.
    const first = await cloakOf(page, '/static.html');
    cloakReport('static.html, no stickers, first load', first);
    expect(first.hiddenFor).toBeLessThan(1500);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).visibility)).toBe('visible');
    let worst = 0;
    for (let i = 0; i < 3; i++) {
      const c = await cloakOf(page, '/static.html');
      cloakReport(`static.html, no stickers, load ${i + 1}`, c);
      worst = Math.max(worst, c.hiddenFor);
    }
    expect(worst, 'page stayed hidden with nothing to cover').toBeLessThan(60);
  });

  test('the cloak is registered only while the origin has stickers', async ({ page, ext }) => {
    await expect.poll(() => cloakCss(ext)).toEqual([]);
    await page.goto('/static.html');
    const id = await ext.cover(page, '#ssn-cell');
    await cloakOn(ext);
    await ext.send(page, { type: 'DELETE_STICKER', id });
    await expect.poll(() => cloakCss(ext)).toEqual([]);
  });

  test('origins the extension is not registered for get no cloak', async ({ page }) => {
    const html = await readFile(fileURLToPath(new URL('../../fixtures/static.html', import.meta.url)), 'utf8');
    await page.route('http://not-enabled.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await installCloakProbe(page);
    const c = await cloakOf(page, 'http://not-enabled.test/static.html');
    cloakReport('unregistered origin', c);
    expect(c.first).toBe('visible');
    expect(await page.locator('aibs-host').count()).toBe(0);
  });

  test('a content script that fails to boot lifts the cloak at once', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    await cloakOn(ext);
    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    // Dev-only switch: boot throws before mounting anything, as a broken build would.
    await ext.worker.evaluate(() => chrome.storage.local.set({ aibsFailBoot: true }));
    try {
      await installCloakProbe(page);
      const c = await cloakOf(page, '/static.html');
      cloakReport('boot failure', c);
      expect(c.first).toBe('hidden');
      expect(c.hiddenFor, 'the content script failsafe').toBeLessThan(1500);
    } catch (e) {
      console.log('[cloak] boot failure console:', consoleLines.join(' | '));
      throw e;
    } finally {
      await ext.worker.evaluate(() => chrome.storage.local.remove('aibsFailBoot'));
    }
  });
});
