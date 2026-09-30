import { KEY_ATTRS } from '../anchor/fingerprint';

/** Attributes that leak text into the accessibility tree or tooltips. */
export const SCRUB_ATTRS = ['title', 'alt', 'aria-label', 'aria-description', 'placeholder', 'data-tooltip', 'data-title'];

export type AttrBackup = Map<Element, Map<string, string | null>>;

export function remember(backup: AttrBackup, el: Element, attr: string) {
  let m = backup.get(el);
  if (!m) {
    m = new Map();
    backup.set(el, m);
  }
  if (!m.has(attr)) m.set(attr, el.getAttribute(attr));
}

/** Blank leaking attributes on `el` and its descendants, recording originals. */
export function scrubAttrs(backup: AttrBackup, root: Element, write: (el: Element, attr: string, value: string | null) => void) {
  const els: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    for (const attr of SCRUB_ATTRS) {
      const v = el.getAttribute(attr);
      if (v === null || v === '') continue;
      remember(backup, el, attr);
      write(el, attr, '');
    }
  }
}

export function restoreAttrs(backup: AttrBackup, write: (el: Element, attr: string, value: string | null) => void) {
  for (const [el, attrs] of backup) {
    if (!el.isConnected) continue;
    for (const [attr, value] of attrs) write(el, attr, value);
  }
  backup.clear();
}

/**
 * The covered text, as the pieces an attribute could repeat it in. Pages hang
 * the same value on `data-value`, `aria-valuetext`, `href="/client/…"`, `<data
 * value>` and so on, where no fixed attribute list can find it; matching the
 * text itself does. Short words are ignored so common prose does not blank
 * half the markup, and long digit runs also match with separators stripped
 * (`123-45-6789` vs `data-ssn="123456789"`).
 */
export interface Tokens {
  words: string[];
  digits: string[];
}

export function tokensOf(texts: Iterable<string>): Tokens {
  const words = new Set<string>();
  const digits = new Set<string>();
  for (const s of texts) {
    for (const tok of s.split(/\s+/)) {
      if (tok.length >= 5 || (tok.length >= 4 && /\d/.test(tok))) words.add(tok);
      const d = tok.replace(/\D/g, '');
      if (d.length >= 6) digits.add(d);
    }
  }
  return { words: Array.from(words), digits: Array.from(digits) };
}

export function leaks(value: string | null, t: Tokens): boolean {
  if (!value) return false;
  for (const w of t.words) if (value.includes(w)) return true;
  if (t.digits.length) {
    const d = value.replace(/\D/g, '');
    for (const x of t.digits) if (d.includes(x)) return true;
  }
  return false;
}

const FORM_VALUE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'BUTTON']);
const NEVER_SCRUB = new Set<string>([
  'id',
  'class',
  'style',
  'name',
  'type',
  'for',
  'role',
  'tabindex',
  'aria-hidden',
  'popover',
  'src',
  'srcset',
  'data-aibs-mask',
  ...KEY_ATTRS,
]);

/**
 * May an attribute be blanked because it repeats covered text? Identity and
 * styling hooks stay (the page and our own anchoring depend on them), and so
 * does `value` on form controls, which is what the form submits. Record keys
 * (`data-key` and friends) stay because re-anchoring after a re-render relies
 * on them; that residual is listed in docs/LIMITATIONS.md.
 */
export function tokenScrubbable(el: Element, attr: string): boolean {
  if (NEVER_SCRUB.has(attr)) return false;
  if (attr === 'value' && FORM_VALUE_TAGS.has(el.tagName)) return false;
  return true;
}

/** Blank every attribute under `root` (inclusive) that repeats covered text. */
export function scrubTokenAttrs(
  backup: AttrBackup,
  root: Element,
  tokens: Tokens,
  write: (el: Element, attr: string, value: string | null) => void,
) {
  if (tokens.words.length === 0 && tokens.digits.length === 0) return;
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      if (!a.value || !tokenScrubbable(el, a.name) || !leaks(a.value, tokens)) continue;
      remember(backup, el, a.name);
      write(el, a.name, '');
    }
  }
}
