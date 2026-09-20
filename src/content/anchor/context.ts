import type { LabelSource, TableContext } from '@/shared/types';

/** Lowercase, strip digits and punctuation, collapse whitespace, cap length. */
export function normalizeContext(text: string | null | undefined, max = 40): string | undefined {
  if (!text) return undefined;
  const t = text
    .toLowerCase()
    .replace(/[\d]+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

function shortText(el: Element | null, max = 60): string | undefined {
  if (!el) return undefined;
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : undefined;
}

function isLabelish(el: Element | null): el is Element {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'LABEL' || tag === 'DT' || tag === 'TH' || tag === 'LEGEND') return true;
  const t = shortText(el);
  return !!t && (t.endsWith(':') || t.length <= 30);
}

/**
 * Nearest label text for `el`, in order of reliability:
 * label[for], aria-labelledby, aria-label, <label> wrapping, dt for dd,
 * row/column th for td, previous sibling that looks like a label,
 * text immediately preceding inside the parent.
 */
export interface LabelInfo {
  text: string;
  source: LabelSource;
}

const info = (text: string | undefined, source: LabelSource): LabelInfo | undefined =>
  text ? { text, source } : undefined;

export function labelInfo(el: Element): LabelInfo | undefined {
  const doc = el.ownerDocument;
  if (el.id) {
    const lab = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const t = shortText(lab);
    if (t) return info(normalizeContext(t), 'label');
  }
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = labelledBy
      .split(/\s+/)
      .map((id) => shortText(doc.getElementById(id)))
      .filter(Boolean)
      .join(' ');
    if (t) return info(normalizeContext(t), 'label');
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return info(normalizeContext(ariaLabel), 'label');

  const wrappingLabel = el.closest('label');
  if (wrappingLabel && wrappingLabel !== el) {
    const clone = wrappingLabel.cloneNode(true) as Element;
    clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
    const t = shortText(clone);
    if (t) return info(normalizeContext(t), 'label');
  }

  if (el.tagName === 'DD') {
    let sib = el.previousElementSibling;
    while (sib && sib.tagName !== 'DT') sib = sib.previousElementSibling;
    const t = shortText(sib);
    if (t) return info(normalizeContext(t), 'row');
  }

  if (el.tagName === 'TD') {
    const row = el.closest('tr');
    const rowHeader = row?.querySelector('th');
    const t = shortText(rowHeader ?? null);
    if (t) return info(normalizeContext(t), 'row');
    // Column headers are shared by every row: useful for finding the column,
    // useless for telling one record from another. Marked as such.
    const tc = tableContext(el);
    if (tc?.header) return info(tc.header, 'column');
  }

  let prev = el.previousElementSibling;
  if (isLabelish(prev)) {
    const t = shortText(prev);
    if (t) return info(normalizeContext(t), 'sibling');
  }

  // Text directly before the element inside its parent, e.g. "SSN: <span>…</span>"
  const parent = el.parentElement;
  if (parent) {
    let text = '';
    for (const node of Array.from(parent.childNodes)) {
      if (node === el) break;
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
      else if (node.nodeType === Node.ELEMENT_NODE) text += ' ' + ((node as Element).textContent ?? '') + ' ';
    }
    const tail = text.replace(/\s+/g, ' ').trim().slice(-60);
    const m = tail.match(/([^.;:\n]{1,40})[:\s]*$/);
    if (m && m[1].trim()) return info(normalizeContext(m[1]), 'sibling');
    // Parent that itself is a label (e.g. <p>SSN: 123</p> with el being a text-only child) handled by previous branch.
    prev = parent.previousElementSibling;
    if (isLabelish(prev) && (parent.childElementCount <= 2)) {
      const t = shortText(prev);
      if (t) return info(normalizeContext(t), 'sibling');
    }
  }
  return undefined;
}

export function labelContext(el: Element): string | undefined {
  return labelInfo(el)?.text;
}

/** Nearest preceding h1-h4 in document order. */
export function headingContext(el: Element): string | undefined {
  const headings = Array.from(el.ownerDocument.querySelectorAll('h1,h2,h3,h4'));
  let best: Element | undefined;
  for (const h of headings) {
    const pos = h.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    else break;
  }
  return normalizeContext(shortText(best ?? null, 80));
}

export function tableContext(el: Element): TableContext | undefined {
  const cell = el.closest('td,th');
  if (!cell) return undefined;
  const row = cell.parentElement;
  const table = cell.closest('table');
  if (!row || !table) return undefined;
  const colIndex = Array.from(row.children).indexOf(cell);
  const bodyRows = Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > tr'));
  const rowIndex = bodyRows.indexOf(row as HTMLTableRowElement);
  const headRow = table.querySelector('thead tr') ?? (bodyRows[0] && bodyRows[0].querySelector('th') ? bodyRows[0] : null);
  const headerCell = headRow?.children[colIndex];
  return {
    header: normalizeContext(shortText(headerCell ?? null)),
    colIndex: colIndex >= 0 ? colIndex : undefined,
    rowIndex: rowIndex >= 0 ? rowIndex : undefined,
  };
}

/** Elements that a label with the given normalised text points at or sits next to. */
export function elementsNearLabel(label: string, tag: string): Element[] {
  const out = new Set<Element>();
  const consider = (target: Element | null | undefined) => {
    if (!target) return;
    if (target.tagName.toLowerCase() === tag) out.add(target);
    // Also the first matching descendant, for "<td><span>…</span></td>" style cells.
    const inner = target.querySelector(tag);
    if (inner) out.add(inner);
  };
  const candidates = document.querySelectorAll('label,dt,th,legend,span,div,p,strong,b');
  for (const c of Array.from(candidates)) {
    if (c.children.length > 3) continue;
    const t = normalizeContext(c.textContent, 40);
    if (!t || t !== label) continue;
    if (c.tagName === 'LABEL') {
      const forId = c.getAttribute('for');
      if (forId) consider(document.getElementById(forId));
      consider(c.querySelector('input,select,textarea'));
    }
    if (c.tagName === 'DT') consider(c.nextElementSibling);
    if (c.tagName === 'TH') {
      const row = c.closest('tr');
      if (row) {
        // Row header: sibling cells. Column header: same column in each body row.
        row.querySelectorAll('td').forEach(consider);
        const table = c.closest('table');
        const col = row ? Array.from(row.children).indexOf(c) : -1;
        if (table && col >= 0) {
          table.querySelectorAll('tbody > tr').forEach((r) => consider(r.children[col] as Element | undefined));
        }
      }
    }
    consider(c.nextElementSibling);
    if (c.parentElement && c.parentElement.children.length <= 3) {
      Array.from(c.parentElement.children).forEach((s) => s !== c && consider(s));
    }
  }
  return Array.from(out);
}
