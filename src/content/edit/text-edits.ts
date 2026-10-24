import type { MutationHub } from '../mask/guard';
import { collectTextNodes } from '../mask/text-mask';
import { leaks, remember, tokenScrubbable, tokensOf, type AttrBackup, type Tokens } from '../mask/attr-mask';

/** Letters, digits and combining marks: a "word" character for snapping and boundaries. */
const WORD = /[\p{L}\p{N}\p{M}]/u;
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}\\p{M}])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}\\p{M}])';
/** Attributes that name where a link or form goes: rewriting them would change behaviour, not just text. */
const NAVIGATION_ATTRS = new Set(['href', 'xlink:href', 'action', 'formaction', 'ping', 'cite']);
/** Ancestors (beyond the text's own element) whose attributes are mirrored. */
const ATTR_DEPTH = 4;
/** Text whose content is a form value: rewriting it would change what the form submits. */
const FORM_TEXT = 'textarea, option, select';

export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The run of text that changed between `before` and `after`, snapped out to
 * whole words so "Zelda" → "Zelma" is one word, not "d" → "m". Whitespace is
 * collapsed first: the editor shows collapsed text. Null when nothing changed.
 */
export function changedRun(before: string, after: string): { orig: string; now: string } | null {
  const a = collapse(before);
  const b = collapse(after);
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Never cut a surrogate pair (two emoji sharing a high surrogate).
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  const word = (c: string | undefined) => c !== undefined && WORD.test(c);
  // Mid-word on either side: widen to the whole word (the prefix and suffix are common, so both strings move together).
  if (p > 0 && word(a[p - 1]) && (word(a[p]) || word(b[p]))) while (p > 0 && word(a[p - 1])) p--;
  const endA = () => a.length - s;
  const endB = () => b.length - s;
  if (s > 0 && word(a[endA()]) && ((endA() > p && word(a[endA() - 1])) || (endB() > p && word(b[endB() - 1]))))
    while (s > 0 && word(a[a.length - s])) s--;
  const orig = a.slice(p, endA()).trim();
  const now = b.slice(p, endB()).trim();
  return orig ? { orig, now } : { orig: a, now: b };
}

/** Matches `orig` in page text: any whitespace run between words, and never inside a longer word ("Zelda" not in "Zeldas"). */
export function runRegex(orig: string): RegExp {
  const body = orig
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const pre = WORD.test(orig[0]) ? NOT_WORD_BEFORE : '';
  const post = WORD.test(orig[orig.length - 1]) ? NOT_WORD_AFTER : '';
  return new RegExp(pre + body + post, 'gu');
}

interface Edit {
  id: number;
  orig: string;
  now: string;
  re: RegExp;
  tokens: Tokens;
  /** The user ticked "Every copy": text the page renders later that contains the run is edited too. */
  everywhere: boolean;
  /** Long enough, and not repeated in `now`, to follow into any text that contains it. */
  followRun: boolean;
  /** Collapsed page text of the nodes edited so far: an identical re-render is the same text again. */
  pageTexts: Set<string>;
  /** The run's own words (3+ characters), to recognise a partial re-render while locked. */
  words: RegExp[];
  nodes: Set<Text>;
  attrs: Set<Element>;
}

/**
 * Live text edits: what the user typed shows instead of the page's text until
 * reload. Nothing is stored. The page's own text lives only here, so revert
 * can put it back. Edits are written as plain `Text.data`, never through
 * editing commands, so the page's undo stack has nothing to bring back.
 *
 * Runs as a synchronous MutationHub listener registered BEFORE the Masker, so
 * a re-render that puts the original back is rewritten in the same callback.
 * A sticker over an edited node keeps the edit (the Masker's `textView` hook,
 * see `view`), while identity code hashes the page's own text (`pageText`,
 * through edit/page-text.ts).
 */
export class TextEdits {
  private edits: Edit[] = [];
  /**
   * The page's own data for every node an edit rewrote.
   * shortcut: detached nodes stay until reload so a remount of the same node is still followed; prune on a timer if heavy-churn pages show memory growth.
   */
  private page = new Map<Text, string>();
  /** What this module last wrote into a node, to tell our writes from the page's. */
  private shown = new WeakMap<Text, string>();
  private attrPage: AttrBackup = new Map();
  private attrShown = new WeakMap<Element, Map<string, string>>();
  private locked = false;
  private nextId = 1;
  private disposeHub: (() => void) | null = null;
  onChange: ((count: number) => void) | null = null;

