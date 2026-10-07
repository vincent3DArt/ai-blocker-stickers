/**
 * Red team: every way an automated agent's MAIN-world script (or its CDP
 * tooling) could still read what sits under a sticker. Each test covers the
 * four sticker kinds on their fixture:
 *   - element sticker  `#ssn-cell`              (static.html)
 *   - rect sticker     tight rect on 987-65-4321 in `#wrapped-span` (static.html)
 *   - input mode       `#ssn`                   (forms.html)
 *   - visual-only      `#photo`                 (forms.html)
 * Secrets that are NOT under a sticker are neutralised first, so any secret a
 * whole-page read returns can only have come from under a sticker.
 *
 * Numbers in test names refer to the red-team channel list.
 */
import type { Page } from '@playwright/test';
import { test, expect, boxOf, pixelAt, ORIGIN, type Ext } from './fixtures';

const SECRETS = ['123-45-6789', '987-65-4321', '111-22-3333', '9876543210', 'Social security number', 'SSN card'];
const STICKER: [number, number, number] = [0x1f, 0x29, 0x37];

type Box = { x: number; y: number; w: number; h: number };

function near(a: [number, number, number], b: [number, number, number], tol = 8) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

function clean(label: string, text: string | null | undefined, secrets = SECRETS) {
  const s = text ?? '';
  for (const x of secrets) expect(s, `${label} leaked "${x}"`).not.toContain(x);
}

function cleanAll(reads: Record<string, string>, secrets = SECRETS) {
  for (const [k, v] of Object.entries(reads)) clean(k, v, secrets);
}

async function substringRect(page: Page, selector: string, needle: string, pad = 1): Promise<Box> {
  return page.evaluate(
    ({ sel, needle, p }) => {
      const el = document.querySelector(sel)!;
      const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n as Text).data.includes(needle)) as Text;
      const start = node.data.indexOf(needle);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const r = range.getBoundingClientRect();
      return { x: r.left - p, y: r.top - p, w: r.width + p * 2, h: r.height + p * 2 };
    },
    { sel: selector, needle, p: pad },
  );
}

/** Viewport rect of the first run of bullets inside `selector`. */
async function bulletRun(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const d = (n as Text).data;
      const i = d.indexOf('•');
      if (i < 0) continue;
      let j = i;
      while (j < d.length && d[j] === '•') j++;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, j);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    throw new Error(`no bullet run in ${sel}`);
  }, selector);
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

async function coveredAt(page: Page, b: Box): Promise<boolean> {
  const c = centre(b);
  return near(await pixelAt(page, c.x, c.y), STICKER);
}

/** Fraction of sticker-coloured pixels inside a viewport box, from a real screenshot. */
async function stickerFraction(page: Page, b: Box): Promise<number> {
  const png = await page.screenshot({
    clip: { x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y)), width: Math.max(1, Math.round(b.w)), height: Math.max(1, Math.round(b.h)) },
  });
  return page.evaluate(
    async ({ b64, rgb }) => {
      const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let hit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - rgb[0]) <= 8 && Math.abs(d[i + 1] - rgb[1]) <= 8 && Math.abs(d[i + 2] - rgb[2]) <= 8) hit++;
      }
      return hit / (d.length / 4);
    },
    { b64: png.toString('base64'), rgb: STICKER },
  );
}

// ---------------------------------------------------------------- setups

interface StaticSetup {
  cellId: string;
  rectId: string;
  /** Raw markup of the masked elements' parents, captured before masking. */
  rawCellParent: string;
  rawSpanParent: string;
}

async function setupStatic(page: Page, ext: Ext): Promise<StaticSetup> {
  await page.goto('/static.html');
  await page.evaluate(() => {
    for (const sel of ['#hdr-account', '#identity .acct', '#bottom-account', '#dep-ssn']) {
      document.querySelector(sel)!.textContent = 'n/a';
    }
  });
  const raw = await page.evaluate(() => ({
    cell: document.getElementById('ssn-cell')!.parentElement!.innerHTML,
    span: document.getElementById('wrapped-span')!.parentElement!.innerHTML,
  }));
  const cellId = await ext.cover(page, '#ssn-cell');
  const sub = await substringRect(page, '#wrapped-span', '987-65-4321');
  const r = await ext.rect(page, sub);
  expect(r.kind).toBe('rect');
  expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));
  expect(await page.textContent('#wrapped-span')).toContain('•'.repeat(11));
  return { cellId, rectId: r.id, rawCellParent: raw.cell, rawSpanParent: raw.span };
}

interface FormsSetup {
  ssnId: string;
  photoId: string;
  rawSsnParent: string;
  rawPhotoParent: string;
}

