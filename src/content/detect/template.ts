/**
 * "Type a format": a tiny template language, and the safety check every
 * user-supplied regular expression goes through before it is stored or run.
 *
 * Template: `#` digit, `A` uppercase letter, `a` lowercase letter, `X` letter
 * or digit, `?` any single character, `*` zero or more of the previous class,
 * `\` makes the next character literal, anything else is literal. A digit
 * typed in a template stands for any digit: a format is never an example, so
 * no typed digit is ever stored.
 *
 * Pure and DOM-free (unit-tested, also imported by the e2e suite). Relative
 * imports only.
 */

import { describeUnits, strengthOf, unitsToRegex, type ShapeStrength, type Unit, type UnitClass } from './derive';

export const TEMPLATE_MAX = 60;
export const REGEX_MAX = 200;

export type TemplateResult =
  | { ok: true; regex: string; description: string; strength: ShapeStrength }
  | { ok: false; error: string };

const CLASS_OF: Record<string, UnitClass> = { '#': 'digit', A: 'upper', a: 'lower', X: 'alnum', '?': 'any' };

export function templateUnits(template: string): Unit[] | string {
  const t = template.trim();
  if (!t) return 'Type a format, for example AA-####-####.';
  if (t.length > TEMPLATE_MAX) return `Keep the format under ${TEMPLATE_MAX} characters.`;
  const units: Unit[] = [];
  const chars = Array.from(t);
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    let cls: UnitClass;
    let lit: string | undefined;
    if (ch === '*') {
      const prev = units[units.length - 1];
      if (!prev) return '"*" needs a character class before it.';
      if (prev.max === Infinity) return '"**" repeats nothing new.';
      prev.min -= 1;
      prev.max = Infinity;
      continue;
    }
    if (ch === '\\' && i + 1 < chars.length) {
      ch = chars[++i];
      cls = 'sep';
      lit = /\d/.test(ch) ? undefined : ch;
      if (lit === undefined) cls = 'digit';
    } else if (CLASS_OF[ch]) {
      cls = CLASS_OF[ch];
    } else if (/\d/.test(ch)) {
      // Never store a typed digit: it stands for any digit.
      cls = 'digit';
    } else if (/\s/.test(ch)) {
      cls = 'sep';
      lit = ' ';
    } else {
      cls = 'sep';
      lit = ch;
    }
    const prev = units[units.length - 1];
    if (prev && prev.cls === cls && prev.max !== Infinity && (cls !== 'sep' || prev.lit === lit)) {
      if (cls === 'sep' && lit === ' ') continue;
      prev.min++;
      prev.max++;
    } else {
      units.push({ cls, min: 1, max: 1, lit });
    }
  }
  if (!units.some((u) => u.cls !== 'sep')) return 'A format needs at least one #, A, a, X or ?.';
  return units;
}

/** Regular expression for a template, with `\b` at alphanumeric ends. */
export function templateToRegex(template: string): TemplateResult {
  const units = templateUnits(template);
  if (typeof units === 'string') return { ok: false, error: units };
  const regex = unitsToRegex(units);
  const safe = checkRegex(regex);
  if (!safe.ok) return safe;
  return { ok: true, regex, description: describeUnits(units), strength: strengthOf(units) };
}

// ---- regex safety ----

export type RegexCheck = { ok: true; re: RegExp } | { ok: false; error: string };

/**
 * Accepts a user regular expression only if it is short, compiles, cannot
 * match the empty string, has no backreference and no quantified group that
 * itself contains a quantifier (the shape of catastrophic backtracking), and
 * runs fast on adversarial input. Flags: `i` and `u` only (`g` is ours).
 */
export function checkRegex(source: string, flags = ''): RegexCheck {
  if (typeof source !== 'string' || !source) return { ok: false, error: 'Empty pattern.' };
  if (source.length > REGEX_MAX) return { ok: false, error: `Keep the pattern under ${REGEX_MAX} characters.` };
  if (!/^[iu]*$/.test(flags) || new Set(flags).size !== flags.length) return { ok: false, error: 'Only the i and u flags are allowed.' };
  if (/\\[1-9]|\\k</.test(source)) return { ok: false, error: 'Backreferences are not allowed.' };
  // Four literal digits in a row read like an example, not a format.
  const stripped = source.replace(/\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/g, '').replace(/\{\d+(,\d*)?\}/g, '');
  if (/\d{4,}/.test(stripped)) {
    return { ok: false, error: 'Use \\d instead of literal digits: a pattern must not contain data.' };
  }
  const nested = nestedQuantifier(source);
  if (nested) return { ok: false, error: nested };
  let re: RegExp;
  try {
    re = new RegExp(source, flags + 'g');
  } catch (e) {
    return { ok: false, error: `Invalid pattern: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}` };
  }
  re.lastIndex = 0;
  if (re.test('')) return { ok: false, error: 'The pattern matches empty text.' };
  // Adversarial inputs: a pattern that is slow here would stall a page.
  for (const probe of ['a'.repeat(3000) + '!', '1'.repeat(3000) + 'x', 'a1-'.repeat(1000) + '\u0000', ' '.repeat(3000) + '#']) {
    const t0 = Date.now();
    re.lastIndex = 0;
    let n = 0;
    for (const _ of probe.matchAll(re)) if (++n > 5000) break;
    if (Date.now() - t0 > 50) return { ok: false, error: 'The pattern is too slow on long text.' };
  }
  re.lastIndex = 0;
  return { ok: true, re };
}

/** Quantifier at `s[0]`: none, fixed (`{3}`), or variable (`*`, `+`, `?`, `{2,}`, `{2,5}`). */
function quantAt(s: string): 'none' | 'fixed' | 'variable' {
  const c = s[0];
  if (c === '*' || c === '+' || c === '?') return 'variable';
  if (c !== '{') return 'none';
  const m = s.match(/^\{(\d+)(,(\d*))?\}/);
  if (!m) return 'none';
  if (m[2] === undefined || m[3] === m[1]) return 'fixed';
  return 'variable';
}

/**
 * A group repeated by a quantifier that itself contains a variable
 * quantifier, or a repeated alternation: the shapes of catastrophic
 * backtracking. `(?:\d{3}-){2}` (fixed inside) is fine.
 */
function nestedQuantifier(src: string): string | null {
  const stack: Array<{ quant: boolean; alt: boolean }> = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      stack.push({ quant: false, alt: false });
      // Skip the group syntax `(?:`, `(?=`, `(?<=`, `(?<name>`.
      if (src[i + 1] === '?') i++;
      continue;
    }
    if (c === '|') {
      if (stack.length) stack[stack.length - 1].alt = true;
      continue;
    }
    if (c === ')') {
      const g = stack.pop();
      if (g === undefined) return 'Unbalanced parenthesis.';
      const outer = quantAt(src.slice(i + 1));
      const outerRepeats = outer !== 'none' && src[i + 1] !== '?';
      if (outerRepeats && g.quant) return 'Nested quantifiers (like (a+)+) are not allowed.';
      if (outer === 'variable' && src[i + 1] !== '?' && g.alt) return 'A repeated alternation (like (a|b)+) is not allowed.';
      if (stack.length && (g.quant || outer === 'variable')) stack[stack.length - 1].quant = true;
      continue;
    }
    if (stack.length && quantAt(src.slice(i)) === 'variable') stack[stack.length - 1].quant = true;
  }
  if (stack.length) return 'Unbalanced parenthesis.';
  return null;
}