  constructor(
    private hub: MutationHub,
    /** Our own overlay nodes and anything a sticker masks: the Masker owns those. */
    private skip: (n: Node) => boolean,
  ) {}

  start() {
    this.disposeHub ??= this.hub.addListener((records) => this.onMutations(records));
  }

  stop() {
    this.disposeHub?.();
    this.disposeHub = null;
  }

  get count(): number {
    return this.edits.length;
  }

  /** True while some node shows an edit (identity code then reads `pageText`). */
  get managing(): boolean {
    return this.page.size > 0;
  }

  /** The page's own text of a node an edit rewrote, else undefined. */
  pageText(t: Text): string | undefined {
    return this.page.get(t);
  }

  isEdited(t: Text): boolean {
    return this.edits.some((e) => e.nodes.has(t));
  }

  /** Connected nodes showing an edit, for the outline marks. */
  nodes(): Text[] {
    return Array.from(this.page.keys()).filter((t) => t.isConnected && this.isEdited(t));
  }

  /**
   * While locked, a page write that drops the edited run is not shown: the
   * node keeps the edit (a partial re-render such as "Ms. Zelda Q." must not
   * leak). On unlock those nodes get the page's latest text back.
   */
  setLocked(on: boolean) {
    if (this.locked === on) return;
    this.locked = on;
    if (on) return;
    for (const t of Array.from(this.page.keys())) {
      const page = this.page.get(t)!;
      if (!this.mine(t).some((e) => page.search(e.re) >= 0)) this.release(t, true);
    }
    this.changed();
  }

  /**
   * Apply what the user typed for node `t`. The run is diffed against the
   * page's own text, so editing an edited node again merges, and typing the
   * page's text back reverts. `everywhere` also rewrites every other copy now
   * on the page (and the tab title), and copies it renders later.
   */
  edit(t: Text, value: string, everywhere = false): { reverted: boolean; copies: number; remaining: number } {
    const none = { reverted: false, copies: 0, remaining: 0 };
    if (this.skip(t)) return none;
    const page = this.page.get(t) ?? t.data;
    // The new run is diffed against the page's text and replaces the node's earlier edits.
    for (const e of this.mine(t)) {
      e.nodes.delete(t);
      if (e.nodes.size === 0) this.drop(e);
    }
    const run = changedRun(page, value);
    if (!run) {
      this.release(t, true);
      this.changed();
      return { ...none, reverted: true };
    }
    const re = runRegex(run.orig);
    const e: Edit = {
      id: this.nextId++,
      ...run,
      re,
      tokens: tokensOf([run.orig]),
      everywhere,
      // "Ann" → "Ann Lee" still shows the run: following it into copies would grow it on every remount.
      followRun: run.orig.replace(/\s/g, '').length >= 3 && run.now.search(re) < 0,
      pageTexts: new Set(),
      words: run.orig
        .split(/\s+/)
        .filter((w) => Array.from(w).filter((c) => WORD.test(c)).length >= 3)
        .map(runRegex),
      nodes: new Set(),
      attrs: new Set(),
    };
    this.edits.push(e);
    this.join(e, t, page);
    const others = this.copies(e);
    if (everywhere) for (const o of others) this.join(e, o, this.page.get(o) ?? o.data);
    this.changed();
    return { ...none, copies: everywhere ? others.length : 0, remaining: everywhere ? 0 : others.length };
  }

  /** Revert every edit shown in `t`. False while locked. */
  revertAt(t: Text): boolean {
    if (this.locked) return false;
    for (const e of this.mine(t)) this.drop(e);
    this.changed();
    return true;
  }

  /** False while locked: the agent's input looks like the user's. */
  revertAll(): boolean {
    if (this.locked) return false;
    for (const e of this.edits.slice().reverse()) this.drop(e);
    this.changed();
    return true;
  }

