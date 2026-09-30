/** Length-preserving replacement: every non-whitespace character becomes a bullet. */
export function bullets(s: string): string {
  return s.replace(/[^\s]/g, '•');
}

export function isBullets(s: string): boolean {
  return /^[\s•]*$/.test(s) && /•/.test(s);
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * The shadow root hanging off `el`, if any. Open roots are always reachable;
 * closed ones only through the extension-only `chrome.dom` API, which we ask
 * for custom elements alone (asking for every element of every scan is not
 * free). Our own overlay host is never entered.
 */
export function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.tagName === 'AIBS-HOST') return null;
  const open = (el as HTMLElement).shadowRoot;
  if (open) return open;
  if (!el.tagName.includes('-')) return null;
  try {
    const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: HTMLElement) => ShadowRoot | null } } }).chrome?.dom;
    return dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/**
 * Text nodes under `root` (including `root` itself if it is a Text node) that
 * carry visible characters. Descends into shadow roots: their text is
 * rendered under the sticker and reaches the accessibility tree like any
 * other, even though a document-level TreeWalker never enters them.
 */
export function collectTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    if (/\S/.test((root as Text).data)) out.push(root as Text);
    return out;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const sr = shadowRootOf(root as Element);
    if (sr) out.push(...collectTextNodes(sr));
  }
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (SKIP_TAGS.has((node as Element).tagName)) return NodeFilter.FILTER_REJECT;
        const sr = shadowRootOf(node as Element);
        if (sr) out.push(...collectTextNodes(sr));
        return NodeFilter.FILTER_SKIP;
      }
      return /\S/.test((node as Text).data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

export interface TextRange {
  node: Text;
  /** Character offsets into `node.data`; `[start, end)`. */
  start: number;
  end: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function intersects(r: DOMRect, rect: Box): boolean {
  return r.right > rect.x && r.left < rect.x + rect.w && r.bottom > rect.y && r.top < rect.y + rect.h;
}

/**
 * Character ranges under a sticker covering `rect` (viewport coords).
 *
 * Only text the user actually drew over is masked. For every Text node whose
 * line boxes intersect the rect we measure per-character rects with a Range; a
 * character counts as covered when at least `minChar` of its own box is inside
 * the sticker. Nodes whose line boxes miss the rect are skipped without any
 * per-character work.
 *
 * Coverage is then snapped to whitespace-delimited tokens: if ANY character of
 * a token is covered the whole token is masked, so a rect drawn tightly over
 * most of "987-65-4321" hides the entire number and never leaks half of it.
 * Adjacent masked tokens (and the whitespace between them) merge into one
 * range, so a node can yield several ranges but never one per character.
 */
export function coveredTextRanges(root: Node, rect: Box, minChar = 0.5): TextRange[] {
  const out: TextRange[] = [];
  if (rect.w <= 0 || rect.h <= 0) return out;
  const doc = root.ownerDocument ?? (root as Document);
  const range = doc.createRange();
  for (const t of collectTextNodes(root)) {
    range.selectNodeContents(t);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!lines.some((r) => intersects(r, rect))) continue;

    const data = t.data;
    const covered = new Array<boolean>(data.length).fill(false);
    let any = false;
    for (let i = 0; i < data.length; i++) {
      if (!/\S/.test(data[i])) continue;
      range.setStart(t, i);
      range.setEnd(t, i + 1);
      for (const r of range.getClientRects()) {
        const a = r.width * r.height;
        if (a <= 0) continue;
        const ix = Math.max(0, Math.min(r.right, rect.x + rect.w) - Math.max(r.left, rect.x));
        const iy = Math.max(0, Math.min(r.bottom, rect.y + rect.h) - Math.max(r.top, rect.y));
        if ((ix * iy) / a >= minChar) {
          covered[i] = true;
          any = true;
          break;
        }
      }
    }
    if (!any) continue;

    // Snap to tokens, then merge adjacent masked tokens (whitespace included).
    let pending: { start: number; end: number } | null = null;
    for (let i = 0; i < data.length; ) {
      if (!/\S/.test(data[i])) {
        i++;
        continue;
      }
      let j = i;
      let hit = false;
      while (j < data.length && /\S/.test(data[j])) {
        if (covered[j]) hit = true;
        j++;
      }
      if (hit) {
        if (pending) pending.end = j;
        else pending = { start: i, end: j };
      } else if (pending) {
        out.push({ node: t, start: pending.start, end: pending.end });
        pending = null;
      }
      i = j;
    }
    if (pending) out.push({ node: t, start: pending.start, end: pending.end });
  }
  range.detach?.();
  return out;
}
