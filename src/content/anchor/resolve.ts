import type { Confidence, Fingerprint } from '@/shared/types';
import { TEST_ID_ATTRS, evalXPath, isIdentifierLike, queryAll, stableClasses, testId } from './selector';
import { elementsNearLabel, headingContext, labelInfo, normalizeContext, tableContext } from './context';
import { center, distance, isRendered, toViewRect, viewToDoc } from './geometry';
import { KEY_ATTR_SELECTOR, attrHmacOf, fingerprintText, keyAttrOf, textHmacOf } from './fingerprint';
import { normalizeText } from '@/shared/hmac';
import { shadowRootOf } from '../mask/text-mask';

/**
 * The tree a fingerprint is resolved in: the document, or the shadow root at
 * the end of `hostPath` (each host found by its CSS path in the tree above).
 * Null when a host on the way is missing.
 */
export function scopeRootOf(fp: Fingerprint): Document | ShadowRoot | null {
  let root: Document | ShadowRoot = document;
  for (const sel of fp.hostPath ?? []) {
    let host: Element | null = null;
    try {
      host = root.querySelector(sel);
    } catch {
      return null;
    }
    const sr: ShadowRoot | null = host ? shadowRootOf(host) : null;
    if (!sr) return null;
    root = sr;
  }
  return root;
}

export interface Resolution {
  el: Element;
  score: number;
  confidence: Confidence;
  /** Other elements that tied with the winner (only when confidence is low). */
  ties: Element[];
}

export interface ResolveOptions {
  /** Elements to never resolve to (our own host, other stickers' anchors). */
  exclude?: (el: Element) => boolean;
  /** Minimum score to accept. */
  threshold?: number;
  /** Minimum margin over the runner-up for high confidence. */
  margin?: number;
  /**
   * Original text for an element we masked ourselves. Re-resolving a sticker
   * that is still attached (the lock coming on) must not read our own bullets,
   * or the current anchor would lose its text match to an unmasked twin.
   */
  textOf?: (el: Element) => string | undefined;
  /**
   * The in-page viewer the sticker belongs to (content/state/view.ts): only
   * elements inside it are candidates.
   */
  within?: Element;
}

/**
 * Options while the AI-session lock is on: accept weaker matches (30, not
 * 45). The margin still defines which candidates tie with the winner, but it
 * no longer decides anything alone: the session masks the winner and every
 * tie, so an ambiguous anchor over-masks instead of leaving a record bare.
 */
export const LOCKED_RESOLVE: Pick<ResolveOptions, 'threshold' | 'margin'> = { threshold: 30, margin: 10 };

const W = {
  id: 40,
  testId: 35,
  cssPath: 25,
  textHmac: 30,
  keyHmac: 30,
  label: 15,
  xpath: 15,
  table: 10,
  classes: 10,
  attr: 2,
  geometry: 8,
  /** Inside the sticker's own in-page viewer (`within`); identity matches only. */
  view: 15,
  /** Same nearest heading; identity matches only. */
  heading: 5,
  hidden: -10,
} as const;

/** Elements the text-identity sweep looks at, at most. */
const TEXT_SWEEP_CAP = 2000;

/**
 * Positional signals (cssPath, xpath, table column, geometry) describe a SLOT,
 * not a record. When the fingerprint carries at least one identity signal, a
 * candidate that matches none of them is a different record sitting in the old
 * slot — a deleted row's successor, the row that shifted up. Those must not be
 * able to reach the acceptance threshold on position alone, or the sticker
 * silently moves to another person's SSN.
 */
const NO_IDENTITY_FACTOR = 0.6;

