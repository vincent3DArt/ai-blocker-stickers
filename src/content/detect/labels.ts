/**
 * Label keywords: the words next to a number that say what it is.
 *
 * Label text reaches us already normalised by `normalizeContext` (lowercase,
 * digits and punctuation gone) or raw from the page; `normalizeLabel` brings
 * both, plus input attribute tokens (`ssn_input`, `acctNumber`), to the same
 * shape before matching.
 */

import { labelInfo, normalizeContext } from '../anchor/context';

export type LabelKind = 'ssn' | 'ein' | 'account' | 'routing' | 'card' | 'dob' | 'id';

const KEYWORDS: ReadonlyArray<[LabelKind, RegExp]> = [
  ['ssn', /\b(ssns?|social security|soc sec|tax ?id|taxpayer|tins?|itins?)\b/],
  ['ein', /\b(eins?|employer id(entification)?( number| no)?|feins?|tax ?id|tins?)\b/],
  ['account', /\b(account (number|no|num)|accounts?|acct|bank account|iban|swift|bic)\b/],
  ['routing', /\b(routing|aba|rtn)\b/],
  ['card', /\b(card (number|no|num)|credit card|debit( card)?|cc ?number|cc num)\b/],
  ['dob', /\b(date of birth|dob|birth ?date|bday|birthday)\b/],
  ['id', /\b(passport|drivers? ?s? licen[cs]e|driver licen[cs]e|licen[cs]e (number|no))\b/],
];

/** `autocomplete` tokens that name the field outright. */
const AUTOCOMPLETE: Record<string, LabelKind> = {
  'cc-number': 'card',
  'cc-csc': 'card',
  bday: 'dob',
  'bday-day': 'dob',
  'bday-month': 'dob',
  'bday-year': 'dob',
};

/** Lowercase, split camelCase and snake/kebab tokens, drop punctuation except `#`. */
export function normalizeLabel(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/#/g, ' number ')
    .replace(/['’]/g, '')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function labelKinds(text: string | null | undefined): Set<LabelKind> {
  const out = new Set<LabelKind>();
  if (!text) return out;
  const t = normalizeLabel(text);
  if (!t) return out;
  for (const [kind, re] of KEYWORDS) if (re.test(t)) out.add(kind);
  return out;
}

export function hasKind(kinds: Set<LabelKind>, wanted: readonly LabelKind[]): boolean {
  for (const k of wanted) if (kinds.has(k)) return true;
  return false;
}

// ---- label lookup ----

const SHORT = 60;

function shortText(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= SHORT ? t : undefined;
}

/** Column header texts per table, computed once per scan (labelInfo's own lookup is O(rows) per cell). */
let headerCache = new WeakMap<Element, Array<string | undefined>>();

export function resetLabelCache() {
  headerCache = new WeakMap();
}

function columnHeaders(table: Element): Array<string | undefined> {
  let h = headerCache.get(table);
  if (h) return h;
  const head =
    table.querySelector(':scope > thead > tr') ??
    (() => {
      const first = table.querySelector(':scope > tbody > tr, :scope > tr');
      return first && first.querySelector(':scope > th') && !first.querySelector(':scope > td') ? first : null;
    })();
  h = head ? Array.from(head.children, (c) => shortText(c)) : [];
  headerCache.set(table, h);
  return h;
}

/** Row header, else column header, of a table cell. */
function cellLabel(td: HTMLTableCellElement): string | undefined {
  const row = td.parentElement;
  const rowHeader = row?.querySelector(':scope > th');
  const t = rowHeader && rowHeader !== td ? shortText(rowHeader) : undefined;
  if (t) return t;
  const table = td.closest('table');
  if (!table) return undefined;
  return columnHeaders(table)[td.cellIndex];
}

/**
 * The label that names `el`: its own `<label>`, `aria-label`, a preceding
 * label-ish sibling, `<dt>` for `<dd>`, or a table header. Reuses the
 * anchoring module's `labelInfo`, except for table cells, where the column
 * header is looked up through a per-table cache.
 */
export function labelFor(el: Element): string | undefined {
  if (el.tagName === 'TD') return cellLabel(el as HTMLTableCellElement);
  const info = labelInfo(el)?.text;
  if (info) return info;
  const td = el.parentElement?.closest('td');
  if (td && td.childElementCount <= 3) return cellLabel(td as HTMLTableCellElement);
  return undefined;
}

/** Keyword evidence carried by a form field's own attributes. */
export function inputKinds(el: Element): Set<LabelKind> {
  const out = new Set<LabelKind>();
  const auto = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  for (const tok of auto) if (AUTOCOMPLETE[tok]) out.add(AUTOCOMPLETE[tok]);
  for (const a of ['name', 'id', 'placeholder', 'aria-label', 'title', 'data-label']) {
    for (const k of labelKinds(el.getAttribute(a))) out.add(k);
  }
  return out;
}

export { normalizeContext };
