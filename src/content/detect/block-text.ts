/**
 * Block text assembly.
 *
 * Pages split numbers across inline elements (`<span>123</span>-<span>45</span>`)
 * and put labels in sibling spans. So the scanner does not match per Text
 * node: it concatenates every Text node that belongs to one block container
 * (its nearest non-inline ancestor) into a single string, with an offset map
 * back to the nodes, and matches on that.
 *
 * Inline-ness is decided by tag name, not computed style: it is deterministic,
 * works without layout (jsdom, a hidden tab) and costs nothing per node.
 */

export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'INS', 'DEL',
  'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U',
  'VAR', 'WBR', 'NOBR', 'OUTPUT',
]);

/** Never scanned: not rendered text, or form controls (handled separately by value). */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'IFRAME', 'OBJECT', 'EMBED', 'AIBS-HOST',
  'HEAD', 'TITLE', 'META', 'LINK',
]);

export interface Segment {
  node: Text;
  /** Offsets into `Block.text`, `[start, end)`. */
  start: number;
  end: number;
}

export interface Block {
  el: Element;
  text: string;
  segs: Segment[];
}

export function isInline(el: Element): boolean {
  return INLINE_TAGS.has(el.tagName);
}

/** Nearest ancestor (or self) that is not an inline element. */
export function nearestBlock(el: Element, cache?: Map<Element, Element>): Element {
  const hit = cache?.get(el);
  if (hit) return hit;
  let n: Element = el;
  while (isInline(n) && n.parentElement) n = n.parentElement;
  cache?.set(el, n);
  return n;
}

const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\d/;

/** Builds one block's string. */
class Builder {
  text = '';
  segs: Segment[] = [];
  /** A nested block or `<br>` came between the previous node and the next. */
  broken = false;
  private lastParent: Element | null = null;

  constructor(readonly el: Element) {}

  add(t: Text) {
    const data = t.data;
    if (!data) return;
    if (this.text) {
      if (this.broken) {
        this.text += '\n';
      } else if (t.parentElement !== this.lastParent) {
        // Across an element boundary a letter meeting a digit or a letter
        // ("SSN" + "123-45-6789" in two spans) is two tokens on screen; two
        // digit runs meeting are one visual number and stay joined.
        const a = this.text[this.text.length - 1];
        const b = data[0];
        if (ALNUM.test(a) && ALNUM.test(b) && !(DIGIT.test(a) && DIGIT.test(b))) this.text += ' ';
      }
    }
    this.broken = false;
    const start = this.text.length;
    this.text += data;
    this.segs.push({ node: t, start, end: this.text.length });
    this.lastParent = t.parentElement;
  }

  done(): Block {
    return { el: this.el, text: this.text, segs: this.segs };
  }
}

export interface WalkOptions {
  /** Skip this element and its subtree (our host, masked roots). */
  skip?: (el: Element) => boolean;
  /** Stop after this many text nodes. */
  cap?: number;
}

/**
 * Walks `root` in document order, a bounded number of blocks at a time, and
 * yields each block once all of its Text nodes have been seen.
 */
export class BlockWalker {
  private walker: TreeWalker;
  private stack: Builder[] = [];
  private cache = new Map<Element, Element>();
  textNodes = 0;
  done = false;
  truncated = false;

