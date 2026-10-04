import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defaultScopeKind,
  frameApplies,
  isDocIdSegment,
  sanitizePathPattern,
  scopeApplies,
} from '@/shared/url-match';
import { setFingerprintKey } from '@/content/anchor/fingerprint';
import { importKey, randomKeyB64 } from '@/shared/hmac';
import { defaultScope, frameDescriptor, makeScope, pathHmacs, type Loc } from '@/content/state/scope';
import { assertNoCoveredText } from '@/shared/storage';
import { SiteStore } from '@/content/state/store';
import { scopeKindOf, type ElementSticker, type SiteRecord, type StickerScope } from '@/shared/types';

const DRIVE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
// A document id that also carries a long digit run: the guard would catch it raw.
const DIGIT_DOC_ID = '1AbCdEfGh123456789012QrStUvWxYz0123';
const UUID = '4b8c1d2e-1111-2222-3333-444455556666';

function loc(url: string): Loc {
  const u = new URL(url);
  return { origin: u.origin, hostname: u.hostname, pathname: u.pathname, search: u.search };
}

beforeAll(async () => {
  setFingerprintKey(await importKey(randomKeyB64()));
});

describe('scope classification', () => {
  it('document ids default to exact', () => {
    expect(isDocIdSegment(DRIVE_ID)).toBe(true);
    expect(isDocIdSegment(UUID)).toBe(true);
    expect(isDocIdSegment('0123456789abcdef0123')).toBe(true);
    expect(defaultScopeKind('example.test', `/file/d/${DRIVE_ID}/view`)).toBe('exact');
    expect(defaultScopeKind('example.test', `/items/${UUID}`)).toBe('exact');
    expect(defaultScopeKind('example.test', '/open', `?id=${DRIVE_ID}`)).toBe('exact');
  });

  it('short record ids keep the pattern default', () => {
    expect(defaultScopeKind('example.test', '/clients/123')).toBe('pattern');
    expect(defaultScopeKind('example.test', '/c/42/orders/INV-20231')).toBe('pattern');
    expect(defaultScopeKind('example.test', '/accounts/123456789/tx')).toBe('pattern');
    expect(defaultScopeKind('example.test', '/settings/account-settings-overview')).toBe('pattern');
    expect(isDocIdSegment('account-settings-overview')).toBe(false);
    expect(isDocIdSegment('deadbeef01')).toBe(false);
  });

  it('known document hosts default to exact', () => {
    for (const host of ['drive.google.com', 'docs.google.com', 'acme.sharepoint.com', 'www.dropbox.com', 'app.box.com', 'www.notion.so', 'app.hubspot.com']) {
      expect(defaultScopeKind(host, '/home'), host).toBe('exact');
    }
    expect(defaultScopeKind('google.com', '/home')).toBe('pattern');
  });

  it('a document id never survives sanitising', () => {
    expect(sanitizePathPattern(`/file/d/${DRIVE_ID}/view`)).toBe('/file/d/*/view');
    expect(sanitizePathPattern(`/document/d/${DRIVE_ID}/edit`)).toBe('/document/d/*/edit');
  });
});

