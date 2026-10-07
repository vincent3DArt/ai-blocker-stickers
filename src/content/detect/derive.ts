/**
 * "Cover things like this": a detector derived from one example.
 *
 * The example is reduced to its SHAPE (runs of digits, letters and
 * separators, with their lengths) and the shape becomes a regular expression.
 * Nothing that comes out of here contains the example: not its digits, not
 * its letters (letter runs become classes), only lengths and the separator
 * characters. The caller drops the example as soon as `deriveFromExample`
 * returns; only the result may be stored.
 *
 * Pure and DOM-free (unit-tested, also imported by the e2e suite). Relative
 * imports only.
 */

export type ShapeStrength = 'high' | 'medium' | 'low';

/** One run of the shape. `sep` units carry their literal character. */
export type UnitClass = 'digit' | 'upper' | 'lower' | 'alpha' | 'alnum' | 'any' | 'sep';

export interface Unit {
  cls: UnitClass;
  min: number;
  max: number;
  /** `sep` only: the separator ('-', '/', '.', '#', ' ' for any space, or another literal). */
  lit?: string;
}

export interface Derived {
  regex: string;
  /** Human-readable shape, e.g. "2 letters, 7 digits". */
  description: string;
  strength: ShapeStrength;
  /** Label keywords (normalised, no digits) found next to the example. */
  labels: string[];
}

/** Runs longer than this become a range (len-1..len+1) instead of an exact length. */
export const EXACT_RUN_MAX = 12;
/** Longest example we derive from: anything longer is a paragraph, not an identifier. */
export const EXAMPLE_MAX = 64;

const SPACE = /[\s     ]/;
const DASH = /[‐-―−]/;

const CLASS_RE: Record<Exclude<UnitClass, 'sep'>, string> = {
  digit: '\\d',
  upper: '[A-Z]',
  lower: '[a-z]',
  alpha: '[A-Za-z]',
  alnum: '[A-Za-z0-9]',
  any: '.',
};

function quant(min: number, max: number): string {
  if (max === Infinity) return min === 0 ? '*' : min === 1 ? '+' : `{${min},}`;
  if (min === max) return min === 1 ? '' : `{${min}}`;
  return `{${min},${max}}`;
}

function escapeLit(ch: string): string {
  if (ch === ' ') return '[ \\u00a0]';
  // An example written with a typographic dash matches either dash.
  if (DASH.test(ch)) return '[-\\u2010-\\u2015]';
  return ch.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => (c === '-' ? '-' : '\\' + c));
}

/** An alphanumeric run, or a literal letter or digit (a template's fixed prefix). */
const isAlnumUnit = (u: Unit) => (u.cls !== 'sep' && u.cls !== 'any') || (u.cls === 'sep' && /^[\p{L}\p{N}]$/u.test(u.lit ?? ''));

/** Regular expression source for a shape, with `\b` at alphanumeric ends. */
export function unitsToRegex(units: readonly Unit[]): string {
  let out = '';
  for (const u of units) {
    if (u.cls === 'sep') {
      const lit = escapeLit(u.lit ?? '');
      out += u.min === 1 && u.max === 1 ? lit : lit.length > 1 && !lit.startsWith('[') ? `(?:${lit})${quant(u.min, u.max)}` : lit + quant(u.min, u.max);
    } else {
      out += CLASS_RE[u.cls] + quant(u.min, u.max);
    }
  }
  if (!units.length) return '';
  const first = units[0];
  const last = units[units.length - 1];
  const start = isAlnumUnit(first) && first.min > 0 ? '\\b' : '';
  const end = isAlnumUnit(last) && last.min > 0 ? '\\b' : '';
  return start + out + end;
}

const NOUN: Record<Exclude<UnitClass, 'sep'>, [string, string]> = {
  digit: ['digit', 'digits'],
  upper: ['letter', 'letters'],
  lower: ['lowercase letter', 'lowercase letters'],
  alpha: ['letter', 'letters'],
  alnum: ['letter or digit', 'letters or digits'],
  any: ['character', 'characters'],
};

function count(u: Unit): string {
  const [one, many] = NOUN[u.cls as Exclude<UnitClass, 'sep'>];
  if (u.max === Infinity) return u.min === 0 ? `any number of ${many}` : `${u.min} or more ${many}`;
  if (u.min === u.max) return `${u.min} ${u.min === 1 ? one : many}`;
  return `${u.min}–${u.max} ${many}`;
}

/** "2 letters, 4 digits, 4 digits": the non-separator runs, in order. */
export function describeUnits(units: readonly Unit[]): string {
  const parts: string[] = [];
  let lit = '';
  for (const u of units) {
    // A template's literal letters and digits ("MBR") are part of the format: quoted.
    if (u.cls === 'sep' && /^[\p{L}\p{N}]$/u.test(u.lit ?? '')) {
      lit += (u.lit ?? '').repeat(u.min);
      continue;
    }
    if (lit) parts.push(`"${lit}"`);
    lit = '';
    if (u.cls !== 'sep') parts.push(count(u));
  }
  if (lit) parts.push(`"${lit}"`);
  return parts.length ? parts.join(', ') : 'separators only';
}

