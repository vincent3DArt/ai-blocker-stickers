import type { OverlayHost } from './host';
import { icon, type IconName } from '@/shared/icons';

export type ToolbarAction = 'pick' | 'rect' | 'selection' | 'suggestions' | 'done';

export interface ToolbarCallbacks {
  onAction(action: ToolbarAction): void;
}

/** chrome.storage.local keys: where the user dragged the toolbar, and whether the first-use hint was seen. */
const POS_KEY = 'settings.toolbarPos';
const HINT_KEY = 'settings.toolbarHint';

const HINTS: Record<'pick' | 'rect' | 'idle', Array<string | [string]>> = {
  pick: ['Hover an element and click to cover it. ', ['↑'], ' / ', ['↓'], ' parent or child, ', ['Esc'], ' cancels.'],
  rect: ['Drag a box over anything to cover it. ', ['Esc'], ' cancels.'],
  idle: ['Hover an element and click to cover it. ', ['Esc'], ' cancels.'],
};

function storage(): chrome.storage.LocalStorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

export class Toolbar {
  private wrap: HTMLDivElement;
  private el: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private buttons = new Map<ToolbarAction, HTMLButtonElement>();
  private suggestLabel: HTMLSpanElement;
  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;
  private toastFade = 0;
  private pos: { x: number; y: number } | null = null;
  private hintSeen = true;
  private active: ToolbarAction | null = null;
  /** Called whenever the toolbar is hidden (edit mode ended, or the lock came on). */
  onHidden: (() => void) | null = null;

