import { afterEach, describe, expect, it } from 'vitest';
import { changedRun, runRegex, TextEdits } from '@/content/edit/text-edits';
import { MutationHub } from '@/content/mask/guard';
import { Masker } from '@/content/mask/masker';
import { bullets } from '@/content/mask/text-mask';
import { setPageTextSource } from '@/content/edit/page-text';

/** MutationObserver callbacks run at the microtask checkpoint; a macrotask drains them and anything they queued. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((c) => c());
  cleanup = [];
  document.body.innerHTML = '';
  document.title = '';
});

/** The content script's wiring: hub, then TextEdits, then the Masker (listener order matters). */
function setup(html: string) {
  document.body.innerHTML = html;
  const hub = new MutationHub();
  hub.start();
  const masker = new Masker(hub);
  const edits = new TextEdits(hub, (n) => masker.isMaskedNode(n));
  edits.start();
  masker.textView = (t, d) => edits.view(t, d);
  setPageTextSource({ active: () => edits.managing, text: (t) => edits.pageText(t) });
  masker.start();
  cleanup.push(() => {
    setPageTextSource(null);
    masker.stop();
    edits.stop();
    hub.stop();
  });
  return { hub, masker, edits };
}

const text = (sel: string, i = 0) => {
  const el = document.querySelector(sel)!;
  return Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE)[i] as Text;
};

describe('changedRun', () => {
  it('snaps a change inside a word to the whole word', () => {
    expect(changedRun('Hello Zelda Quarry', 'Hello Zelma Quarry')).toEqual({ orig: 'Zelda', now: 'Zelma' });
  });
  it('keeps a word-aligned change as is', () => {
    expect(changedRun('Hello Zelda Quarry', 'Hello Jane Quarry')).toEqual({ orig: 'Zelda', now: 'Jane' });
  });
  it('covers several changed words in one run', () => {
    expect(changedRun('Client: Zelda Quarry, SSN on file', 'Client: Jane Doe, SSN on file')).toEqual({ orig: 'Zelda Quarry', now: 'Jane Doe' });
  });
  it('turns a pure insertion into a run with its neighbouring word', () => {
    expect(changedRun('Hello', 'Hello there')).toEqual({ orig: 'Hello', now: 'Hello there' });
  });
  it('returns null when only whitespace changed', () => {
    expect(changedRun('  Hello   Zelda ', 'Hello Zelda')).toBeNull();
  });
  it('handles a deleted word', () => {
    expect(changedRun('Hello Zelda Quarry', 'Hello Quarry')).toEqual({ orig: 'Zelda', now: '' });
  });
  it('handles right-to-left text', () => {
    expect(changedRun('שלום זלדה קוורי', 'שלום ג׳יין קוורי')).toEqual({ orig: 'זלדה', now: 'ג׳יין' });
  });
});

describe('runRegex', () => {
  it('matches across any whitespace and never inside a longer word', () => {
    const re = runRegex('Zelda Quarry');
    expect('Hi Zelda \n Quarry!'.search(re)).toBe(3);
    expect('Zeldas Quarry'.search(re)).toBe(-1);
    expect('XZelda Quarry'.search(re)).toBe(-1);
  });
  it('escapes regex syntax', () => {
    expect('cost (est.) $5'.search(runRegex('(est.) $5'))).toBe(5);
  });
});