/**
 * How far a match of this shape can be trusted without a label:
 * - digits only and at most 6 characters, or letters only: `low` (label-gated);
 * - at least 9 characters with a separator between alphanumeric runs: `high`;
 * - anything else (mixed, separated, or 7+ characters): `medium`.
 */
export function strengthOf(units: readonly Unit[]): ShapeStrength {
  const body = units.filter((u) => u.cls !== 'sep');
  const chars = units.reduce((n, u) => n + u.min, 0);
  if (!body.length) return 'low';
  const digitsOnly = body.every((u) => u.cls === 'digit');
  const lettersOnly = body.every((u) => u.cls === 'upper' || u.cls === 'lower' || u.cls === 'alpha');
  if ((digitsOnly && chars <= 6) || lettersOnly) return 'low';
  // A separator between two alphanumeric runs (not just a leading '#').
  let sepInside = false;
  for (let i = 1; i < units.length - 1; i++) {
    if (units[i].cls === 'sep' && units.slice(0, i).some((u) => u.cls !== 'sep') && units.slice(i + 1).some((u) => u.cls !== 'sep')) sepInside = true;
  }
  if (chars >= 9 && sepInside && body.length >= 2) return 'high';
  return 'medium';
}

/** Lowercase words of a label, digits and punctuation gone. */
export function normalizeLabelWords(label: string | null | undefined): string {
  if (!label) return '';
  return label
    .toLowerCase()
    .replace(/#/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

type Kind = 'digit' | 'upper' | 'lower' | 'other-letter' | 'space' | 'sep';

function kindOf(ch: string): Kind {
  if (ch >= '0' && ch <= '9') return 'digit';
  if (ch >= 'A' && ch <= 'Z') return 'upper';
  if (ch >= 'a' && ch <= 'z') return 'lower';
  if (/\p{Nd}/u.test(ch)) return 'digit';
  if (/\p{L}/u.test(ch)) return 'other-letter';
  if (SPACE.test(ch)) return 'space';
  return 'sep';
}

/**
 * The shape of `text`, after a leading label (the words of `label`, with any
 * `:` or `#` after them) and surrounding punctuation are dropped.
 */
export function shapeOf(text: string, label?: string): Unit[] {
  let t = text.replace(/^[\s ]+|[\s ]+$/g, '');
  const words = new Set(normalizeLabelWords(label).split(' ').filter(Boolean));
  // "MRN 00912345" with the label "MRN": the shape is the number's.
  if (words.size) {
    for (;;) {
      const m = t.match(/^([\p{L}]+)[\s :#.]*/u);
      if (!m || !words.has(m[1].toLowerCase()) || m[0].length >= t.length) break;
      t = t.slice(m[0].length);
    }
  }
  t = t.replace(/^[:#,;]+\s*/, '').replace(/[\s ]*[.,;:]+$/, '');
  const mixed = /[A-Z]/.test(t) && /[a-z]/.test(t);
  const units: Unit[] = [];
  for (const ch of Array.from(t)) {
    const k = kindOf(ch);
    let cls: UnitClass;
    let lit: string | undefined;
    if (k === 'digit') cls = 'digit';
    else if (k === 'upper') cls = mixed ? 'alpha' : 'upper';
    else if (k === 'lower') cls = mixed ? 'alpha' : 'lower';
    else if (k === 'other-letter') cls = 'alpha';
    else if (k === 'space') {
      cls = 'sep';
      lit = ' ';
    } else {
      cls = 'sep';
      lit = ch;
    }
    const prev = units[units.length - 1];
    if (prev && prev.cls === cls && (cls !== 'sep' || prev.lit === lit)) {
      // Runs of the same class merge; a run of spaces is one space.
      if (cls === 'sep' && lit === ' ') continue;
      prev.min++;
      prev.max++;
    } else {
      units.push({ cls, min: 1, max: 1, lit });
    }
  }
  // Long runs: the exact length is not part of the format.
  for (const u of units) {
    if (u.cls !== 'sep' && u.min > EXACT_RUN_MAX) {
      u.min -= 1;
      u.max += 1;
    }
  }
  return units;
}

export type DeriveResult = ({ ok: true } & Derived) | { ok: false; error: string };

/**
 * A detector for things shaped like `example`. `label` is the label found
 * next to the example on the page (labelInfo), if any. The result contains no
 * character of the example except separators.
 */
export function deriveFromExample(example: string, label?: string): DeriveResult {
  const text = example.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'Select an example first.' };
  if (Array.from(text).length > EXAMPLE_MAX) return { ok: false, error: 'Select one identifier, not a whole passage.' };
  const units = shapeOf(text, label);
  const body = units.filter((u) => u.cls !== 'sep');
  if (!body.length) return { ok: false, error: 'The selection has no letters or digits.' };
  const alnum = body.reduce((n, u) => n + u.min, 0);
  if (alnum < 3) return { ok: false, error: 'Too short to tell apart from ordinary text.' };
  const labelWords = normalizeLabelWords(label);
  return {
    ok: true,
    regex: unitsToRegex(units),
    description: describeUnits(units),
    strength: strengthOf(units),
    labels: labelWords ? [labelWords] : [],
  };
}
