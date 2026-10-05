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
    const bullets = '•'.repeat(secret.length);
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

test.describe('boot gap (MAIN-world innerText polled every 10 ms)', () => {
  for (const c of [
    { name: 'static.html', url: '/static.html', sel: '#ssn-cell' },
    { name: 'layout-shift.html', url: '/layout-shift.html', sel: '#rows tr[data-key="9876543210"] td.col-ssn' },
    { name: 'spa.html', url: '/app/clients/123', sel: '#client-ssn' },
  ]) {
    test(`${c.name}: reload`, async ({ page, ext }) => {
      await page.goto(c.url);
      await ext.cover(page, c.sel);
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
