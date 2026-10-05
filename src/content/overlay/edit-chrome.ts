import type { ViewRect } from '@/shared/types';
import type { OverlayHost } from './host';
import { icon, type IconName } from '@/shared/icons';

export interface EditChromeScope {
  value: string;
  label: string;
}

export interface EditChromeTarget {
  id: string;
  /** Union rect of the sticker, viewport coordinates. */
  rect: ViewRect;
  label: string;
  canExpand: boolean;
  scopes: EditChromeScope[];
  currentScope: string;
}

export interface EditChromeCallbacks {
  onDelete(id: string): void;
  onExpand(id: string): void;
  onScope(id: string, value: string): void;
}

/**
 * Edit mode: a small floating action bar over the sticker under the pointer
 * (delete, expand to the parent element, scope). Lives in the overlay's
 * closed shadow root; only trusted clicks act.
 */
export class EditChrome {
  private el: HTMLDivElement;
  private nameEl: HTMLSpanElement;
  private expandBtn: HTMLButtonElement;
  private menu: HTMLDivElement;
  private target: EditChromeTarget | null = null;
  private over = false;

  constructor(
    private host: OverlayHost,
    private cb: EditChromeCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'chrome';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.addEventListener('mouseenter', () => (this.over = true));
    this.el.addEventListener('mouseleave', () => (this.over = false));
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'name';
    this.menu = document.createElement('div');
    this.menu.className = 'menu';
    this.menu.hidden = true;
    this.expandBtn = this.button('expand', 'Expand to parent element', () => this.target && this.cb.onExpand(this.target.id));
    const scope = this.button('layers', 'Where it applies', () => {
      this.menu.hidden = !this.menu.hidden;
    });
    const del = this.button('trash', 'Delete sticker', () => this.target && this.cb.onDelete(this.target.id));
    del.classList.add('danger');
    this.el.append(this.nameEl, this.expandBtn, scope, del, this.menu);
  }

  get visible(): boolean {
    return this.el.isConnected;
  }

  /** Pointer is over the bar (or its menu): keep it up. */
  get hovering(): boolean {
    return this.over && this.visible;
  }

  get targetId(): string | null {
    return this.visible ? (this.target?.id ?? null) : null;
  }

  show(t: EditChromeTarget) {
    const same = this.target?.id === t.id && this.visible;
    this.target = t;
    this.nameEl.textContent = t.label;
    this.expandBtn.disabled = !t.canExpand;
    if (!same) this.menu.hidden = true;
    this.menu.replaceChildren(
      ...t.scopes.map((s) => {
        const b = this.button('check', '', () => {
          this.menu.hidden = true;
          if (this.target) this.cb.onScope(this.target.id, s.value);
        });
        b.removeAttribute('data-tip');
        b.append(s.label);
        b.classList.toggle('current', s.value === t.currentScope);
        return b;
      }),
    );
    if (!this.visible) this.host.ui.appendChild(this.el);
    const w = this.el.offsetWidth || 120;
    const hgt = this.el.offsetHeight || 34;
    const x = Math.max(4, Math.min(t.rect.x + t.rect.w - w, window.innerWidth - w - 4));
    const above = t.rect.y - hgt - 6;
    const y = above >= 4 ? above : Math.min(t.rect.y + t.rect.h + 6, window.innerHeight - hgt - 4);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  hide() {
    this.el.remove();
    this.menu.hidden = true;
    this.over = false;
    this.target = null;
  }

  private button(ic: IconName, tip: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.appendChild(icon(ic));
    if (tip) {
      b.dataset.tip = tip;
      b.setAttribute('aria-label', tip);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // A page script cannot delete or re-scope a sticker on the user's behalf.
      if (e.isTrusted && !b.disabled) fn();
    });
    return b;
  }
}
