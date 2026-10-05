import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { setFingerprintKey } from '@/content/anchor/fingerprint';
import { isObfuscatedClass, isStableClass } from '@/content/anchor/selector';
import { overlayRootOf, presentViews, viewIdentityOf, viewKey, viewText, VIEW_TEXT_MAX } from '@/content/state/view';
import { assertNoCoveredText } from '@/shared/storage';
import { importKey, randomKeyB64 } from '@/shared/hmac';
import type { SiteRecord } from '@/shared/types';

beforeAll(async () => {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (!g.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  setFingerprintKey(await importKey(randomKeyB64()));
});

const LINES = Array.from({ length: 60 }, (_, i) => `Formula ${i + 1}: integral of f over x equals F of b minus F of a`);

function viewer(lines: string[], toolbar = 'Page 1 / 3') {
  document.body.innerHTML = `
    <h1>My Drive</h1>
    <div class="YM5U3" style="position: fixed">
      <div class="title">Some file.pdf</div>
      <div role="dialog" aria-label="Showing viewer.">
        <div role="document" class="a-b-Xa-yj">
          <div role="toolbar">${toolbar}</div>
          <div class="a-b-Xa-La"><img alt=""><div class="a-b-Xa-La-mf-x-j">${lines.map((l) => `<p class="a-b-Xa-La-mf-Ic">${l}</p>`).join('\n')}</div></div>
        </div>
      </div>
    </div>`;
  return document.querySelectorAll('[role="document"] p');
}

describe('in-page viewer identity', () => {
  it('finds the viewer dialog around an anchor, and none on the page behind it', () => {
    const ps = viewer(LINES);
    expect(overlayRootOf(ps[3])?.getAttribute('role')).toBe('dialog');
    expect(overlayRootOf(document.querySelector('h1')!)).toBeNull();
  });

  it('a small dialog without a document is not a viewer', () => {
    document.body.innerHTML = '<div role="dialog"><p id="x">Share with people</p></div>';
    expect(overlayRootOf(document.getElementById('x')!)).toBeNull();
  });

  it('hashes the first characters only, without whitespace or the toolbar', () => {
    viewer(LINES, 'Page 1 / 3');
    const doc = document.querySelector('[role="document"]')!;
    const t = viewText(doc);
    expect(t.length).toBe(VIEW_TEXT_MAX);
    expect(t).not.toMatch(/\s/);
    expect(t.startsWith('formula1:integral')).toBe(true);
    expect(t).not.toContain('page1/3');
  });

  it('same text gives the same hash; toolbar text and later pages do not matter', async () => {
    const ps = viewer(LINES, 'Page 1 / 3');
    const a = await viewIdentityOf(ps[0]);
    expect(a?.viewHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.viewLen).toBe(VIEW_TEXT_MAX);

    const ps2 = viewer([...LINES, 'a lazily rendered later page'], 'Page 3 / 3 · 150%');
    const b = await viewIdentityOf(ps2[5]);
    expect(b?.viewHmac).toBe(a?.viewHmac);
    const present = await presentViews([VIEW_TEXT_MAX]);
    expect(present.has(viewKey(a!))).toBe(true);
  });

  it('a different document gives a different hash', async () => {
    const a = await viewIdentityOf(viewer(LINES)[0]);
    const b = await viewIdentityOf(viewer(LINES.map((l) => l.replace('integral', 'derivative')))[0]);
    expect(b?.viewHmac).not.toBe(a?.viewHmac);
    expect((await presentViews([VIEW_TEXT_MAX])).has(viewKey(a!))).toBe(false);
  });

  it('reads masked text back as the original', async () => {
    const ps = viewer(LINES);
    const a = await viewIdentityOf(ps[0]);
    const t = ps[1].firstChild as Text;
    const original = t.data;
    t.data = original.replace(/\S/g, '•');
    const masked = await viewIdentityOf(ps[0]);
    expect(masked?.viewHmac).not.toBe(a?.viewHmac);
    const restored = await viewIdentityOf(ps[0], { originalOf: (n) => (n === t ? original : undefined) });
    expect(restored?.viewHmac).toBe(a?.viewHmac);
  });

  it('nothing before the text layer renders: no identity at the requested length', async () => {
    const ps = viewer(LINES);
    const a = await viewIdentityOf(ps[0]);
    document.querySelector('.a-b-Xa-La-mf-x-j')!.remove();
    expect((await presentViews([a!.viewLen])).size).toBe(0);
  });

  it('the privacy guard accepts a view HMAC and scans anything else under that key', () => {
    const base: SiteRecord = { v: 1, origin: 'https://x.test', enabled: true, stickers: [], updatedAt: 1 };
    const sticker = (viewHmac: string) =>
      ({
        id: 'a', kind: 'rect', source: 'rect', padding: 0, createdAt: 1, updatedAt: 1, frame: { depth: 0 },
        scope: { kind: 'pattern', pathPattern: '/home', viewHmac, viewLen: 1500 },
        container: { tag: 'p', classes: [], cssPath: 'p', xpath: '/html/body/p', textLen: 3, rect: { x: 0, y: 0, w: 1, h: 1 }, viewportW: 1, docH: 1 },
        frac: { fx: 0, fy: 0, fw: 1, fh: 1 }, px: { w: 1, h: 1 }, maskUnderlyingText: true,
      }) as SiteRecord['stickers'][number];
    expect(() => assertNoCoveredText({ ...base, stickers: [sticker('1234567890'.repeat(6) + '0123')] })).not.toThrow();
    expect(() => assertNoCoveredText({ ...base, stickers: [sticker('SSN 123-45-6789')] })).toThrow();
  });
});

describe('isStableClass: obfuscated deployment classes', () => {
  it('rejects letter-group soup', () => {
    for (const c of ['a-b-Xa-La', 'a-b-Xa-La-mf-Ic', 'a-b-Xa-La-mf-x-j', 'a-b-Sh-ng', 'tORug', 'SmKAyb']) {
      expect(isObfuscatedClass(c), c).toBe(true);
      expect(isStableClass(c), c).toBe(false);
    }
  });

  it('keeps ordinary class names', () => {
    for (const c of ['btn-primary', 'col-ssn', 'narrow', 'navBar', 'cell', 'row', 'vw-page', 'col-x']) {
      expect(isStableClass(c), c).toBe(true);
    }
  });
});
