import { webcrypto, createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { b64Bytes, sha256 } from '@/shared/hmac-sync';
import { importKey, randomKeyB64 } from '@/shared/hmac';
import { setFingerprintKey, textHmacOf, textHmacSync } from '@/content/anchor/fingerprint';

beforeAll(() => {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (!g.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
});

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('synchronous HMAC-SHA256', () => {
  it('sha256 matches node for empty, short and multi-block inputs', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'ü'.repeat(300)]) {
      const bytes = new TextEncoder().encode(s);
      expect(hex(sha256(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('textHmacSync equals the WebCrypto textHmacOf for the same key', async () => {
    const b64 = randomKeyB64();
    setFingerprintKey(await importKey(b64), b64Bytes(b64));
    for (const s of ['123-45-6789', '  Taxpayer   SSN 123-45-6789 ', 'Ünïcode ✓ text', 'a'.repeat(200)]) {
      expect(textHmacSync(s)).toBe(await textHmacOf(s));
    }
    expect(textHmacSync('   ')).toBeUndefined();
  });
});
