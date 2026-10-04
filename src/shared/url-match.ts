/**
 * Path scope matching for stickers.
 *
 * A pattern is a slash-separated glob over `location.pathname`:
 *   `*`  matches exactly one segment
 *   `**` matches zero or more remaining segments
 * Query string and hash are ignored.
 *
 * An `exact` scope instead stores an HMAC (per-install key) of the path and
 * matches only that page; the raw path is never stored.
 */

import type { StickerFrame, StickerScope } from './types';

const ID_LIKE = [
  /^\d+$/, // 123
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{8,}$/i, // hex ids
  /^[A-Z]{1,3}-?\d{4,}$/, // INV-20231, C0001234
];

export function isIdLikeSegment(segment: string): boolean {
  return ID_LIKE.some((re) => re.test(segment));
}

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A document / resource identifier rather than a record number: Google
 * Drive/Docs ids, UUIDs, long hex, Notion/SharePoint style tokens. Each one
 * names ONE document, so a scope must never generalise over it ("next client
 * on the same screen" does not apply to "next file").
 *
 * Rule: at least 16 characters of `[A-Za-z0-9_-]`, and either a uuid, long
 * hex, letters mixed with digits, or real mixed case (not a lowercase slug of
 * words like `account-settings-overview`).
 */
export function isDocIdSegment(segment: string): boolean {
  if (segment.length < 16 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (UUID_SEG.test(segment) || /^[0-9a-f]+$/i.test(segment)) return true;
  if (/^[a-z]+(?:[-_][a-z]+)*$/.test(segment)) return false; // lowercase word slug
  const hasDigit = /\d/.test(segment);
  const hasLetter = /[A-Za-z]/.test(segment);
  if (hasDigit && hasLetter) return true;
  const uppers = (segment.match(/[A-Z]/g) ?? []).length;
  return uppers >= 3 && /[a-z]/.test(segment) && !/[-_]/.test(segment);
}

export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/** Canonical form of a path for exact (HMAC) matching: no empty segments, no trailing slash. */
export function normalizePath(pathname: string): string {
  const segs = splitPath(pathname);
  return segs.length ? '/' + segs.join('/') : '/';
}

/** A run of this many digits is never stored in a pattern (the privacy guard's territory). */
const DIGIT_RUN = /\d{4,}/;

/**
 * Replace every segment that is id-like, a document id, or that still carries
 * a run of four or more digits, with `*`. Glob segments are kept. Used for
 * everything that ends up in storage (scopes and iframe URL patterns), so an
 * account number or a document id in the URL can never reach
 * `chrome.storage.local` or trip the save guard.
 */
export function sanitizePathPattern(pattern: string): string {
  const segs = splitPath(pattern).map((s) =>
    s === '*' || s === '**' ? s : isIdLikeSegment(s) || isDocIdSegment(s) || DIGIT_RUN.test(s) ? '*' : s,
  );
  return segs.length ? '/' + segs.join('/') : '/';
}

/**
 * The "pages like this" pattern for `pathname`: the same path with EVERY
 * id-like segment generalised to `*`, so the sticker also applies to the next
 * client/record on the same screen and no record id is stored. Only the
 * default scope for paths without a document id (see `defaultScopeKind`).
 */
export function defaultPathPattern(pathname: string): string {
  return sanitizePathPattern(pathname);
}

/** Hosts whose URLs name documents: stickers there default to this page only. */
const DOC_HOSTS = [
  /^drive\.google\.com$/,
  /^docs\.google\.com$/,
  /(^|\.)sharepoint\.com$/,
  /(^|\.)dropbox\.com$/,
  /(^|\.)box\.com$/,
  /(^|\.)notion\.so$/,
  /^app\.hubspot\.com$/,
];

export function isDocHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return DOC_HOSTS.some((re) => re.test(h));
}

/** True when the query string carries a document id (`/open?id=1AbC…`). */
export function searchHasDocId(search: string): boolean {
  try {
    for (const v of new URLSearchParams(search).values()) if (isDocIdSegment(v)) return true;
  } catch {
    /* malformed: treat as none */
  }
  return false;
}

/**
 * Default scope kind for a sticker created at this URL. `exact` (this page
 * only, matched by HMAC) when any path segment is a document id, or on a
 * known document host; `pattern` (record ids generalised) otherwise, which is
 * what keeps `/clients/123` -> `/clients/*` working.
 */
export function defaultScopeKind(hostname: string, pathname: string, search = ''): 'pattern' | 'exact' {
  if (isDocHost(hostname)) return 'exact';
  if (splitPath(pathname).some(isDocIdSegment)) return 'exact';
  if (searchHasDocId(search)) return 'exact';
  return 'pattern';
}

/** HMACs of the current location, precomputed once per navigation (see Session.load). */
export interface PathHmacs {
  /** HMAC of the normalised pathname. */
  path?: string;
  /** HMAC of the normalised pathname plus the search string. */
  pathQuery?: string;
  /** Frames only: HMAC of origin + normalised pathname. */
  frame?: string;
}

/** Does `scope` apply at `pathname`? Scopes without `kind` (stored before it existed) are patterns. */
export function scopeApplies(scope: StickerScope, pathname: string, hmacs: PathHmacs): boolean {
  if (scope.kind === 'exact') {
    const here = scope.includeQuery ? hmacs.pathQuery : hmacs.path;
    return !!scope.pathHmac && !!here && here === scope.pathHmac;
  }
  return typeof scope.pathPattern === 'string' && matchesPath(scope.pathPattern, pathname);
}

/** Does a sticker's frame descriptor apply in this frame? */
export function frameApplies(frame: StickerFrame, depth: number, hmacs: PathHmacs): boolean {
  if (frame.depth !== depth) return false;
  if (depth > 0 && frame.urlHmac) return !!hmacs.frame && hmacs.frame === frame.urlHmac;
  return true;
}

export function prefixPathPattern(pathname: string): string {
  const segs = splitPath(pathname);
  if (segs.length <= 1) return '/**';
  return sanitizePathPattern('/' + segs.slice(0, -1).join('/')).replace(/\/$/, '') + '/**';
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