  /**
   * The Masker's `textView` hook: what a mask keeps as the original of an
   * edited node, so removing the sticker later (or an unsplit, or a pause)
   * writes the edit back, never the page's text. Nodes no edit owns are left
   * alone; once unmasked, the listener follows them like any other text.
   */
  view(t: Text, data: string): string {
    if (!this.page.has(t) || this.shown.get(t) === data) return data;
    const frozen = this.locked && !this.mine(t).some((e) => data.search(e.re) >= 0);
    this.page.set(t, data);
    const v = frozen ? (this.shown.get(t) ?? this.render(t)) : this.render(t);
    this.shown.set(t, v);
    return v;
  }

  private mine(t: Text): Edit[] {
    return this.edits.filter((e) => e.nodes.has(t));
  }

  private render(t: Text): string {
    let out = this.page.get(t) ?? t.data;
    for (const e of this.mine(t)) out = out.replace(e.re, () => e.now);
    return out;
  }

  private write(t: Text, value: string) {
    this.shown.set(t, value);
    if (t.data !== value) t.data = value;
  }

  private join(e: Edit, t: Text, page: string) {
    e.nodes.add(t);
    e.pageTexts.add(collapse(page));
    this.page.set(t, page);
    this.watch(t);
    this.write(t, this.render(t));
    this.mirror(e, t);
  }

  /** Text that changing would alter a form's value, not just what the page shows. */
  private formText(t: Text): boolean {
    return !!t.parentElement?.closest(FORM_TEXT);
  }

  /** Does page text the user never edited belong to edit `e`: the same text re-rendered, or (Every copy) any text with the run? */
  private follows(e: Edit, t: Text, data: string): boolean {
    if (this.formText(t)) return false;
    if (e.pageTexts.has(collapse(data))) return true;
    return e.everywhere && e.followRun && data.search(e.re) >= 0;
  }

  /** Stop managing `t`; `restore` writes the page's text back (unless a sticker masks it). */
  private release(t: Text, restore: boolean) {
    const page = this.page.get(t);
    for (const e of this.mine(t)) e.nodes.delete(t);
    this.page.delete(t);
    this.shown.delete(t);
    if (restore && page !== undefined && t.isConnected && !this.skip(t) && t.data !== page) t.data = page;
  }

  private drop(e: Edit) {
    const i = this.edits.indexOf(e);
    if (i >= 0) this.edits.splice(i, 1);
    for (const t of e.nodes) {
      if (this.mine(t).length === 0) this.release(t, true);
      else if (t.isConnected && !this.skip(t)) this.write(t, this.render(t));
    }
    // Attributes under a sticker keep the edit: the Masker holds them now (LIMITATIONS: reverting text under a sticker).
    for (const el of e.attrs) if (!this.skip(el)) this.renderAttrs(el);
  }

  private changed() {
    this.onChange?.(this.edits.length);
  }

  /** Other text nodes on the page (and the tab title) that show the run right now. */
  private copies(e: Edit): Text[] {
    const out: Text[] = [];
    const title = document.querySelector('head > title');
    for (const t of [...collectTextNodes(document.body ?? document.documentElement), ...(title ? collectTextNodes(title) : [])]) {
      if (e.nodes.has(t) || this.skip(t) || this.formText(t)) continue;
      if ((this.page.get(t) ?? t.data).search(e.re) >= 0) out.push(t);
    }
    return out;
  }

  /** Text inside a shadow tree needs that tree observed: a document-level observer never sees it. */
  private watch(t: Text) {
    let r = t.getRootNode();
    while (r !== t && r.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      this.hub.observe(r);
      const host = (r as ShadowRoot).host;
      if (!host) break;
      r = host.getRootNode();
    }
  }

