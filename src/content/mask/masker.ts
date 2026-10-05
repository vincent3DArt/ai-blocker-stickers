import type { MaskMode } from '@/shared/types';
import type { MutationHub } from './guard';
import { MASK_ATTR, ensureMaskSheet, installMaskSheet } from './sheet';
import { bullets, collectTextNodes, type TextRange } from './text-mask';
import { StrictInputs, readValue, writeValue, type StrictOptions } from './strict-input';
import {
  leaks,
  remember,
  restoreAttrs,
  scrubAttrs,
  scrubTokenAttrs,
  SCRUB_ATTRS,
  tokenScrubbable,
  tokensOf,
  type AttrBackup,
  type Tokens,
} from './attr-mask';

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
  prev: { ariaHidden: string | null; tabIndex: string | null; maskAttr: string | null; style: string | null };
  /** Page's own inline value of every style property we forced on the root. */
  styleBackup: Map<string, { value: string; priority: string }>;
  /** Size pins for an image whose source we swapped out (keeps its box). */
  pins: Array<[string, string]>;
  /**
   * What the root showed before masking (text, value or image source), in
   * memory only, like the originals. A re-rendered copy must match it to
   * inherit the mask: the same slot alone may hold a different record.
   */
  signature: string;
  peeking: boolean;
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const MEDIA_TAGS = new Set(['IMG', 'CANVAS', 'VIDEO', 'PICTURE', 'OBJECT', 'EMBED']);
/** Input types whose `value` content attribute is only the default (`value` mode). */
const VALUE_MODE_TYPES = new Set([
  'text',
  'search',
  'tel',
  'url',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'color',
  'range',
]);
/** 1x1 transparent GIF standing in for a covered image's real source. */
const PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Parent across a shadow boundary: a shadow root's top-level nodes belong to its host. */
function up(n: Node): Element | null {
  const p = n.parentNode;
  if (!p) return null;
  if (p.nodeType === Node.ELEMENT_NODE) return p as Element;
  return (p as ShadowRoot).host ?? null;
}

