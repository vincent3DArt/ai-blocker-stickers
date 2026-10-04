/**
 * The pathname stickers are scoped against. On a web page that is
 * `location.pathname`. The extension's own PDF viewer has a single page
 * (`/pdf.html`) for every document, so it substitutes a per-document path
 * (`/pdf/<doc key>`) and the ordinary exact/pattern scope logic applies.
 */
let override: (() => string) | null = null;

export function setPagePathOverride(fn: (() => string) | null): void {
  override = fn;
}

export function pagePath(): string {
  return override?.() ?? location.pathname;
}

/**
 * The location stickers are scoped against: `location` itself on a web page;
 * on the PDF viewer, the per-document path with no query (the query only
 * carries the source URL, which the document key already identifies).
 */
export function pageLoc(): { origin: string; hostname: string; pathname: string; search: string } {
  if (!override) return location;
  return { origin: location.origin, hostname: location.hostname, pathname: override(), search: '' };
}