async function setupForms(page: Page, ext: Ext): Promise<FormsSetup> {
  await page.goto('/forms.html');
  await page.evaluate(() => {
    // The live re-render demo and the page's own <script> source mention the SSN.
    document.getElementById('react-ish')!.remove();
    document.querySelectorAll('script').forEach((s) => s.remove());
    const acct = document.getElementById('acct') as HTMLInputElement;
    acct.setAttribute('value', 'n/a');
    acct.value = 'n/a';
    const notes = document.getElementById('notes') as HTMLTextAreaElement;
    notes.textContent = 'n/a';
    notes.value = 'n/a';
    document.getElementById('editor')!.textContent = 'n/a';
    // Give the photo its own parent so a churn test can rewrite just that.
    const photo = document.getElementById('photo')!;
    const wrap = document.createElement('div');
    wrap.id = 'photo-wrap';
    photo.replaceWith(wrap);
    wrap.appendChild(photo);
  });
  const raw = await page.evaluate(() => ({
    ssn: document.getElementById('ssn')!.parentElement!.innerHTML,
    photo: document.getElementById('photo-wrap')!.innerHTML,
  }));
  const ssnId = await ext.cover(page, '#ssn');
  const photoId = await ext.cover(page, '#photo');
  return { ssnId, photoId, rawSsnParent: raw.ssn, rawPhotoParent: raw.photo };
}

// ---------------------------------------------------------------- readers

/** Channels 1, 2, 4 and 5, exactly as a MAIN-world script sees them. `.value` is excluded (channel 15). */
async function mainWorldReads(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const b = document.body;
    // 1
    out.innerText = b.innerText;
    out.textContent = b.textContent ?? '';
    out.bodyOuterHTML = b.outerHTML;
    out.bodyInnerHTML = b.innerHTML;
    out.docOuterHTML = document.documentElement.outerHTML;
    out.docInnerText = document.documentElement.innerText;
    out.xml = new XMLSerializer().serializeToString(document);
    // 2
    const w = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    let n: Node | null;
    while ((n = w.nextNode())) texts.push((n as Text).data);
    out.treeWalker = texts.join('|');
    const r = document.createRange();
    r.selectNodeContents(b);
    out.range = r.toString();
    out.rangeFragment = new XMLSerializer().serializeToString(r.cloneContents());
    const sel = getSelection()!;
    sel.selectAllChildren(b);
    out.selection = sel.toString();
    sel.removeAllRanges();
    // 4
    const per: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      per.push((el as HTMLElement).innerText ?? '', el.textContent ?? '');
    }
    out.perElement = per.join('|');
    // 5
    const attrs: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) attrs.push(`${a.name}=${a.value}`);
      for (const k of ['alt', 'title', 'aria-label', 'placeholder', 'value']) attrs.push(el.getAttribute(k) ?? '');
      if (el instanceof HTMLElement) attrs.push(JSON.stringify({ ...el.dataset }));
      if (el instanceof HTMLImageElement) attrs.push(el.currentSrc, el.src, el.srcset);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) attrs.push(el.defaultValue);
    }
    out.attributes = attrs.join('|');
    return out;
  });
}

/** Channel 3: Playwright's aria snapshot and the raw CDP accessibility tree (every field of every node). */
async function axReads(page: Page): Promise<Record<string, string>> {
  const snap = await page.locator('body').ariaSnapshot();
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: unknown[] };
  await cdp.detach();
  return { ariaSnapshot: snap, cdpAXTree: JSON.stringify(nodes) };
}

async function pageInnerText(page: Page) {
  return page.evaluate(() => document.body.innerText + '\n' + (document.body.textContent ?? ''));
}

// ================================================================= tests

test.describe('red team: MAIN-world readers', () => {
  test('1,2,4,5 static: serialisers, walkers, ranges, selection, attributes', async ({ page, ext }) => {
    await setupStatic(page, ext);
    // Things a page commonly hangs on a value: they must not survive either.
    await page.evaluate(() => {
      const cell = document.getElementById('ssn-cell')!;
      // Set before masking would be the realistic order; setting after tests the guard.
      cell.setAttribute('data-value', '123-45-6789');
      cell.setAttribute('aria-valuetext', 'SSN 123-45-6789');
      cell.setAttribute('title', '123-45-6789');
    });
    await page.waitForTimeout(50);
    cleanAll(await mainWorldReads(page));
    // Control: things we never touch are untouched.
    expect(await page.title()).toBe('Fixture: static client page');
    expect(await page.evaluate(() => document.querySelector('meta')!.getAttribute('charset'))).toBe('utf-8');
    const t = await pageInnerText(page);
    expect(t).toContain('spouse SSN is');
    expect(t).toContain('and this inline span wraps');
  });

  test('5 static: attributes set before the sticker are scrubbed too', async ({ page, ext }) => {
    await page.goto('/static.html');
    await page.evaluate(() => {
      for (const sel of ['#hdr-account', '#identity .acct', '#bottom-account', '#dep-ssn']) document.querySelector(sel)!.textContent = 'n/a';
      const cell = document.getElementById('ssn-cell')!;
      cell.setAttribute('data-value', '123-45-6789');
      cell.setAttribute('data-digits', '123456789');
      cell.setAttribute('aria-valuetext', 'SSN 123-45-6789');
    });
    const id = await ext.cover(page, '#ssn-cell');
    const attrs = await page.evaluate(() => {
      const c = document.getElementById('ssn-cell')!;
      return Array.from(c.attributes).map((a) => `${a.name}=${a.value}`).join('|');
    });
    clean('attributes', attrs);
    expect(attrs).not.toContain('123456789');
    // Restored exactly on delete.
    await ext.send(page, { type: 'DELETE_STICKER', id });
    expect(await page.getAttribute('#ssn-cell', 'data-value')).toBe('123-45-6789');
    expect(await page.getAttribute('#ssn-cell', 'aria-valuetext')).toBe('SSN 123-45-6789');
  });

  test('1,2,4,5 forms: serialisers, walkers, attributes (input + image)', async ({ page, ext }) => {
    await setupForms(page, ext);
    cleanAll(await mainWorldReads(page));
    expect(await page.title()).toBe('Fixture: forms');
    // Channel 15, non-strict mode (default 'locked' setting, tab unlocked): the
    // submission-relevant value is untouched (documented residual).
    expect((await ext.state(page)).strict).toEqual({ on: false, count: 0 });
    expect(await page.locator('#ssn').inputValue()).toBe('123-45-6789');
  });

  test('3 accessibility: aria snapshot and CDP full AX tree', async ({ page, ext }) => {
    await setupStatic(page, ext);
    cleanAll(await axReads(page));
    await setupForms(page, ext);
    cleanAll(await axReads(page));
  });
});

