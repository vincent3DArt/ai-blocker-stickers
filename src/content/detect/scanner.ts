/**
 * Auto-suggest scanner.
 *
 * Unlocked, it finds likely sensitive numbers after the page is idle and
 * offers each as a suggestion the user can cover or dismiss. While the tab is
 * locked (AI session, detected automation) it never suggests: every detection
 * at or above the balanced threshold is covered at once, and text inserted
 * while locked is checked and masked inside the mutation callback that
 * reports it, before the page can paint it.
 *
 * Privacy: matched text never leaves memory. A suggestion's identity is an
 * HMAC of pattern + element path + label, which is all a dismissal stores.
 */

import type { Settings, SiteRecord, StickerSource, ViewRect } from '@/shared/types';
import type { MutationHub } from '../mask/guard';
import type { Masker } from '../mask/masker';
import { defaultMaskMode } from '../mask/masker';
import { isBullets } from '../mask/text-mask';
import { suggestionHmacOf } from '../anchor/fingerprint';
import { isStableId } from '../anchor/selector';
import { normalizeContext } from '../anchor/context';
import { BlockWalker, SKIP_TAGS, allBlocks, nearestBlock, ownBlock, rangesFor, targetFor, type Block } from './block-text';
import {
  DETECTOR_BY_ID,
  HIGH_IDS,
  STRENGTH_POINTS,
  accepts,
  findMatches,
  type PatternId,
  type Sensitivity,
  type Strength,
} from './patterns';
import { hasKind, inputKinds, labelFor, labelKinds, resetLabelCache, type LabelKind } from './labels';
import { IdleJob, ViewportOrder, onIdle } from './scheduler';

export interface Hit {
  el: Element;
  pattern: PatternId;
  strength: Strength;
  /** Label evidence: 3 same element, 2 adjacent label, 1 same block, 0 none. */
  bonus: number;
  score: number;
  /** The block is the only covering element and is much longer than the match. */
  wide: boolean;
  /** A form field, matched on its value. */
  input: boolean;
  /** Where the match sits, for text hits (in memory only). */
  block?: Block;
  start?: number;
  end?: number;
}

export interface DetectOptions {
  sensitivity: Sensitivity;
  /** Only these detectors. */
  ids?: ReadonlySet<PatternId>;
  /** Elements that must not be reported (our overlay, already masked content). */
  exclude?: (el: Element) => boolean;
}

// ---- pure detection over the DOM ----

