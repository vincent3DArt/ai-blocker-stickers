import { test, expect, boxOf, pixelAt, coverage } from './fixtures';

/** Viewport rect of a substring inside an element's first text node, padded by `pad`. */
async function substringRect(page: import('@playwright/test').Page, selector: string, text: string, pad = 1) {
  return page.evaluate(
    ({ sel, needle, p }) => {
      const el = document.querySelector(sel)!;
      const node = Array.from(el.childNodes).find(
        (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data.includes(needle),
      ) as Text | undefined;
      if (!node) throw new Error(`no text node with ${needle} in ${sel}`);
      const start = node.data.indexOf(needle);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const r = range.getBoundingClientRect();
      return { x: r.left - p, y: r.top - p, w: r.width + p * 2, h: r.height + p * 2 };
    },
    { sel: selector, needle: text, p: pad },
  );
}

const SECRETS = ['123-45-6789', '9876543210', '987-65-4321', '111-22-3333'];

async function pageText(page: import('@playwright/test').Page) {
  return page.evaluate(() => ({
    innerText: document.body.innerText,
    textContent: document.body.textContent ?? '',
    values: Array.from(document.querySelectorAll('input,textarea')).map((i) => (i as HTMLInputElement).value),
  }));
}

test.describe('M3 DOM masking', () => {
  test('page readers get bullets, not the SSN', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    await ext.cover(page, '#identity tbody tr:nth-child(3) td');
    const t = await pageText(page);
    expect(t.innerText).not.toContain('123-45-6789');
    expect(t.textContent).not.toContain('123-45-6789');
    // The covered account cell itself is all bullets...
    const cell = await page.textContent('#identity tbody tr:nth-child(3) td');
    expect(cell).toBe('••••••••••');
    // ...while the same number elsewhere on the page is untouched.
    expect(await page.textContent('#hdr-account')).toBe('9876543210');
    // Length-preserving bullets replace every non-space character, dashes included.
    expect(await page.textContent('#ssn-cell')).toBe('•'.repeat('123-45-6789'.length));
    expect(t.innerText).toContain('•');
    const snapshot = await page.locator('body').ariaSnapshot();
    expect(snapshot).not.toContain('123-45-6789');
    // Uncovered content still readable.
    expect(t.innerText).toContain('12-3456789');
  });

  test('re-mask lands before paint while a framework rewrites the node', async ({ page, ext }) => {
    await page.goto('/forms.html');
    await ext.cover(page, '#live');
    const box = await boxOf(page, '#live');
    const start = Date.now();
    let reads = 0;
    while (Date.now() - start < 3000) {
      const t = await page.evaluate(() => document.getElementById('live')!.textContent);
      expect(t).not.toContain('123-45-6789');
      const px = await pixelAt(page, box.x + box.w / 2, box.y + box.h / 2);
      expect(px[0]).toBeLessThan(0x40); // sticker, not white page
      reads++;
    }
    const ticks = await page.evaluate(() => (window as unknown as { __ticks: number }).__ticks);
    expect(ticks).toBeGreaterThan(5);
    expect(reads).toBeGreaterThan(5);
  });

  test('inputs: pixels hidden, a11y excluded, copy blocked, value still submits', async ({ page, ext }) => {
    await page.goto('/forms.html');
    await ext.cover(page, '#ssn');
    // Pixels are hidden by -webkit-text-security, and the a11y node is gone.
    const styles = await page.evaluate(() => {
      const el = document.getElementById('ssn')!;
      const cs = getComputedStyle(el);
      return {
        textSecurity: cs.getPropertyValue('-webkit-text-security').trim(),
        ariaHidden: el.getAttribute('aria-hidden'),
        title: el.getAttribute('title'),
      };
    });
    expect(styles.textSecurity).toBe('disc');
    expect(styles.ariaHidden).toBe('true');
    expect(styles.title).toBe('');
    const snapshot = await page.locator('body').ariaSnapshot();
    // The masked input is absent from the a11y tree (other elements on the page
    // legitimately still mention the number; only #ssn was covered).
    expect(snapshot).not.toContain('textbox "SSN"');
    expect(snapshot).not.toContain('Social security number');
    for (const line of snapshot.split('\n')) {
      if (line.includes('textbox')) expect(line).not.toContain('123-45-6789');
    }
    // Documented residual: the raw value is still there for a script that asks for it.
    expect(await page.locator('#ssn').inputValue()).toBe('123-45-6789');
    // Copy is blocked.
    await page.evaluate(() => navigator.clipboard.writeText('clean').catch(() => {}));
    await page.evaluate(() => {
      const el = document.getElementById('ssn') as HTMLInputElement;
      el.focus();
      el.select();
      document.execCommand('copy');
    });
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => 'unreadable'));
    expect(clip).not.toContain('123-45-6789');
    // Submitting sends the real value.
    await page.evaluate(() => (document.getElementById('intake') as HTMLFormElement).requestSubmit());
    const submitted = await page.evaluate(() => (window as unknown as { __submitted: Record<string, string> }).__submitted);
    expect(submitted.ssn).toBe('123-45-6789');
  });

  test('image: alt scrubbed and pixels hidden', async ({ page, ext }) => {
    await page.goto('/forms.html');
    await ext.cover(page, '#photo');
    const alt = await page.getAttribute('#photo', 'alt');
    expect(alt).toBe('');
    const snapshot = await page.locator('body').ariaSnapshot();
    expect(snapshot).not.toContain('SSN card');
    const vis = await page.evaluate(() => getComputedStyle(document.getElementById('photo')!).visibility);
    expect(vis).toBe('hidden');
  });

  test('deleting the sticker restores the original text and attributes', async ({ page, ext }) => {
    await page.goto('/static.html');
    const id = await ext.cover(page, '#ssn-cell');
    expect(await page.textContent('#ssn-cell')).not.toContain('123-45-6789');
    await ext.send(page, { type: 'DELETE_STICKER', id });
    expect(await page.textContent('#ssn-cell')).toBe('123-45-6789');
    expect(await page.getAttribute('#ssn-cell', 'aria-hidden')).toBeNull();
    expect(await page.getAttribute('#ssn-cell', 'data-aibs-mask')).toBeNull();
  });

  test('a rect over one line of a wrapped span masks only that line, overlay stays one line', async ({ page, ext }) => {
    await page.goto('/static.html');
    // First line box of the wrapped span — the line holding the SSN.
    const line = await page.evaluate(() => {
      const r = document.getElementById('wrapped-span')!.getClientRects()[0];
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await ext.rect(page, line);
    const t = await pageText(page);
    expect(t.innerText).not.toContain('987-65-4321');
    expect(t.textContent).not.toContain('987-65-4321');
    expect(await page.textContent('#wrapped-span')).toContain('•'.repeat('987-65-4321'.length));
    // Lines the rect never touched stay readable.
    expect(t.innerText).toContain('spouse SSN is');
    expect(t.innerText).toContain('in a narrow column');
    // The overlay is NOT widened to match: one piece, roughly one line tall.
    const st = await ext.state(page);
    expect(st.pieces).toHaveLength(1);
    expect(st.pieces[0].h).toBeLessThan(line.h * 2);
  });

  test('a tight rect around one number inside a wrapped line masks only that number', async ({ page, ext }) => {
    await page.goto('/static.html');
    // Just the SSN inside the first line of the four-line wrapped span.
    const sub = await substringRect(page, '#wrapped-span', '987-65-4321');
    const made = await ext.rect(page, sub);
    expect(made.kind).toBe('rect');
    const t = await pageText(page);
    expect(t.innerText).not.toContain('987-65-4321');
    expect(t.textContent).not.toContain('987-65-4321');
    // Exactly the 11 covered characters became bullets...
    expect(await page.textContent('#wrapped-span')).toContain('•'.repeat('987-65-4321'.length));
    expect(await page.textContent('#wrapped-span')).not.toContain('•'.repeat('987-65-4321'.length + 1));
    // ...and the rest of the sentence is still readable.
    expect(t.innerText).toContain('and this inline span wraps');
    expect(t.innerText).toContain('spouse SSN is');
    // The overlay is not widened to the line/node: it stays the drawn rect.
    const st = await ext.state(page);
    expect(st.pieces).toHaveLength(1);
    expect(st.pieces[0].w).toBeLessThan(sub.w * 1.5);
  });

  test('rect masking never grows the page', async ({ page, ext }) => {
    await page.goto('/static.html');
    const before = await pageText(page);
    const span = await page.textContent('#wrapped-span');
    // Union of the wrapped span's line boxes 1..n: everything but the first line.
    const lines = await page.evaluate(() => {
      const rs = Array.from(document.getElementById('wrapped-span')!.getClientRects()).slice(1);
      const x1 = Math.min(...rs.map((r) => r.left));
      const y1 = Math.min(...rs.map((r) => r.top));
      const x2 = Math.max(...rs.map((r) => r.right));
      const y2 = Math.max(...rs.map((r) => r.bottom));
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, count: rs.length };
    });
    expect(lines.count).toBeGreaterThan(1);
    const made = await ext.rect(page, lines);
    expect(made.kind).toBe('rect');
    // Many mutation batches (50 ms) and slow ticks (300 ms) go by: every one of
    // them re-masks, and none of them may add a single character to the page.
    await page.waitForTimeout(2500);

    const after = await pageText(page);
    expect(after.innerText.length).toBe(before.innerText.length);
    expect(after.textContent.length).toBe(before.textContent.length);
    expect(after.innerText).not.toContain('span wraps across several lines');
    const st = await ext.state(page);
    expect(st.stickers[0].status).toBe('resolved');
    expect(st.pieces[0].low).toBe(false);

    await ext.send(page, { type: 'DELETE_STICKER', id: made.id });
    expect(await page.textContent('#wrapped-span')).toBe(span);
    const restored = await pageText(page);
    expect(restored.innerText).toBe(before.innerText);
    expect(restored.textContent).toBe(before.textContent);
  });

  test('two rects on the same paragraph leave the text intact', async ({ page, ext }) => {
    await page.goto('/static.html');
    const before = await pageText(page);
    const span = await page.textContent('#wrapped-span');
    const sub = await substringRect(page, '#wrapped-span', '987-65-4321');
    const tight = await ext.rect(page, sub);
    expect(tight.kind).toBe('rect');
    const last = await page.evaluate(() => {
      const rs = document.getElementById('wrapped-span')!.getClientRects();
      const r = rs[rs.length - 1];
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const line = await ext.rect(page, last);
    await page.waitForTimeout(1500);

    const after = await pageText(page);
    expect(after.innerText.length).toBe(before.innerText.length);
    expect(after.textContent.length).toBe(before.textContent.length);
    expect(after.innerText).not.toContain('987-65-4321');
    expect(after.textContent).not.toContain('987-65-4321');
    expect(await page.textContent('#wrapped-span')).toContain('•'.repeat('987-65-4321'.length));

    await ext.send(page, { type: 'DELETE_STICKER', id: tight.id });
    await ext.send(page, { type: 'DELETE_STICKER', id: line.id });
    expect(await page.textContent('#wrapped-span')).toBe(span);
    const restored = await pageText(page);
    expect(restored.innerText).toBe(before.innerText);
    expect(restored.textContent).toBe(before.textContent);
  });

  test('a framework rewriting the split node gets the number re-masked', async ({ page, ext }) => {
    await page.goto('/static.html');
    const sub = await substringRect(page, '#wrapped-span', '987-65-4321');
    await ext.rect(page, sub);
    expect((await pageText(page)).innerText).not.toContain('987-65-4321');
    // Simulate a re-render writing the whole sentence back into the first text node.
    await page.evaluate(() => {
      const span = document.getElementById('wrapped-span')!;
      (span.firstChild as Text).data =
        '987-65-4321 and this inline span wraps across several lines in a narrow column';
    });
    await page.waitForTimeout(200);
    const t = await pageText(page);
    expect(t.innerText).not.toContain('987-65-4321');
    expect(t.textContent).not.toContain('987-65-4321');
    expect(await page.textContent('#wrapped-span')).toContain('•'.repeat('987-65-4321'.length));
    expect(t.innerText).toContain('and this inline span wraps');
  });

  test('a rect inside a nested scroll container survives reload', async ({ page, ext }) => {
    await page.goto('/static.html');
    const scroll = () => page.evaluate(() => { document.getElementById('scroller')!.scrollTop = 140; });
    await scroll();
    const sub = await substringRect(page, '#dep-ssn', '111-22-3333');
    const made = await ext.rect(page, sub);
    expect(made.kind).toBe('rect');
    const before = await pageText(page);
    expect(before.innerText).not.toContain('111-22-3333');
    expect(before.innerText).toContain('Dependent SSN:');
    expect(await page.textContent('#dep-ssn')).toBe('•'.repeat('111-22-3333'.length));

    await page.reload();
    await expect
      .poll(async () => (await ext.state(page)).stickers[0]?.status, { timeout: 10_000 })
      .toBe('resolved');
    await scroll();
    const after = await ext.state(page);
    const t = await pageText(page);
    expect(t.innerText).not.toContain('111-22-3333');
    expect(t.innerText).toContain('Dependent SSN:');
    expect(await page.textContent('#dep-ssn')).toBe('•'.repeat('111-22-3333'.length));
    const sub2 = await page.evaluate(() => {
      const r = document.getElementById('dep-ssn')!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    expect(coverage(sub2, after.pieces)).toBeGreaterThanOrEqual(0.8);
  });

  test('no secret is stored in extension storage', async ({ page, ext }) => {
    await page.goto('/static.html');
    await ext.cover(page, '#ssn-cell');
    await page.waitForTimeout(500); // debounced save
    const all = await ext.worker.evaluate(() => chrome.storage.local.get(null));
    const json = JSON.stringify(all);
    for (const s of SECRETS) expect(json).not.toContain(s);
  });
});
