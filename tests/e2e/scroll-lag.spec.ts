/**
 * Scroll lag: Chrome scrolls the document and overflow boxes on the
 * compositor thread, ahead of script, while the fixed sticker overlay is
 * repositioned from script on the next animation frame. Pixels that are not
 * DOM text (a canvas-drawn page, an <img>) have no bullets to fall back on,
 * so whatever covers them must move with the content itself: the in-page
 * cover (src/content/overlay/in-page-cover.ts).
 *
 * Each case draws a rect sticker, scrolls in 10 wheel steps and checks the
 * frame captured right after each step, without waiting for anything; then
 * freezes the overlay outright (TEST_FREEZE_OVERLAY) and scrolls again.
 */
import type { Page } from '@playwright/test';
import { test, expect, decodePng, type Ext } from './fixtures';

const STICKER: [number, number, number] = [0x1f, 0x29, 0x37];
/** An overlay piece's 1px top highlight and rim (styles.css): still the opaque sticker. */
const STICKER_EDGE: [number, number, number] = [78, 86, 97];
const near = (a: number[], b: number[], tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const stickerPixel = (px: number[]) => near(px, STICKER) || near(px, STICKER_EDGE, 12);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Case {
  name: string;
  url: string;
  viewport?: { width: number; height: number };
  /** Page-world setup after load (e.g. make the document scrollable). */
  prepare?: (page: Page) => Promise<void>;
  /** Current viewport box of the covered pixels. */
  target: (page: Page) => Promise<Box>;
  /** Visible region the target is clipped to (viewport or scroll box). */
  clip: (page: Page) => Promise<Box>;
  /** Where the wheel is turned. */
  wheelAt: (page: Page) => Promise<{ x: number; y: number }>;
  /** Scroll offset of whatever the wheel scrolls. */
  offset: (page: Page) => Promise<number>;
  step: number;
  /** Rect drawn this far outside the target (0: exactly over it, so it anchors to the image itself). */
  pad: number;
}

const viewportClip = async (page: Page): Promise<Box> => {
  const v = page.viewportSize()!;
  return { x: 0, y: 0, w: v.width, h: v.height };
};
const elBox = (sel: string) => (page: Page) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, sel);

const CASES: Case[] = [
  {
    name: 'canvas-drawn SSN, document scroll',
    url: '/canvas.html',
    viewport: { width: 1000, height: 400 },
    prepare: async (page) => {
      await page.addStyleTag({ content: 'body { padding-bottom: 600px; }' });
    },
    // window.ssnBox is measured at draw time, in viewport coordinates at scroll 0.
    target: (page) =>
      page.evaluate(() => {
        const b = (window as unknown as { ssnBox: { x: number; y: number; w: number; h: number } }).ssnBox;
        return { x: b.x, y: b.y - window.scrollY, w: b.w, h: b.h };
      }),
    clip: viewportClip,
    wheelAt: async () => ({ x: 500, y: 300 }),
    offset: (page) => page.evaluate(() => window.scrollY),
    step: 12,
    pad: 4,
  },
  {
    name: 'image in an overflow:auto box, box scroll',
    url: '/image-page.html',
    target: elBox('#card-scroll'),
    clip: async (page) => {
      const b = await elBox('#scroller')(page);
      return { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 };
    },
    wheelAt: async (page) => {
      const b = await elBox('#scroller')(page);
      return { x: b.x + b.w * 0.75, y: b.y + b.h / 2 };
    },
    offset: (page) => page.evaluate(() => document.getElementById('scroller')!.scrollTop),
    step: 10,
    pad: 0,
  },
  {
    name: 'image in the document flow, document scroll',
    url: '/image-page.html',
    target: elBox('#card-flow'),
    clip: viewportClip,
    wheelAt: async () => ({ x: 600, y: 640 }),
    offset: (page) => page.evaluate(() => window.scrollY),
    step: 30,
    pad: 0,
  },
];

