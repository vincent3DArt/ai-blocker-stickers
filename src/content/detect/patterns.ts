/**
 * Sensitive-number detectors for the auto-suggest scanner.
 *
 * Every detector is a regular expression plus a validator (checksum, reserved
 * ranges, issuer prefixes) and a strength. Strength says how much a match can
 * be trusted without a nearby label: a Luhn-valid card number with a known
 * issuer prefix is `high`, a bare nine-digit number is `low`.
 *
 * Nothing here ever leaves memory: callers get offsets, never store the text.
 */

import type { ScanSensitivity } from '@/shared/types';
import type { LabelKind } from './labels';

export type Strength = 'high' | 'medium' | 'low';

export type PatternId =
  | 'ssn'
  | 'itin'
  | 'ssn-raw'
  | 'ein'
  | 'routing'
  | 'account'
  | 'iban'
  | 'card'
  | 'dob'
  | 'maskedLast4';

export type Sensitivity = ScanSensitivity;

export interface Detector {
  id: PatternId;
  strength: Strength;
  /** Never accepted without a label, whatever the sensitivity. */
  labelGated: boolean;
  /** Label keywords that count as evidence for this detector. */
  kinds: readonly LabelKind[];
  /** Short, non-sensitive name drawn on the suggestion chip. */
  name: string;
  re: RegExp;
  validate?: (m: string) => boolean;
}

export interface RawMatch {
  id: PatternId;
  strength: Strength;
  start: number;
  end: number;
}

