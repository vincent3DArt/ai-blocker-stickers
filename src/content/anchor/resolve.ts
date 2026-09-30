import type { Confidence, Fingerprint } from '@/shared/types';
import { TEST_ID_ATTRS, evalXPath, isIdentifierLike, queryAll, stableClasses, testId } from './selector';
import { elementsNearLabel, labelInfo, normalizeContext, tableContext } from './context';
import { center, distance, isRendered, toViewRect, viewToDoc } from './geometry';
import { KEY_ATTR_SELECTOR, attrHmacOf, fingerprintText, keyAttrOf, textHmacOf } from './fingerprint';

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
}

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
  hidden: -10,
} as const;

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

  const candidates = new Set<Element>();
  if (fp.id) {
    const byId = document.getElementById(fp.id);
    if (byId) candidates.add(byId);
  }
  if (fp.testId) {
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      queryAll(`[${a}="${CSS.escape(fp.testId)}"]`).forEach((e) => candidates.add(e));
    }
  }
  queryAll(fp.cssPath).forEach((e) => candidates.add(e));
  evalXPath(fp.xpath).forEach((e) => candidates.add(e));
  if (fp.name) queryAll(`${fp.tag}[name="${CSS.escape(fp.name)}"]`).forEach((e) => candidates.add(e));
  if (fp.labelContext) elementsNearLabel(fp.labelContext, fp.tag).forEach((e) => candidates.add(e));

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
    const els = queryAll(selector).slice(0, 1000);
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
    const holders = queryAll(KEY_ATTR_SELECTOR).slice(0, 200);
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
    for (const th of queryAll('th')) {
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

  const list = Array.from(candidates).filter(
    (el) => el.isConnected && el.tagName.toLowerCase() === fp.tag && !exclude(el),
  );
  if (list.length === 0) return null;

  const cssExact = new Set(queryAll(fp.cssPath));
  const xpathExact = new Set(evalXPath(fp.xpath));
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
      const h = await textHmacOf(fingerprintText(el));
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
  const ties = scored.filter((s) => best.score - s.score < margin).map((s) => s.el);
  return { el: best.el, score: best.score, confidence: 'low', ties: ties.slice(1) };
}
