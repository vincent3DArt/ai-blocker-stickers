import type { OverlayHost } from './host';
import { wheelThrough } from './wheel-through';
import type { ViewRect } from '@/shared/types';
import { union } from '../anchor/geometry';
import { shadowRootOf } from '../mask/text-mask';
import { collapse } from '../edit/text-edits';

export interface TextEditCallbacks {
  /** Why `t` cannot be edited (shown in the hover tag), or null. */
  blocked(t: Text): string | null;
  isEdited(t: Text): boolean;
  commit(t: Text, value: string, everywhere: boolean): void;
  revert(t: Text): void;
  /** Connected nodes showing an edit, outlined while the tool is on. */
  marks(): Text[];
  /** The node under an open editor was removed by the page. */
  lost(): void;
  /** Esc with no editor open. */
  onDone(): void;
  /** Label of the "every copy" checkbox ("Every copy on this page" by default). */
  everyLabel?: string;
}

function textRects(t: Text): ViewRect[] {
  const range = document.createRange();
  range.selectNodeContents(t);
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
}

const within = (x: number, y: number, r: ViewRect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * "Edit text": hover highlights the text under the pointer, a click opens a
 * field over it. The field lives in our closed shadow root, so typing never
 * runs the page's editing commands (nothing lands on its undo stack) and the
 * capture layer swallows clicks, so links and buttons never fire. Stays on
 * until Esc, like the other placement tools.
 */
export class TextEditTool {
  private capture: HTMLDivElement;
  private highlight: HTMLDivElement;
  private tag: HTMLSpanElement;
  private markLayer: HTMLDivElement;
  private editor: HTMLDivElement | null = null;
  private field: HTMLTextAreaElement | null = null;
  private every: HTMLInputElement | null = null;
  private target: Text | null = null;
  private initial = '';
  private hover: Text | null = null;
  private frame = 0;
  private disposers: Array<() => void> = [];

  constructor(
    private host: OverlayHost,
    private isOurs: (n: Node | null) => boolean,
    private cb: TextEditCallbacks,
  ) {
    this.capture = document.createElement('div');
    this.capture.className = 'capture text';
    this.highlight = document.createElement('div');
    this.highlight.className = 'highlight';
    this.highlight.style.display = 'none';
    this.tag = document.createElement('span');
    this.tag.className = 'tag';
    this.highlight.appendChild(this.tag);
    this.markLayer = document.createElement('div');
    this.markLayer.className = 'edit-marks';
  }

  get isOpen(): boolean {
    return !!this.editor;
  }

  start() {
    this.host.ui.append(this.markLayer, this.capture, this.highlight);
    // A focused page button would still take Enter or Space.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !this.isOurs(active)) active.blur?.();
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(type, fn, opts);
      this.disposers.push(() => window.removeEventListener(type, fn, opts));
    };
    this.capture.addEventListener('mousemove', (e) => this.onHover(e.clientX, e.clientY));
    this.disposers.push(wheelThrough(this.capture, this.isOurs));
    this.capture.addEventListener('mousedown', (e) => e.preventDefault());
    this.capture.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(e.clientX, e.clientY);
    });
    // Window capture runs before the page's document-level handlers: keys, focus and composition aimed at
    // our editor never reach them (focus traps, shortcuts), and the browser still types into the field.
    // Stopping here also skips our own listeners inside the shadow root, so `input` is left to bubble
    // (the editor stops it there) and Enter is handled in this listener.
    on(
      'keydown',
      (e) => {
        const ours = e.target instanceof Node && this.isOurs(e.target);
        if (e.isComposing || e.keyCode === 229) {
          if (ours) e.stopImmediatePropagation();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (this.editor) this.close();
          else this.cb.onDone();
          return;
        }
        if (ours) {
          if (e.key === 'Enter' && !e.shiftKey && this.field?.matches(':focus')) {
            e.preventDefault();
            this.save();
          }
          e.stopImmediatePropagation();
        } else if (e.key === 'Enter' || e.key === ' ') {
          // Nothing on the page may activate while the tool is on.
          e.preventDefault();
        }
      },
      { capture: true },
    );
    const mine = (e: Event) => {
      if (e.target instanceof Node && this.isOurs(e.target)) e.stopImmediatePropagation();
    };
    for (const type of ['keyup', 'keypress', 'focusin', 'focusout', 'focus', 'blur', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut'] as const)
      on(type, mine, { capture: true });
    const relayout = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.place();
        this.renderMarks();
        if (this.hover) this.show(this.hover);
      });
    };
    on('scroll', relayout, { capture: true, passive: true });
    on('resize', relayout);
    this.renderMarks();
  }

  /** Ends the tool. An open editor is saved, as if the user had clicked elsewhere, unless `save` is false. */
  stop(save = true) {
    if (save) this.save();
    else this.close();
    this.disposers.forEach((d) => d());
    this.disposers = [];
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.capture.remove();
    this.highlight.remove();
    this.markLayer.remove();
    this.hover = null;
  }

  /** Redraw the outlines after edits change outside the tool. */
  refresh() {
    this.renderMarks();
  }

  private onHover(x: number, y: number) {
    const t = this.textAt(x, y);
    this.hover = t;
    if (t) this.show(t);
    else this.highlight.style.display = 'none';
  }

  private show(t: Text) {
    const box = union(textRects(t));
    if (!box) {
      this.highlight.style.display = 'none';
      return;
    }
    this.highlight.style.display = '';
    this.highlight.style.transform = `translate(${box.x}px, ${box.y}px)`;
    this.highlight.style.width = `${box.w}px`;
    this.highlight.style.height = `${box.h}px`;
    this.highlight.classList.toggle('tag-below', box.y < 30);
    // The tag never repeats page text: it lives in our shadow root, which CDP can read.
    this.tag.textContent = this.cb.blocked(t) ?? (this.cb.isEdited(t) ? 'Edited · click to change' : 'Edit text');
  }

  private onClick(x: number, y: number) {
    this.save();
    const t = this.textAt(x, y);
    if (!t || this.cb.blocked(t)) return;
    this.open(t);
  }

  private open(t: Text) {
    this.target = t;
    this.initial = collapse(t.data);
    const box = union(textRects(t));
    const style = t.parentElement ? getComputedStyle(t.parentElement) : null;

    const editor = document.createElement('div');
    editor.className = 'text-editor';
    // Keys and clicks in the editor are ours; the page's own handlers must not see them.
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'paste'])
      editor.addEventListener(type, stop);

    const field = document.createElement('textarea');
    field.className = 'te-field';
    field.rows = 1;
    field.spellcheck = false;
    field.dir = 'auto';
    field.setAttribute('aria-label', 'Edited text');
    if (style) {
      for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textAlign'] as const) field.style[p] = style[p];
      field.style.direction = style.direction;
    }
    // 14px: the editor's padding and border, so the field never pushes the panel past the viewport.
    field.style.minWidth = `${Math.min(Math.max(120, Math.ceil(box?.w ?? 0) + 12), Math.min(640, window.innerWidth - 16) - 14)}px`;
    field.value = this.initial;
    // Enter saves: handled by the window keydown listener, which runs before anything else sees the key.
    field.addEventListener('input', () => this.place());

    const row = document.createElement('div');
    row.className = 'te-row';
    const label = document.createElement('label');
    const every = document.createElement('input');
    every.type = 'checkbox';
    every.className = 'te-every';
    label.append(every, document.createTextNode(' ' + (this.cb.everyLabel ?? 'Every copy on this page')));
    row.appendChild(label);
    if (this.cb.isEdited(t)) {
      const revert = document.createElement('button');
      revert.type = 'button';
      revert.className = 'te-revert';
      revert.textContent = 'Revert';
      revert.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        const node = this.target;
        this.close();
        if (node) this.cb.revert(node);
        this.renderMarks();
      });
      row.appendChild(revert);
    }
    const keys = document.createElement('span');
    keys.className = 'te-keys';
    keys.textContent = 'Enter saves · Esc cancels';
    row.appendChild(keys);

    editor.append(field, row);
    this.host.ui.appendChild(editor);
    this.editor = editor;
    this.field = field;
    this.every = every;
    this.place();
    field.focus();
    field.select();
  }

  /** Keep the editor over its text as the page scrolls; close it if the page removed the text. */
  private place() {
    if (!this.editor || !this.target) return;
    if (!this.target.isConnected) {
      this.close();
      this.cb.lost();
      return;
    }
    const box = union(textRects(this.target));
    if (!box) return;
    const w = this.editor.offsetWidth;
    const h = this.editor.offsetHeight;
    const left = Math.max(8, Math.min(box.x - 6, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(box.y - 6, window.innerHeight - h - 8));
    this.editor.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  private save() {
    if (!this.editor || !this.target || !this.field) return;
    const t = this.target;
    const value = this.field.value;
    const everywhere = !!this.every?.checked;
    this.close();
    if (!t.isConnected) return this.cb.lost();
    if (collapse(value) === this.initial && !everywhere) return;
    this.cb.commit(t, value, everywhere);
    this.renderMarks();
  }

  private close() {
    this.editor?.remove();
    this.editor = null;
    this.field = null;
    this.every = null;
    this.target = null;
  }

  private renderMarks() {
    const boxes = this.cb
      .marks()
      .map((t) => union(textRects(t)))
      .filter((b): b is ViewRect => !!b);
    this.markLayer.replaceChildren(
      ...boxes.map((b) => {
        const m = document.createElement('div');
        m.className = 'edit-mark';
        m.style.transform = `translate(${b.x}px, ${b.y}px)`;
        m.style.width = `${b.w}px`;
        m.style.height = `${b.h}px`;
        return m;
      }),
    );
  }

  /** The text node under the pointer, looking through open (and extension-visible) shadow roots. */
  private textAt(x: number, y: number): Text | null {
    this.capture.style.pointerEvents = 'none';
    let el: Element | null;
    try {
      el = document.elementsFromPoint(x, y).find((e) => !this.isOurs(e) && e !== document.documentElement && e !== document.body) ?? null;
    } finally {
      this.capture.style.pointerEvents = '';
    }
    for (let depth = 0; el && depth < 8; depth++) {
      const sr = shadowRootOf(el);
      const inner = sr?.elementsFromPoint(x, y).find((e) => e !== el && !this.isOurs(e) && sr.contains(e));
      if (!inner) break;
      el = inner;
    }
    if (!el) return null;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== Node.TEXT_NODE || !/\S/.test((n as Text).data)) continue;
      if (textRects(n as Text).some((r) => within(x, y, r))) return n as Text;
    }
    return null;
  }
}
