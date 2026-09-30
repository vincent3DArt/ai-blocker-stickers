import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertNoCoveredText, saveSite, siteKey } from '@/shared/storage';
import { SiteStore } from '@/content/state/store';
import { defaultPathPattern } from '@/shared/url-match';
import type { ElementSticker, Fingerprint, SiteRecord } from '@/shared/types';

const anchor: Fingerprint = {
  tag: 'td',
  classes: ['col-ssn'],
  cssPath: '#rows > tr:nth-of-type(2) > td.col-ssn',
  xpath: '/html/body/div[1]/table[1]/tbody[1]/tr[2]/td[2]',
  labelContext: 'ssn',
  labelSource: 'column',
  tableContext: { header: 'ssn', colIndex: 1, rowIndex: 1 },
  // 64 hex chars with a long run of digits: an HMAC, not a leak.
  textHmac: '1234567890123456' + 'ab'.repeat(24),
  keyHmac: '9876543210987654' + 'cd'.repeat(24),
  textLen: 11,
  rect: { x: 12, y: 345678901, w: 90, h: 20 },
  viewportW: 1000,
  docH: 2000,
};

function record(sticker: ElementSticker): SiteRecord {
  return { v: 1, origin: 'https://example.test', enabled: true, stickers: [sticker], updatedAt: 1758193000000 };
}

const sticker: ElementSticker = {
  kind: 'element',
  id: '282770b4-f9b5-4c50-b1be-130f31e5b56b',
  scope: { pathPattern: '/clients/*' },
  frame: { depth: 0 },
  source: 'manual',
  padding: 3,
  createdAt: 1758193000000,
  updatedAt: 1758193000000,
  anchor,
  maskMode: 'text',
};

describe('privacy invariant', () => {
  it('accepts a record whose only long digit runs are timestamps and HMACs', () => {
    expect(() => assertNoCoveredText(record(sticker))).not.toThrow();
  });

  it('rejects a raw SSN that leaked into a context string', () => {
    const bad = { ...sticker, anchor: { ...anchor, labelContext: 'ssn 123-45-6789' } };
    expect(() => assertNoCoveredText(record(bad))).toThrow(/Privacy invariant/);
  });

  it('rejects a raw account number that leaked into a label', () => {
    const bad = { ...sticker, label: 'acct 9876543210' };
    expect(() => assertNoCoveredText(record(bad))).toThrow(/Privacy invariant/);
  });
});

/** Minimal chrome.storage mock; `set` can be told to fail. */
function mockChrome(opts: { failSet?: boolean } = {}) {
  const data: Record<string, unknown> = {};
  const set = vi.fn(async (items: Record<string, unknown>) => {
    if (opts.failSet) throw new Error('QUOTA_BYTES quota exceeded');
    Object.assign(data, JSON.parse(JSON.stringify(items)));
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { set, get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return { data, set };
}

describe('H1: saving never trips over a record id', () => {
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  it('a path with a 9-digit account id in a middle segment yields a storable scope', () => {
    const pattern = defaultPathPattern('/accounts/123456789/tx');
    expect(pattern).toBe('/accounts/*/tx');
    const frameUrl = 'https://bank.example' + defaultPathPattern('/embed/100200300/frame/C0001234');
    expect(frameUrl).toBe('https://bank.example/embed/*/frame/*');
    const s = { ...sticker, scope: { pathPattern: pattern }, frame: { depth: 1, urlPattern: frameUrl } };
    expect(() => assertNoCoveredText(record(s))).not.toThrow();
  });

  it('a record with one bad sticker still persists the good ones', async () => {
    const { data } = mockChrome();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad: ElementSticker = { ...sticker, id: 'bad', anchor: { ...anchor, cssPath: 'td[data-testid="row-123456789"]' } };
    const good: ElementSticker = { ...sticker, id: 'good' };
    const rec: SiteRecord = { ...record(good), stickers: [bad, good] };
    const { dropped } = await saveSite(rec);
    expect(dropped).toEqual(['bad']);
    const stored = data[siteKey(rec.origin)] as SiteRecord;
    expect(stored.stickers.map((s) => s.id)).toEqual(['good']);
  });

  it('SiteStore.flush keeps the record in memory and raises saveError instead of rejecting', async () => {
    mockChrome({ failSet: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await SiteStore.open('https://example.test');
    const seen: boolean[] = [];
    store.onSaveStatus = (e) => seen.push(e);
    store.upsert({ ...sticker, id: 'a' });
    await expect(store.flush()).resolves.toBe(false);
    await store.flush();
    expect(store.saveError).toBe(true);
    expect(store.all.map((s) => s.id)).toEqual(['a']);
    expect(seen).toEqual([true]);
    expect(err).toHaveBeenCalledTimes(1); // logged once, not per save
    store.destroy();
  });
});
