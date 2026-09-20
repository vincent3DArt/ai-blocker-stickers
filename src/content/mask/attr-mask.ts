/** Attributes that leak text into the accessibility tree or tooltips. */
export const SCRUB_ATTRS = ['title', 'alt', 'aria-label', 'aria-description', 'placeholder', 'data-tooltip', 'data-title'];

export type AttrBackup = Map<Element, Map<string, string | null>>;

function remember(backup: AttrBackup, el: Element, attr: string) {
  let m = backup.get(el);
  if (!m) {
    m = new Map();
    backup.set(el, m);
  }
  if (!m.has(attr)) m.set(attr, el.getAttribute(attr));
}

/** Blank leaking attributes on `el` and its descendants, recording originals. */
export function scrubAttrs(backup: AttrBackup, root: Element, write: (el: Element, attr: string, value: string | null) => void) {
  const els: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    for (const attr of SCRUB_ATTRS) {
      const v = el.getAttribute(attr);
      if (v === null || v === '') continue;
      remember(backup, el, attr);
      write(el, attr, '');
    }
  }
}

export function restoreAttrs(backup: AttrBackup, write: (el: Element, attr: string, value: string | null) => void) {
  for (const [el, attrs] of backup) {
    if (!el.isConnected) continue;
    for (const [attr, value] of attrs) write(el, attr, value);
  }
  backup.clear();
}
