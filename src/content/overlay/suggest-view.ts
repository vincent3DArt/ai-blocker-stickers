import type { ViewRect } from '@/shared/types';
import type { OverlayHost } from './host';
import { clientRects, union } from '../anchor/geometry';
import { matchRect, type Suggestion } from '../detect/scanner';
import { icon } from '@/shared/icons';

export interface SuggestViewCallbacks {
  onCover(id: string): void;
  onDismiss(id: string): void;
}

interface Dom {
  root: HTMLDivElement;
  pieces: HTMLDivElement[];
  chip: HTMLDivElement;
}

interface Group {
  s: Suggestion;
  /** Built the first time the suggestion is on screen: a long page may hold hundreds. */
  dom: Dom | null;
}

/**
 * Draws auto-suggest suggestions: a dashed amber outline around each match
 * (never blocks the page: `pointer-events: none`) and a small chip with
 * "Cover" and "×", the only part that takes clicks. Lives in the overlay's
 * closed shadow root, so page readers never see it. Never drawn while locked.
 */
export class SuggestView {
  private layer: HTMLDivElement;
  private groups = new Map<string, Group>();

  constructor(
    host: OverlayHost,
    private cb: SuggestViewCallbacks,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'suggestions';
    this.layer.setAttribute('aria-hidden', 'true');
    host.ui.appendChild(this.layer);
  }

  get count(): number {
    return this.groups.size;
  }

  /** Chips currently drawn in the overlay (tests: none while locked). */
  chipCount(): number {
    return this.layer.querySelectorAll('.sg-chip').length;
  }

  set(list: Suggestion[]) {
    const ids = new Set(list.map((s) => s.id));
    for (const [id, g] of this.groups) {
      if (!ids.has(id)) {
        g.dom?.root.remove();
        this.groups.delete(id);
      }
    }
    for (const s of list) {
      const g = this.groups.get(s.id);
      if (g) g.s = s;
      else this.groups.set(s.id, { s, dom: null });
    }
    this.reposition();
  }

  clear() {
    this.set([]);
  }

  reposition() {
    if (!this.groups.size) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Measure everything first, then write: interleaving a style write on the
    // overlay with the next geometry read forces a layout per suggestion.
    const measured = Array.from(this.groups.values(), (g) => ({ g, rects: this.rectsOf(g.s) }));
    for (const { g, rects } of measured) {
      const u = union(rects);
      const visible = !!u && u.x < vw && u.y < vh && u.x + u.w > 0 && u.y + u.h > 0;
      if (!visible) {
        if (g.dom) g.dom.root.style.display = 'none';
        continue;
      }
      const d = (g.dom ??= this.create(g.s));
      d.root.style.display = '';
      while (d.pieces.length < rects.length) {
        const p = document.createElement('div');
        p.className = 'sg-piece';
        d.root.insertBefore(p, d.chip);
        d.pieces.push(p);
      }
      while (d.pieces.length > rects.length) d.pieces.pop()!.remove();
      rects.forEach((r, i) => place(d.pieces[i], r, 2));
      const top = u!.y >= 22 ? u!.y - 22 : u!.y + u!.h + 2;
      d.chip.style.transform = `translate(${Math.round(Math.max(0, Math.min(u!.x, vw - 120)))}px, ${Math.round(top)}px)`;
    }
  }

  private rectsOf(s: Suggestion): ViewRect[] {
    const el = s.hit.el;
    if (!el.isConnected) return [];
    if (s.hit.wide) {
      const r = matchRect(s.hit);
      if (r) return [r];
    }
    return clientRects(el, 8);
  }

  private create(s: Suggestion): Dom {
    const root = document.createElement('div');
    root.className = 'sg';
    const chip = document.createElement('div');
    chip.className = 'sg-chip';
    const name = document.createElement('span');
    name.className = 'sg-name';
    name.append(icon('sparkle', 12), s.name);
    const cover = document.createElement('button');
    cover.type = 'button';
    cover.className = 'sg-cover';
    cover.textContent = 'Cover';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'sg-x';
    dismiss.appendChild(icon('close', 12));
    dismiss.title = 'Not sensitive';
    dismiss.setAttribute('aria-label', 'Not sensitive');
    // Trusted clicks only: a page script cannot cover or dismiss on the user's behalf.
    const on = (b: HTMLButtonElement, fn: () => void) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.isTrusted) fn();
      });
    on(cover, () => this.cb.onCover(s.id));
    on(dismiss, () => this.cb.onDismiss(s.id));
    chip.append(name, cover, dismiss);
    root.appendChild(chip);
    this.layer.appendChild(root);
    return { root, pieces: [], chip };
  }
}

function place(el: HTMLElement, r: ViewRect, pad: number) {
  el.style.transform = `translate(${Math.round(r.x - pad)}px, ${Math.round(r.y - pad)}px)`;
  el.style.width = `${Math.ceil(r.w + pad * 2)}px`;
  el.style.height = `${Math.ceil(r.h + pad * 2)}px`;
}
