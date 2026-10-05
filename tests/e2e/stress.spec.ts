/**
 * Stress matrix: pages that behave like real apps (virtualised lists, tabs,
 * web components, reloading frames, RTL and zoom, late fonts, SPA routers,
 * rich-text editors, print media, hostile page scripts). Every fixture under
 * fixtures/stress/ exposes `window.__fx` (see fixtures/stress/common.js).
 *
 * For each fixture an element sticker and a rect sticker are placed on its
 * secret, every action is run, and after each one:
 *   - the sticker is resolved,
 *   - its pieces cover >= 98 % of the target (the element, or for a rect the
 *     secret's characters),
 *   - no piece lies outside the target's box padded by 5 px,
 *   - no frame's innerText (shadow roots included) nor ariaSnapshot holds the
 *     secret,
 *   - a screenshot pixel at the target's centre is sticker-coloured.
 * Actions are asynchronous re-renders, so each check polls until all of that
 * holds at the same moment, for at most CHECK_MS.
 */
import type { Page } from '@playwright/test';
import { test, expect, coverage, pixelAt, type Ext, type PieceInfo, type TestState } from './fixtures';

type Box = { x: number; y: number; w: number; h: number };
interface Target {
  el: Box;
  secret: Box;
  offset: { x: number; y: number };
}
interface Cover {
  selector: string;
  shadowPath?: string[];
  frame?: string;
}
type Kind = 'element' | 'rect';

const STICKER: [number, number, number] = [0x1f, 0x29, 0x37];
const CHECK_MS = 5000;
const PAD = 5;

interface Fixture {
  name: string;
  url: string;
  /** Kinds that cannot pass, with the reason (test.fixme + docs/LIMITATIONS.md). */
  fixme?: Partial<Record<Kind, string>>;
}

const FIXTURES: Fixture[] = [
  { name: 'react-list', url: '/stress/react-list.html' },
  { name: 'tabs-accordion', url: '/stress/tabs-accordion.html' },
  { name: 'shadow-app', url: '/stress/shadow-app.html' },
  { name: 'iframe-app (reloading frame)', url: '/stress/iframe-app.html' },
  { name: 'iframe-app (two levels deep)', url: '/stress/iframe-app.html?v=nested' },
  { name: 'rtl-zoom', url: '/stress/rtl-zoom.html' },
  { name: 'late-fonts', url: '/stress/late-fonts.html' },
  { name: 'spa-router', url: '/stress/clients/1' },
  { name: 'contenteditable (editor)', url: '/stress/contenteditable.html' },
  { name: 'contenteditable (textarea)', url: '/stress/contenteditable.html?v=textarea' },
  { name: 'print', url: '/stress/print.html' },
  { name: 'aggressive-page', url: '/stress/aggressive-page.html' },
];

const fx = <T,>(page: Page, fn: string, arg?: unknown) =>
  page.evaluate(
    ([f, a]) => (window as unknown as { __fx: Record<string, (x?: unknown) => unknown> }).__fx[f as string](a),
    [fn, arg] as const,
  ) as Promise<T>;

const fxGet = <T,>(page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as { __fx: Record<string, unknown> }).__fx[k], key) as Promise<T>;

async function ready(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as { __fx?: unknown }).__fx);
}

/** Message the content script of the frame whose pathname is `frame` (top frame when absent). */
async function sendTo<T>(ext: Ext, page: Page, frame: string | undefined, msg: Record<string, unknown>): Promise<T> {
  if (!frame) return ext.send<T>(page, msg);
  await page.bringToFront();
  return ext.worker.evaluate(
    async ({ p, m }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, func: () => location.pathname });
      const hit = res.find((r) => r.result === p);
      if (!hit) throw new Error(`no frame ${p}`);
      return chrome.tabs.sendMessage(tab.id!, m, { frameId: hit.frameId });
    },
    { p: frame, m: msg },
  ) as Promise<T>;
}

/** Everything a page reader gets as text: every same-origin frame's innerText, open shadow roots included. */
async function pageTexts(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visitDoc = (doc: Document) => {
      if (!doc.body) return;
      out.push(doc.body.innerText);
      const walk = (root: Document | ShadowRoot) => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const sr = (el as HTMLElement).shadowRoot;
          if (sr) {
            for (const c of Array.from(sr.children)) if (c.tagName !== 'STYLE') out.push((c as HTMLElement).innerText ?? c.textContent ?? '');
            walk(sr);
          }
          if (el.tagName === 'IFRAME') {
            try {
              const d = (el as HTMLIFrameElement).contentDocument;
              if (d) visitDoc(d);
            } catch {
              /* cross-origin */
            }
          }
        }
      };
      walk(doc);
    };
    visitDoc(document);
    return out.join('\n');
  });
}

async function ariaTexts(page: Page): Promise<string> {
  const out: string[] = [];
  for (const f of page.frames()) {
    out.push(await f.locator('body').ariaSnapshot({ timeout: 1000 }).catch(() => ''));
  }
  return out.join('\n');
}