// ---- validators ----

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** SSA rules: area not 000, 666 or 9xx; group not 00; serial not 0000. */
export function validSsn(s: string): boolean {
  const d = digitsOf(s);
  if (d.length !== 9) return false;
  const area = Number(d.slice(0, 3));
  const group = Number(d.slice(3, 5));
  const serial = Number(d.slice(5));
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

/** IRS ITIN: area 9xx, group 50-65, 70-88, 90-92 or 94-99. */
export function validItin(s: string): boolean {
  const d = digitsOf(s);
  if (d.length !== 9 || d[0] !== '9') return false;
  const g = Number(d.slice(3, 5));
  if (Number(d.slice(5)) === 0) return false;
  return (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99);
}

/** IRS campus prefixes assigned to EINs. */
const EIN_PREFIXES = new Set(
  (
    '01 02 03 04 05 06 10 11 12 13 14 15 16 20 21 22 23 24 25 26 27 30 31 32 33 34 35 36 37 38 39 ' +
    '40 41 42 43 44 45 46 47 48 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 71 72 73 ' +
    '74 75 76 77 80 81 82 83 84 85 86 87 88 90 91 92 93 94 95 98 99'
  ).split(' '),
);

export function validEin(s: string): boolean {
  const d = digitsOf(s);
  return d.length === 9 && EIN_PREFIXES.has(d.slice(0, 2)) && Number(d.slice(2)) !== 0;
}

/** ABA routing number: Federal Reserve prefix plus the 3-7-1 checksum. */
export function validAba(s: string): boolean {
  const d = digitsOf(s);
  if (d.length !== 9 || /^0+$/.test(d)) return false;
  const p = Number(d.slice(0, 2));
  if (!((p >= 0 && p <= 12) || (p >= 21 && p <= 32) || (p >= 61 && p <= 72) || p === 80)) return false;
  const n = d.split('').map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

export function luhn(s: string): boolean {
  const d = digitsOf(s);
  if (d.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let v = d.charCodeAt(i) - 48;
    if (dbl) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Known issuer prefix and a length that issuer uses. */
export function cardBrand(d: string): string | null {
  const len = d.length;
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  const p6 = Number(d.slice(0, 6));
  if (d[0] === '4' && (len === 13 || len === 16 || len === 19)) return 'visa';
  if (((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) && len === 16) return 'mastercard';
  if ((p2 === 34 || p2 === 37) && len === 15) return 'amex';
  if ((p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || (p6 >= 622126 && p6 <= 622925)) && len >= 16 && len <= 19) return 'discover';
  if (((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38 || p2 === 39) && len >= 14 && len <= 19) return 'diners';
  if (p4 >= 3528 && p4 <= 3589 && len >= 16 && len <= 19) return 'jcb';
  if (p2 === 62 && len >= 16 && len <= 19) return 'unionpay';
  return null;
}

export function validCard(s: string): boolean {
  const d = digitsOf(s);
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  // Separators, when present, must group the digits the way cards are printed.
  const groups = s.split(/[ -]/).map((g) => g.length);
  if (groups.length > 1) {
    const g = groups.join(',');
    const ok = /^(4,4,4,4|4,4,4,4,3|4,6,5|4,6,4|4,4,4,1|4,4,4,4,1,2)$/.test(g) || groups.every((n) => n === 4 || n === groups[groups.length - 1]);
    if (!ok) return false;
  }
  return cardBrand(d) !== null && luhn(d);
}

/** IBAN lengths per country (the common SEPA and SWIFT ones). */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, MU: 30, NL: 18, NO: 15,
  PK: 24, PL: 28, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TR: 26, UA: 29,
};

export function validIban(s: string): boolean {
  const v = s.replace(/\s+/g, '').toUpperCase();
  const len = IBAN_LENGTHS[v.slice(0, 2)];
  if (!len || v.length !== len || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const val = code >= 65 ? String(code - 55) : ch;
    for (const c of val) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

export function validAccount(s: string): boolean {
  const digits = digitsOf(s).length;
  return digits >= 6 && digits / s.length >= 0.8;
}

export function validDob(s: string): boolean {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return false;
  const [mo, da, yr] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = new Date().getFullYear();
  return mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && yr >= 1900 && yr <= now;
}

// ---- detectors ----

/** Not preceded or followed by a word character or a dash: a whole token. */
const L = '(?<![\\w-])';
const R = '(?![\\w-])';

export const DETECTORS: readonly Detector[] = [
  {
    id: 'ssn',
    strength: 'high',
    labelGated: false,
    kinds: ['ssn'],
    name: 'SSN',
    re: new RegExp(`${L}\\d{3}([- \\u2013])\\d{2}\\1\\d{4}${R}`, 'g'),
    validate: validSsn,
  },
  {
    id: 'itin',
    strength: 'high',
    labelGated: false,
    kinds: ['ssn', 'ein'],
    name: 'ITIN',
    re: new RegExp(`${L}9\\d{2}([- \\u2013])\\d{2}\\1\\d{4}${R}`, 'g'),
    validate: validItin,
  },
  {
    id: 'ssn-raw',
    strength: 'low',
    labelGated: true,
    kinds: ['ssn'],
    name: 'SSN',
    re: new RegExp(`${L}\\d{9}${R}`, 'g'),
    validate: (m) => validSsn(m) || validItin(m),
  },
  {
    id: 'ein',
    strength: 'medium',
    labelGated: false,
    kinds: ['ein'],
    name: 'EIN',
    re: new RegExp(`${L}\\d{2}-\\d{7}${R}`, 'g'),
    validate: validEin,
  },
  {
    id: 'routing',
    strength: 'medium',
    labelGated: false,
    kinds: ['routing'],
    name: 'Routing',
    re: new RegExp(`${L}\\d{9}${R}`, 'g'),
    validate: validAba,
  },
  {
    id: 'account',
    strength: 'low',
    labelGated: true,
    kinds: ['account', 'id'],
    name: 'Account',
    re: new RegExp(`${L}[A-Za-z0-9]{8,17}${R}`, 'g'),
    validate: validAccount,
  },
  {
    id: 'iban',
    strength: 'high',
    labelGated: false,
    kinds: ['account'],
    name: 'IBAN',
    re: new RegExp(`${L}[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?${R}`, 'g'),
    validate: validIban,
  },
  {
    id: 'card',
    strength: 'high',
    labelGated: false,
    kinds: ['card'],
    name: 'Card',
    re: new RegExp(`${L}\\d(?:[ -]?\\d){12,18}${R}`, 'g'),
    validate: validCard,
  },
  {
    id: 'dob',
    strength: 'low',
    labelGated: true,
    kinds: ['dob'],
    name: 'Birth date',
    re: /(?<![\w/.-])\d{1,2}\/\d{1,2}\/\d{4}(?![\w/.-])/g,
    validate: validDob,
  },
  {
    id: 'maskedLast4',
    strength: 'medium',
    labelGated: false,
    kinds: ['ssn', 'account', 'card'],
    name: 'Last 4',
    re: /(?<![\w*•-])(?:[*•xX]{3}[- ]?[*•xX]{2}[- ]?|[*•xX]{4,12}[- ]?)\d{4}(?![\w-])/g,
  },
];

export const DETECTOR_BY_ID: Record<PatternId, Detector> = Object.fromEntries(DETECTORS.map((d) => [d.id, d])) as Record<
  PatternId,
  Detector
>;

/** Patterns checked synchronously on every inserted text node while locked. */
export const HIGH_IDS: ReadonlySet<PatternId> = new Set<PatternId>(['ssn', 'itin', 'card', 'iban', 'maskedLast4']);

// ---- explicit negatives ----

interface Negative {
  name: string;
  re: RegExp;
  /** Detectors this negative does not veto. */
  exempt?: ReadonlySet<PatternId>;
}

export const NEGATIVES: readonly Negative[] = [
  { name: 'phone', re: /(?<![\w-])(?:\+?1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w-])/g },
  { name: 'zip4', re: /(?<![\w-])\d{5}-\d{4}(?![\w-])/g },
  { name: 'date', re: /(?<![\w-])(?:\d{1,2}[-.]\d{1,2}[-.]\d{2,4}|\d{4}[-.]\d{1,2}[-.]\d{1,2})(?![\w-])/g },
  { name: 'uuid', re: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g },
  // A lowercase hex token with at least one letter and one digit: hashes, commit ids, colours.
  { name: 'hex', re: /(?<![\w-])(?:0x)?(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}(?![\w-])/g, exempt: new Set(['iban']) },
];

/** The number goes on past the match (`123-45-6789-01`, `4111 1111 1111 1111 22`): not a whole identifier. */
function continues(text: string, start: number, end: number): boolean {
  const after = text.slice(end, end + 2);
  const before = text.slice(Math.max(0, start - 2), start);
  return /^[-.]\d/.test(after) || /\d[-.]$/.test(before);
}

export interface FindOptions {
  /** Only these detectors. */
  ids?: ReadonlySet<PatternId>;
}

/**
 * Every validated match in `text`, negatives removed. Overlapping matches of
 * different detectors are all returned: the caller scores each with its label
 * evidence and keeps the best.
 */
export function findMatches(text: string, opts: FindOptions = {}): RawMatch[] {
  if (!/\d/.test(text)) return [];
  const negs: Array<{ start: number; end: number; exempt?: ReadonlySet<PatternId> }> = [];
  for (const n of NEGATIVES) {
    n.re.lastIndex = 0;
    for (const m of text.matchAll(n.re)) negs.push({ start: m.index!, end: m.index! + m[0].length, exempt: n.exempt });
  }
  const out: RawMatch[] = [];
  for (const d of DETECTORS) {
    if (opts.ids && !opts.ids.has(d.id)) continue;
    d.re.lastIndex = 0;
    for (const m of text.matchAll(d.re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (d.validate && !d.validate(m[0])) continue;
      if (continues(text, start, end)) continue;
      if (negs.some((n) => n.start < end && n.end > start && !n.exempt?.has(d.id))) continue;
      out.push({ id: d.id, strength: d.strength, start, end });
    }
  }
  return out;
}

/**
 * Sensitivity thresholds. `bonus` is the label evidence: 3 same element,
 * 2 adjacent label / th / dt, 1 same block within 60 characters, 0 none.
 *
 * - labeled-only: a label bonus of at least 2, whatever the pattern.
 * - balanced (default): high alone; medium with any label; low with 2.
 * - aggressive: high and medium alone; low with any label.
 *
 * Label-gated detectors (bare nine digits, account numbers, dates of birth)
 * need a label at every level: 2 normally, 1 when aggressive.
 */
export function accepts(strength: Strength, bonus: number, sensitivity: Sensitivity, labelGated = false): boolean {
  if (labelGated && bonus < (sensitivity === 'aggressive' ? 1 : 2)) return false;
  switch (sensitivity) {
    case 'labeled-only':
      return bonus >= 2;
    case 'aggressive':
      return strength !== 'low' || bonus >= 1;
    case 'balanced':
    default:
      return strength === 'high' || (strength === 'medium' && bonus >= 1) || (strength === 'low' && bonus >= 2);
  }
}

export const STRENGTH_POINTS: Record<Strength, number> = { high: 3, medium: 2, low: 1 };
