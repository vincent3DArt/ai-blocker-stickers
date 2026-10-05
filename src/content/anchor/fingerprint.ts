import type { Fingerprint } from '@/shared/types';
import { hmacHex, normalizeText } from '@/shared/hmac';
import { syncHmac, type SyncHmac } from '@/shared/hmac-sync';
import { buildCssPath, buildXPath, isIdentifierLike, isKeyword, isStableId, stableClasses, testId } from './selector';
import { headingContext, labelInfo, normalizeContext, tableContext } from './context';
import { toViewRect, viewToDoc } from './geometry';

/** The HMAC key is set once by the content script boot before any fingerprinting. */
let hmacKey: CryptoKey | null = null;
/** The same key for synchronous use inside mutation callbacks (shared/hmac-sync.ts). */
let syncKey: SyncHmac | null = null;
export function setFingerprintKey(key: CryptoKey, raw?: Uint8Array) {
  hmacKey = key;
  syncKey = raw ? syncHmac(raw) : null;
}

export async function textHmacOf(text: string): Promise<string | undefined> {
  const norm = normalizeText(text);
  if (!norm || !hmacKey) return undefined;
  return hmacHex(hmacKey, norm);
}

/**
 * `textHmacOf`, synchronously; undefined when no raw key was given. Equal to
 * the async value for the same text (tests/unit/hmac-sync.test.ts).
 */
export function textHmacSync(text: string): string | undefined {
  const norm = normalizeText(text);
  if (!norm || !syncKey) return undefined;
  return syncKey.hex(norm);
}

/** True when the synchronous hasher is available. */
export function hasSyncKey(): boolean {
  return !!syncKey;
}

/**
 * HMAC of the exact characters a rect sticker covered (whitespace collapsed,
 * case kept: the text is located again by this value). Domain-separated.
 */
export function coveredHmacSync(text: string): string | undefined {
  if (!syncKey || !text) return undefined;
  return syncKey.hex('cover\u0000' + text.replace(/\s+/g, ' '));
}

/** HMAC of one whitespace-delimited token (lowercased). Domain-separated. */
export function tokenHmacSync(token: string): string | undefined {
  const t = token.trim().toLowerCase();
  if (!syncKey || !t) return undefined;
  return syncKey.hex('token\u0000' + t);
}

/** Record-key HMAC of `el` (see `keyHmacOf`), synchronously. */
export function keyHmacSync(el: Element): string | undefined {
  const k = keyAttrOf(el);
  return k ? textHmacSync(k.value) : undefined;
}

/**
 * HMAC of an attribute value, un-normalised, for attributes that must match
 * exactly (`id`, test id, `name`). Domain-separated from text HMACs.
 */
export async function attrHmacOf(value: string | null | undefined): Promise<string | undefined> {
  if (!value || !hmacKey) return undefined;
  return hmacHex(hmacKey, 'attr\u0000' + value);
}

/**
 * HMAC of a URL path (already normalised by the caller), for exact sticker
 * scopes and frame descriptors. Domain-separated from text and attribute
 * HMACs. `kind` separates page paths from frame URLs.
 */
export async function pathHmacOf(value: string, kind: 'path' | 'frame' = 'path'): Promise<string | undefined> {
  if (!hmacKey) return undefined;
  return hmacHex(hmacKey, kind + '\u0000' + value);
}

/** `pathHmacOf`, synchronously (boot fast path); undefined without the raw key. */
export function pathHmacSync(value: string, kind: 'path' | 'frame' = 'path'): string | undefined {
  return syncKey?.hex(kind + '\u0000' + value);
}

/**
 * HMAC of an in-page viewer's normalised document text (content/state/view.ts).
 * Domain-separated from text, attribute and path HMACs.
 */
export async function viewHmacOf(text: string): Promise<string | undefined> {
  if (!hmacKey) return undefined;
  return hmacHex(hmacKey, 'view\u0000' + text);
}

/** An attribute stored raw when identifier-like, as an HMAC otherwise. */
async function rawOrHmac(value: string | null | undefined): Promise<{ raw?: string; hmac?: string }> {
  if (!value) return {};
  if (isIdentifierLike(value)) return { raw: value };
  return { hmac: await attrHmacOf(value) };
}

/** Text used for the fingerprint: visible text, or the value for form controls. */
export function fingerprintText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el.value ?? '';
  }
  return el.textContent ?? '';
}