test.describe('red team: clipboard, print, layout', () => {
  test('6 clipboard: copy and drag of masked content yield no secret', async ({ page, ext }) => {
    await ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await setupStatic(page, ext);
    const staticRes = await page.evaluate(async () => {
      const out: Record<string, string> = {};
      for (const sel of ['#ssn-cell', '#wrapped-span']) {
        await navigator.clipboard.writeText('clean-marker').catch(() => {});
        const el = document.querySelector(sel)!;
        getSelection()!.selectAllChildren(el);
        out[sel + ':selection'] = getSelection()!.toString();
        out[sel + ':exec'] = String(document.execCommand('copy'));
        out[sel + ':clipboard'] = await navigator.clipboard.readText().catch(() => 'unreadable');
        const dt = new DataTransfer();
        const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        out[sel + ':drag'] = `${dt.getData('text/plain')}|${dt.getData('text/html')}`;
        getSelection()!.removeAllRanges();
      }
      return out;
    });
    cleanAll(staticRes);

    await setupForms(page, ext);
    const formRes = await page.evaluate(async () => {
      const out: Record<string, string> = {};
      await navigator.clipboard.writeText('clean-marker').catch(() => {});
      const el = document.getElementById('ssn') as HTMLInputElement;
      el.focus();
      el.select();
      out.exec = String(document.execCommand('copy'));
      out.clipboard = await navigator.clipboard.readText().catch(() => 'unreadable');
      const dt = new DataTransfer();
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(ev);
      out.drag = dt.getData('text/plain');
      out.dragPrevented = String(ev.defaultPrevented);
      return out;
    });
    cleanAll(formRes);
    expect(formRes.dragPrevented).toBe('true');
  });

  test('7 print: stickers are fixed in the top layer and print media still shows bullets', async ({ page, ext }) => {
    await setupStatic(page, ext);
    const host = await page.evaluate(() => {
      const h = document.querySelector('aibs-host') as HTMLElement;
      return { position: getComputedStyle(h).position, topLayer: h.matches(':popover-open') };
    });
    expect(host.position).toBe('fixed');
    expect(host.topLayer).toBe(true);
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(100);
    cleanAll({ innerText: await pageInnerText(page) });
    expect(await coveredAt(page, await boxOf(page, '#ssn-cell'))).toBe(true);
    expect(await coveredAt(page, await bulletRun(page, '#wrapped-span'))).toBe(true);
    await page.emulateMedia({ media: 'screen' });
  });

  const layouts: Array<[string, (page: Page) => Promise<void>]> = [
    ['tiny viewport', (p) => p.setViewportSize({ width: 360, height: 700 })],
    ['3000px viewport', (p) => p.setViewportSize({ width: 3000, height: 900 })],
    ['body zoom 0.5', (p) => p.evaluate(() => void ((document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = '0.5'))],
    [
      'ancestor transform',
      (p) =>
        p.evaluate(() => {
          for (const sel of ['main', '#intake', '#photo-wrap']) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) continue;
            el.style.transformOrigin = '0 0';
            el.style.transform = 'translate(40px, 30px) scale(1.25)';
          }
        }),
    ],
  ];
  for (const [name, apply] of layouts) {
    test(`8 layout: ${name} keeps every anchor covered and masked`, async ({ page, ext }) => {
      await setupStatic(page, ext);
      await apply(page);
      await expect.poll(async () => coveredAt(page, await boxOf(page, '#ssn-cell')), { timeout: 3000 }).toBe(true);
      await expect.poll(async () => coveredAt(page, await bulletRun(page, '#wrapped-span')), { timeout: 3000 }).toBe(true);
      cleanAll({ innerText: await pageInnerText(page) });

      await page.setViewportSize({ width: 1000, height: 700 });
      await setupForms(page, ext);
      await apply(page);
      await expect.poll(async () => coveredAt(page, await boxOf(page, '#ssn')), { timeout: 3000 }).toBe(true);
      await expect.poll(async () => coveredAt(page, await boxOf(page, '#photo')), { timeout: 3000 }).toBe(true);
      cleanAll({ innerText: await pageInnerText(page) });
    });
  }
});