  private onMutations(records: MutationRecord[]) {
    if (this.edits.length === 0) return;
    // Locked: edited text the page removed anywhere in this batch. New text that repeats its words is
    // its re-render ("Ms. Zelda Q.", or a keyed remount in a separate record) and keeps the edit.
    const gone = this.locked
      ? records.flatMap((r) => (r.type === 'childList' ? Array.from(r.removedNodes).flatMap((n) => collectTextNodes(n).filter((t) => this.isEdited(t))) : []))
      : [];
    for (const r of records) {
      if (r.type === 'characterData') this.onText(r.target as Text);
      else if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) {
          if (this.skip(n)) continue;
          for (const t of collectTextNodes(n)) this.onText(t, gone);
        }
      } else if (r.type === 'attributes' && r.attributeName) this.onAttr(r.target as Element, r.attributeName);
    }
  }

  private onText(t: Text, gone: Text[] = []) {
    if (!t.isConnected || this.skip(t)) return;
    const data = t.data;
    if (this.shown.get(t) === data) return; // our own write
    if (!this.page.has(t)) {
      // A re-render or remount of edited text: fail closed and edit it too.
      const hits = this.edits.filter((e) => this.follows(e, t, data));
      for (const e of hits) this.join(e, t, data);
      if (hits.length === 0 && !this.formText(t)) {
        const was = gone.find((g) => this.mine(g).some((e) => e.words.some((w) => data.search(w) >= 0)));
        if (was) {
          // Frozen like an edited node rewritten in place.
          for (const e of this.mine(was)) e.nodes.add(t);
          this.page.set(t, data);
          this.watch(t);
          this.write(t, this.shown.get(was) ?? data);
        }
      }
      return;
    }
    this.page.set(t, data);
    if (this.mine(t).some((e) => data.search(e.re) >= 0)) this.write(t, this.render(t));
    else if (this.locked) this.write(t, this.shown.get(t) ?? this.render(t));
    else {
      // The page moved on to unrelated text: the node is no longer edited (other edits may still match it).
      this.release(t, false);
      this.onText(t);
    }
  }

  /** Mirror the edit into attributes that repeat the text (title, aria-label, alt…) on the text's element and a few ancestors. */
  private mirror(e: Edit, t: Text) {
    let el = t.parentElement;
    for (let i = 0; el && i <= ATTR_DEPTH && el !== document.body && el !== document.documentElement; i++, el = el.parentElement) {
      if (this.skip(el)) break;
      let hit = false;
      for (const a of Array.from(el.attributes)) {
        if (!this.mirrorable(el, a.name)) continue;
        const page = this.attrPage.get(el)?.get(a.name) ?? a.value;
        if (!page || (page.search(e.re) < 0 && !leaks(page, e.tokens))) continue;
        remember(this.attrPage, el, a.name);
        hit = true;
      }
      if (hit) {
        e.attrs.add(el);
        this.renderAttrs(el);
      }
    }
  }

  private mirrorable(el: Element, attr: string): boolean {
    return tokenScrubbable(el, attr) && !NAVIGATION_ATTRS.has(attr) && !attr.startsWith('on');
  }

  /** Recompute every mirrored attribute of `el` from the page's value; put the page's value back when no edit touches it any more. */
  private renderAttrs(el: Element) {
    const backup = this.attrPage.get(el);
    if (!backup) return;
    const edits = this.edits.filter((e) => e.attrs.has(el));
    for (const [attr, page] of backup) {
      let out = page;
      for (const e of edits) {
        if (out === null) break;
        if (out.search(e.re) >= 0) out = out.replace(e.re, () => e.now);
        // The run itself is gone, but its words are still there ("Quarry, Zelda"): blank it.
        else if (leaks(out, e.tokens)) out = '';
      }
      this.writeAttr(el, attr, out);
    }
    if (edits.length === 0) this.attrPage.delete(el);
  }

  private writeAttr(el: Element, attr: string, value: string | null) {
    let m = this.attrShown.get(el);
    if (!m) this.attrShown.set(el, (m = new Map()));
    if (value === null) {
      m.delete(attr);
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
      return;
    }
    m.set(attr, value);
    if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
  }

  private onAttr(el: Element, attr: string) {
    if (!el.isConnected || this.skip(el)) return;
    const current = el.getAttribute(attr);
    if (this.attrShown.get(el)?.get(attr) === current) return; // ours
    const backup = this.attrPage.get(el);
    if (backup?.has(attr)) {
      // The page reset an attribute we mirror: its new value is the page's, shown with the edits applied.
      backup.set(attr, current);
      this.renderAttrs(el);
      return;
    }
    const edits = this.edits.filter((e) => e.attrs.has(el));
    if (!current || edits.length === 0 || !this.mirrorable(el, attr)) return;
    if (edits.some((e) => current.search(e.re) >= 0 || leaks(current, e.tokens))) {
      remember(this.attrPage, el, attr);
      this.renderAttrs(el);
    }
  }
}
