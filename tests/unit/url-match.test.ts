import { describe, expect, it } from 'vitest';
import { defaultPathPattern, isIdLikeSegment, matchesPath, prefixPathPattern } from '@/shared/url-match';

describe('isIdLikeSegment', () => {
  it('detects numeric, uuid, hex and prefixed ids', () => {
    expect(isIdLikeSegment('123')).toBe(true);
    expect(isIdLikeSegment('4b8c1d2e-1111-2222-3333-444455556666')).toBe(true);
    expect(isIdLikeSegment('deadbeef01')).toBe(true);
    expect(isIdLikeSegment('INV-20231')).toBe(true);
  });
  it('keeps ordinary words', () => {
    expect(isIdLikeSegment('clients')).toBe(false);
    expect(isIdLikeSegment('edit')).toBe(false);
    expect(isIdLikeSegment('2024-returns')).toBe(false);
  });
});

describe('defaultPathPattern', () => {
  it('generalises an id-like last segment', () => {
    expect(defaultPathPattern('/clients/123')).toBe('/clients/*');
    expect(defaultPathPattern('/clients/123/')).toBe('/clients/*');
  });
  it('keeps non-id paths exact', () => {
    expect(defaultPathPattern('/clients/list')).toBe('/clients/list');
    expect(defaultPathPattern('/')).toBe('/');
  });
});

describe('prefixPathPattern', () => {
  it('replaces the last segment with **', () => {
    expect(prefixPathPattern('/clients/123')).toBe('/clients/**');
    expect(prefixPathPattern('/only')).toBe('/**');
  });
});

describe('matchesPath', () => {
  it('matches exact paths', () => {
    expect(matchesPath('/clients/list', '/clients/list')).toBe(true);
    expect(matchesPath('/clients/list', '/clients/list/extra')).toBe(false);
  });
  it('* matches exactly one segment', () => {
    expect(matchesPath('/clients/*', '/clients/456')).toBe(true);
    expect(matchesPath('/clients/*', '/clients')).toBe(false);
    expect(matchesPath('/clients/*', '/clients/456/edit')).toBe(false);
  });
  it('** matches the rest', () => {
    expect(matchesPath('/clients/**', '/clients')).toBe(true);
    expect(matchesPath('/clients/**', '/clients/1/2/3')).toBe(true);
    expect(matchesPath('/**', '/anything/at/all')).toBe(true);
  });
  it('ignores trailing slashes', () => {
    expect(matchesPath('/a/b', '/a/b/')).toBe(true);
  });
});