test.describe('red team: churn and observers', () => {
  /** How the churned target must look in the DOM on every tick. */
  type Masked = { sel: string; want: 'bullets' | 'input' | 'visual' };

  /**
   * Rewrite `parentSel`'s innerHTML with the RAW markup every 100 ms. On every tick, read from the
   * MAIN world: no secret in innerText, textContent or any attribute, and the freshly rendered target
   * is masked (bullets, input mask, or hidden image). The sticker pixel is sampled at two fixed ticks
   * and at the end, each with a bounded poll, while the churn is still running.
   */
  async function churn(page: Page, ext: Ext, parentSel: string, rawHtml: string, probe: () => Promise<Box>, masked: Masked) {
    await page.evaluate(
      ({ sel, html }) => {
        const w = window as unknown as { __churn: number; __renders: number };
        const parent = document.querySelector(sel)!;
        w.__renders = 0;
        w.__churn = window.setInterval(() => {
          parent.innerHTML = html;
          w.__renders++;
        }, 100);
      },
      { sel: parentSel, html: rawHtml },
    );
    const TICKS = 20;
    const PIXEL_AT = new Set([7, 14]);
    const pixel = async (label: string) => {
      let last = '';
      try {
        await expect
          .poll(
            async () => {
              const b = await probe();
              const c = centre(b);
              const px = await pixelAt(page, c.x, c.y);
              last = JSON.stringify({ box: b, px });
              return near(px, STICKER);
            },
            { timeout: 3000 },
          )
          .toBe(true);
      } catch {
        const st = await ext.state(page).catch(() => undefined);
        const stickers = { status: st?.stickers?.map((x) => `${x.kind}:${x.status}`), pieces: st?.pieces };
        throw new Error(`sticker off ${label}: last sample ${last}; stickers ${JSON.stringify(stickers)}`);
      }
    };
    for (let tick = 0; tick < TICKS; tick++) {
      const reads = await page.evaluate(
        ({ sel, m }) => {
          const parent = document.querySelector(sel)!;
          const attrs: string[] = [];
          for (const el of [parent, ...Array.from(parent.querySelectorAll('*'))]) {
            for (const a of Array.from(el.attributes)) attrs.push(`${a.name}=${a.value}`);
          }
          const t = document.querySelector(m.sel) as HTMLElement | null;
          let ok = false;
          if (t) {
            const mask = t.getAttribute('data-aibs-mask') ?? '';
            const cs = getComputedStyle(t);
            if (m.want === 'bullets') ok = (t.textContent ?? '').includes('•'.repeat(11));
            else if (m.want === 'input') ok = mask.startsWith('input') && cs.getPropertyValue('-webkit-text-security').trim() === 'disc';
            else ok = mask === 'visual' && cs.visibility === 'hidden';
          }
          return { dom: { innerText: document.body.innerText, textContent: document.body.textContent ?? '', attrs: attrs.join('|') }, ok };
        },
        { sel: parentSel, m: masked },
      );
      cleanAll(reads.dom);
      expect(reads.ok, `${masked.sel} not masked (${masked.want}) at tick ${tick}`).toBe(true);
      if (PIXEL_AT.has(tick)) await pixel(`at tick ${tick}`);
      await page.waitForTimeout(100);
    }
    await pixel('at the end');
    const renders = await page.evaluate(() => {
      const w = window as unknown as { __churn: number; __renders: number };
      clearInterval(w.__churn);
      return w.__renders;
    });
    expect(renders, 'the page re-rendered the parent throughout').toBeGreaterThan(10);
  }

  test('9 churn: element sticker parent re-rendered every 100 ms', async ({ page, ext }) => {
    const s = await setupStatic(page, ext);
    await churn(page, ext, '#identity tbody tr:first-child', s.rawCellParent, () => boxOf(page, '#ssn-cell'), { sel: '#ssn-cell', want: 'bullets' });
    expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));
  });

  test('9 churn: rect sticker paragraph re-rendered every 100 ms', async ({ page, ext }) => {
    const s = await setupStatic(page, ext);
    await churn(page, ext, 'p.narrow', s.rawSpanParent, () => bulletRun(page, '#wrapped-span'), { sel: '#wrapped-span', want: 'bullets' });
    expect(await page.textContent('#wrapped-span')).toContain('•'.repeat(11));
    expect(await pageInnerText(page)).toContain('and this inline span wraps');
  });

  test('9 churn: input and image parents re-rendered every 100 ms', async ({ page, ext }) => {
    const s = await setupForms(page, ext);
    await churn(page, ext, '#intake .field:first-child', s.rawSsnParent, () => boxOf(page, '#ssn'), { sel: '#ssn', want: 'input' });
    await churn(page, ext, '#photo-wrap', s.rawPhotoParent, () => boxOf(page, '#photo'), { sel: '#photo', want: 'visual' });
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('ssn')!).getPropertyValue('-webkit-text-security').trim())).toBe('disc');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('photo')!).visibility)).toBe('hidden');
  });

  async function observe(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __rec: Record<string, string>[]; __t: number };
      w.__rec = [];
      new MutationObserver((recs) => {
        for (const r of recs) {
          w.__rec.push({
            type: r.type,
            old: r.oldValue ?? '',
            now: r.target.nodeType === Node.TEXT_NODE ? (r.target as Text).data : ((r.target as Element).textContent ?? ''),
            added: Array.from(r.addedNodes).map((n) => n.textContent ?? '').join('|'),
            removed: Array.from(r.removedNodes).map((n) => n.textContent ?? '').join('|'),
          });
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      const cell = document.getElementById('ssn-cell')!;
      let i = 0;
      w.__t = window.setInterval(() => {
        if (i++ % 2) (cell.firstChild as Text).data = '123-45-6789';
        else cell.textContent = '123-45-6789';
      }, 50);
    });
    await page.waitForTimeout(1000);
    return page.evaluate(() => {
      const w = window as unknown as { __rec: Record<string, string>[]; __t: number };
      clearInterval(w.__t);
      return w.__rec;
    });
  }

  test('12 MAIN-world MutationObserver: live node state is always masked when it looks', async ({ page, ext }) => {
    await setupStatic(page, ext);
    const recs = await observe(page);
    expect(recs.length).toBeGreaterThan(10);
    for (const r of recs) {
      clean('record.target (at callback time)', r.now);
      clean('record.addedNodes (at callback time)', r.added);
    }
  });

  /**
   * A MutationObserver that asks for `characterDataOldValue` is handed, in the
   * record for OUR re-mask write, the value the page had just written. No
   * content script can avoid this: any mutation of a node (data write, node
   * replacement, removal) reports its previous state to every observer of the
   * subtree, transient observers included. See docs/LIMITATIONS.md.
   */
  test.fixme('12 MAIN-world MutationObserver: oldValue of the re-mask record carries the page write', async ({ page, ext }) => {
    await setupStatic(page, ext);
    const recs = await observe(page);
    for (const r of recs) clean('record.oldValue', r.old);
  });
});

