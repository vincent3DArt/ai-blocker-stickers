/**
 * The page's own text of nodes a live edit rewrote. Identity code (sticker
 * fingerprints, mask signatures, drift checks, viewer identity) must hash what
 * the page wrote, not what an edit shows: the page re-renders its own text,
 * and the edit is gone after a reload.
 */
interface PageTextSource {
  /** False while no node is edited: callers then use the DOM as is. */
  active(): boolean;
  /** The page's text of an edited node, undefined for any other node. */
  text(t: Text): string | undefined;
}

let source: PageTextSource | null = null;

export function setPageTextSource(s: PageTextSource | null) {
  source = s;
}

/** The page's own text of `t` when an edit rewrote it, else undefined. */
export function editedPageText(t: Text): string | undefined {
  return source?.active() ? source.text(t) : undefined;
}

/** `node.textContent` as the page wrote it, with live edits undone. */
export function pageTextContent(node: Node): string {
  if (!source?.active()) return node.textContent ?? '';
  if (node.nodeType === Node.TEXT_NODE) return source.text(node as Text) ?? (node as Text).data;
  let out = '';
  const w = (node.ownerDocument ?? document).createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out += source.text(n as Text) ?? (n as Text).data;
  return out;
}
