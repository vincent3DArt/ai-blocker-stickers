/**
 * In-page viewer identity.
 *
 * Some sites open a document in an overlay without changing the URL: Google
 * Drive's file preview sits on top of `/drive/u/0/home`, and every file opened
 * from there shares that URL. A sticker placed inside such a viewer must not
 * apply to the page behind it, nor to another file's preview, so it also
 * carries a *view identity*: an HMAC of the first characters of the viewer's
 * document text. Same file, same hash; another file, another hash. Nothing
 * readable is stored.
 *
 * Only the first `VIEW_TEXT_MAX` characters (whitespace removed) are hashed,
 * and a sticker records how many it hashed (`viewLen`), so the identity does
 * not change as lazily rendered later pages add text. Two files whose first
 * page reads the same share their stickers.
 */
import type { StickerScope } from '@/shared/types';
import { viewHmacOf } from '../anchor/fingerprint';

/** Characters of document text (whitespace removed) a view identity is computed from. */
export const VIEW_TEXT_MAX = 1500;
/** An overlay without a `[role=document]` needs at least this much text to count as a viewer. */
export const VIEW_TEXT_MIN = 200;
/** A `position: fixed` element covering this share of the viewport counts as an overlay. */
const FIXED_COVER = 0.6;

export interface ViewOptions {
  /** Our own nodes (overlay host): never part of a view's text. */
  isOurs?: (n: Node) => boolean;
  /** The page's original text of a node we masked (Masker.originalText). */
  originalOf?: (t: Text) => string | undefined;
}

export interface ViewIdentity {
  viewHmac: string;
  viewLen: number;
  /** The overlay the identity was computed for (memory only). */
  root: Element;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * Normalised text of `root` for view identities: whitespace removed,
 * lowercased, at most `max` characters. Toolbars (`role=toolbar`: page
 * counters, zoom levels), our own nodes, and scripts are skipped; text we
 * masked is read back as the page's original, so covering something inside
 * the first characters does not change the hash.
 */
export function viewText(root: Element, o: ViewOptions = {}, max = VIEW_TEXT_MAX): string {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = n as Element;
      if (SKIP_TAGS.has(el.tagName) || el.getAttribute('role') === 'toolbar' || o.isOurs?.(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  let out = '';
  for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
    const t = n as Text;
    const data = o.originalOf?.(t) ?? t.data;
    out += data.replace(/\s+/g, '').toLowerCase();
  }
  return out.slice(0, max);
}

function coversViewport(el: Element, share: number): boolean {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw <= 0 || vh <= 0) return false;
  const w = Math.min(r.right, vw) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
  return w > 0 && h > 0 && (w * h) / (vw * vh) >= share;
}

/** A dialog, a modal, or a fixed layer over most of the viewport. */
function isOverlayCandidate(el: Element): boolean {
  if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') return true;
  if (el === document.body || el === document.documentElement) return false;
  return getComputedStyle(el).position === 'fixed' && coversViewport(el, FIXED_COVER);
}

/** The element whose text identifies the view: its `[role=document]`, or the overlay itself. */
export function textRootOf(overlay: Element): Element {
  if (overlay.getAttribute('role') === 'document') return overlay;
  return overlay.querySelector('[role="document"]') ?? overlay;
}

/**
 * An overlay that holds a document: a `[role=document]` inside it, or (for
 * overlays without one) a viewport-sized layer with at least VIEW_TEXT_MIN
 * characters. A small dialog (a share form, a confirmation) is not a viewer.
 */
function isViewer(overlay: Element, o: ViewOptions): boolean {
  if (overlay.querySelector('[role="document"]')) return true;
  return coversViewport(overlay, FIXED_COVER) && viewText(overlay, o, VIEW_TEXT_MIN).length >= VIEW_TEXT_MIN;
}

/** Nearest ancestor-or-self of `el` that is an overlay viewer, or null. */
export function overlayRootOf(el: Element, o: ViewOptions = {}): Element | null {
  for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
    if (o.isOurs?.(a)) return null;
    if (isOverlayCandidate(a) && isViewer(a, o)) return a;
  }
  return null;
}

/** Every overlay viewer currently in the document. */
export function overlayRoots(o: ViewOptions = {}): Element[] {
  const cands = new Set<Element>(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="document"]'));
  // Fixed layers without a role: the body's children and grandchildren.
  const body = document.body;
  if (body) {
    let seen = 0;
    for (const c of Array.from(body.children)) {
      if (++seen > 300) break;
      cands.add(c);
      for (const g of Array.from(c.children)) {
        if (++seen > 300) break;
        cands.add(g);
      }
    }
  }
  const roots = new Set<Element>();
  for (const c of cands) {
    if (o.isOurs?.(c)) continue;
    // Only role-bearing candidates walk up; plain body children must be the overlay themselves.
    const r = c.hasAttribute('role') || c.hasAttribute('aria-modal') ? overlayRootOf(c, o) : isOverlayCandidate(c) && isViewer(c, o) ? c : null;
    if (r) roots.add(r);
  }
  return Array.from(roots);
}

/** HMACs of recent view prefixes, so a mutation batch does not re-sign the same text. Memory only. */
const cache = new Map<string, string>();

async function hmacOfPrefix(prefix: string): Promise<string | undefined> {
  const hit = cache.get(prefix);
  if (hit) return hit;
  const h = await viewHmacOf(prefix);
  if (!h) return undefined;
  cache.set(prefix, h);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return h;
}

/** Lookup key of a view identity: length and HMAC. */
export function viewKey(scope: Pick<StickerScope, 'viewHmac' | 'viewLen'>): string {
  return `${scope.viewLen ?? VIEW_TEXT_MAX}:${scope.viewHmac}`;
}

/** View identity for a sticker placed on `el`, or undefined when `el` is not inside an overlay viewer. */
export async function viewIdentityOf(el: Element, o: ViewOptions = {}): Promise<ViewIdentity | undefined> {
  const root = overlayRootOf(el, o);
  if (!root) return undefined;
  const text = viewText(textRootOf(root), o);
  const viewHmac = await hmacOfPrefix(text);
  return viewHmac ? { viewHmac, viewLen: text.length, root } : undefined;
}

/**
 * The view keys present right now, each mapped to its overlay. `lens` are
 * the `viewLen`s of the stickers that could apply: a view is only hashed at
 * the lengths someone asked for, and only once it has that much text (a
 * text layer that has not rendered yet matches nothing).
 */
export async function presentViews(lens: number[], o: ViewOptions = {}): Promise<Map<string, Element>> {
  const out = new Map<string, Element>();
  if (!lens.length) return out;
  const want = Array.from(new Set(lens)).sort((a, b) => a - b);
  const max = Math.min(VIEW_TEXT_MAX, want[want.length - 1]);
  for (const root of overlayRoots(o)) {
    const text = viewText(textRootOf(root), o, max);
    for (const len of want) {
      if (text.length < len) break;
      const h = await hmacOfPrefix(text.slice(0, len));
      if (h) out.set(`${len}:${h}`, root);
    }
  }
  return out;
}
