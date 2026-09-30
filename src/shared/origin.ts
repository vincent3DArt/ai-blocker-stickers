/** Origin validation and content-script registration ids (background only, pure for tests). */

const SCRIPT_ID_PREFIX = 'aibs-v2-';

/** 32-bit FNV-1a over the UTF-16 code units of `s`, as unsigned base36. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Registration id for an origin. The sanitised host keeps ids readable; the
 * FNV hash of the full origin (scheme and port included) keeps `a-b.com` and
 * `a.b.com`, or http and https, from ever sharing an id.
 */
export function scriptId(origin: string): string {
  const host = origin.replace(/^[a-z]+:\/\//i, '').replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  return `${SCRIPT_ID_PREFIX}${host}-${fnv1a(origin)}`;
}

/**
 * A bare http(s) origin, exactly as `URL.origin` prints it, or null. Anything
 * with a path, query, credentials, wildcard or another scheme is rejected, so
 * it can never widen a registered `matches` pattern.
 */
export function parseOrigin(o: unknown): string | null {
  if (typeof o !== 'string') return null;
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // URL() accepts `*` and other odd characters in a host; match patterns
    // would read them as wildcards.
    if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(u.hostname)) return null;

    return u.origin === o ? o : null;
  } catch {
    return null;
  }
}
