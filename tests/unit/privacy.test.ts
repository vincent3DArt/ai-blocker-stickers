import { describe, expect, it } from 'vitest';

import { assertNoCoveredText } from '@/shared/storage';
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
