import type { ScopeKind, StickerFrame, StickerScope } from '@/shared/types';
import { defaultScopeKind, normalizePath, sanitizePathPattern, searchHasDocId, type PathHmacs } from '@/shared/url-match';
import { pathHmacOf } from '../anchor/fingerprint';

/** The parts of `Location` scoping needs (tests pass plain objects). */
export interface Loc {
  origin: string;
  hostname: string;
  pathname: string;
  search: string;
}

/** Canonical search string for HMACs: params sorted, so `?b=1&a=2` equals `?a=2&b=1`. */
function canonicalSearch(search: string): string {
  try {
    const p = new URLSearchParams(search);
    p.sort();
    return p.toString();
  } catch {
    return search.replace(/^\?/, '');
  }
}

/** HMACs of `loc`, computed once per navigation and handed to `SiteStore.active`. */
export async function pathHmacs(loc: Loc, frameDepth: number): Promise<PathHmacs> {
  const path = normalizePath(loc.pathname);
  const [p, pq, f] = await Promise.all([
    pathHmacOf(path),
    pathHmacOf(path + '?' + canonicalSearch(loc.search)),
    frameDepth > 0 ? pathHmacOf(loc.origin + path, 'frame') : Promise.resolve(undefined),
  ]);
  return { path: p, pathQuery: pq, frame: f };
}

/**
 * Build a scope of `kind` for `loc`. `exact` stores only the HMAC of the
 * path (plus query when the query names the document) and the sanitised
 * pattern for display; `pattern` stores the sanitised `pattern` (default: the
 * path with every id generalised).
 */
export async function makeScope(kind: ScopeKind, loc: Loc, pattern?: string): Promise<StickerScope> {
  if (kind === 'exact') {
    const includeQuery = searchHasDocId(loc.search);
    const h = await pathHmacs(loc, 0);
    const pathHmac = includeQuery ? h.pathQuery : h.path;
    // Without a key there is no way to match exactly; fall back to the pattern.
    if (pathHmac) {
      const scope: StickerScope = { kind: 'exact', pathPattern: sanitizePathPattern(loc.pathname), pathHmac };
      if (includeQuery) scope.includeQuery = true;
      return scope;
    }
  }
  return { kind: 'pattern', pathPattern: sanitizePathPattern(pattern ?? loc.pathname) };
}

/** Scope for a new sticker: exact on document URLs, record ids generalised otherwise. */
export function defaultScope(loc: Loc): Promise<StickerScope> {
  return makeScope(defaultScopeKind(loc.hostname, loc.pathname, loc.search), loc);
}

/**
 * Frame descriptor for a new sticker. A frame whose URL names a document (a
 * Drive preview) gets an HMAC of origin + path, so stickers do not follow
 * into another document's preview; otherwise origin plus the sanitised path.
 */
export async function frameDescriptor(depth: number, loc: Loc): Promise<StickerFrame> {
  if (depth === 0) return { depth };
  if (defaultScopeKind(loc.hostname, loc.pathname, loc.search) === 'exact') {
    const urlHmac = (await pathHmacs(loc, depth)).frame;
    if (urlHmac) return { depth, urlHmac };
  }
  return { depth, urlPattern: loc.origin + sanitizePathPattern(loc.pathname) };
}
