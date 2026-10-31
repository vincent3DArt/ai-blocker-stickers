import { describe, expect, it, vi } from 'vitest';

import { LATEST_RELEASE_API, availableUpdate, fetchLatestRelease, isNewer, parseVersion, readUpdateInfo, releaseUrl } from '@/shared/update';

function reply(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('version compare', () => {
  it('parses plain and v-prefixed tags only', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.10.0')).toEqual([0, 10, 0]);
    expect(parseVersion('v1.2.3-beta.1')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('compares numerically, part by part', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
    expect(isNewer(undefined, '0.1.0')).toBe(false);
  });

  it('offers an update only when the stored release is newer', () => {
    expect(availableUpdate({ checkedAt: 1, latest: '0.2.0' }, '0.1.0')).toBe('0.2.0');
    expect(availableUpdate({ checkedAt: 1, latest: '0.1.0' }, '0.1.0')).toBeNull();
    expect(availableUpdate({ checkedAt: 1 }, '0.1.0')).toBeNull();
    expect(availableUpdate(undefined, '0.1.0')).toBeNull();
  });

  it('builds the release link from the version, on github.com only', () => {
    expect(releaseUrl('0.2.0')).toBe('https://github.com/vincent3DArt/ai-blocker-stickers/releases/tag/v0.2.0');
  });

  it('drops a malformed stored version', () => {
    expect(readUpdateInfo({ checkedAt: 5, latest: 'javascript:alert(1)' })).toEqual({ checkedAt: 5 });
    expect(readUpdateInfo({ checkedAt: 5, latest: '0.3.1' })).toEqual({ checkedAt: 5, latest: '0.3.1' });
    expect(readUpdateInfo({ latest: '0.3.1' })).toBeUndefined();
    expect(readUpdateInfo(null)).toBeUndefined();
  });
});

describe('fetchLatestRelease', () => {
  it('reads the tag of the latest release, anonymously', async () => {
    const f = reply(200, { tag_name: 'v0.4.2', draft: false, prerelease: false });
    expect(await fetchLatestRelease(f, 42)).toEqual({ checkedAt: 42, latest: '0.4.2' });
    expect(f).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.objectContaining({ credentials: 'omit' }));
  });

  it('treats 404 (no release yet) as nothing newer', async () => {
    expect(await fetchLatestRelease(reply(404), 7)).toEqual({ checkedAt: 7 });
  });

  it('ignores prereleases and odd tags', async () => {
    expect(await fetchLatestRelease(reply(200, { tag_name: 'v0.5.0', prerelease: true }), 1)).toEqual({ checkedAt: 1 });
    expect(await fetchLatestRelease(reply(200, { tag_name: 'nightly' }), 1)).toEqual({ checkedAt: 1 });
  });

  it('throws on rate limits and server errors so the last result is kept', async () => {
    await expect(fetchLatestRelease(reply(403))).rejects.toThrow('403');
    await expect(fetchLatestRelease(reply(500))).rejects.toThrow('500');
  });
});