test.describe('red team: tampering', () => {
  test('13 inline style / mask attribute removal is undone before the next frame', async ({ page, ext }) => {
    await setupForms(page, ext);
    const ssn = await boxOf(page, '#ssn');
    const photo = await boxOf(page, '#photo');
    await page.evaluate(() => {
      for (const id of ['ssn', 'photo']) {
        const el = document.getElementById(id)!;
        el.style.setProperty('-webkit-text-security', 'none', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.removeAttribute('data-aibs-mask');
        el.removeAttribute('aria-hidden');
      }
      // A page stylesheet that out-specifies the adopted mask sheet.
      const st = document.createElement('style');
      st.textContent = '#ssn{-webkit-text-security:none!important} #photo{visibility:visible!important}';
      document.head.appendChild(st);
      document.adoptedStyleSheets = [];
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 400) {
      expect(await coveredAt(page, ssn)).toBe(true);
      expect(await coveredAt(page, photo)).toBe(true);
    }
    const st = await page.evaluate(() => {
      const s = document.getElementById('ssn')!;
      const p = document.getElementById('photo')!;
      return {
        sec: getComputedStyle(s).getPropertyValue('-webkit-text-security').trim(),
        vis: getComputedStyle(p).visibility,
        maskS: s.getAttribute('data-aibs-mask'),
        maskP: p.getAttribute('data-aibs-mask'),
        ariaS: s.getAttribute('aria-hidden'),
        ariaP: p.getAttribute('aria-hidden'),
      };
    });
    expect(st).toEqual({ sec: 'disc', vis: 'hidden', maskS: 'input', maskP: 'visual', ariaS: 'true', ariaP: 'true' });
    cleanAll(await axReads(page));
  });

  test('13b the mask stylesheet re-installs after the page clears adoptedStyleSheets', async ({ page, ext }) => {
    await setupStatic(page, ext);
    // user-select:none on text masks comes only from the adopted sheet, so it
    // shows whether the sheet itself is back (the hiding styles are inline).
    const userSelect = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById('ssn-cell')!);
        return cs.userSelect || (cs as unknown as { webkitUserSelect: string }).webkitUserSelect;
      });
    expect(await userSelect()).toBe('none');
    // Read synchronously after clearing, before any watchdog can run: proves
    // the attack took effect, so the poll below measures a real re-install.
    const cleared = await page.evaluate(() => {
      document.adoptedStyleSheets = [];
      const cs = getComputedStyle(document.getElementById('ssn-cell')!);
      return cs.userSelect || (cs as unknown as { webkitUserSelect: string }).webkitUserSelect;
    });
    expect(cleared).not.toBe('none');
    await expect.poll(userSelect, { timeout: 3000, message: 'mask sheet re-installed' }).toBe('none');
    expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));
  });

  test('14 removing or hiding the overlay host re-mounts it at once', async ({ page, ext }) => {

    await setupStatic(page, ext);
    const cell = await boxOf(page, '#ssn-cell');
    const hostOk = () =>
      page.evaluate(() => {
        const h = document.querySelector('aibs-host') as HTMLElement | null;
        return !!h && h.isConnected && h.matches(':popover-open');
      });
    const attacks: Array<[string, () => void]> = [
      ['remove', () => document.querySelector('aibs-host')!.remove()],
      ['hidePopover', () => (document.querySelector('aibs-host') as HTMLElement).hidePopover()],
      ['inline display:none', () => ((document.querySelector('aibs-host') as HTMLElement).style.display = 'none')],
      ['remove popover attr', () => document.querySelector('aibs-host')!.removeAttribute('popover')],
      [
        'page stylesheet',
        () => {
          const s = document.createElement('style');
          s.textContent = 'aibs-host{display:none!important;opacity:0!important;visibility:hidden!important;transform:scale(0)!important}';
          document.head.appendChild(s);
        },
      ],
    ];
    for (const [name, fn] of attacks) {
      // The DOM half of the requirement, measured in the page itself: run the
      // attack, let the microtask queue drain (no task, no frame), then check
      // the host is back in place and open in the top layer.
      const restoredInMicrotask = await page.evaluate(async (src) => {
        (0, eval)(`(${src})`)();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const h = document.querySelector('aibs-host') as HTMLElement | null;
        return !!h && h.isConnected && h.matches(':popover-open');
      }, fn.toString());
      // A page stylesheet produces no mutation record: it is handled by the
      // inline !important styles, so only the DOM state is checked for it.
      if (name !== 'page stylesheet') expect(restoredInMicrotask, `host restored in the same microtask after ${name}`).toBe(true);
      await expect.poll(hostOk, { timeout: 1500, message: `host after ${name}` }).toBe(true);
      // Pixels need a rendered frame and a screenshot, whose latency depends on
      // machine load: allow up to 3 s for the screenshot to show the sticker.
      await expect.poll(() => coveredAt(page, cell), { timeout: 3000, message: `pixels after ${name}` }).toBe(true);
      expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));
    }
    cleanAll({ innerText: await pageInnerText(page) });
  });

  test('14c removing or restyling an in-page cover is undone before the next paint', async ({ page, ext }) => {
    // A rect sticker over an image gets an <aibs-cover> inside the page (see
    // overlay/in-page-cover.ts), which a MAIN-world script can reach.
    await page.goto('/image-page.html');
    await page.evaluate(() => Promise.all(Array.from(document.images, (i) => i.decode().catch(() => {}))));
    const card = await boxOf(page, '#card-flow');
    await ext.rect(page, { x: card.x, y: card.y, w: card.w, h: card.h });
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('aibs-cover').length)).toBe(1);
    // Freeze the fixed overlay and move the page under it: from here on only
    // the in-page cover can be what covers the image.
    await ext.send(page, { type: 'TEST_FREEZE_OVERLAY', on: true });
    try {
      await page.evaluate(() => window.scrollBy(0, 150));
      const moved = await boxOf(page, '#card-flow');
      expect(moved.y).toBeLessThan(card.y - 100);
      await expect.poll(() => coveredAt(page, moved), { timeout: 3000, message: 'cover before the attacks' }).toBe(true);
      const attacks: Array<[string, () => void]> = [
        ['remove', () => document.querySelector('aibs-cover')!.remove()],
        ['inline display:none', () => ((document.querySelector('aibs-cover') as HTMLElement).style.display = 'none')],
        ['style attribute', () => document.querySelector('aibs-cover')!.setAttribute('style', 'background:transparent')],
        ['hidden attribute', () => document.querySelector('aibs-cover')!.setAttribute('hidden', '')],
        ['move elsewhere', () => document.getElementById('after')!.appendChild(document.querySelector('aibs-cover')!)],
        [
          'page stylesheet',
          () => {
            const st = document.createElement('style');
            st.textContent = 'aibs-cover{display:none!important;opacity:0!important;visibility:hidden!important;background:transparent!important;transform:scale(0)!important}';
            document.head.appendChild(st);
          },
        ],
      ];
      for (const [name, fn] of attacks) {
        const state = await page.evaluate(async (src) => {
          (0, eval)(`(${src})`)();
          // Microtasks only: no task, no frame.
          for (let i = 0; i < 5; i++) await Promise.resolve();
          const inMicrotask = (() => {
            const c = document.querySelectorAll('aibs-cover');
            return c.length === 1 && c[0].parentElement === document.body && !c[0].hasAttribute('hidden') && getComputedStyle(c[0]).display === 'block';
          })();
          // The last thing that runs before the next paint.
          const beforePaint = await new Promise<boolean>((r) =>
            requestAnimationFrame(() => {
              const c = document.querySelector('aibs-cover');
              const cs = c && getComputedStyle(c);
              r(!!cs && cs.display === 'block' && cs.visibility === 'visible' && cs.opacity === '1' && cs.backgroundColor === 'rgb(31, 41, 55)');
            }),
          );
          return { inMicrotask, beforePaint };
        }, fn.toString());
        if (name !== 'page stylesheet') expect(state.inMicrotask, `cover restored in the same microtask after ${name}`).toBe(true);
        expect(state.beforePaint, `cover in place before the next paint after ${name}`).toBe(true);
        expect(await coveredAt(page, moved), `pixels after ${name}`).toBe(true);
      }
    } finally {
      await ext.send(page, { type: 'TEST_FREEZE_OVERLAY', on: false });
    }
  });

  test('14b page CSS cannot recolour, fade, blur or hide the stickers from outside the shadow root', async ({ page, ext }) => {
    await setupStatic(page, ext);
    const cell = await boxOf(page, '#ssn-cell');
    await expect.poll(() => coveredAt(page, cell), { timeout: 3000 }).toBe(true);
    await page.evaluate(() => {
      const s = document.createElement('style');
      // Custom properties and inherited properties set on the host flow into
      // a shadow tree; descendant selectors cannot pierce it but are tried anyway.
      s.textContent = [
        'aibs-host{--aibs-color:transparent!important;--aibs-piece:transparent!important;--accent:transparent!important;color:transparent!important;opacity:0!important;filter:blur(20px)!important;visibility:hidden!important;font-size:0!important}',
        'aibs-host *, aibs-host::part(piece), html aibs-host > *{visibility:hidden!important;background:transparent!important;opacity:0!important}',
      ].join('\n');
      document.head.appendChild(s);
    });
    await page.waitForTimeout(200);
    await expect.poll(() => coveredAt(page, cell), { timeout: 3000, message: 'sticker pixels after page CSS' }).toBe(true);
    expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));
    cleanAll({ innerText: await pageInnerText(page) });
  });
});