describe('TextEdits', () => {
  it('edits one node and keeps its surrounding whitespace and formatting', async () => {
    const { edits } = setup('<p id="p">  Hello <b>Zelda</b> Quarry  </p>');
    const t = text('#p', 0);
    edits.edit(t, 'Hi', false);
    expect(t.data).toBe('  Hi ');
    expect(document.querySelector('#p b')!.textContent).toBe('Zelda');
    expect(edits.count).toBe(1);
  });

  it('puts the edit back when the page writes the original again', async () => {
    const { edits } = setup('<p id="p">Client Zelda Quarry</p>');
    const t = text('#p');
    edits.edit(t, 'Client Jane Doe', false);
    t.data = 'Client Zelda Quarry';
    await settle();
    expect(t.data).toBe('Client Jane Doe');
    expect(edits.revertAll()).toBe(true);
    expect(t.data).toBe('Client Zelda Quarry');
  });

  it('follows a remount of the same text; other text with the run only with Every copy', async () => {
    const { edits } = setup('<p id="p">Zelda Quarry</p><p id="q"></p><p id="r"></p>');
    const p = document.querySelector('#p')!;
    edits.edit(text('#p'), 'Jane Doe', false);
    p.textContent = 'Zelda Quarry';
    document.querySelector('#q')!.textContent = 'Dear Zelda Quarry';
    await settle();
    expect(p.textContent).toBe('Jane Doe');
    expect(document.querySelector('#q')!.textContent).toBe('Dear Zelda Quarry');

    edits.revertAll();
    edits.edit(text('#p'), 'Jane Doe', true);
    document.querySelector('#r')!.innerHTML = 'Zelda Quarryson and <i>Zelda Quarry</i>';
    await settle();
    expect(document.querySelector('#q')!.textContent).toBe('Dear Jane Doe');
    expect(document.querySelector('#r')!.textContent).toBe('Zelda Quarryson and Jane Doe');
  });

  it('locked: a container swap keeps the edit only where the new text repeats its words', async () => {
    const { edits } = setup('<main id="m"><h1>Zelda Quarry</h1></main>');
    const m = document.querySelector('#m')!;
    edits.edit(text('h1'), 'Jane Doe', false);
    edits.setLocked(true);
    m.innerHTML = '<nav>Home</nav><h1>Ms. Zelda Q.</h1><p>Welcome back</p>';
    await settle();
    expect(m.textContent).toBe('HomeJane DoeWelcome back');
  });

  it('form text is never followed or rewritten as a copy', async () => {
    const { edits } = setup('<p id="p">Zelda Quarry</p><select><option>Zelda Quarry</option></select><textarea>Zelda Quarry</textarea>');
    const r = edits.edit(text('#p'), 'Jane Doe', true);
    expect(r.copies).toBe(0);
    expect(document.querySelector('option')!.textContent).toBe('Zelda Quarry');
    expect(document.querySelector('textarea')!.textContent).toBe('Zelda Quarry');
  });

  it('releases a node the page moves on from, but freezes it while locked', async () => {
    const { edits } = setup('<p id="p">Zelda Quarry</p>');
    const t = text('#p');
    edits.edit(t, 'Jane Doe', false);
    t.data = 'Loading…';
    await settle();
    expect(t.data).toBe('Loading…'); // unlocked: unrelated page text wins

    edits.revertAll();
    t.data = 'Zelda Quarry';
    await settle();
    edits.edit(t, 'Jane Doe', false);
    edits.setLocked(true);
    t.data = 'Ms. Zelda Q.';
    await settle();
    expect(t.data).toBe('Jane Doe'); // locked: a partial re-render cannot show through
    expect(edits.revertAll()).toBe(false);
    expect(t.data).toBe('Jane Doe');
    edits.setLocked(false);
    expect(t.data).toBe('Ms. Zelda Q.'); // unlocked: the page's latest text comes back
  });

  it('locked: a remount that drops the run inherits the edit', async () => {
    const { edits } = setup('<p id="p">Zelda Quarry</p>');
    const p = document.querySelector('#p')!;
    edits.edit(text('#p'), 'Jane Doe', false);
    edits.setLocked(true);
    p.textContent = 'Ms. Zelda Q.';
    await settle();
    expect(p.textContent).toBe('Jane Doe');
    edits.setLocked(false);
    expect(p.textContent).toBe('Ms. Zelda Q.');
  });

  it('every copy also rewrites the tab title; otherwise copies are counted', () => {
    document.title = 'Zelda Quarry · Clients';
    const { edits } = setup('<p id="p">Zelda Quarry</p><p id="q">Call Zelda Quarry</p>');
    const r1 = edits.edit(text('#p'), 'Jane Doe', false);
    expect(r1.remaining).toBe(2);
    edits.revertAll();
    const r2 = edits.edit(text('#p'), 'Jane Doe', true);
    expect(r2.copies).toBe(2);
    expect(document.querySelector('#q')!.textContent).toBe('Call Jane Doe');
    expect(document.title).toBe('Jane Doe · Clients');
  });

  it('editing again diffs against the page text, and typing it back reverts', () => {
    const { edits } = setup('<p id="p">Hello Zelda Quarry</p>');
    const t = text('#p');
    edits.edit(t, 'Hello Jane Quarry', false);
    edits.edit(t, 'Hello Jane Doe', false);
    expect(t.data).toBe('Hello Jane Doe');
    expect(edits.count).toBe(1);
    const r = edits.edit(t, 'Hello Zelda Quarry', false);
    expect(r.reverted).toBe(true);
    expect(t.data).toBe('Hello Zelda Quarry');
    expect(edits.count).toBe(0);
  });

  it('mirrors attributes that repeat the text and restores them on revert', async () => {
    const { edits } = setup('<a id="a" href="/c/1" title="Open Zelda Quarry" aria-label="Quarry, Zelda" data-x="keep">Zelda Quarry</a>');
    const a = document.querySelector('#a')!;
    edits.edit(text('#a'), 'Jane Doe', false);
    expect(a.getAttribute('title')).toBe('Open Jane Doe');
    expect(a.getAttribute('aria-label')).toBe(''); // the words are there, the run is not: blanked
    expect(a.getAttribute('href')).toBe('/c/1');
    expect(a.getAttribute('data-x')).toBe('keep');
    a.setAttribute('title', 'Zelda Quarry (updated)');
    await settle();
    expect(a.getAttribute('title')).toBe('Jane Doe (updated)');
    edits.revertAll();
    expect(a.getAttribute('title')).toBe('Zelda Quarry (updated)');
    expect(a.getAttribute('aria-label')).toBe('Quarry, Zelda');
  });

  it('an edit that still contains its run does not grow on remount', async () => {
    const { edits } = setup('<p id="p">Ann</p><p id="q"></p>');
    edits.edit(text('#p'), 'Ann Lee', false);
    document.querySelector('#q')!.textContent = 'Ann Lee';
    await settle();
    expect(document.querySelector('#q')!.textContent).toBe('Ann Lee');
  });
});

