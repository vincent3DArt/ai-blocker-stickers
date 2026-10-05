/**
 * Text anchoring for rect stickers.
 *
 * A rect sticker is drawn over pixels, but what the user means to hide is the
 * text under it. Fractions of a container box only find that text again while
 * the layout is unchanged: a late web font, a zoom or a wrapped line moves the
 * characters inside the container and the projected rectangle no longer sits
 * on them. So the covered characters themselves are the anchor:
 *
 *  - at creation the covered characters (whitespace removed) are HMAC'd
 *    (`coverHmac`); every covered token is HMAC'd on its own (`tokenHmacs`);
 *  - while the page runs, the masked characters are found again by their
 *    original text (kept in memory only);
 *  - after a reload the projection picks a first guess, and if the guess does
 *    not hash to `coverHmac`, a window of the same length that does is
 *    searched for in the container.
 *
 * Nothing readable is stored. Searches are bounded (MAX_SEARCH characters).
 */
import type { TextRange } from '../mask/text-mask';
import { collectTextNodes } from '../mask/text-mask';

/** Characters of container text a hash search looks at, at most. */
export const MAX_SEARCH = 20_000;

/** Whitespace-free text of `root` with, for every character, the node and offset it came from. */
export interface Stripped {
  s: string;
  nodes: Text[];
  /** Index into `nodes` for each character of `s`. */
  node: Uint32Array;
  /** Offset into that node's data for each character of `s`. */
  off: Uint32Array;
}

export function stripped(root: Node, cap = MAX_SEARCH): Stripped | null {
  const nodes = collectTextNodes(root);
  let total = 0;
  for (const t of nodes) total += t.data.length;
  if (total > cap * 2) return null;
  const node = new Uint32Array(total);
  const off = new Uint32Array(total);
  let s = '';
  let k = 0;
  nodes.forEach((t, ni) => {
    const d = t.data;
    for (let i = 0; i < d.length; i++) {
      const c = d[i];
      if (/\s/.test(c)) continue;
      s += c;
      node[k] = ni;
      off[k] = i;
      k++;
    }
  });
  if (s.length > cap) return null;
  return { s, nodes, node: node.subarray(0, k), off: off.subarray(0, k) };
}

/** The covered characters of `ranges`, whitespace removed, in order. */
export function coveredKey(ranges: TextRange[]): string {
  return ranges.map((r) => r.node.data.slice(r.start, r.end)).join('').replace(/\s+/g, '');
}

/** Whitespace-delimited tokens of `ranges` (each range is already snapped to whole tokens). */
export function coveredTokens(ranges: TextRange[]): string[] {
  return ranges.flatMap((r) => r.node.data.slice(r.start, r.end).split(/\s+/).filter(Boolean));
}

/** Ranges (one per node) for stripped characters `[start, start + len)`. */
export function rangesForSpan(st: Stripped, start: number, len: number): TextRange[] {
  const out: TextRange[] = [];
  for (let i = start; i < start + len && i < st.s.length; i++) {
    const n = st.nodes[st.node[i]];
    const o = st.off[i];
    const last = out[out.length - 1];
    if (last && last.node === n) last.end = o + 1;
    else out.push({ node: n, start: o, end: o + 1 });
  }
  return out;
}

/** Stripped index of the first character of `ranges`, or -1. */
export function startOf(st: Stripped, ranges: TextRange[]): number {
  if (!ranges.length) return -1;
  const ni = st.nodes.indexOf(ranges[0].node);
  if (ni < 0) return -1;
  for (let i = 0; i < st.s.length; i++) if (st.node[i] === ni && st.off[i] >= ranges[0].start) return i;
  return -1;
}

/** Every occurrence of `key` in `st`, the one nearest to `near` first. */
export function locateExact(st: Stripped, key: string, near: number): number {
  if (!key) return -1;
  let best = -1;
  for (let i = st.s.indexOf(key); i >= 0; i = st.s.indexOf(key, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** A window of `len` characters whose hash equals `hmac`, nearest to `near`; -1 when none. */
export function locateByHash(st: Stripped, len: number, hmac: string, hash: (s: string) => string | undefined, near: number): number {
  if (len <= 0 || len > st.s.length) return -1;
  // Nearest first: walk outwards from `near`.
  const max = st.s.length - len;
  const from = Math.max(0, Math.min(max, near < 0 ? 0 : near));
  for (let d = 0; d <= max; d++) {
    for (const i of d === 0 ? [from] : [from - d, from + d]) {
      if (i < 0 || i > max) continue;
      if (hash(st.s.slice(i, i + len)) === hmac) return i;
    }
  }
  return -1;
}