const near = (a: [number, number, number], b: [number, number, number], tol = 10) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Every way the current moment falls short of "stays put and does not leak"; empty when it holds. */
async function problems(page: Page, ext: Ext, cover: Cover, kind: Kind): Promise<string[]> {
  const out: string[] = [];
  const t = await fx<Target | null>(page, 'target').catch(() => null);
  if (!t) return ['target not in the DOM'];
  const st = await sendTo<TestState>(ext, page, cover.frame, { type: 'TEST_STATE' }).catch(() => undefined);
  if (!st) return ['content script did not answer'];
  if (st.stickers.length !== 1) out.push(`expected 1 sticker, got ${st.stickers.length}`);
  else if (st.stickers[0].status !== 'resolved') out.push(`status ${st.stickers[0].status}`);
  const box = kind === 'element' ? t.el : t.secret;
  const pieces: PieceInfo[] = st.pieces;
  const cov = coverage(box, pieces);
  if (cov < 0.98) out.push(`coverage ${cov.toFixed(2)} of ${JSON.stringify(box)} by ${JSON.stringify(pieces.map(({ x, y, w, h }) => ({ x, y, w, h })))}`);
  for (const p of pieces) {
    if (p.x < box.x - PAD || p.y < box.y - PAD || p.x + p.w > box.x + box.w + PAD || p.y + p.h > box.y + box.h + PAD) {
      out.push(`piece ${JSON.stringify({ x: p.x, y: p.y, w: p.w, h: p.h })} outside ${JSON.stringify(box)}`);
    }
  }
  const secrets = await fx<string[]>(page, 'secrets');
  const texts = await pageTexts(page).catch(() => '');
  const aria = await ariaTexts(page);
  for (const s of secrets) {
    if (texts.includes(s)) out.push(`innerText holds ${s}`);
    if (aria.includes(s)) out.push(`ariaSnapshot holds ${s}`);
  }
  const cx = t.offset.x + box.x + box.w / 2;
  const cy = t.offset.y + box.y + box.h / 2;
  const vp = page.viewportSize()!;
  if (cx < 0 || cy < 0 || cx >= vp.width || cy >= vp.height) out.push(`target centre ${cx},${cy} outside the viewport`);
  else {
    const px = await pixelAt(page, cx, cy);
    if (!near(px, STICKER)) out.push(`pixel at target centre is ${px}`);
  }
  return out;
}

async function check(page: Page, ext: Ext, cover: Cover, kind: Kind, step: string) {
  let last: string[] = [];
  const until = Date.now() + CHECK_MS;
  do {
    last = await problems(page, ext, cover, kind);
    if (!last.length) return;
    await page.waitForTimeout(100);
  } while (Date.now() < until);
  expect(last, `after ${step}`).toEqual([]);
}

async function runAction(page: Page, action: string) {
  if (action === 'spec:reload') {
    await page.reload();
    await ready(page);
  } else if (action.startsWith('spec:vp:')) {
    const [w, h] = action.slice(8).split('x').map(Number);
    await page.setViewportSize({ width: w, height: h });
  } else if (action === 'spec:print') {
    await page.emulateMedia({ media: 'print' });
  } else if (action === 'spec:screen') {
    await page.emulateMedia({ media: 'screen' });
  } else {
    await fx(page, 'run', action);
  }
}

async function place(page: Page, ext: Ext, cover: Cover, kind: Kind) {
  let t: Target | null = null;
  await expect.poll(async () => (t = await fx<Target | null>(page, 'target').catch(() => null)) !== null, { timeout: 5000 }).toBe(true);
  if (kind === 'element') {
    const r = await sendTo<{ ok: boolean; error?: string }>(ext, page, cover.frame, { type: 'TEST_COVER', selector: cover.selector, shadowPath: cover.shadowPath });
    expect(r.ok, r.error).toBe(true);
  } else {
    const s = t!.secret;
    const r = await sendTo<{ ok: boolean; kind: string }>(ext, page, cover.frame, { type: 'TEST_RECT', rect: { x: s.x - 1, y: s.y - 1, w: s.w + 2, h: s.h + 2 } });
    expect(r.kind).toBe('rect');
  }
}

for (const f of FIXTURES) {
  test.describe(`stress: ${f.name}`, () => {
    for (const kind of ['element', 'rect'] as const) {
      test(`${kind} sticker stays put through every action`, async ({ page, ext }) => {
        test.fixme(!!f.fixme?.[kind], f.fixme?.[kind]);
        test.setTimeout(150_000);
        await page.goto(f.url);
        await ready(page);
        const cover = await fxGet<Cover>(page, 'cover');
        await place(page, ext, cover, kind);
        await check(page, ext, cover, kind, 'placement');
        const actions = await fxGet<string[]>(page, 'actions');
        for (const [i, a] of actions.entries()) {
          await runAction(page, a);
          await check(page, ext, cover, kind, `${i + 1}:${a}`);
        }
      });
    }
  });
}