function signatureOf(el: Element, mode: MaskMode): string {
  if (mode === 'input') return (el as HTMLInputElement).value ?? el.textContent ?? '';
  if (mode === 'visual-only') {
    const srcs = mediaSources(el);
    return srcs.length ? srcs.map((s) => `${s.getAttribute('src')}|${s.getAttribute('srcset')}`).join(';') : el.outerHTML;
  }
  return collectTextNodes(el)
    .map((t) => t.data)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValueModeInput(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && VALUE_MODE_TYPES.has(el.type);
}

/** The IMG itself plus the <source>s of its <picture>: all of them name the pixels. */
function mediaSources(root: Element): Element[] {
  const out: Element[] = [];
  const pic = root.tagName === 'PICTURE' ? root : root.tagName === 'IMG' && root.parentElement?.tagName === 'PICTURE' ? root.parentElement : null;
  if (pic) out.push(...Array.from(pic.querySelectorAll('source, img')));
  else if (root.tagName === 'IMG') out.push(root);
  return out;
}

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
  /** Records the page disturbed during the current mutation callback. */
  private pendingStale = new Set<string>();
  /** Strict input masking: live `.value` swapped for bullets (see strict-input.ts). */
  private strict: StrictInputs;
  private strictOn = false;

  /**
   * The page replaced a masked root with a structurally identical element (a
   * framework re-rendering the parent). The mask has already moved to `el`;
   * the owner updates its anchor. For rect records only the container moved:
   * the owner must rescan.
   */
  onRebind: ((id: string, el: Element) => void) | null = null;
  /**
   * The page rewrote text a rect record had cut apart; the mask is gone until
   * the owner rescans. Called synchronously, inside the mutation callback, so
   * the rescan lands before any other task can read the raw text.
   */
  onStale: ((id: string) => void) | null = null;

  constructor(
    private hub: MutationHub,
    strictOptions: StrictOptions = {},
  ) {
    this.strict = new StrictInputs((el, a, v) => this.writeAttr(el, a, v), strictOptions);
  }

  start() {
    installMaskSheet();
    this.strict.install();
    this.disposeHub = this.hub.addListener((records) => {
      ensureMaskSheet();
      // A framework that re-renders a controlled input writes `.value` without
      // a mutation record, but usually alongside other DOM changes.
      this.strict.syncAll();
      this.onMutations(records);
    });
    // Watchdog for tampering that produces no mutation record (clearing
    // `document.adoptedStyleSheets`) or that detaches the observer itself
    // (replacing `<html>`). A plain interval: it keeps running in a hidden tab,
    // unlike the positioner's slow tick.
    const watchdog = window.setInterval(() => {
      ensureMaskSheet();
      this.strict.syncAll();
      if (this.hub.ensureRoot()) {
        for (const rec of this.records.values()) if (rec.root.isConnected) this.enforceStyle(rec);
      }
    }, 250);
    this.disposers.push(() => clearInterval(watchdog));

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
    // A form reset goes back to the `value` attribute / textarea text, which we
    // blanked. Hand the page its defaults back for the reset itself, then blank
    // them again once the reset has run (it runs after this event, in the same
    // task, so a timer is the first safe moment).
    const onReset = (e: Event) => {
      const form = e.target as Element | null;
      if (!form) return;
      const recs = Array.from(this.records.values()).filter((r) => r.mode === 'input' && form.contains(r.root));
      for (const r of recs) this.restoreDefaults(r);
      if (recs.length)
        setTimeout(() => {
          for (const r of recs) if (this.records.get(r.id) === r && r.root.isConnected) this.scrubDefaults(r);
          // The reset put the (real) default back into the live value.
          this.strict.syncAll();
        }, 0);
    };
    window.addEventListener('reset', onReset, true);
    this.disposers.push(() => window.removeEventListener('reset', onReset, true));
  }

  stop() {
    for (const id of Array.from(this.records.keys())) this.restore(id);
    this.disposeHub?.();
    this.disposeHub = null;
    this.strict.dispose();
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  /**
   * Turn strict input masking on or off for every covered text field, now and
   * for fields masked later.
   */
  setStrict(on: boolean) {
    if (this.strictOn === on) return;
    this.strictOn = on;
    for (const rec of this.records.values()) {
      if (rec.mode !== 'input' || rec.subset) continue;
      if (on) this.engageStrict(rec);
      else this.strict.release(rec.root);
    }
  }

  get isStrict(): boolean {
    return this.strictOn;
  }

  /** Covered fields whose live value currently holds bullets. */
  strictCount(): number {
    return this.strict.count;
  }

  private engageStrict(rec: MaskRecord) {
    if (!this.strictOn || rec.mode !== 'input' || rec.subset) return;
    if (this.strict.engage(rec.root) && rec.peeking) this.strict.lift(rec.root, 'peek');
  }

  /** The field's real value: remembered by strict mode, else the live one. */
  private liveValue(rec: MaskRecord): string {
    return this.strict.real(rec.root) ?? (rec.root as HTMLInputElement).value ?? '';
  }

  /**
   * True when this id currently holds a mask. A record only exists while it
   * actually rewrote something: `applyTextRanges` drops a record that produced
   * no splits, so callers can use this to decide whether to keep retrying.
   */
  has(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    return rec.subset ? rec.splits.length > 0 : true;
  }

  /** Mask a whole element. */
  apply(id: string, root: Element, mode: MaskMode) {
    if (this.records.has(id)) this.restore(id);
    const rec = this.newRecord(id, root, mode, false);
    this.records.set(id, rec);
    this.byRoot.set(root, rec);
    this.watchRoot(root);
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
    if (rec.splits.length === 0) {
      // Nothing was actually masked: every covered node was already cut up by
      // another sticker, or the ranges collapsed. Leaving the record behind
      // would make `has(id)` report a mask that does not exist, and the caller's
      // "already masked, skip the scan" guard would then never rescan — the
      // sticker would sit over readable text forever. Drop it so the next tick
      // tries again.
      this.records.delete(id);
      return;
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
    if (rec.mode === 'input' && !rec.subset) this.strict.release(rec.root);
    for (const split of rec.splits.slice()) this.unsplit(rec, split, false, false);
    for (const [t, original] of rec.texts) {
      if (t.isConnected) this.writeText(t, original);
    }
    rec.texts.clear();
    restoreAttrs(rec.attrs, (el, a, v) => this.writeAttr(el, a, v));
    if (!rec.subset && rec.root.isConnected) {
      this.restoreStyle(rec);
      this.writeAttr(rec.root, 'aria-hidden', rec.prev.ariaHidden);
      this.writeAttr(rec.root, 'tabindex', rec.prev.tabIndex);
      this.writeAttr(rec.root, MASK_ATTR, rec.prev.maskAttr);
    }
  }

  /** Original text of a masked sticker, for the peek card. */
  originals(id: string): string {
    const rec = this.records.get(id);
    if (!rec) return '';
    if (rec.mode === 'input') return this.liveValue(rec);
    const parts: string[] = [];
    for (const [t, original] of rec.texts) if (t.isConnected) parts.push(original);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /** Input mode: lift the CSS mask while the user peeks so they can read/type. */
  setPeek(id: string, on: boolean) {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.peeking = on;
    if (rec.mode === 'input') {
      this.writeAttr(rec.root, MASK_ATTR, on ? 'input-peek' : 'input');
      this.enforceStyle(rec);
      if (this.strict.has(rec.root)) {
        if (on) {
          this.strict.lift(rec.root, 'peek');
        } else {
          // Whatever the user typed during the peek is the new real value;
          // the field must not keep taking keystrokes into bullets.
          this.strict.settle(rec.root, 'peek');
          const active = document.activeElement;
          if (active === rec.root) (active as HTMLElement).blur?.();
        }
      }
    }
  }

  /**
   * The page's own text of a Text node we masked (whole-element or rect
   * split part), or undefined for a node we did not touch. Lets readers that
   * must see the page's text (the in-page viewer identity) undo our bullets.
   */
  originalText(t: Text): string | undefined {
    for (const rec of this.records.values()) {
      const o = rec.texts.get(t);
      if (o !== undefined) return o;
    }
    return undefined;
  }

  isMaskedNode(node: Node): boolean {
    return !!this.recordFor(node);
  }

  /** The element a whole-element mask is applied to (undefined for rect records and unknown ids). */
  rootOf(id: string): Element | undefined {
    const rec = this.records.get(id);
    return rec && !rec.subset ? rec.root : undefined;
  }

  /** True when `el` is the root of a whole-element mask: the scanner skips its subtree. */
  isMaskRoot(el: Element): boolean {
    const rec = this.byRoot.get(el);
    return !!rec && !rec.subset;
  }

  private recordFor(node: Node): MaskRecord | undefined {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const rec of this.records.values()) if (rec.texts.has(node as Text)) return rec;
      const owner = this.splitOwner.get(node as Text);
      if (owner) return owner.rec;
    }
    // Walk up across shadow boundaries: text inside a shadow tree under a
    // masked host belongs to the host's record.
    let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : up(node) ?? (node as ShadowRoot).host ?? null;
    while (el) {
      const rec = this.byRoot.get(el);
      if (rec) return rec;
      el = up(el);
    }
    return undefined;
  }

  /** Masked content inside a shadow tree needs that tree observed too. */
  private watchRoot(n: Node) {
    const r = n.getRootNode();
    if (r !== n && r.nodeType === Node.DOCUMENT_FRAGMENT_NODE) this.hub.observe(r);
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
        style: root.getAttribute('style'),
      },
      styleBackup: new Map(),
      pins: [],
      signature: signatureOf(root, mode),
      peeking: false,
    };
  }

  private applyRecord(rec: MaskRecord) {
    const { root, mode } = rec;
    const write = (el: Element, a: string, v: string | null) => this.writeAttr(el, a, v);
    if (mode === 'text') {
      for (const t of collectTextNodes(root)) this.maskText(rec, t);
      scrubAttrs(rec.attrs, root, write);
      scrubTokenAttrs(rec.attrs, root, this.tokens(rec), write);
      this.writeAttr(root, MASK_ATTR, 'text');
    } else if (mode === 'input') {
      scrubAttrs(rec.attrs, root, write);
      this.scrubDefaults(rec);
      scrubTokenAttrs(rec.attrs, root, this.tokens(rec), write);
      this.engageStrict(rec);
      this.writeAttr(root, MASK_ATTR, rec.peeking ? 'input-peek' : 'input');
      this.writeAttr(root, 'tabindex', '-1');
      if (document.activeElement === root || root.contains(document.activeElement)) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    } else {
      scrubAttrs(rec.attrs, root, write);
      this.scrubMedia(rec);
      this.writeAttr(root, MASK_ATTR, 'visual');
    }
    this.writeAttr(root, 'aria-hidden', 'true');
    this.enforceStyle(rec);
  }

  /** What an attribute would have to repeat to leak this record's content. */
  private tokens(rec: MaskRecord): Tokens {
    if (rec.mode === 'input') return tokensOf([this.liveValue(rec), ...rec.texts.values()]);
    return tokensOf(rec.texts.values());
  }

  /**
   * An input's `value` attribute (and a textarea's text) is its DEFAULT value,
   * and it is serialised into innerHTML/outerHTML and read by getAttribute.
   * Assigning `.value` first flips the control's dirty flag, so the live value
   * (what the form submits) stops following the default; only then is the
   * default blanked. The live `.value` itself is the documented residual,
   * unless strict input masking is on (see strict-input.ts).
   */
  private scrubDefaults(rec: MaskRecord) {
    const el = rec.root;
    if (isValueModeInput(el)) {
      const v = el.getAttribute('value');
      if (!v) return;
      writeValue(el, readValue(el));
      remember(rec.attrs, el, 'value');
      this.writeAttr(el, 'value', '');
    } else if (el instanceof HTMLTextAreaElement) {
      const kids = collectTextNodes(el);
      if (kids.length === 0) return;
      writeValue(el, readValue(el));
      for (const t of kids) this.maskText(rec, t);
    }
  }

  private restoreDefaults(rec: MaskRecord) {
    const el = rec.root;
    if (isValueModeInput(el)) {
      const orig = rec.attrs.get(el)?.get('value');
      if (orig != null) this.writeAttr(el, 'value', orig);
    } else if (el instanceof HTMLTextAreaElement) {
      for (const [t, original] of rec.texts) if (t.isConnected) this.writeText(t, original);
    }
  }

  /**
   * A covered image's source names its pixels: anything that can read the
   * DOM can fetch it again (or, for a data: URL, simply has it). Swap in a
   * transparent placeholder while covered, pinning the box so nothing moves.
   */
  private scrubMedia(rec: MaskRecord) {
    const sources = mediaSources(rec.root);
    if (sources.length === 0) return;
    const img = rec.root as HTMLImageElement;
    if (img.tagName === 'IMG' && rec.pins.length === 0 && !img.hasAttribute('width') && !img.hasAttribute('height')) {
      const w = img.offsetWidth;
      const h = img.offsetHeight;
      if (w > 0 && h > 0) rec.pins = [
        ['width', `${w}px`],
        ['height', `${h}px`],
      ];
    }
    for (const el of sources) this.scrubMediaAttrs(rec, el);
  }

  private scrubMediaAttrs(rec: MaskRecord, el: Element) {
    for (const a of ['src', 'srcset']) {
      const v = el.getAttribute(a);
      const want = a === 'src' && el.tagName === 'IMG' ? PLACEHOLDER_SRC : null;
      if (v === null || v === want) continue;
      remember(rec.attrs, el, a);
      this.writeAttr(el, a, want);
    }
  }

  /**
   * Style properties the mask relies on, forced INLINE with !important. The
   * adopted sheet alone loses to an inline `!important` declaration, to a
   * page rule with higher specificity, and to a script clearing
   * `document.adoptedStyleSheets`; an inline !important declaration loses to
   * none of them, and the guard re-applies it whenever the page edits `style`.
   */
  private wantedStyles(rec: MaskRecord): Array<[string, string]> {
    if (rec.subset) return [];
    const out: Array<[string, string]> = [...rec.pins];
    if (rec.mode === 'input' && !rec.peeking) out.push(['-webkit-text-security', 'disc']);
    if (rec.mode === 'visual-only') out.push(['visibility', 'hidden']);
    return out;
  }

  private enforceStyle(rec: MaskRecord) {
    const style = (rec.root as HTMLElement).style as CSSStyleDeclaration | undefined;
    if (!style) return;
    const wanted = this.wantedStyles(rec);
    const names = new Set(wanted.map(([p]) => p));
    for (const [p, v] of wanted) {
      if (!rec.styleBackup.has(p)) rec.styleBackup.set(p, { value: style.getPropertyValue(p), priority: style.getPropertyPriority(p) });
      if (style.getPropertyValue(p) !== v || style.getPropertyPriority(p) !== 'important') style.setProperty(p, v, 'important');
    }
    for (const [p, b] of Array.from(rec.styleBackup)) {
      if (names.has(p)) continue;
      if (b.value) style.setProperty(p, b.value, b.priority);
      else style.removeProperty(p);
      rec.styleBackup.delete(p);
    }
    this.noteStyle(rec.root);
  }

  private restoreStyle(rec: MaskRecord) {
    const style = (rec.root as HTMLElement).style as CSSStyleDeclaration | undefined;
    if (!style || rec.styleBackup.size === 0) return;
    for (const [p, b] of rec.styleBackup) {
      if (b.value) style.setProperty(p, b.value, b.priority);
      else style.removeProperty(p);
    }
    rec.styleBackup.clear();
    if (rec.prev.style === null && rec.root.getAttribute('style') === '') rec.root.removeAttribute('style');
    this.noteStyle(rec.root);
  }

  /** Record the style attribute as ours, so the guard does not treat it as a page edit. */
  private noteStyle(el: Element) {
    let m = this.expectedAttr.get(el);
    if (!m) {
      m = new Map();
      this.expectedAttr.set(el, m);
    }
    m.set('style', el.getAttribute('style'));
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
    if (stale) {
      rec.stale = true;
      this.pendingStale.add(rec.id);
    }
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
    this.watchRoot(t);
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
    const removedEls: Array<{ r: MutationRecord; n: Element }> = [];
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
          if (n.nodeType === Node.ELEMENT_NODE) {
            removedEls.push({ r, n: n as Element });
            // Split nodes inside a removed element are gone with it. Every
            // text node counts: a split's original is often left empty.
            const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
            const seen = new Set<SplitRecord>();
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
              const owner = this.splitOwner.get(t as Text);
              if (!owner || seen.has(owner.split)) continue;
              seen.add(owner.split);
              this.unsplit(owner.rec, owner.split, false, true);
            }
            continue;
          }
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
        const backup = () => {
          let m = rec.attrs.get(el);
          if (!m) {
            m = new Map();
            rec.attrs.set(el, m);
          }
          m.set(attr, current);
        };
        if (attr === 'aria-hidden' && el === rec.root && !rec.subset && current !== 'true') {
          this.writeAttr(el, 'aria-hidden', 'true');
        } else if (attr === MASK_ATTR && el === rec.root && !rec.subset) {
          const want = rec.mode === 'text' ? 'text' : rec.mode === 'input' ? (rec.peeking ? 'input-peek' : 'input') : 'visual';
          if (current !== want) this.writeAttr(el, MASK_ATTR, want);
        } else if (attr === 'style' && el === rec.root) {
          this.enforceStyle(rec);
        } else if (attr === 'value' && el === rec.root && rec.mode === 'input' && isValueModeInput(el)) {
          // A framework syncing the default (React does): take it as the new default, blank again.
          if (current) {
            backup();
            writeValue(el, readValue(el));
            this.writeAttr(el, 'value', '');
          }
        } else if ((attr === 'src' || attr === 'srcset') && rec.mode === 'visual-only' && mediaSources(rec.root).includes(el)) {
          if (current !== null && !(attr === 'src' && current === PLACEHOLDER_SRC)) {
            backup();
            this.scrubMediaAttrs(rec, el);
          }
        } else if (SCRUB_ATTRS.includes(attr) && current) {
          backup();
          this.writeAttr(el, attr, '');
        } else if (current && tokenScrubbable(el, attr) && leaks(current, this.tokens(rec))) {
          backup();
          this.writeAttr(el, attr, '');
        }
      }
    }
    this.rebindReplaced(removedEls);
    this.flushStale();
  }

  /**
   * A framework re-rendering the parent replaces a masked root with a fresh,
   * raw copy. Waiting for the resolver (a debounced batch, then an async
   * re-resolve) leaves that copy readable for tens of milliseconds, which is
   * plenty for an agent polling the page. When the replacement sits in the
   * same slot of the same mutation record with the same tag (and id) at every
   * step down to the root, it is the same thing re-rendered: move the mask now,
   * in this callback, before any other task runs.
   */
  private rebindReplaced(removedEls: Array<{ r: MutationRecord; n: Element }>) {
    if (removedEls.length === 0) return;
    const done = new Set<string>();
    for (const { r, n } of removedEls) {
      for (const rec of Array.from(this.records.values())) {
        if (done.has(rec.id) || rec.root.isConnected) continue;
        if (n !== rec.root && !n.contains(rec.root)) continue;
        const twin = this.findTwin(rec, n, r);
        if (!twin || this.byRoot.has(twin)) continue;
        done.add(rec.id);
        if (rec.subset) {
          this.pendingStale.delete(rec.id);
          this.restore(rec.id);
        } else {
          this.apply(rec.id, twin, rec.mode);
        }
        try {
          this.onRebind?.(rec.id, twin);
        } catch (e) {
          console.error('[aibs] rebind failed', e);
        }
      }
    }
  }

  /**
   * The page's fresh copy of `rec.root` among the nodes `r` added in place of
   * `removed`: same tag (and id) at every step of the path down from
   * `removed`, AND the same content as the root had before masking. The slot
   * is tried first, then every other added sibling; a copy is accepted only
   * when exactly one candidate matches, so a shifted or deleted row never
   * hands its mask to a neighbour.
   */
  private findTwin(rec: MaskRecord, removed: Element, r: MutationRecord): Element | null {
    const same = (a: Node | null | undefined, b: Element): a is Element =>
      !!a && a.nodeType === Node.ELEMENT_NODE && (a as Element).tagName === b.tagName && (a as Element).id === b.id;
    const path: number[] = [];
    const tags: Element[] = [];
    for (let cur: Element = rec.root; cur !== removed; ) {
      const p = cur.parentElement;
      if (!p) return null;
      path.unshift(Array.prototype.indexOf.call(p.children, cur) as number);
      tags.unshift(cur);
      cur = p;
    }
    const follow = (top: Node): Element | null => {
      if (!same(top, removed) || !top.isConnected) return null;
      let cand: Element = top;
      for (let k = 0; k < path.length; k++) {
        const next: Element | undefined = cand.children[path[k]];
        if (!same(next, tags[k])) return null;
        cand = next;
      }
      return signatureOf(cand, rec.mode) === rec.signature ? cand : null;
    };
    const idx = Array.prototype.indexOf.call(r.removedNodes, removed) as number;
    const slot = r.addedNodes[idx];
    const first = slot ? follow(slot) : null;
    if (first) return first;
    const hits = Array.from(r.addedNodes)
      .filter((a) => a !== slot)
      .map(follow)
      .filter((e): e is Element => !!e);
    return hits.length === 1 ? hits[0] : null;
  }

  private flushStale() {
    if (this.pendingStale.size === 0) return;
    const ids = Array.from(this.pendingStale);
    this.pendingStale.clear();
    for (const id of ids) {
      if (!this.records.get(id)?.stale) continue;
      try {
        this.onStale?.(id);
      } catch (e) {
        console.error('[aibs] re-mask failed', e);
      }
    }
  }
}
