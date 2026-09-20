import { describe, expect, it } from 'vitest';
import { Masker } from '@/content/mask/masker';
import { MutationHub } from '@/content/mask/guard';
import type { TextRange } from '@/content/mask/text-mask';

/** Every node in the subtree, so a split that is not undone shows up as growth. */
function nodeCount(root: Node): number {
  let n = 1;
  for (const c of Array.from(root.childNodes)) n += nodeCount(c);
  return n;
}

function makeRoot(html: string): HTMLElement {
  document.body.innerHTML = '';
  const p = document.createElement('p');
  p.innerHTML = html;
  document.body.appendChild(p);
  return p;
}

function firstText(el: Element): Text {
  return el.firstChild as Text;
}

function range(node: Text, needle: string): TextRange {
  const start = node.data.indexOf(needle);
  if (start < 0) throw new Error(`no ${needle}`);
  return { node, start, end: start + needle.length };
}

function newMasker(): Masker {
  // The hub is never started: these tests drive the split/merge logic directly,
  // which is all jsdom can do (it cannot measure client rects).
  return new Masker(new MutationHub());
}

const SENTENCE = '987-65-4321 and this inline span wraps across several lines';

describe('Masker.applyTextRanges / restore', () => {
  it('two ranges in one node round-trip exactly', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const nodes = nodeCount(root);
    const m = newMasker();
    const t = firstText(root);

    m.applyTextRanges('a', root, [range(t, '987-65-4321'), range(t, 'several')]);
    expect(root.textContent).not.toContain('987-65-4321');
    expect(root.textContent).not.toContain('several');
    expect(root.textContent).toContain('•'.repeat('987-65-4321'.length));
    // Bullets are length-preserving and splitting moves no characters.
    expect(root.textContent!.length).toBe(before.length);

    m.restore('a');
    expect(root.textContent).toBe(before);
    expect(nodeCount(root)).toBe(nodes);
  });

  it('is idempotent over many apply/restore cycles', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const nodes = nodeCount(root);
    const m = newMasker();
    for (let i = 0; i < 10; i++) {
      const t = firstText(root);
      m.applyTextRanges('a', root, [range(t, '987-65-4321')]);
      expect(root.textContent!.length).toBe(before.length);
      m.restore('a');
      expect(root.textContent).toBe(before);
      expect(nodeCount(root)).toBe(nodes);
    }
  });

  it('re-applying without restoring first does not duplicate text', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const nodes = nodeCount(root);
    const m = newMasker();
    // The same range object stays valid across a re-apply: applyTextRanges
    // restores the previous record for this id first, which puts the original
    // node's full text back before the new split.
    const r = range(firstText(root), '987-65-4321');
    m.applyTextRanges('a', root, [r]);
    m.applyTextRanges('a', root, [r]);
    expect(root.textContent!.length).toBe(before.length);
    m.restore('a');
    expect(root.textContent).toBe(before);
    expect(nodeCount(root)).toBe(nodes);
  });

  it('a second record never splits a node the first one owns', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const nodes = nodeCount(root);
    const m = newMasker();
    const t = firstText(root);
    m.applyTextRanges('a', root, [range(t, '987-65-4321')]);
    const afterFirst = root.textContent!;

    // The tail node now carries the rest of the sentence; a second sticker that
    // tries to cut it is skipped rather than fighting over the same split.
    const tail = Array.from(root.childNodes).find(
      (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data.includes('several'),
    ) as Text;
    m.applyTextRanges('b', root, [range(tail, 'several')]);
    expect(root.textContent!.length).toBe(before.length);
    expect(root.textContent).toBe(afterFirst);

    m.restore('b');
    expect(root.textContent).toBe(afterFirst);
    m.restore('a');
    expect(root.textContent).toBe(before);
    expect(nodeCount(root)).toBe(nodes);
  });

  it('restores text without duplicating when a split part was cut up underneath us', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const m = newMasker();
    m.applyTextRanges('a', root, [range(firstText(root), '987-65-4321')]);
    // Something else splits the tail: our parts are no longer the exact set of
    // consecutive siblings, so `originalData` must NOT be written back.
    const tail = root.lastChild as Text;
    tail.splitText(5);
    m.restore('a');
    expect(root.textContent).toBe(before);
  });

  it('restores text without duplicating when a part is moved away', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const m = newMasker();
    m.applyTextRanges('a', root, [range(firstText(root), '987-65-4321')]);
    const tail = root.lastChild as Text;
    const moved = tail.data;
    tail.remove();
    m.restore('a');
    expect(root.textContent).toBe(before.slice(0, before.length - moved.length));
    expect(root.textContent!.length + moved.length).toBe(before.length);
  });

  it('restore is a no-op for an unknown id and leaves the DOM alone', () => {
    const root = makeRoot(SENTENCE);
    const before = root.textContent!;
    const nodes = nodeCount(root);
    newMasker().restore('nope');
    expect(root.textContent).toBe(before);
    expect(nodeCount(root)).toBe(nodes);
  });

  it('masks ranges across sibling text nodes and restores both', () => {
    const root = makeRoot('one <b>two</b> three');
    const before = root.textContent!;
    const nodes = nodeCount(root);
    const m = newMasker();
    const first = root.firstChild as Text;
    const last = root.lastChild as Text;
    m.applyTextRanges('a', root, [range(first, 'one'), range(last, 'three')]);
    expect(root.textContent).toBe('••• two •••••');
    expect(root.textContent!.length).toBe(before.length);
    m.restore('a');
    expect(root.textContent).toBe(before);
    expect(nodeCount(root)).toBe(nodes);
  });
});
