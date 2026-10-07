/**
 * Run-time side of user-defined detectors: user-taught ones (stored as
 * CustomDetector) and the catalogue additions. Both compile to a
 * `UserDetector` and are matched here, then scored by the scanner exactly
 * like the built-ins (strength, label evidence, sensitivity).
 *
 * Every regex runs inside a per-page time budget (default 2 s, shared by all
 * user detectors): once spent, user detectors stop matching on this page.
 */

import type { CustomDetector } from '@/shared/types';
import type { Strength } from './patterns';
import { checkRegex } from './template';
import { isTracking, type CatalogEntry } from './catalog';
import { normalizeLabel } from './labels';

export type LabelTest = (text: string | null | undefined) => boolean;

export interface UserDetector {
  /** Identity in hits and suggestions: `custom:<id>` or `catalog:<id>`. */
  key: string;
  id: string;
  name: string;
  re: RegExp;
  strength: Strength;
  /** Low-strength detectors need a label, like the built-in label-gated ones. */
  labelGated: boolean;
  labels: readonly string[];
  test: LabelTest;
  validate?: (m: string) => boolean;
  /** The pattern cannot match text without a digit (lets the scanner skip digit-free blocks). */
  needsDigit: boolean;
  catalog: boolean;
}

export interface UserMatch {
  det: UserDetector;
  start: number;
  end: number;
}

export interface UserBudget {
  /** Milliseconds spent in user regexes on this page. */
  spent: number;
  limit: number;
}

export const PAGE_BUDGET_MS = 2000;

export function newBudget(limit = PAGE_BUDGET_MS): UserBudget {
  return { spent: 0, limit };
}

export const budgetSpent = (b: UserBudget | undefined) => !!b && b.spent >= b.limit;

/** Label evidence for free keywords: any of `labels`, as whole words, in the normalised text. */
export function keywordTest(labels: readonly string[]): LabelTest {
  const phrases = labels.map((l) => normalizeLabel(l)).filter(Boolean);
  if (!phrases.length) return () => false;
  return (text) => {
    if (!text) return false;
    const t = ` ${normalizeLabel(text)} `;
    if (t.length <= 2) return false;
    return phrases.some((p) => t.includes(` ${p} `));
  };
}

/**
 * Whether the pattern needs a digit to match: it has a digit class and no
 * class or wildcard that could stand in for one. Conservative: unsure means no.
 */
function needsDigitOf(source: string): boolean {
  if (!/\\d|\[0-9\]/.test(source)) return false;
  // Alternation: some branch might not need a digit.
  if (/(?<!\\)\|/.test(source)) return false;
  return true;
}

/** A stored detector, ready to run, or null when its regex is invalid or unsafe. */
export function compileCustom(d: CustomDetector): UserDetector | null {
  const chk = checkRegex(d.regex, d.flags ?? '');
  if (!chk.ok) return null;
  return {
    key: `custom:${d.id}`,
    id: d.id,
    name: d.name,
    re: chk.re,
    strength: d.strength,
    labelGated: d.strength === 'low',
    labels: d.labels,
    test: keywordTest(d.labels),
    needsDigit: needsDigitOf(d.regex),
    catalog: false,
  };
}

export function compileCatalog(e: CatalogEntry): UserDetector | null {
  if (!e.regex) return null;
  let re: RegExp;
  try {
    re = new RegExp(e.regex, (e.flags ?? '') + 'g');
  } catch {
    return null;
  }
  return {
    key: `catalog:${e.id}`,
    id: e.id,
    name: e.name.replace(/^Driver's licence: .*/, "Driver's licence"),
    re,
    strength: e.strength,
    labelGated: e.strength === 'low',
    labels: e.labels,
    test: keywordTest(e.labels),
    validate: e.validate,
    needsDigit: needsDigitOf(e.regex),
    catalog: true,
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The number goes on past the match: not a whole identifier (same rule as the built-ins). */
function continues(text: string, start: number, end: number): boolean {
  return /^[-.]\d/.test(text.slice(end, end + 2)) || /\d[-.]$/.test(text.slice(Math.max(0, start - 2), start));
}

/** Longest text one user regex is run over: a block longer than this is matched in its first part only. */
const TEXT_MAX = 50_000;
const MATCHES_MAX = 500;

/**
 * Every validated match of every detector in `text`. Charged to `budget`;
 * returns what it has as soon as the budget is spent.
 */
export function findUserMatches(text: string, dets: readonly UserDetector[], budget?: UserBudget): UserMatch[] {
  const out: UserMatch[] = [];
  if (!dets.length || !text) return out;
  const hasDigit = /\d/.test(text);
  const t = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
  for (const det of dets) {
    if (budgetSpent(budget)) break;
    if (det.needsDigit && !hasDigit) continue;
    const t0 = now();
    det.re.lastIndex = 0;
    let n = 0;
    try {
      for (const m of t.matchAll(det.re)) {
        if (++n > MATCHES_MAX) break;
        if (!m[0]) continue;
        const start = m.index!;
        const end = start + m[0].length;
        if (det.validate && !det.validate(m[0])) continue;
        if (continues(t, start, end)) continue;
        if (det.catalog && isTracking(m[0], t.slice(Math.max(0, start - 40), start))) continue;
        out.push({ det, start, end });
      }
    } catch {
      /* a pathological input: skip this detector here */
    }
    if (budget) budget.spent += now() - t0;
  }
  return out;
}
