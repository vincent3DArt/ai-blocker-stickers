import type { OverlayHost } from './host';

export type ToolbarAction = 'pick' | 'rect' | 'selection' | 'suggestions' | 'done';

export interface ToolbarCallbacks {
  onAction(action: ToolbarAction): void;
}

export class Toolbar {
  private el: HTMLDivElement;
  private buttons = new Map<ToolbarAction, HTMLButtonElement>();
  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;

  constructor(
    private host: OverlayHost,
    private cb: ToolbarCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'toolbar';
    const add = (action: ToolbarAction, text: string, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (cls) b.className = cls;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onAction(action);
      });
      this.el.appendChild(b);
      this.buttons.set(action, b);
    };
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Stickers';
    this.el.appendChild(hint);
    add('pick', 'Cover element');
    add('rect', 'Draw rectangle');
    add('selection', 'Cover selection');
    add('suggestions', 'Suggestions (0)');
    this.buttons.get('suggestions')!.style.display = 'none';
    add('done', 'Done', 'primary');
  }

  show() {
    this.host.ui.appendChild(this.el);
  }

  hide() {
    this.el.remove();
    this.setActive(null);
  }

  /** "Suggestions (n)": hidden when there are none. Clicking steps through them. */
  setSuggestions(n: number, more = false) {
    const b = this.buttons.get('suggestions');
    if (!b) return;
    b.textContent = `Suggestions (${n}${more ? '+' : ''})`;
    b.style.display = n > 0 ? '' : 'none';
  }

  setActive(action: ToolbarAction | null) {
    for (const [a, b] of this.buttons) b.classList.toggle('active', a === action);
  }

  toast(text: string, ms = 2200) {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'toast';
    }
    this.toastEl.textContent = text;
    this.host.ui.appendChild(this.toastEl);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl?.remove(), ms);
  }
}