/**
 * Attributes frameworks use to identify the record a node belongs to. The
 * value is frequently the sensitive number itself (the layout-shift fixture's
 * `data-key` IS the account number), so only its HMAC is ever stored.
 */
export const KEY_ATTRS = [
  'data-key',
  'data-id',
  'data-row-id',
  'data-rowid',
  'data-uid',
  'data-record-id',
  'data-item-id',
  'key',
] as const;

export const KEY_ATTR_SELECTOR = KEY_ATTRS.map((a) => `[${a}]`).join(',');

/** Nearest record key on the element or one of its first four ancestors. */
export function keyAttrOf(el: Element): { attr: string; value: string } | undefined {
  let node: Element | null = el;
  for (let level = 0; node && level <= 4; level++, node = node.parentElement) {
    for (const a of KEY_ATTRS) {
      const v = node.getAttribute(a);
      if (v && v.trim()) return { attr: a, value: v.trim() };
    }
  }
  return undefined;
}

export async function keyHmacOf(el: Element): Promise<{ keyAttr: string; keyHmac: string } | undefined> {
  const k = keyAttrOf(el);
  if (!k) return undefined;
  const h = await textHmacOf(k.value);
  return h ? { keyAttr: k.attr, keyHmac: h } : undefined;
}

/** The shadow root `el` lives in (null in the document) and the chain of hosts above it, outermost first. */
export function shadowChain(el: Element): { root: Document | ShadowRoot; hosts: Element[] } {
  const hosts: Element[] = [];
  let r = el.getRootNode();
  const root = r instanceof ShadowRoot ? r : document;
  while (r instanceof ShadowRoot) {
    hosts.unshift(r.host);
    r = r.host.getRootNode();
  }
  return { root, hosts };
}

export async function buildFingerprint(el: Element): Promise<Fingerprint> {
  const chain = shadowChain(el);
  const text = fingerprintText(el);
  const label = labelInfo(el);
  const key = await keyHmacOf(el);
  // Attribute values can carry the covered data itself (the masker scrubs
  // them for that reason), so none is stored verbatim unless it reads like an
  // identifier: exact-match attributes fall back to an HMAC, descriptive ones
  // are normalised exactly like labelContext.
  const id = await rawOrHmac(el.id && isStableId(el.id) ? el.id : undefined);
  const tid = await rawOrHmac(testId(el));
  const name = await rawOrHmac(el.getAttribute('name'));
  const type = el.getAttribute('type');
  const role = el.getAttribute('role');
  const rect = viewToDoc(toViewRect(el.getBoundingClientRect()));
  const fp: Fingerprint = {
    tag: el.tagName.toLowerCase(),
    id: id.raw,
    idHmac: id.hmac,
    testId: tid.raw,
    testIdHmac: tid.hmac,
    name: name.raw,
    nameHmac: name.hmac,
    type: isKeyword(type) ? type : undefined,
    role: isKeyword(role) ? role : undefined,
    ariaLabel: normalizeContext(el.getAttribute('aria-label')),
    placeholder: normalizeContext(el.getAttribute('placeholder')),

    classes: stableClasses(el),
    cssPath: buildCssPath(el, 8, chain.root),
    hostPath: chain.hosts.length ? chain.hosts.map((h) => buildCssPath(h, 8, shadowChain(h).root)) : undefined,
    xpath: buildXPath(el),
    labelContext: label?.text,
    labelSource: label?.source,
    keyHmac: key?.keyHmac,
    keyAttr: key?.keyAttr,
    headingContext: headingContext(el),
    tableContext: tableContext(el),
    textHmac: await textHmacOf(text),
    textLen: normalizeText(text).length,
    rect,
    viewportW: window.innerWidth,
    docH: document.documentElement.scrollHeight,
  };
  // Drop undefined keys so stored records stay compact.
  for (const k of Object.keys(fp) as (keyof Fingerprint)[]) {
    if (fp[k] === undefined) delete fp[k];
  }
  return fp;
}

/**
 * Identity of an auto-suggest suggestion (pattern, element path, label), so a
 * dismissal can be remembered without storing any of it. Same per-install key
 * as the fingerprints, domain-separated.
 */
export async function suggestionHmacOf(identity: string): Promise<string | undefined> {
  if (!hmacKey) return undefined;
  return hmacHex(hmacKey, 'suggest\u0000' + identity);
}