function digitCount(s: string, enough = 4): number {
  let n = 0;
  for (let i = 0; i < s.length && n < enough; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

export const hasDigits = (s: string, n = 4) => digitCount(s, n) >= n;

/** A link whose href carries the match: a URL or a tel:/mailto:, not a displayed identifier. */
function inHref(el: Element, text: string): boolean {
  const a = el.closest('a[href]');
  if (!a) return false;
  const compact = text.replace(/\s+/g, '');
  const href = a.getAttribute('href') ?? '';
  return href.includes(compact) || href.replace(/\D/g, '').includes(compact.replace(/\D/g, '') || '\u0000');
}

/** Label evidence for a match: the strongest of same element, adjacent label, same block. */
export function labelBonus(block: Block, start: number, end: number, target: Element, kinds: readonly LabelKind[]): number {
  const len = end - start;
  const own = target === block.el ? block.text : (target.textContent ?? '');
  if (own.length <= 3 * len + 40) {
    const rest = own.replace(block.text.slice(start, end), ' ');
    if (hasKind(labelKinds(rest), kinds)) return 3;
  }
  if (hasKind(inputKinds(target), kinds)) return 3;
  if (hasKind(labelKinds(labelFor(target)), kinds)) return 2;
  if (target !== block.el && hasKind(labelKinds(labelFor(block.el)), kinds)) return 2;
  const win = block.text.slice(Math.max(0, start - 60), start) + ' \n ' + block.text.slice(end, end + 60);
  if (hasKind(labelKinds(win), kinds)) return 1;
  return 0;
}

/** Suggestions in one block: at most one per element, the best-scoring detector. */
export function detectBlock(block: Block, o: DetectOptions): Hit[] {
  if (!hasDigits(block.text)) return [];
  const matches = findMatches(block.text, { ids: o.ids });
  if (!matches.length) return [];
  const best = new Map<Element, Hit>();
  for (const m of matches) {
    const det = DETECTOR_BY_ID[m.id];
    const t = targetFor(block, m.start, m.end);
    if (!t || o.exclude?.(t.el)) continue;
    if (inHref(t.el, block.text.slice(m.start, m.end))) continue;
    const bonus = labelBonus(block, m.start, m.end, t.el, det.kinds);
    if (!accepts(det.strength, bonus, o.sensitivity, det.labelGated)) continue;
    const score = STRENGTH_POINTS[det.strength] + bonus;
    const prev = best.get(t.el);
    if (prev && prev.score >= score) continue;
    best.set(t.el, { el: t.el, pattern: m.id, strength: det.strength, bonus, score, wide: t.wide, input: false, block, start: m.start, end: m.end });
  }
  return Array.from(best.values());
}

export const FIELD_SELECTOR = 'input:not([type=hidden]):not([type=password]), textarea';
const NON_TEXT_TYPES = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color']);

/**
 * Form fields. A field whose label or attributes carry a keyword is checked
 * against every pattern; any other text field only against the high-strength
 * ones. The value is read in memory and never kept.
 */
export function detectInputs(root: ParentNode, o: DetectOptions): Hit[] {
  const out: Hit[] = [];
  const fields: Element[] = [];
  if (root instanceof Element && root.matches(FIELD_SELECTOR)) fields.push(root);
  fields.push(...Array.from(root.querySelectorAll(FIELD_SELECTOR)));
  for (const el of fields) {
    if (o.exclude?.(el)) continue;
    if (el instanceof HTMLInputElement && NON_TEXT_TYPES.has(el.type)) continue;
    const value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? '';
    if (!hasDigits(value)) continue;
    const kinds = inputKinds(el);
    for (const k of labelKinds(labelFor(el))) kinds.add(k);
    const ids = kinds.size ? o.ids : new Set([...HIGH_IDS].filter((id) => !o.ids || o.ids.has(id)));
    let best: Hit | null = null;
    for (const m of findMatches(value, { ids })) {
      const det = DETECTOR_BY_ID[m.id];
      const win = value.slice(Math.max(0, m.start - 60), m.start) + ' \n ' + value.slice(m.end, m.end + 60);
      const bonus = hasKind(kinds, det.kinds) ? 3 : hasKind(labelKinds(win), det.kinds) ? 1 : 0;
      if (!accepts(det.strength, bonus, o.sensitivity, det.labelGated)) continue;
      const score = STRENGTH_POINTS[det.strength] + bonus;
      if (!best || score > best.score) best = { el, pattern: m.id, strength: det.strength, bonus, score, wide: false, input: true };
    }
    if (best) out.push(best);
  }
  return out;
}

/** Keep the best hit per element. */
function dedupe(hits: Hit[]): Hit[] {
  const m = new Map<Element, Hit>();
  for (const h of hits) {
    const p = m.get(h.el);
    if (!p || h.score > p.score) m.set(h.el, h);
  }
  return Array.from(m.values());
}

/** Everything under `root`, synchronously (tests and the locked full scan). */
export function scanSync(root: Element | Document, o: DetectOptions & { skip?: (el: Element) => boolean; cap?: number }): Hit[] {
  resetLabelCache();
  const start = root instanceof Document ? (root.body ?? root.documentElement) : root;
  const blocks = allBlocks(start, { skip: o.skip, cap: o.cap });
  const hits: Hit[] = [];
  for (const b of blocks) hits.push(...detectBlock(b, o));
  hits.push(...detectInputs(root, o));
  return dedupe(hits);
}

/** A cheap structural path for suggestion identity (hashed, never stored raw). */
export function identityPath(el: Element): string {
  const parts: string[] = [];
  let n: Element | null = el;
  while (n && n !== n.ownerDocument.documentElement && parts.length < 12) {
    if (n.id && isStableId(n.id)) {
      parts.unshift('#' + n.id);
      break;
    }
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    parts.unshift(`${n.tagName.toLowerCase()}:${i}`);
    n = n.parentElement;
  }
  return parts.join('>');
}

// ---- the live scanner ----

export interface Suggestion {
  id: string;
  hit: Hit;
  /** Chip text, e.g. "SSN". */
  name: string;
}

export interface ScannerHooks {
  hub: MutationHub;
  masker: Masker;
  isOurs: (n: Node | null) => boolean;
  settings: () => Settings;
  site: () => Pick<SiteRecord, 'scanEnabled'> & { dismissed: ReadonlySet<string> };
  dismiss: (id: string) => void;
  locked: () => boolean;
  paused: () => boolean;
  /** Session-scoped stickers currently held, to cap how many the lock creates. */
  autoStickers: () => number;
  /** The suggestion list or the auto-cover count changed. */
  onChange: () => void;
  /** Place an element sticker. `maskId`: `el` is already masked under this id. */
  cover: (el: Element, source: StickerSource, opts?: { maskId?: string; ephemeral?: boolean }) => Promise<unknown>;
  /** Place a rectangle sticker (a suggestion inside a long block). */
  coverRect: (rect: ViewRect) => Promise<unknown>;
}

export const MAX_SUGGESTIONS = 200;
/** Beyond this many session stickers, auto-covered content is masked without an overlay sticker. */
export const MAX_AUTO_STICKERS = 200;
export const TEXT_NODE_CAP = 20_000;
export const BATCH_MS = 750;
export const CHUNK_BLOCKS = 200;
/** Text nodes the locked pre-paint check walks per mutation callback. */
const PREPAINT_BUDGET = 5000;
/** Beyond this many changed nodes in one batch, rescan the page instead. */
const DIRTY_CAP = 2000;

export interface ScanStats {
  startedAt: number;
  finishedAt: number;
  blocks: number;
  candidates: number;
  textNodes: number;
  truncated: boolean;
  chunks: number;
  maxChunkMs: number;
}

const now = () => performance.now();

export class Scanner {
  readonly suggestions = new Map<string, Suggestion>();
  /** Detections in the last full scan (plus later deltas), including beyond the cap. */
  total = 0;
  stats: ScanStats = { startedAt: 0, finishedAt: 0, blocks: 0, candidates: 0, textNodes: 0, truncated: false, chunks: 0, maxChunkMs: 0 };
  private job: IdleJob | null = null;
  private order: ViewportOrder<Block> | null = null;
  private dirty = new Set<Node>();
  private dirtyOverflow = false;
  private devOff = false;
  private started = false;
  private gen = 0;
  private autoEls = new WeakSet<Element>();
  /** Auto-covered without a sticker (beyond the cap, or text ranges in a huge block). */
  private maskOnly: Array<{ id: string; el: Element }> = [];
  private notifyQueued = false;
  private disposers: Array<() => void> = [];
  private idleWaiter: (() => void) | null = null;

  constructor(private h: ScannerHooks) {}

  /** Register the mutation listeners now; the first unlocked scan waits for the page to finish loading. */
  start(devOff = false) {
    if (this.started) return;
    this.started = true;
    this.devOff = devOff;
    this.disposers.push(this.h.hub.addListener((r) => this.onRecords(r)));
    this.disposers.push(this.h.hub.onBatch(() => this.onBatch(), BATCH_MS));
    if (this.h.locked() && this.active()) this.lockedFullScan();
    // First unlocked pass: once the page has loaded and the browser is idle
    // (after the first full layout and paint, which on a big page is itself
    // a long task that must not be charged to, or collide with, the scan).
    this.afterLoad(() => {
      this.idleWaiter = onIdle(() => {
        this.idleWaiter = null;
        this.rescan();
      }, 1000);
    });
  }

  destroy() {
    this.cancelJob();
    this.idleWaiter?.();
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  get scanning(): boolean {
    return !!this.job?.running;
  }

  get autoMaskOnly(): number {
    return this.maskOnly.length;
  }

  /** Scanning applies: always while locked (protection), else per site and not paused. */
  active(): boolean {
    if (this.devOff) return false;
    if (this.h.locked()) return true;
    return this.siteEnabled() && !this.h.paused();
  }

  siteEnabled(): boolean {
    return this.h.site().scanEnabled ?? this.h.settings().scanDefault;
  }

  /** While locked the threshold is balanced at least, whatever the setting. */
  sensitivity(): Sensitivity {
    const s = this.h.settings().scanSensitivity;
    if (this.h.locked()) return s === 'aggressive' ? 'aggressive' : 'balanced';
    return s;
  }

  setDevOff(off: boolean) {
    if (this.devOff === off) return;
    this.devOff = off;
    this.rescan();
  }

  setLocked(on: boolean) {
    this.cancelJob();
    if (on) {
      this.clearSuggestions();
      if (this.active()) this.lockedFullScan();
    } else {
      this.rescan();
    }
  }

  /** Full rescan: synchronous while locked, idle-chunked otherwise. */
  rescan() {
    this.cancelJob();
    if (!this.active()) {
      this.clearSuggestions();
      return;
    }
    if (this.h.locked()) {
      this.clearSuggestions();
      this.lockedFullScan();
      return;
    }
    this.idleFullScan();
  }

  // ---- suggestions ----

  list(): Suggestion[] {
    return Array.from(this.suggestions.values());
  }

  async cover(id: string): Promise<boolean> {
    const s = this.suggestions.get(id);
    if (!s || this.h.locked()) return false;
    this.suggestions.delete(id);
    this.notify();
    const { hit } = s;
    if (!hit.el.isConnected) return false;
    if (hit.wide && hit.block && hit.start !== undefined) {
      const rect = matchRect(hit);
      if (rect) {
        await this.h.coverRect(rect);
        return true;
      }
    }
    await this.h.cover(hit.el, 'suggest');
    return true;
  }

  async coverAll(): Promise<number> {
    let n = 0;
    for (const id of Array.from(this.suggestions.keys())) if (await this.cover(id)) n++;
    return n;
  }

  dismiss(id: string) {
    if (!this.suggestions.has(id)) return;
    this.suggestions.delete(id);
    this.h.dismiss(id);
    this.notify();
  }

  // ---- session end ----

  /** Keep: mask-only covers of whole elements become stickers too. */
  keepAuto() {
    const list = this.maskOnly;
    this.maskOnly = [];
    for (const m of list) {
      const root = this.h.masker.rootOf(m.id);
      if (root?.isConnected) void this.h.cover(root, 'session-auto', { maskId: m.id, ephemeral: false });
      else this.h.masker.restore(m.id);
    }
    this.notify();
  }

  /** Discard: unmask what the lock covered without a sticker. */
  dropAuto() {
    if (this.h.locked()) return;
    for (const m of this.maskOnly) this.h.masker.restore(m.id);
    this.maskOnly = [];
    this.autoEls = new WeakSet();
    this.notify();
  }

  // ---- internals ----

  private exclude = (el: Element) => this.h.isOurs(el) || this.h.masker.isMaskedNode(el);
  private skip = (el: Element) => this.h.isOurs(el) || this.h.masker.isMaskRoot(el);

  private options(ids?: ReadonlySet<PatternId>): DetectOptions {
    return { sensitivity: this.sensitivity(), ids, exclude: this.exclude };
  }

  private afterLoad(fn: () => void) {
    const go = () => fn();
    if (document.readyState === 'complete') {
      go();
      return;
    }
    const onLoad = () => {
      window.removeEventListener('load', onLoad);
      this.idleWaiter = null;
      go();
    };
    window.addEventListener('load', onLoad);
    this.idleWaiter = () => window.removeEventListener('load', onLoad);
  }

  private cancelJob() {
    this.gen++;
    this.job?.cancel();
    this.job = null;
    this.order?.dispose();
    this.order = null;
  }

  private clearSuggestions() {
    if (!this.suggestions.size && !this.total) return;
    this.suggestions.clear();
    this.total = 0;
    this.notify();
  }

  /**
   * Tell the owner once per burst, in a task of its own: drawing the chips
   * must not be added to the scan chunk (or crypto callback) that found them.
   */
  private notify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    setTimeout(() => {
      this.notifyQueued = false;
      this.h.onChange();
    }, 0);
  }

  /** The locked full pass: synchronous, every detector, auto-cover. Protection outranks a long task. */
  private lockedFullScan() {
    const root = document.body ?? document.documentElement;
    if (!root) return;
    const hits = scanSync(document, { ...this.options(), skip: this.skip, cap: TEXT_NODE_CAP });
    for (const hit of hits) this.autoCover(hit);
  }

  private idleFullScan() {
    const gen = this.gen;
    const root = document.body ?? document.documentElement;
    if (!root) return;
    resetLabelCache();
    const walker = new BlockWalker(root, { skip: this.skip, cap: TEXT_NODE_CAP });
    const order = new ViewportOrder<Block>();
    this.order = order;
    const seen = new Set<string>();
    const pending: Promise<unknown>[] = [];
    const budget = { accepted: 0 };
    this.total = 0;
    let walking = true;
    this.stats = { startedAt: 0, finishedAt: 0, blocks: 0, candidates: 0, textNodes: 0, truncated: false, chunks: 0, maxChunkMs: 0 };
    const opts = this.options();
    const job = new IdleJob(
      (timeUp) => {
        const t0 = now();
        if (!this.stats.startedAt) this.stats.startedAt = t0;
        let more = true;
        if (walking) {
          for (const b of walker.next(CHUNK_BLOCKS, timeUp)) {
            this.stats.blocks++;
            if (hasDigits(b.text)) {
              this.stats.candidates++;
              order.push(b);
            }
          }
          this.stats.textNodes = walker.textNodes;
          if (walker.done) {
            walking = false;
            this.stats.truncated = walker.truncated;
          }
        } else {
          const hits: Hit[] = [];
          for (let n = 0; n < CHUNK_BLOCKS && !timeUp(); n++) {
            const b = order.take();
            if (!b) break;
            if (b.el.isConnected) hits.push(...detectBlock(b, opts));
          }
          if (hits.length) this.addHits(hits, gen, seen, pending, budget);
          if (order.size === 0) {
            this.addHits(detectInputs(document, opts), gen, seen, pending, budget);
            more = false;
          }
        }
        const dt = now() - t0;
        this.stats.chunks++;
        if (dt > this.stats.maxChunkMs) this.stats.maxChunkMs = dt;
        return more;
      },
      () => {
        order.dispose();
        if (this.order === order) this.order = null;
        void Promise.all(pending).then(() => {
          if (gen !== this.gen) return;
          // Suggestions not found again are gone (covered, removed, now dismissed).
          for (const id of Array.from(this.suggestions.keys())) if (!seen.has(id)) this.suggestions.delete(id);
          this.stats.finishedAt = now();
          this.notify();
        });
      },
    );
    this.job = job;
    job.start();
  }

  /**
   * Unlocked: give each hit its identity and add it unless dismissed or over
   * the cap. Locked: cover it.
   */
  private addHits(hits: Hit[], gen: number, seen: Set<string> | null, pending: Promise<unknown>[] | null, budget: { accepted: number } | null) {
    if (this.h.locked()) {
      for (const hit of hits) this.autoCover(hit);
      return;
    }
    const dismissed = this.h.site().dismissed;
    for (const hit of hits) {
      this.total++;
      if (budget) {
        if (budget.accepted >= MAX_SUGGESTIONS) continue;
        budget.accepted++;
      } else if (this.suggestions.size >= MAX_SUGGESTIONS) continue;
      const label = normalizeContext(labelFor(hit.el)) ?? '';
      const p = suggestionHmacOf(`${hit.pattern}|${identityPath(hit.el)}|${label}`).then((id) => {
        if (!id || gen !== this.gen || this.h.locked()) return;
        if (dismissed.has(id) || this.h.site().dismissed.has(id)) {
          if (budget) budget.accepted--;
          return;
        }
        seen?.add(id);
        if (!hit.el.isConnected || this.exclude(hit.el)) return;
        const prev = this.suggestions.get(id);
        if (prev && prev.hit.score > hit.score && prev.hit.el.isConnected) return;
        this.suggestions.set(id, { id, hit, name: DETECTOR_BY_ID[hit.pattern].name });
        this.notify();
      });
      pending?.push(p);
    }
  }

  /**
   * Locked: mask now, in this task, then hand the element to the session as a
   * session-scoped sticker (the sticker adopts the mask; nothing is un-masked
   * in between).
   */
  private autoCover(hit: Hit) {
    const el = hit.el;
    if (!el.isConnected || this.autoEls.has(el) || this.h.masker.isMaskedNode(el) || this.h.isOurs(el)) return;
    this.autoEls.add(el);
    const id = crypto.randomUUID();
    const huge = el === document.body || el === document.documentElement || (el.textContent?.length ?? 0) > 2000;
    if (huge) {
      if (hit.block && hit.start !== undefined && hit.end !== undefined) {
        this.h.masker.applyTextRanges(id, hit.block.el, rangesFor(hit.block, hit.start, hit.end));
        this.maskOnly.push({ id, el });
        this.notify();
      }
      return;
    }
    this.h.masker.apply(id, el, defaultMaskMode(el));
    if (this.h.autoStickers() + this.pendingAuto < MAX_AUTO_STICKERS) {
      this.pendingAuto++;
      void this.h
        .cover(el, 'session-auto', { maskId: id, ephemeral: true })
        .catch((e) => console.error('[aibs] auto-cover failed', e))
        .finally(() => {
          this.pendingAuto--;
          this.notify();
        });
    } else {
      this.maskOnly.push({ id, el });
      this.notify();
    }
  }
  private pendingAuto = 0;

  /** Mutation callback. Locked: the pre-paint check. Unlocked: remember what changed for the batch. */
  private onRecords(records: MutationRecord[]) {
    if (this.devOff || !this.started) return;
    const touched: Node[] = [];
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => touched.push(n));
      else if (r.type === 'characterData') touched.push(r.target);
    }
    if (!touched.length) return;
    if (this.h.locked()) {
      this.prePaint(touched);
      return;
    }
    if (this.dirtyOverflow) return;
    for (const n of touched) {
      if (n.nodeType === Node.TEXT_NODE && !/\d/.test((n as Text).data)) continue;
      this.dirty.add(n);
      if (this.dirty.size > DIRTY_CAP) {
        this.dirtyOverflow = true;
        this.dirty.clear();
        return;
      }
    }
  }

  /**
   * Locked, inside the mutation callback: every inserted or rewritten Text
   * node with digits is checked, with its whole block, against the
   * high-strength patterns, or against all of them when the block (or its
   * label) already carries a keyword. Matches are masked before returning,
   * so they are never painted. No frame, timer or visibility is involved.
   */
  private prePaint(touched: Node[]) {
    const blocks = new Set<Element>();
    const fields: Element[] = [];
    let budget = PREPAINT_BUDGET;
    const visitText = (t: Text) => {
      budget--;
      if (!t.isConnected || !/\d/.test(t.data) || isBullets(t.data)) return;
      const p = t.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName.toUpperCase()) || this.exclude(p)) return;
      blocks.add(nearestBlock(p));
    };
    for (const n of touched) {
      if (budget <= 0) break;
      if (n.nodeType === Node.TEXT_NODE) {
        visitText(n as Text);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE || !n.isConnected) continue;
      const el = n as Element;
      if (this.h.isOurs(el) || SKIP_TAGS.has(el.tagName.toUpperCase())) {
        if (el.tagName === 'TEXTAREA') fields.push(el);
        continue;
      }
      if (el.matches(FIELD_SELECTOR) || el.querySelector(FIELD_SELECTOR)) fields.push(el);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t && budget > 0; t = w.nextNode()) visitText(t as Text);
    }
    if (budget <= 0) {
      // More than one callback can check: cover what the full pass finds.
      this.lockedFullScan();
      return;
    }
    const sensitivity = this.sensitivity();
    for (const b of blocks) {
      const block = ownBlock(b, { skip: this.skip });
      if (!block || !hasDigits(block.text)) continue;
      const keyword = labelKinds(block.text).size > 0 || labelKinds(labelFor(b)).size > 0;
      for (const hit of detectBlock(block, { sensitivity, ids: keyword ? undefined : HIGH_IDS, exclude: this.exclude })) this.autoCover(hit);
    }
    for (const f of fields) for (const hit of detectInputs(f, { sensitivity, exclude: this.exclude })) this.autoCover(hit);
  }

  /** Debounced (750 ms): rescan the blocks that changed, drop suggestions whose element went away. */
  private onBatch() {
    if (!this.active()) {
      this.dirty.clear();
      this.dirtyOverflow = false;
      return;
    }
    this.prune();
    if (this.dirtyOverflow) {
      this.dirtyOverflow = false;
      this.dirty.clear();
      this.rescan();
      return;
    }
    if (!this.dirty.size) return;
    const nodes = Array.from(this.dirty);
    this.dirty.clear();
    resetLabelCache();
    const blocks = new Map<Element, Block>();
    const fields: Element[] = [];
    const addBlock = (el: Element) => {
      if (blocks.has(el)) return;
      const b = ownBlock(el, { skip: this.skip });
      if (b) blocks.set(el, b);
    };
    for (const n of nodes) {
      if (!n.isConnected) continue;
      if (n.nodeType === Node.TEXT_NODE) {
        const p = (n as Text).parentElement;
        if (p && !this.exclude(p)) addBlock(nearestBlock(p));
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      if (this.exclude(el) || SKIP_TAGS.has(el.tagName.toUpperCase())) {
        if (el.tagName === 'TEXTAREA') fields.push(el);
        continue;
      }
      addBlock(nearestBlock(el));
      for (const b of allBlocks(el, { skip: this.skip, cap: TEXT_NODE_CAP })) if (!blocks.has(b.el)) blocks.set(b.el, b);
      if (el.matches(FIELD_SELECTOR) || el.querySelector(FIELD_SELECTOR)) fields.push(el);
    }
    const opts = this.options();
    const hits: Hit[] = [];
    for (const b of blocks.values()) hits.push(...detectBlock(b, opts));
    for (const f of fields) hits.push(...detectInputs(f, opts));
    if (hits.length) this.addHits(dedupe(hits), this.gen, null, null, null);
  }

  /** Drop suggestions whose element is gone or got covered. */
  private prune() {
    let changed = false;
    for (const [id, s] of this.suggestions) {
      if (!s.hit.el.isConnected || this.exclude(s.hit.el)) {
        this.suggestions.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** A field's value changed: re-check it (values produce no mutation record). */
  recheckField(el: Element) {
    if (!this.active() || !el.matches(FIELD_SELECTOR)) return;
    const hits = detectInputs(el, this.options());
    if (hits.length) this.addHits(hits, this.gen, null, null, null);
  }
}

/** Viewport rect of the matched characters of a text hit. */
export function matchRect(hit: Hit): ViewRect | null {
  if (!hit.block || hit.start === undefined || hit.end === undefined) return null;
  const range = document.createRange();
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rangesFor(hit.block, hit.start, hit.end)) {
    if (!r.node.isConnected) continue;
    range.setStart(r.node, r.start);
    range.setEnd(r.node, r.end);
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width <= 0 || cr.height <= 0) continue;
      x1 = Math.min(x1, cr.left);
      y1 = Math.min(y1, cr.top);
      x2 = Math.max(x2, cr.right);
      y2 = Math.max(y2, cr.bottom);
    }
  }
  if (!isFinite(x1)) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