test.describe('red team: peek abuse', () => {
  test('11 synthetic key/mouse events from the page never peek; trusted input does, briefly', async ({ page, ext }) => {
    await setupStatic(page, ext);
    const cell = await boxOf(page, '#ssn-cell');
    const c = centre(cell);
    await page.evaluate(({ x, y }) => {
      const t = document.elementFromPoint(x, y) ?? document.body;
      t.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      for (const init of [
        { key: 'Control', code: 'ControlLeft', ctrlKey: true },
        { key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true },
        { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true },
      ]) {
        window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
      }
    }, c);
    await page.waitForTimeout(400);
    expect((await ext.state(page)).state as unknown as { peeking: boolean }).toMatchObject({ peeking: false });
    expect(await coveredAt(page, cell)).toBe(true);
    expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));

    // Real (trusted) input peeks: the screenshot shows the original, the DOM does not.
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.waitForTimeout(400);
    expect(await stickerFraction(page, cell)).toBeLessThan(0.2);
    expect(await page.textContent('#ssn-cell')).toBe('•'.repeat(11));
    cleanAll(await mainWorldReads(page));
    cleanAll(await axReads(page));
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    // Release ends the peek at once (state), and the screenshot shows the
    // sticker again as soon as a frame is rendered and captured, which under
    // load can take longer than one short screenshot poll.
    await expect.poll(async () => ((await ext.state(page)).state as unknown as { peeking: boolean }).peeking, { timeout: 500 }).toBe(false);
    await expect.poll(() => coveredAt(page, cell), { timeout: 3000 }).toBe(true);
  });
});