/** Viewport points to sample inside the target: the centre and an inset grid, where visible. */
function samplePoints(t: Box, clip: Box): Array<[number, number]> {
  const pts: Array<[number, number]> = [[t.x + t.w / 2, t.y + t.h / 2]];
  for (const fx of [0.2, 0.4, 0.6, 0.8]) for (const fy of [0.3, 0.5, 0.7]) pts.push([t.x + t.w * fx, t.y + t.h * fy]);
  return pts.filter(([x, y]) => x > clip.x + 2 && x < clip.x + clip.w - 2 && y > clip.y + 2 && y < clip.y + clip.h - 2);
}

async function expectCovered(page: Page, c: Case, shot: Buffer, label: string) {
  const img = decodePng(shot);
  const t = await c.target(page);
  const pts = samplePoints(t, await c.clip(page));
  expect(pts.length, `${label}: target centre visible`).toBeGreaterThan(0);
  for (const [x, y] of pts) {
    const px = img.at(x, y);
    expect(stickerPixel(px), `${label}: pixel at ${Math.round(x)},${Math.round(y)} is ${px}`).toBe(true);
  }
}

async function setup(page: Page, ext: Ext, c: Case) {
  if (c.viewport) await page.setViewportSize(c.viewport);
  await page.goto(c.url);
  await page.evaluate(() => Promise.all(Array.from(document.images, (i) => i.decode().catch(() => {}))));
  await c.prepare?.(page);
  const t = await c.target(page);
  const r = await ext.rect(page, { x: t.x - c.pad, y: t.y - c.pad, w: t.w + c.pad * 2, h: t.h + c.pad * 2 });
  expect(r.kind).toBe('rect');
  await expect.poll(async () => (await ext.state(page)).stickers.map((s) => s.status)).toEqual(['resolved']);
  const w = await c.wheelAt(page);
  await page.mouse.move(w.x, w.y);
}

test.describe('scroll lag: non-text pixels under rect stickers', () => {
  for (const c of CASES) {
    test(`${c.name}: covered in the frame right after every wheel step`, async ({ page, ext }) => {
      await setup(page, ext, c);
      await expectCovered(page, c, await page.screenshot({ animations: 'disabled' }), 'before');
      let moved = 0;
      for (let step = 0; step < 10; step++) {
        const before = await c.offset(page);
        await page.mouse.wheel(0, c.step);
        // Immediately: the frame on screen right now, nothing awaited in between.
        const shot = await page.screenshot({ animations: 'disabled' });
        await expectCovered(page, c, shot, `step ${step + 1}`);
        if ((await c.offset(page)) !== before) moved++;
      }
      expect(moved, 'the wheel really scrolled').toBeGreaterThanOrEqual(8);
      // What did it: a cover inside the page, holding no text.
      expect(await page.evaluate(() => Array.from(document.querySelectorAll('aibs-cover'), (e) => e.textContent).join(''))).toBe('');
      expect(await page.evaluate(() => document.querySelectorAll('aibs-cover').length)).toBeGreaterThan(0);
    });

    test(`${c.name}: covered with the fixed overlay frozen`, async ({ page, ext }) => {
      await setup(page, ext, c);
      // Stand-in for compositor lag: the overlay stops following the page.
      await ext.send(page, { type: 'TEST_FREEZE_OVERLAY', on: true });
      const w = await c.wheelAt(page);
      await page.mouse.move(w.x, w.y);
      try {
        for (let step = 0; step < 6; step++) {
          const before = await c.offset(page);
          await page.mouse.wheel(0, c.step);
          await expect.poll(() => c.offset(page)).toBeGreaterThan(before);
          const shot = await page.screenshot({ animations: 'disabled' });
          await expectCovered(page, c, shot, `overlay frozen, step ${step + 1}`);
        }
      } finally {
        await ext.send(page, { type: 'TEST_FREEZE_OVERLAY', on: false });
      }
    });
  }
});