  constructor(
    private host: OverlayHost,
    private cb: ToolbarCallbacks,
  ) {
    this.wrap = document.createElement('div');
    this.wrap.className = 'toolbar-wrap';
    this.el = document.createElement('div');
    this.el.className = 'toolbar';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'toolbar-hint';
    this.wrap.append(this.el, this.hintEl);

    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'grip';
    grip.title = 'Drag to move the toolbar';
    grip.setAttribute('aria-label', 'Move toolbar');
    grip.appendChild(icon('grip'));
    this.el.appendChild(grip);
    this.initDrag(grip);

    const add = (action: ToolbarAction, text: string, ic: IconName | null, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      if (ic) b.appendChild(icon(ic));
      const label = document.createElement('span');
      label.textContent = text;
      b.appendChild(label);
      if (cls) b.className = cls;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (action !== 'done') this.markHintSeen();
        cb.onAction(action);
      });
      this.el.appendChild(b);
      this.buttons.set(action, b);
      return label;
    };
    add('pick', 'Cover element', 'sticker');
    add('rect', 'Draw rectangle', 'rect');
    add('selection', 'Cover selection', 'textSelect');
    this.suggestLabel = add('suggestions', 'Suggestions', 'sparkle');
    this.suggestCount = document.createElement('span');
    this.suggestCount.className = 'count';
    this.buttons.get('suggestions')!.appendChild(this.suggestCount);
    this.buttons.get('suggestions')!.style.display = 'none';
    const sep = document.createElement('span');
    sep.className = 'sep';
    this.el.appendChild(sep);
    add('done', 'Done', null, 'primary');
    this.canvasHint = document.createElement('span');
    this.canvasHint.className = 'canvas-hint';
    this.canvasHint.textContent = 'Canvas page: text here is pixels. Use Draw rectangle.';

    const st = storage();
    if (st) {
      st.get([POS_KEY, HINT_KEY])
        .then((r) => {
          const p = r[POS_KEY] as { x?: unknown; y?: unknown } | undefined;
          if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            this.pos = { x: p.x, y: p.y };
            if (this.wrap.isConnected) this.applyPos();
          }
          this.hintSeen = r[HINT_KEY] === true;
          this.renderHint();
        })
        .catch(() => {});
    }
  }

  private canvasHint: HTMLSpanElement;
  private suggestCount: HTMLSpanElement;
  private canvas = false;
  private suggestionCount = 0;

  /**
   * Canvas-drawn page: Cover element and Suggestions cannot see the text, so
   * they are hidden and a one-line hint points at Draw rectangle.
   */
  setCanvas(on: boolean) {
    if (this.canvas === on) return;
    this.canvas = on;
    this.buttons.get('pick')!.style.display = on ? 'none' : '';
    this.renderHint();
    this.updateSuggestions();
  }

  get canvasMode(): boolean {
    return this.canvas;
  }

  show() {
    this.host.ui.appendChild(this.wrap);
    this.applyPos();
    this.renderHint();
    window.addEventListener('resize', this.onResize);
  }

  hide() {
    this.wrap.remove();
    this.setActive(null);
    window.removeEventListener('resize', this.onResize);
    this.onHidden?.();
  }

  /** "Suggestions (n)": hidden when there are none. Clicking steps through them. */
  setSuggestions(n: number, more = false) {
    const b = this.buttons.get('suggestions');
    if (!b) return;
    this.suggestLabel.textContent = 'Suggestions';
    this.suggestCount.textContent = `${n}${more ? '+' : ''}`;
    b.setAttribute('aria-label', `Suggestions (${n}${more ? '+' : ''})`);
    this.suggestionCount = n;
    this.updateSuggestions();
  }

  private updateSuggestions() {
    const b = this.buttons.get('suggestions');
    if (b) b.style.display = this.suggestionCount > 0 && !this.canvas ? '' : 'none';
  }

  setActive(action: ToolbarAction | null) {
    this.active = action;
    for (const [a, b] of this.buttons) b.classList.toggle('active', a === action);
    this.renderHint();
  }

  toast(text: string, ms = 2200, kind?: 'ok' | 'warn') {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'toast';
      this.toastEl.setAttribute('role', 'status');
    }
    const warn = kind ? kind === 'warn' : /could not|refused|locked|first|stay on|not /i.test(text);
    const label = document.createElement('span');
    label.textContent = text;
    this.toastEl.replaceChildren(icon(warn ? 'alert' : 'check'), label);
    this.toastEl.classList.toggle('warn', warn);
    this.toastEl.classList.remove('leaving');
    this.host.ui.appendChild(this.toastEl);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.toastFade) clearTimeout(this.toastFade);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl?.classList.add('leaving');
      this.toastFade = window.setTimeout(() => this.toastEl?.remove(), 200);
    }, ms);
  }

  // ---- hint line ----

  private renderHint() {
    if (this.canvas) {
      this.hintEl.replaceChildren(this.canvasHint);
      return;
    }
    const which = this.active === 'pick' ? 'pick' : this.active === 'rect' ? 'rect' : this.hintSeen ? null : 'idle';
    if (!which) {
      this.hintEl.replaceChildren();
      return;
    }
    const nodes = HINTS[which].map((part) => {
      if (typeof part === 'string') return document.createTextNode(part);
      const k = document.createElement('kbd');
      k.textContent = part[0];
      return k;
    });
    this.hintEl.replaceChildren(...nodes);
  }

  private markHintSeen() {
    if (this.hintSeen) return;
    this.hintSeen = true;
    storage()?.set({ [HINT_KEY]: true }).catch(() => {});
  }

  // ---- dragging ----

  private onResize = () => this.applyPos();

  private applyPos() {
    if (!this.pos) {
      this.wrap.classList.remove('placed');
      this.wrap.style.left = '';
      this.wrap.style.top = '';
      return;
    }
    const w = this.el.offsetWidth || 400;
    const h = this.el.offsetHeight || 40;
    const x = Math.round(Math.max(4, Math.min(this.pos.x, window.innerWidth - w - 4)));
    const y = Math.round(Math.max(4, Math.min(this.pos.y, window.innerHeight - h - 4)));
    this.wrap.classList.add('placed');
    this.wrap.style.left = `${x}px`;
    this.wrap.style.top = `${y}px`;
  }

  private savePos() {
    if (this.pos) storage()?.set({ [POS_KEY]: this.pos }).catch(() => {});
  }

  private initDrag(grip: HTMLButtonElement) {
    let start: { px: number; py: number; x: number; y: number } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      // Only the user's own pointer can move the toolbar.
      if (!e.isTrusted || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start || !e.isTrusted) return;
      this.pos = { x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py };
      this.applyPos();
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      start = null;
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      this.savePos();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('click', (e) => e.stopPropagation());
    // Keyboard: arrow keys nudge the toolbar, Home puts it back in the corner.
    grip.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      const step = e.shiftKey ? 48 : 16;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Home') {
        this.pos = null;
        storage()?.remove(POS_KEY).catch(() => {});
        this.applyPos();
      } else if (d[e.key]) {
        const r = this.el.getBoundingClientRect();
        this.pos = { x: r.left + d[e.key][0], y: r.top + d[e.key][1] };
        this.applyPos();
        this.savePos();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