describe('TextEdits with the Masker', () => {
  it('a sticker over an edited node captures the edit, never the original', async () => {
    const { edits, masker } = setup('<p id="p">Zelda Quarry</p>');
    const p = document.querySelector('#p')!;
    const t = text('#p');
    edits.edit(t, 'Jane Doe', false);
    masker.apply('s1', p, 'text');
    expect(p.textContent).toBe(bullets('Jane Doe'));
    expect(masker.originals('s1')).toBe('Jane Doe');

    // The page re-renders the masked node with the real text.
    t.data = 'Zelda Quarry';
    await settle();
    expect(p.textContent).not.toContain('Zelda');
    expect(masker.originals('s1')).toBe('Jane Doe');

    // Removing the sticker writes the edit back, not the original.
    masker.restore('s1');
    await settle();
    expect(p.textContent).toBe('Jane Doe');
  });

  it('a re-rendered row under a sticker is rebound and masked in the same callback, though it repeats an edit', async () => {
    const { edits, masker } = setup('<h1>Zelda Quarry</h1><div id="list"><div class="row">Zelda Quarry</div></div>');
    const row = document.querySelector('.row')!;
    masker.apply('s1', row, 'text');
    edits.edit(text('h1'), 'Jane Doe', true);
    edits.setLocked(true);
    const fresh = document.createElement('div');
    fresh.className = 'row';
    fresh.textContent = 'Zelda Quarry';
    document.querySelector('#list')!.replaceChild(fresh, row);
    await settle();
    expect(masker.rootOf('s1')).toBe(fresh);
    expect(fresh.textContent).not.toContain('Zelda');
  });

  it('locked: a page rewrite of a node a rect sticker split never shows the original', async () => {
    const { edits, masker } = setup('<p id="p">Zelda Quarry · 5 min ago</p>');
    const p = document.querySelector('#p')!;
    const t = text('#p');
    edits.edit(t, 'Jane Doe · 5 min ago', false);
    edits.setLocked(true);
    const cover = () => {
      const node = Array.from(p.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n as Text).data.includes('min')) as Text;
      const start = node.data.indexOf('min');
      masker.applyTextRanges('r1', p, [{ node, start, end: start + 3 }]);
    };
    masker.onStale = () => cover(); // the session rescans a stale rect in the same callback
    cover();
    t.data = 'Zelda Quarry · 6 min ago';
    await settle();
    expect(p.textContent).not.toContain('Zelda');
    expect(p.textContent).toContain('Jane Doe');
  });

  it('locked: a partial re-render under a sticker does not become the sticker\'s original', async () => {
    const { edits, masker } = setup('<p id="p">Zelda Quarry</p>');
    const p = document.querySelector('#p')!;
    const t = text('#p');
    edits.edit(t, 'Jane Doe', false);
    masker.apply('s1', p, 'text');
    edits.setLocked(true);
    t.data = 'Ms. Zelda Q.';
    await settle();
    expect(masker.originals('s1')).toBe('Jane Doe');
    masker.restore('s1');
    await settle();
    expect(p.textContent).toBe('Jane Doe');
  });

  it('text inside a masked element is left to the Masker', async () => {
    const { edits, masker } = setup('<p id="p">Zelda Quarry</p><p id="q">Zelda Quarry</p>');
    masker.apply('s1', document.querySelector('#q')!, 'text');
    edits.edit(text('#p'), 'Jane Doe', true);
    expect(document.querySelector('#q')!.textContent).toBe(bullets('Zelda Quarry'));
    masker.restore('s1');
    expect(document.querySelector('#q')!.textContent).toBe('Zelda Quarry');
  });
});
