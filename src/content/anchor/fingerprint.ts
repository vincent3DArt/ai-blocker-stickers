import type { Fingerprint } from '@/shared/types';
import { hmacHex, normalizeText } from '@/shared/hmac';
import { buildCssPath, buildXPath, isIdentifierLike, isKeyword, isStableId, stableClasses, testId } from './selector';
import { headingContext, labelInfo, normalizeContext, tableContext } from './context';
import { toViewRect, viewToDoc } from './geometry';

/** The HMAC key is set once by the content script boot before any fingerprinting. */
let hmacKey: CryptoKey | null = null;
export function setFingerprintKey(key: CryptoKey) {
  hmacKey = key;
}

export async function textHmacOf(text: string): Promise<string | undefined> {
  const norm = normalizeText(text);
  if (!norm || !hmacKey) return undefined;
  return hmacHex(hmacKey, norm);
}

/**
 * HMAC of an attribute value, un-normalised, for attributes that must match
 * exactly (`id`, test id, `name`). Domain-separated from text HMACs.
 */
export async function attrHmacOf(value: string | null | undefined): Promise<string | undefined> {
  if (!value || !hmacKey) return undefined;
  return hmacHex(hmacKey, 'attr\u0000' + value);
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

export async function buildFingerprint(el: Element): Promise<Fingerprint> {
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
    cssPath: buildCssPath(el),
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