  constructor(
    private root: Node,
    private opts: WalkOptions = {},
  ) {
    const skip = opts.skip;
    this.walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (SKIP_TAGS.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (skip?.(el)) return NodeFilter.FILTER_REJECT;
          return el.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return /\S/.test((node as Text).data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
  }

  /**
   * Up to `maxBlocks` finished blocks, or fewer when `timeUp()` says so.
   * Returns an empty array only when the walk is done.
   */
  next(maxBlocks: number, timeUp: () => boolean = () => false): Block[] {
    const out: Block[] = [];
    const cap = this.opts.cap ?? Infinity;
    let steps = 0;
    while (!this.done && out.length < maxBlocks) {
      // Checking the clock every node would cost more than the nodes.
      if (++steps % 64 === 0 && timeUp()) break;
      const n = this.walker.nextNode();
      if (!n || this.textNodes >= cap) {
        if (n) this.truncated = true;
        this.done = true;
        while (this.stack.length) out.push(this.stack.pop()!.done());
        break;
      }
      if (n.nodeType === Node.ELEMENT_NODE) {
        // <br>: a line break inside its block.
        const b = nearestBlock(n.parentElement ?? (n as Element), this.cache);
        this.closeOutside(n, out);
        const top = this.stack[this.stack.length - 1];
        if (top && top.el === b) top.broken = true;
        continue;
      }
      const t = n as Text;
      const parent = t.parentElement;
      if (!parent) continue;
      this.textNodes++;
      const block = nearestBlock(parent, this.cache);
      this.closeOutside(t, out);
      let top = this.stack[this.stack.length - 1];
      if (!top || top.el !== block) {
        if (top) top.broken = true;
        top = new Builder(block);
        this.stack.push(top);
      }
      top.add(t);
    }
    return out;
  }

  /** Finish every open block that does not contain `n`: the walk has left it. */
  private closeOutside(n: Node, out: Block[]) {
    while (this.stack.length) {
      const top = this.stack[this.stack.length - 1];
      if (top.el.contains(n)) return;
      this.stack.pop();
      out.push(top.done());
      const below = this.stack[this.stack.length - 1];
      if (below) below.broken = true;
    }
  }
}

/** Every block under `root`, synchronously. */
export function allBlocks(root: Node, opts: WalkOptions = {}): Block[] {
  const w = new BlockWalker(root, opts);
  const out: Block[] = [];
  while (!w.done) out.push(...w.next(10_000));
  return out;
}

/**
 * One block's own text: its Text nodes and those of its inline descendants,
 * without descending into nested blocks. Cheap enough to run inside a
 * mutation callback (the locked pre-paint check).
 */
export function ownBlock(blockEl: Element, opts: WalkOptions = {}): Block | null {
  const b = new Builder(blockEl);
  let budget = opts.cap ?? 2000;
  const visit = (parent: Node) => {
    for (let c = parent.firstChild; c && budget > 0; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        budget--;
        if (/\S/.test((c as Text).data)) b.add(c as Text);
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const el = c as Element;
        if (SKIP_TAGS.has(el.tagName.toUpperCase()) || opts.skip?.(el)) continue;
        if (el.tagName === 'BR' || !isInline(el)) b.broken = true;
        else visit(el);
      }
    }
  };
  visit(blockEl);
  return b.segs.length ? b.done() : null;
}

/** The single block `el` belongs to (see `ownBlock`). */
export function blockOf(el: Element, opts: WalkOptions = {}): Block | null {
  return ownBlock(nearestBlock(el), opts);
}

/** Text nodes a `[start, end)` range of `block.text` touches. */
export function nodesFor(block: Block, start: number, end: number): Text[] {
  const out: Text[] = [];
  for (const s of block.segs) if (s.start < end && s.end > start) out.push(s.node);
  return out;
}

/** The exact character ranges of `[start, end)`, per node. */
export function rangesFor(block: Block, start: number, end: number): Array<{ node: Text; start: number; end: number }> {
  const out: Array<{ node: Text; start: number; end: number }> = [];
  for (const s of block.segs) {
    if (s.start >= end || s.end <= start) continue;
    out.push({ node: s.node, start: Math.max(0, start - s.start), end: Math.min(s.end, end) - s.start });
  }
  return out;
}

export interface Target {
  el: Element;
  /**
   * The only element covering the whole match is the block itself and its
   * text is at least three times longer than the match: covering the element
   * hides much more than the number.
   */
  wide: boolean;
}

/**
 * The deepest element that covers every node of the match: the nearest
 * inline ancestor when the match sits inside one (`<span>123-45-6789</span>`),
 * the block otherwise. `wide` flags a block whose text is at least three
 * times the match, where covering the element hides much more than the number.
 */
export function targetFor(block: Block, start: number, end: number): Target | null {
  const nodes = nodesFor(block, start, end);
  if (!nodes.length) return null;
  let common: Element | null = nodes[0].parentElement;
  for (const n of nodes.slice(1)) {
    while (common && !common.contains(n)) common = common.parentElement;
  }
  if (!common) return null;
  const wide = common === block.el && block.text.trim().length >= 3 * (end - start);
  return { el: common, wide };
}
