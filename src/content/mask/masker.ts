import type { MaskMode } from '@/shared/types';
import type { MutationHub } from './guard';
import { MASK_ATTR, installMaskSheet } from './sheet';
import { bullets, collectTextNodes, type TextRange } from './text-mask';
import { restoreAttrs, scrubAttrs, SCRUB_ATTRS, type AttrBackup } from './attr-mask';

/**
 * One Text node the rect masker cut into pieces. `original` is the page's own
 * node object (it keeps the text before the first covered character); `parts`
 * are the nodes we created, in document order, alternating covered / not.
 */
interface SplitRecord {
  original: Text;
  head: string;
  parts: Text[];
  originalData: string;
}

interface MaskRecord {
  id: string;
  root: Element;
  mode: MaskMode;
  /** Rect stickers mask a subset of text nodes rather than the whole root. */
  subset: boolean;
  texts: Map<Text, string>;
  splits: SplitRecord[];
  /** The page rewrote a split node: the mask was undone and must be recomputed. */
  stale: boolean;
  attrs: AttrBackup;
  prev: { ariaHidden: string | null; tabIndex: string | null; maskAttr: string | null };
  peeking: boolean;
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const MEDIA_TAGS = new Set(['IMG', 'CANVAS', 'VIDEO', 'PICTURE', 'OBJECT', 'EMBED']);

export function defaultMaskMode(el: Element): MaskMode {
  if (INPUT_TAGS.has(el.tagName) || el.closest('[contenteditable]:not([contenteditable="false"])')) return 'input';
  if (MEDIA_TAGS.has(el.tagName) || (el.tagName === 'svg' && !/\S/.test(el.textContent ?? ''))) return 'visual-only';
  return 'text';
}

/**
 * Rewrites covered DOM so page readers get bullets, and keeps it that way when
 * frameworks re-render. Originals live only in this module's memory.
 */
export class Masker {
  private records = new Map<string, MaskRecord>();
  private byRoot = new Map<Element, MaskRecord>();
  private expectedText = new WeakMap<Text, string>();
  /** Every node taking part in a split (the original and the parts we created). */
  private splitOwner = new WeakMap<Text, { rec: MaskRecord; split: SplitRecord }>();
  private expectedAttr = new WeakMap<Element, Map<string, string | null>>();
  /**
   * Nodes this masker inserted or removed during the current task. Mutation
   * records naming only these are our own bookkeeping and must never mark a
   * record stale, otherwise every split/merge schedules another re-mask and the
   * two keep feeding each other. Cleared in a microtask, which runs after the
   * MutationObserver callback that the same DOM write queued.
   */
  private ownNodes = new Set<Node>();
  private ownScheduled = false;
  private disposeHub: (() => void) | null = null;
  private disposers: Array<() => void> = [];

  constructor(private hub: MutationHub) {}