test.describe('red team: input value (documented residual)', () => {
  test('15 non-strict: .value / FormData readable as documented; selection, copy and AX are not', async ({ page, ext }) => {
    await ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await setupForms(page, ext);
    // Default 'locked' setting on an unlocked tab: strict input masking is off,
    // and the live value stays for form submission (documented residual).
    expect((await ext.state(page)).strict).toEqual({ on: false, count: 0 });
    expect(await page.getAttribute('#ssn', 'data-aibs-strict')).toBeNull();
    expect(await page.locator('#ssn').inputValue()).toBe('123-45-6789');
    expect(
      await page.evaluate(() => new FormData(document.getElementById('intake') as HTMLFormElement).get('ssn')),
    ).toBe('123-45-6789');
    const res = await page.evaluate(async () => {
      await navigator.clipboard.writeText('clean-marker').catch(() => {});
      const el = document.getElementById('ssn') as HTMLInputElement;
      el.focus();
      el.select();
      const out: Record<string, string> = {};
      out.selection = getSelection()!.toString();
      out.active = document.activeElement?.id ?? '';
      out.exec = String(document.execCommand('copy'));
      out.clipboard = await navigator.clipboard.readText().catch(() => 'unreadable');
      el.setSelectionRange(0, el.value.length);
      out.selection2 = getSelection()!.toString();
      return out;
    });
    cleanAll(res);
    expect(res.active).not.toBe('ssn');
    cleanAll(await axReads(page));
    // Form reset while masked still restores the page's own default.
    await page.evaluate(() => (document.getElementById('intake') as HTMLFormElement).reset());
    await page.waitForTimeout(50);
    expect(await page.locator('#ssn').inputValue()).toBe('123-45-6789');
    cleanAll(await mainWorldReads(page));
  });

  test('15 strict: .value reads bullets for every reader, FormData and reset keep the real value', async ({ page, ext }) => {
    await ext.worker.evaluate(() => chrome.storage.local.set({ settings: { strictInputs: 'always' } }));
    await setupForms(page, ext);
    await expect.poll(async () => (await ext.state(page)).strict?.count).toBe(1);
    const reads = async () => {
      const r = await mainWorldReads(page);
      r.values = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input,textarea')).map((i) => (i as HTMLInputElement).value).join('|'),
      );
      r.inputValue = await page.locator('#ssn').inputValue();
      return r;
    };
    cleanAll(await reads());
    cleanAll(await axReads(page));
    const formSsn = () => page.evaluate(() => new FormData(document.getElementById('intake') as HTMLFormElement).get('ssn'));
    expect(await formSsn()).toBe('123-45-6789');
    // A form reset goes back to the page's own default, which is then masked again.
    await page.evaluate(() => (document.getElementById('intake') as HTMLFormElement).reset());
    await expect.poll(() => page.locator('#ssn').inputValue(), { timeout: 2000 }).toBe('•'.repeat(11));
    expect(await formSsn()).toBe('123-45-6789');
    cleanAll(await reads());
  });
});

