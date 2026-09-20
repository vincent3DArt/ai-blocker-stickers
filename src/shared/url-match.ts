/**
 * Path scope matching for stickers.
 *
 * A pattern is a slash-separated glob over `location.pathname`:
 *   `*`  matches exactly one segment
 *   `**` matches zero or more remaining segments
 * Query string and hash are ignored.
 */

const ID_LIKE = [
  /^\d+$/, // 123
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{8,}$/i, // hex ids
  /^[A-Z]{1,3}-?\d{4,}$/, // INV-20231, C0001234
];

export function isIdLikeSegment(segment: string): boolean {
  return ID_LIKE.some((re) => re.test(segment));
}

export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/**
 * Default scope for a sticker created on `pathname`: the same path, with an
 * ID-like last segment generalised to `*` so the sticker also applies to the
 * next client/record on the same screen.
 */
export function defaultPathPattern(pathname: string): string {
  const segs = splitPath(pathname);
  if (segs.length === 0) return '/';
  const last = segs[segs.length - 1];
  if (isIdLikeSegment(last)) segs[segs.length - 1] = '*';
  return '/' + segs.join('/');
}

export function prefixPathPattern(pathname: string): string {
  const segs = splitPath(pathname);
  if (segs.length <= 1) return '/**';
  return '/' + segs.slice(0, -1).join('/') + '/**';
}

export function matchesPath(pattern: string, pathname: string): boolean {
  const p = splitPath(pattern);
  const s = splitPath(pathname);
  let i = 0;
  for (; i < p.length; i++) {
    const seg = p[i];
    if (seg === '**') return true;
    if (i >= s.length) return false;
    if (seg === '*') continue;
    if (seg !== s[i]) return false;
  }
  return i === s.length;
}
