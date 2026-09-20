/**
 * Selector builders and stability heuristics.
 *
 * The goal is a CSS path that survives framework rebuilds: generated ids and
 * hashed class names are rejected, structural position is added only where a
 * segment is ambiguous among its siblings.
 */

const UNSTABLE_ID = [
  /^(:r|radix-|mui-|headlessui-|react-select|downshift|ember|yui_|ui-id-|rc-|ant-|chakra-|mantine-)/i,
  /[0-9a-f]{8,}/i,
  /\d{4,}/,
  /^\d/,
];

const UNSTABLE_CLASS = [
  /^(css|sc|jss|emotion|chakra|mantine|svelte|astro|_)-/i,
  /[[\]:]/, // tailwind arbitrary values and variants
  /[0-9a-f]{5,}$/i,
  /\d{3,}/,
  /--[a-z0-9]{4,}$/i, // css-modules hash suffix
  /^[a-z]{1,2}\d/i,
  /^(active|hover|focus|selected|open|closed|visible|hidden|show|is-|has-)/i, // state classes churn
];

export function isStableId(id: string): boolean {
  if (!id || id.length > 64) return false;
  return !UNSTABLE_ID.some((re) => re.test(id));
}

export function isStableClass(cls: string): boolean {
  if (cls.length < 2 || cls.length > 40) return false;
  return !UNSTABLE_CLASS.some((re) => re.test(cls));
}

export function stableClasses(el: Element, max = 5): string[] {
  return Array.from(el.classList).filter(isStableClass).slice(0, max);
}

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];

export function testId(el: Element): string | undefined {
  for (const a of TEST_ID_ATTRS) {
    const v = el.getAttribute(a);
    if (v) return v;
  }
  return undefined;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');
}

function nthOfType(el: Element): number {
  let n = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) n++;
    sib = sib.previousElementSibling;
  }
  return n;
}

function segmentFor(el: Element, withNth: boolean): string {
  const tag = el.tagName.toLowerCase();
  let seg = tag;
  const classes = stableClasses(el, 3);
  if (classes.length) seg += '.' + classes.map(cssEscape).join('.');
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') {
    const name = el.getAttribute('name');
    if (name) seg += `[name="${cssEscape(name)}"]`;
    const type = el.getAttribute('type');
    if (type) seg += `[type="${cssEscape(type)}"]`;
  }
  if (withNth) seg += `:nth-of-type(${nthOfType(el)})`;
  return seg;
}

function isAmbiguous(el: Element, seg: string): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  try {
    return parent.querySelectorAll(`:scope > ${seg}`).length > 1;
  } catch {
    return true;
  }
}

function matchCount(root: Document | Element, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return -1;
  }
}

/**
 * Builds a CSS path from a stable ancestor (id / test id / body) down to `el`,
 * at most `maxSegments` deep, adding :nth-of-type only where needed, and
 * verifying uniqueness in the document. Returns the path even when it can't be
 * made unique (resolution scores handle that); in that case a positional
 * segment is added to every ambiguous level.
 */
export function buildCssPath(el: Element, maxSegments = 8): string {
  const segments: string[] = [];
  const chain: Element[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && chain.length < maxSegments) {
    chain.unshift(node);
    const id = node.id;
    const tid = testId(node);
    if (node !== el && ((id && isStableId(id)) || tid)) break;
    if (node.tagName === 'BODY') break;
    node = node.parentElement;
  }

  for (let i = 0; i < chain.length; i++) {
    const n = chain[i];
    const id = n.id;
    const tid = testId(n);
    if (i === 0 && id && isStableId(id)) {
      segments.push(`#${cssEscape(id)}`);
      continue;
    }
    if (i === 0 && tid) {
      segments.push(`${n.tagName.toLowerCase()}[data-testid="${cssEscape(tid)}"]`);
      continue;
    }
    if (n.tagName === 'BODY') {
      segments.push('body');
      continue;
    }
    const plain = segmentFor(n, false);
    segments.push(isAmbiguous(n, plain) ? segmentFor(n, true) : plain);
  }

  let path = segments.join(' > ');
  if (matchCount(document, path) !== 1) {
    // Force positional segments everywhere below the root segment.
    const forced = chain.map((n, i) => (i === 0 ? segments[0] : segmentFor(n, true)));
    const forcedPath = forced.join(' > ');
    if (matchCount(document, forcedPath) === 1) path = forcedPath;
  }
  return path;
}

/** Purely positional XPath from the document root. */
export function buildXPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    parts.unshift(`${node.tagName.toLowerCase()}[${nthOfType(node)}]`);
    node = node.parentElement;
  }
  return '/html/' + parts.join('/');
}

export function evalXPath(xpath: string): Element[] {
  try {
    const res = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out: Element[] = [];
    for (let i = 0; i < res.snapshotLength; i++) {
      const n = res.snapshotItem(i);
      if (n instanceof Element) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

export function queryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}