// ------------------------------------------------------------- shadow / frames

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

async function shadowReads(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById('shadow-host')!.shadowRoot!;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const t: string[] = [];
    let n: Node | null;
    while ((n = w.nextNode())) t.push((n as Text).data);
    return {
      innerHTML: root.innerHTML,
      textContent: root.textContent ?? '',
      innerText: Array.from(root.querySelectorAll('p')).map((p) => p.innerText).join('|'),
      walker: t.join('|'),
    };
  });
}

test.describe('red team: shadow DOM and iframes', () => {
  test('10 element sticker inside an open shadow root, re-rendered', async ({ page, ext }) => {
    await page.goto('/shadow.html');
    const r = await ext.send<{ ok: boolean }>(page, { type: 'TEST_COVER', selector: '#shadow-ssn', shadowHost: '#shadow-host' });
    expect(r.ok).toBe(true);
    const secrets = ['123-45-6789'];
    cleanAll(await shadowReads(page), secrets);
    cleanAll(await axReads(page), secrets);
    // A framework re-render inside the shadow root is re-masked before anyone reads.
    for (let i = 0; i < 5; i++) {
      const after = await page.evaluate(() => {
        (window as unknown as { rerenderShadow: () => void }).rerenderShadow();
        return new Promise<string>((res) =>
          setTimeout(() => res(document.getElementById('shadow-host')!.shadowRoot!.textContent ?? ''), 0),
        );
      });
      clean('shadow after re-render', after, secrets);
    }
    const box = await page.evaluate(() => {
      const r = document.getElementById('shadow-host')!.shadowRoot!.getElementById('shadow-ssn')!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    expect(await coveredAt(page, box)).toBe(true);
  });

  test('10 rect sticker drawn over shadow content masks it', async ({ page, ext }) => {
    await page.goto('/shadow.html');
    const rect = await page.evaluate(() => {
      const p = document.getElementById('shadow-host')!.shadowRoot!.getElementById('shadow-para')!;
      const node = p.firstChild as Text;
      const i = node.data.indexOf('987-65-4321');
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 11);
      const b = r.getBoundingClientRect();
      return { x: b.left - 1, y: b.top - 1, w: b.width + 2, h: b.height + 2 };
    });
    const made = await ext.rect(page, rect);
    expect(made.kind).toBe('rect');
    const reads = await shadowReads(page);
    cleanAll(reads, ['987-65-4321']);
    expect(reads.textContent).toContain('inside the shadow root');
    cleanAll(await axReads(page), ['987-65-4321']);
    expect(await coveredAt(page, rect)).toBe(true);
  });

  test('10 element sticker inside a same-origin iframe', async ({ page, ext }) => {
    await page.goto('/shadow.html');
    const frame = page.frameLocator('#inner');
    await expect(frame.locator('#frame-ssn')).toHaveText('111-22-3333');
    const r = await sendToFrame<{ ok: boolean }>(ext, page, '/frame-inner.html', { type: 'TEST_COVER', selector: '#frame-ssn' });
    expect(r.ok).toBe(true);
    const inner = page.frame({ url: /frame-inner/ })!;
    const reads = await inner.evaluate(() => ({
      innerText: document.body.innerText,
      html: document.documentElement.outerHTML,
    }));
    cleanAll(reads, ['111-22-3333']);
    // Read through the parent, as an agent walking frames would.
    const viaParent = await page.evaluate(() => (document.getElementById('inner') as HTMLIFrameElement).contentDocument!.body.innerText);
    clean('iframe via parent', viaParent, ['111-22-3333']);
    clean('frame ariaSnapshot', await frame.locator('body').ariaSnapshot(), ['111-22-3333']);
    clean('page ariaSnapshot', await page.locator('body').ariaSnapshot(), ['111-22-3333']);
    const box = await page.evaluate(() => {
      const f = (document.getElementById('inner') as HTMLIFrameElement).getBoundingClientRect();
      const r = (document.getElementById('inner') as HTMLIFrameElement).contentDocument!.getElementById('frame-ssn')!.getBoundingClientRect();
      return { x: f.left + 1 + r.left, y: f.top + 1 + r.top, w: r.width, h: r.height };
    });
    expect(await coveredAt(page, box)).toBe(true);
  });
});