describe('exact scopes', () => {
  it('match the same document only, by HMAC', async () => {
    const a = loc(`https://drive.example/file/d/${DRIVE_ID}/view`);
    const b = loc('https://drive.example/file/d/9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876/view');
    const scope = await defaultScope(a);
    expect(scope.kind).toBe('exact');
    expect(scope.pathHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.pathPattern).toBe('/file/d/*/view');
    expect(scopeApplies(scope, a.pathname, await pathHmacs(a, 0))).toBe(true);
    expect(scopeApplies(scope, a.pathname + '/', await pathHmacs({ ...a, pathname: a.pathname + '/' }, 0))).toBe(true);
    expect(scopeApplies(scope, b.pathname, await pathHmacs(b, 0))).toBe(false);
    // Without HMACs (no key yet) an exact scope never applies.
    expect(scopeApplies(scope, a.pathname, {})).toBe(false);
  });

  it('a record path still defaults to a generalised pattern', async () => {
    const scope = await defaultScope(loc('https://crm.example/clients/123'));
    expect(scope).toEqual({ kind: 'pattern', pathPattern: '/clients/*' });
    expect(scopeApplies(scope, '/clients/456', {})).toBe(true);
  });

  it('includes the query when the query names the document', async () => {
    const a = loc(`https://files.example/open?id=${DRIVE_ID}`);
    const scope = await makeScope('exact', a);
    expect(scope.includeQuery).toBe(true);
    expect(scopeApplies(scope, a.pathname, await pathHmacs(a, 0))).toBe(true);
    const other = loc('https://files.example/open?id=9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876');
    expect(scopeApplies(scope, other.pathname, await pathHmacs(other, 0))).toBe(false);
  });

  it('document frames get an HMAC descriptor, other frames a sanitised pattern', async () => {
    const a = loc(`https://drive.example/drive/file/d/${DRIVE_ID}/preview`);
    const b = loc('https://drive.example/drive/file/d/9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876/preview');
    const f = await frameDescriptor(1, a);
    expect(f.urlHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(f.urlPattern).toBeUndefined();
    expect(frameApplies(f, 1, await pathHmacs(a, 1))).toBe(true);
    expect(frameApplies(f, 1, await pathHmacs(b, 1))).toBe(false);
    const plain = await frameDescriptor(1, loc('https://bank.example/embed/100200300/frame'));
    expect(plain).toEqual({ depth: 1, urlPattern: 'https://bank.example/embed/*/frame' });
  });
});

describe('migration', () => {
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('stored scopes without a kind are patterns, unchanged', async () => {
    const legacy: StickerScope = { pathPattern: '/clients/*' };
    expect(scopeKindOf(legacy)).toBe('pattern');
    expect(scopeApplies(legacy, '/clients/456', {})).toBe(true);
    expect(scopeApplies(legacy, '/settings', {})).toBe(false);

    const sticker = { id: 'legacy', kind: 'element', scope: legacy, frame: { depth: 0 } } as unknown as ElementSticker;
    const rec: SiteRecord = { v: 1, origin: 'https://crm.example', enabled: true, stickers: [sticker], updatedAt: 1 };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: { get: vi.fn(async () => ({ 'site:https://crm.example': rec })), set: vi.fn() },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
    const store = await SiteStore.open('https://crm.example');
    expect(store.active('/clients/456', 0).map((s) => s.id)).toEqual(['legacy']);
    expect(store.all).toHaveLength(1);
    store.destroy();
  });
});

describe('privacy guard on exact scopes', () => {
  it('an exact-scoped record stores no raw document id', async () => {
    const a = loc(`https://drive.google.com/file/d/${DIGIT_DOC_ID}/view`);
    const scope = await defaultScope(a);
    const frame = await frameDescriptor(1, loc(`https://drive.google.com/file/d/${DIGIT_DOC_ID}/preview`));
    const sticker = {
      kind: 'element',
      id: '282770b4-f9b5-4c50-b1be-130f31e5b56b',
      scope,
      frame,
      source: 'manual',
      padding: 3,
      createdAt: 1758193000000,
      updatedAt: 1758193000000,
      anchor: { tag: 'span', classes: [], cssPath: '#doc-ssn', xpath: '/html/body/span[1]', textLen: 11, rect: { x: 0, y: 0, w: 1, h: 1 }, viewportW: 1000, docH: 1000 },
      maskMode: 'text',
    } as ElementSticker;
    const rec: SiteRecord = { v: 1, origin: a.origin, enabled: true, stickers: [sticker], updatedAt: 1758193000000 };
    const json = JSON.stringify(rec);
    expect(json).not.toContain(DIGIT_DOC_ID);
    expect(json).not.toContain(a.pathname);
    expect(() => assertNoCoveredText(rec)).not.toThrow();
    // The exemption only covers real HMACs: a raw path in `pathHmac` is still scanned.
    const leaky = { ...rec, stickers: [{ ...sticker, scope: { ...scope, pathHmac: '/accounts/123456789' } }] };
    expect(() => assertNoCoveredText(leaky)).toThrow(/Privacy invariant/);
  });
});