  start() {
    installMaskSheet();
    this.disposeHub = this.hub.addListener((records) => this.onMutations(records));
    const onCopy = (e: Event) => {
      const t = e.target as Node | null;
      if (t && this.isMaskedNode(t)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (!t || !this.isMaskedNode(t)) return;
      const rec = this.recordFor(t);
      if (rec && rec.mode === 'input' && !rec.peeking) (t as HTMLElement).blur?.();
    };
    for (const type of ['copy', 'cut', 'dragstart']) {
      window.addEventListener(type, onCopy, true);
      this.disposers.push(() => window.removeEventListener(type, onCopy, true));
    }
    window.addEventListener('focusin', onFocus, true);
    this.disposers.push(() => window.removeEventListener('focusin', onFocus, true));
  }

  stop() {
    for (const id of Array.from(this.records.keys())) this.restore(id);
    this.disposeHub?.();
    this.disposeHub = null;
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Mask a whole element. */
  apply(id: string, root: Element, mode: MaskMode) {
    if (this.records.has(id)) this.restore(id);
    const rec = this.newRecord(id, root, mode, false);
    this.records.set(id, rec);
    this.byRoot.set(root, rec);
    this.applyRecord(rec);
  }

  /**
   * Mask only the covered character ranges (rect stickers). Each range is cut
   * out of its Text node so the surrounding sentence stays readable on screen
   * and in innerText.
   *
   * Text nodes that already take part in ANOTHER record's split are skipped.
   * Two records cutting the same node cannot both undo their split safely: the
   * loser used to write its whole sentence back on top of the other record's
   * surviving pieces, duplicating the text on every pass. The cost of skipping
   * is that a rect drawn over text another rect already split leaves that node
   * alone until the first sticker goes away; an intact page DOM wins.
   */
  applyTextRanges(id: string, root: Element, ranges: TextRange[]) {
    if (this.records.has(id)) this.restore(id);
    const before = root.textContent ?? '';
    const rec = this.newRecord(id, root, 'text', true);
    this.records.set(id, rec);
    const byNode = new Map<Text, { start: number; end: number }[]>();
    for (const r of ranges) {
      const list = byNode.get(r.node);
      if (list) list.push({ start: r.start, end: r.end });
      else byNode.set(r.node, [{ start: r.start, end: r.end }]);
    }
    for (const [node, list] of byNode) {
      if (!node.isConnected) continue;
      const owner = this.splitOwner.get(node);
      if (owner && owner.rec !== rec) continue; // another sticker already split this node
      const originalData = node.data;
      const clean: { start: number; end: number }[] = [];
      for (const r of list.sort((a, b) => a.start - b.start)) {
        const start = Math.max(0, Math.min(r.start, originalData.length));
        const end = Math.max(start, Math.min(r.end, originalData.length));
        if (end <= start) continue;
        const last = clean[clean.length - 1];
        if (last && start <= last.end) last.end = Math.max(last.end, end);
        else clean.push({ start, end });
      }
      if (clean.length === 0) continue;
      const split: SplitRecord = { original: node, head: originalData.slice(0, clean[0].start), parts: [], originalData };
      const middles: Text[] = [];
      // Back to front, so the offsets of the earlier ranges stay valid.
      for (let i = clean.length - 1; i >= 0; i--) {
        const tail = node.splitText(clean[i].end);
        const middle = node.splitText(clean[i].start);
        this.noteOwn(tail);
        this.noteOwn(middle);
        split.parts.unshift(middle, tail);
        middles.unshift(middle);
      }
      // splitText rewrote the original data; that is our own write, not the page's.
      this.expectedText.set(node, node.data);
      rec.splits.push(split);
      this.splitOwner.set(node, { rec, split });
      for (const p of split.parts) this.splitOwner.set(p, { rec, split });
      for (const m of middles) this.maskText(rec, m);
    }
    if (import.meta.env.DEV) {
      const after = root.textContent ?? '';
      console.assert(after.length === before.length, '[aibs] masking changed the page text length', {
        id,
        before: before.length,
        after: after.length,
      });
    }
  }

  /** True when the page rewrote a split node and the rect must be rescanned. */
  isStale(id: string): boolean {
    return this.records.get(id)?.stale === true;
  }

  restore(id: string) {
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    if (this.byRoot.get(rec.root) === rec) this.byRoot.delete(rec.root);
    for (const split of rec.splits.slice()) this.unsplit(rec, split, false, false);
    for (const [t, original] of rec.texts) {
      if (t.isConnected) this.writeText(t, original);
    }
    rec.texts.clear();
    restoreAttrs(rec.attrs, (el, a, v) => this.writeAttr(el, a, v));
    if (!rec.subset && rec.root.isConnected) {
      this.writeAttr(rec.root, 'aria-hidden', rec.prev.ariaHidden);
      this.writeAttr(rec.root, 'tabindex', rec.prev.tabIndex);
      this.writeAttr(rec.root, MASK_ATTR, rec.prev.maskAttr);
    }
  }

  /** Original text of a masked sticker, for the peek card. */
  originals(id: string): string {
    const rec = this.records.get(id);
    if (!rec) return '';
    if (rec.mode === 'input') {
      const el = rec.root as HTMLInputElement;
      return el.value ?? '';
    }
    const parts: string[] = [];
    for (const [t, original] of rec.texts) if (t.isConnected) parts.push(original);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /** Input mode: lift the CSS mask while the user peeks so they can read/type. */
  setPeek(id: string, on: boolean) {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.peeking = on;
    if (rec.mode === 'input') this.writeAttr(rec.root, MASK_ATTR, on ? 'input-peek' : 'input');
  }

  isMaskedNode(node: Node): boolean {
    return !!this.recordFor(node);
  }

  private recordFor(node: Node): MaskRecord | undefined {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const rec of this.records.values()) if (rec.texts.has(node as Text)) return rec;
      const owner = this.splitOwner.get(node as Text);
      if (owner) return owner.rec;
      node = node.parentNode ?? node;
    }
    let el: Element | null = node as Element;
    while (el) {
      const rec = this.byRoot.get(el);
      if (rec) return rec;
      el = el.parentElement;
    }
    return undefined;
  }

  private newRecord(id: string, root: Element, mode: MaskMode, subset: boolean): MaskRecord {
    return {
      id,
      root,
      mode,
      subset,
      texts: new Map(),
      splits: [],
      stale: false,
      attrs: new Map(),
      prev: {
        ariaHidden: root.getAttribute('aria-hidden'),
        tabIndex: root.getAttribute('tabindex'),
        maskAttr: root.getAttribute(MASK_ATTR),
      },
      peeking: false,
    };
  }

  private applyRecord(rec: MaskRecord) {
    const { root, mode } = rec;
    if (mode === 'text') {
      for (const t of collectTextNodes(root)) this.maskText(rec, t);
      scrubAttrs(rec.attrs, root, (el, a, v) => this.writeAttr(el, a, v));
      this.writeAttr(root, MASK_ATTR, 'text');
    } else if (mode === 'input') {
      scrubAttrs(rec.attrs, root, (el, a, v) => this.writeAttr(el, a, v));
      this.writeAttr(root, MASK_ATTR, rec.peeking ? 'input-peek' : 'input');
      this.writeAttr(root, 'tabindex', '-1');
      if (document.activeElement === root || root.contains(document.activeElement)) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    } else {
      scrubAttrs(rec.attrs, root, (el, a, v) => this.writeAttr(el, a, v));
      this.writeAttr(root, MASK_ATTR, 'visual');
    }
    this.writeAttr(root, 'aria-hidden', 'true');
  }

  /**
   * Undo one split without ever duplicating text.
   *
   * The fast path needs the split to still be intact: the parts are exactly the
   * consecutive siblings after `original`, `original` still holds the head, and
   * head + the parts' own texts reconstruct `originalData`. Only then may the
   * parts be dropped and `originalData` written back. That write is what used to
   * duplicate a whole sentence whenever something else had meanwhile cut one of
   * the parts up, moved it, or split it again.
   *
   * Otherwise every surviving masked part gets its OWN original text back and
   * `original` is left holding the head, so the concatenation across the (still
   * split) nodes is exactly the page's text again.
   *
   * `keepOriginalData` means the page itself just rewrote `original` with the
   * whole sentence: the parts are then stale duplicates and are only removed.
   */
  private unsplit(rec: MaskRecord, split: SplitRecord, keepOriginalData: boolean, stale: boolean) {
    const i = rec.splits.indexOf(split);
    if (i >= 0) rec.splits.splice(i, 1);
    const parts = split.parts;
    split.parts = [];
    const parent = split.original.parentNode;

    let intact = !!parent && split.original.isConnected && split.original.data === split.head;
    if (intact) {
      let cursor: Node | null = split.original.nextSibling;
      let text = split.head;
      for (const p of parts) {
        if (cursor !== p) {
          intact = false;
          break;
        }
        text += rec.texts.get(p) ?? p.data;
        cursor = p.nextSibling;
      }
      if (intact && text !== split.originalData) intact = false;
    }

    if (keepOriginalData) {
      for (const p of parts) {
        this.forget(rec, p);
        if (p.parentNode && p.parentNode === parent) this.removeNode(p);
      }
    } else if (intact) {
      for (const p of parts) {
        this.forget(rec, p);
        this.removeNode(p);
      }
      this.writeText(split.original, split.originalData);
    } else {
      for (const p of parts) {
        const own = rec.texts.get(p);
        if (own !== undefined && p.isConnected && p.data !== own) this.writeText(p, own);
        this.forget(rec, p);
      }
    }
    this.splitOwner.delete(split.original);
    if (stale) rec.stale = true;
  }

  /** Drop a node from this record's bookkeeping, without touching the DOM. */
  private forget(rec: MaskRecord, t: Text) {
    rec.texts.delete(t);
    const owner = this.splitOwner.get(t);
    if (owner && owner.rec === rec) this.splitOwner.delete(t);
  }

  private removeNode(t: Text) {
    this.noteOwn(t);
    t.remove();
  }

  private noteOwn(n: Node) {
    this.ownNodes.add(n);
    if (this.ownScheduled) return;
    this.ownScheduled = true;
    queueMicrotask(() => {
      this.ownScheduled = false;
      this.ownNodes.clear();
    });
  }

  private maskText(rec: MaskRecord, t: Text) {
    if (!rec.texts.has(t)) rec.texts.set(t, t.data);
    const masked = bullets(t.data);
    if (t.data !== masked) this.writeText(t, masked);
    else this.expectedText.set(t, masked);
  }

  private writeText(t: Text, value: string) {
    this.expectedText.set(t, value);
    t.data = value;
  }

  private writeAttr(el: Element, attr: string, value: string | null) {
    let m = this.expectedAttr.get(el);
    if (!m) {
      m = new Map();
      this.expectedAttr.set(el, m);
    }
    m.set(attr, value);
    if (value === null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  }

  /**
   * Runs at the microtask checkpoint, before the next paint. Framework writes
   * to masked nodes are captured as the new original and re-masked here. Our
   * own splits and merges are filtered out first, so only genuinely foreign
   * writes can mark a record stale.
   */
  private onMutations(records: MutationRecord[]) {
    if (this.records.size === 0) return;
    for (const r of records) {
      if (r.type === 'characterData') {
        const t = r.target as Text;
        // A framework rewrote a node we cut apart (typically the original,
        // handed back the whole sentence). Undo the split and let the rect be
        // rescanned rather than fighting over half a node.
        const owner = this.splitOwner.get(t);
        if (owner) {
          const ours = t === owner.split.original ? t.data === owner.split.head : this.expectedText.get(t) === t.data;
          if (ours) continue;
          this.unsplit(owner.rec, owner.split, t === owner.split.original, true);
          continue;
        }
        const rec = this.recordFor(t);
        if (!rec || rec.mode !== 'text') continue;
        if (this.expectedText.get(t) === t.data) continue; // our own write
        rec.texts.set(t, t.data);
        this.writeText(t, bullets(t.data));
      } else if (r.type === 'childList') {
        const removed = Array.from(r.removedNodes).filter((n) => !this.ownNodes.has(n));
        const added = Array.from(r.addedNodes).filter((n) => !this.ownNodes.has(n));
        if (removed.length === 0 && added.length === 0) continue; // our own split or merge
        for (const n of removed) {
          if (n.nodeType !== Node.TEXT_NODE) continue;
          const owner = this.splitOwner.get(n as Text);
          if (owner) this.unsplit(owner.rec, owner.split, false, true);
        }
        const rec = this.recordFor(r.target);
        if (!rec || rec.mode !== 'text' || rec.subset) continue;
        for (const n of added) {
          for (const t of collectTextNodes(n)) this.maskText(rec, t);
          if (n.nodeType === Node.ELEMENT_NODE) scrubAttrs(rec.attrs, n as Element, (el, a, v) => this.writeAttr(el, a, v));
        }
        for (const n of removed) {
          for (const t of collectTextNodes(n)) rec.texts.delete(t);
        }
      } else if (r.type === 'attributes' && r.attributeName) {
        const el = r.target as Element;
        const rec = this.recordFor(el);
        if (!rec) continue;
        const attr = r.attributeName;
        const expected = this.expectedAttr.get(el)?.get(attr);
        const current = el.getAttribute(attr);
        if (expected !== undefined && expected === current) continue; // ours
        if (attr === 'aria-hidden' && el === rec.root && !rec.subset && current !== 'true') {
          this.writeAttr(el, 'aria-hidden', 'true');
        } else if (attr === MASK_ATTR && el === rec.root && !rec.subset) {
          const want = rec.mode === 'text' ? 'text' : rec.mode === 'input' ? (rec.peeking ? 'input-peek' : 'input') : 'visual';
          if (current !== want) this.writeAttr(el, MASK_ATTR, want);
        } else if (SCRUB_ATTRS.includes(attr) && current) {
          let m = rec.attrs.get(el);
          if (!m) {
            m = new Map();
            rec.attrs.set(el, m);
          }
          m.set(attr, current);
          this.writeAttr(el, attr, '');
        }
      }
    }
  }
}