/** Identity signals: things that name the record, not the position. */
function hasIdentity(fp: Fingerprint): boolean {
  return !!(
    fp.id ||
    fp.idHmac ||
    fp.testId ||
    fp.testIdHmac ||
    fp.name ||
    fp.nameHmac ||
    fp.textHmac ||
    fp.keyHmac ||
    (fp.labelContext && fp.labelSource && fp.labelSource !== 'column')
  );
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function cssSegmentsMatch(fp: Fingerprint, el: Element): number {
  // Partial credit: how many trailing segments of the stored path still match
  // the element's ancestry. Full match handled by querySelectorAll.
  const segs = fp.cssPath.split(' > ');
  let node: Element | null = el;
  let matched = 0;
  for (let i = segs.length - 1; i >= 0 && node; i--) {
    try {
      if (node.matches(segs[i])) matched++;
      else break;
    } catch {
      break;
    }
    node = node.parentElement;
  }
  return matched / segs.length;
}

export async function resolveFingerprint(fp: Fingerprint, opts: ResolveOptions = {}): Promise<Resolution | null> {
  const threshold = opts.threshold ?? 45;
  const margin = opts.margin ?? 10;
  const exclude = opts.exclude ?? (() => false);

  const root = scopeRootOf(fp);
  if (!root) return null;
  const inShadow = root !== document;
  const candidates = new Set<Element>();
  if (fp.id) {
    const byId = root.getElementById(fp.id);
    if (byId) candidates.add(byId);
  }
  if (fp.testId) {
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      queryAll(`[${a}="${CSS.escape(fp.testId)}"]`, root).forEach((e) => candidates.add(e));
    }
  }
  queryAll(fp.cssPath, root).forEach((e) => candidates.add(e));
  if (!inShadow) evalXPath(fp.xpath).forEach((e) => candidates.add(e));
  if (fp.name) queryAll(`${fp.tag}[name="${CSS.escape(fp.name)}"]`, root).forEach((e) => candidates.add(e));
  if (fp.labelContext && !inShadow) elementsNearLabel(fp.labelContext, fp.tag).forEach((e) => candidates.add(e));

  // Exact-match attributes stored as HMACs (values that were not
  // identifier-like). Memoised per raw value for this pass; only values that
  // would themselves have been hashed are hashed, so the cost stays bounded.
  const attrCache = new Map<string, Promise<string | undefined>>();
  const attrHmac = (v: string | null | undefined): Promise<string | undefined> => {
    if (!v || isIdentifierLike(v)) return Promise.resolve(undefined);
    let p = attrCache.get(v);
    if (!p) {
      p = attrHmacOf(v);
      attrCache.set(v, p);
    }
    return p;
  };
  const addByHmac = async (selector: string, want: string, read: (e: Element) => string | null | undefined) => {
    const els = queryAll(selector, root).slice(0, 1000);
    await Promise.all(
      els.map(async (e) => {
        if ((await attrHmac(read(e))) === want) candidates.add(e);
      }),
    );
  };
  if (fp.idHmac) await addByHmac(`${fp.tag}[id]`, fp.idHmac, (e) => e.id);
  if (fp.testIdHmac) await addByHmac(TEST_ID_ATTRS.map((a) => `${fp.tag}[${a}]`).join(','), fp.testIdHmac, testId);
  if (fp.nameHmac) await addByHmac(`${fp.tag}[name]`, fp.nameHmac, (e) => e.getAttribute('name'));

  // HMAC of a record key, memoised per raw value for this resolve pass.
  const keyCache = new Map<string, Promise<string | undefined>>();
  const keyHmacOfEl = (el: Element): Promise<string | undefined> => {
    const k = keyAttrOf(el);
    if (!k) return Promise.resolve(undefined);
    let p = keyCache.get(k.value);
    if (!p) {
      p = textHmacOf(k.value);
      keyCache.set(k.value, p);
    }
    return p;
  };

  // Records whose key still matches, wherever the framework re-rendered them to.
  if (fp.keyHmac) {
    const holders = queryAll(KEY_ATTR_SELECTOR, root).slice(0, 200);
    await Promise.all(
      holders.map(async (h) => {
        if (exclude(h)) return;
        if ((await keyHmacOfEl(h)) !== fp.keyHmac) return;
        if (h.tagName.toLowerCase() === fp.tag) candidates.add(h);
        h.querySelectorAll(fp.tag).forEach((e) => candidates.add(e));
      }),
    );
  }

  // Same tag inside the same table column, for reordered / re-rendered tables.
  if (fp.tableContext?.header) {
    for (const th of queryAll('th', root)) {
      const t = th.textContent?.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (t !== fp.tableContext.header) continue;
      const row = th.closest('tr');
      const table = th.closest('table');
      const col = row ? Array.from(row.children).indexOf(th) : -1;
      if (!table || col < 0) continue;
      table.querySelectorAll('tbody > tr').forEach((r) => {
        const cell = r.children[col];
        if (cell && cell.tagName.toLowerCase() === fp.tag) candidates.add(cell);
      });
    }
  }

  // Text identity as a candidate source. Positional selectors fail where the
  // page regenerates class names and moves its layers around (an in-page
  // viewer re-opened after a deployment), and the text HMAC is then the only
  // strong identity left; without this nothing would put the element in the
  // running at all. Bounded: same tag, same normalised length, capped count,
  // and only when no candidate so far has the right length.
  if (fp.textHmac && fp.textLen > 0) {
    const sameLen = (e: Element) => normalizeText(opts.textOf?.(e) ?? fingerprintText(e)).length === fp.textLen;
    const have = Array.from(candidates).some((e) => e.tagName.toLowerCase() === fp.tag && sameLen(e));
    if (!have) {
      const sweepRoot: ParentNode = opts.within ?? root;
      const pool = Array.from(sweepRoot.querySelectorAll(fp.tag)).slice(0, TEXT_SWEEP_CAP);
      const hits = await Promise.all(
        pool.map(async (e) => (!exclude(e) && sameLen(e) && (await textHmacOf(opts.textOf?.(e) ?? fingerprintText(e))) === fp.textHmac ? e : null)),
      );
      for (const e of hits) if (e) candidates.add(e);
    }
  }

  const list = Array.from(candidates).filter(
    (el) => el.isConnected && el.tagName.toLowerCase() === fp.tag && !exclude(el) && (!opts.within || opts.within.contains(el)),
  );
  if (list.length === 0) return null;

  const cssExact = new Set(queryAll(fp.cssPath, root));
  const xpathExact = new Set(inShadow ? [] : evalXPath(fp.xpath));
  const storedCenter = center(fp.rect);
  const scaleX = fp.viewportW > 0 ? window.innerWidth / fp.viewportW : 1;

  const identityAvailable = hasIdentity(fp);
  // In a layout-less environment (jsdom, or a document that has not laid out
  // yet) nothing has client rects; penalising every candidate equally would
  // only push the whole field below the threshold, so skip it.
  const anyRendered = list.some((el) => isRendered(el));

  const scored: { el: Element; score: number }[] = [];
  for (const el of list) {
    let s = 0;
    let identityMatched = false;
    if ((fp.id && el.id === fp.id) || (fp.idHmac && (await attrHmac(el.id)) === fp.idHmac)) {
      s += W.id;
      identityMatched = true;
    }
    const tid = testId(el);
    if ((fp.testId && tid === fp.testId) || (fp.testIdHmac && (await attrHmac(tid)) === fp.testIdHmac)) {
      s += W.testId;
      identityMatched = true;
    }
    if (cssExact.has(el)) s += W.cssPath;
    else s += W.cssPath * 0.5 * cssSegmentsMatch(fp, el);
    if (xpathExact.has(el)) s += W.xpath;
    if (fp.textHmac) {
      const h = await textHmacOf(opts.textOf?.(el) ?? fingerprintText(el));
      if (h && h === fp.textHmac) {
        s += W.textHmac;
        identityMatched = true;
      }
    }
    if (fp.keyHmac && (await keyHmacOfEl(el)) === fp.keyHmac) {
      s += W.keyHmac;
      identityMatched = true;
    }
    if (fp.labelContext) {
      const li = labelInfo(el);
      // A column header is shared by every row: it neither proves identity nor
      // earns points here, because it is the same fact `tableContext.header`
      // already scored.
      const columnOnly = fp.labelSource === 'column' || li?.source === 'column';
      if (li?.text === fp.labelContext && !columnOnly) {
        s += W.label;
        identityMatched = true;
      }
    }
    if (fp.tableContext?.header) {
      const tc = tableContext(el);
      if (tc?.header === fp.tableContext.header) s += W.table;
      if (tc?.colIndex === fp.tableContext.colIndex && tc?.rowIndex === fp.tableContext.rowIndex) s += 3;
    }
    s += W.classes * jaccard(fp.classes, stableClasses(el));
    const elName = el.getAttribute('name');
    if ((fp.name && elName === fp.name) || (fp.nameHmac && (await attrHmac(elName)) === fp.nameHmac)) {
      s += W.attr;
      identityMatched = true;
    }
    for (const [k, attr] of [
      ['type', 'type'],
      ['role', 'role'],
    ] as const) {
      if (fp[k] && el.getAttribute(attr) === fp[k]) s += W.attr;
    }
    // Stored normalised (current records) or raw (records from before the
    // normalisation): accept either form.
    for (const [k, attr] of [
      ['ariaLabel', 'aria-label'],
      ['placeholder', 'placeholder'],
    ] as const) {
      const v = el.getAttribute(attr);
      if (fp[k] && v && (normalizeContext(v) === fp[k] || v.slice(0, 60) === fp[k])) s += W.attr;
    }

    // Context that only corroborates: the same heading, and being inside the
    // sticker's own viewer. Neither says which record an element is (every row
    // under a heading shares it), so both count only once something about the
    // element itself matched. On a percentage-positioned text layer the text
    // HMAC plus the viewer is as strong as identity gets.
    if (identityMatched) {
      if (fp.headingContext && headingContext(el) === fp.headingContext) s += W.heading;
      if (opts.within) s += W.view;
    }

    if (isRendered(el)) {
      const c = center(viewToDoc(toViewRect(el.getBoundingClientRect())));
      const d = distance({ x: storedCenter.x * scaleX, y: storedCenter.y }, c);
      if (d < 120) s += W.geometry * (1 - d / 120);
    } else if (anyRendered) {
      s += W.hidden;
    }
    if (identityAvailable && !identityMatched) s *= NO_IDENTITY_FACTOR;
    scored.push({ el, score: Math.round(s * 10) / 10 });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < threshold) return null;
  const second = scored[1];
  if (!second || best.score - second.score >= margin) {
    return { el: best.el, score: best.score, confidence: 'high', ties: [] };
  }
  // A tie must itself clear the threshold: the locked session masks every tie.
  const ties = scored.filter((s) => best.score - s.score < margin && s.score >= threshold).map((s) => s.el);
  return { el: best.el, score: best.score, confidence: 'low', ties: ties.slice(1) };
}
