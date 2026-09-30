import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT_PATH = fileURLToPath(new URL('../../.output/chrome-mv3-dev/', import.meta.url));

export interface PieceInfo {
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lost: boolean;
  low: boolean;
}

export interface TestState {
  stickers: { id: string; kind: 'element' | 'rect'; status: 'resolving' | 'resolved' | 'lost'; pathPattern: string }[];
  state: { editMode: boolean; paused: boolean; stickerCount: number; lostCount: number; peeking?: boolean; locked?: boolean; lockReason?: string };
  pieces: PieceInfo[];
  lock?: {
    locked: boolean;
    reason?: string;
    signals: { debugger: boolean; manual: boolean; localSession: boolean; webdriver: boolean };
  };
  /** Strict input masking: whether it applies in this tab, and how many fields it holds. */
  strict?: { on: boolean; count: number };
}

export interface Ext {
  context: BrowserContext;
  worker: Worker;
  /** Send a message to the content script in the active tab's top frame. */
  send<T = unknown>(page: Page, msg: Record<string, unknown>): Promise<T>;
  cover(page: Page, selector: string): Promise<string>;
  rect(page: Page, r: { x: number; y: number; w: number; h: number }): Promise<{ id: string; kind: string }>;
  state(page: Page): Promise<TestState>;
}

export const test = base.extend<{ ext: Ext; page: Page }>({
  // eslint-disable-next-line no-empty-pattern
  ext: async ({}, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'aibs-'));
    // Google Chrome 137+ no longer honours --load-extension; Edge still does.
    // Override with AIBS_CHANNEL=chromium if Playwright's bundled Chromium
    // launches on your machine. Set AIBS_HEADED=1 to watch the tests.
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: process.env.AIBS_CHANNEL ?? 'msedge',
      headless: !process.env.AIBS_HEADED,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--disable-features=DisableLoadExtensionSwitch',
        '--hide-scrollbars',
      ],
      viewport: { width: 1000, height: 700 },
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    // Give onInstalled a moment to register the fixture origin.
    await worker.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        if (scripts.length > 0) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('content script never registered');
    });
    // Playwright is itself a debugger on every tab and sets navigator.webdriver,
    // so the AI-session auto-lock would lock the whole suite. The dev build
    // honours this flag; tests/e2e/lock.spec.ts clears it.
    await worker.evaluate(() => chrome.storage.local.set({ aibsNoAutoLock: true }));

    const send = async <T,>(page: Page, msg: Record<string, unknown>): Promise<T> => {
      await page.bringToFront();
      return worker.evaluate(async (m) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('no active tab');
        return chrome.tabs.sendMessage(tab.id, m, { frameId: 0 });
      }, msg) as Promise<T>;
    };

    const ext: Ext = {
      context,
      worker,
      send,
      cover: async (page, selector) => {
        const r = await send<{ ok: boolean; id?: string; error?: string }>(page, { type: 'TEST_COVER', selector });
        if (!r.ok) throw new Error(`cover failed: ${r.error}`);
        return r.id!;
      },
      rect: async (page, rect) => send(page, { type: 'TEST_RECT', rect }),
      state: async (page) => send<TestState>(page, { type: 'TEST_STATE' }),
    };
    await use(ext);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  },
  page: async ({ ext }, use) => {
    const page = await ext.context.newPage();
    await use(page);
    await page.close();
  },
});

export const expect = test.expect;

/** Viewport rect of an element via the page's own layout. */
export async function boxOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const rs = Array.from(el.getClientRects());
    const x1 = Math.min(...rs.map((r) => r.left));
    const y1 = Math.min(...rs.map((r) => r.top));
    const x2 = Math.max(...rs.map((r) => r.right));
    const y2 = Math.max(...rs.map((r) => r.bottom));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, rects: rs.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })) };
  }, selector);
}

/** Fraction of `target`'s area covered by the union of pieces (all axis-aligned). */
export function coverage(target: { x: number; y: number; w: number; h: number }, pieces: PieceInfo[]): number {
  if (target.w <= 0 || target.h <= 0) return 0;
  // Sample a grid; good enough for tests and avoids rectangle-union math.
  const N = 20;
  let hit = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const px = target.x + ((i + 0.5) / N) * target.w;
      const py = target.y + ((j + 0.5) / N) * target.h;
      if (pieces.some((p) => px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h)) hit++;
    }
  }
  return hit / (N * N);
}

/** Pixel colour at a viewport point, from a screenshot. */
export async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  // Decode the 1x1 PNG: find IDAT and inflate.
  const { inflateSync } = await import('node:zlib');
  let off = 8;
  const chunks: Buffer[] = [];
  let colorType = 6;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') colorType = data[9];
    if (type === 'IDAT') chunks.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  // First byte is the filter type for the row.
  return [raw[1], raw[2], bpp >= 3 ? raw[3] : raw[1]];
}
