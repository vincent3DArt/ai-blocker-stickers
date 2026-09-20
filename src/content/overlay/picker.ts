import type { OverlayHost } from './host';
import { clientRects, union } from '../anchor/geometry';

export interface PickerCallbacks {
  onPick(el: Element): void;
  onCancel(): void;
}

/**
 * Hover-to-highlight element picker. ArrowUp expands to the parent, ArrowDown
 * shrinks to the first child with text, Escape cancels, click picks.
 */
export class Picker {
  private capture: HTMLDivElement;
  private highlight: HTMLDivElement;
  private tag: HTMLSpanElement;
  private current: Element | null = null;
  private hoverBase: Element | null = null;
  private disposers: Array<() => void> = [];

  constructor(
    private host: OverlayHost,
    private isOurs: (n: Node | null) => boolean,
    private cb: PickerCallbacks,
  ) {
    this.capture = document.createElement('div');
    this.capture.className = 'capture';
    this.highlight = document.createElement('div');
    this.highlight.className = 'highlight';
    this.highlight.style.display = 'none';
    this.tag = document.createElement('span');
    this.tag.className = 'tag';
    this.highlight.appendChild(this.tag);
  }

  start() {
    this.host.ui.append(this.capture, this.highlight);
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(type, fn, opts);
      this.disposers.push(() => window.removeEventListener(type, fn, opts));
    };
    const onMove = (e: MouseEvent) => {
      const el = this.elementAt(e.clientX, e.clientY);
      if (el && el !== this.hoverBase) {
        this.hoverBase = el;
        this.set(el);
      }
    };
    this.capture.addEventListener('mousemove', onMove);
    this.capture.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.current) this.cb.onPick(this.current);
    });
    on(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.cb.onCancel();
        } else if (e.key === 'ArrowUp' && this.current?.parentElement && this.current.parentElement !== document.documentElement) {
          e.preventDefault();
          this.set(this.current.parentElement);
        } else if (e.key === 'ArrowDown' && this.current) {
          e.preventDefault();
          const child = Array.from(this.current.children).find((c) => /\S/.test(c.textContent ?? '') && !this.isOurs(c));
          if (child) this.set(child);
        }
      },
      { capture: true },
    );
    on('scroll', () => this.current && this.set(this.current), { capture: true, passive: true });
  }

  stop() {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.capture.remove();
    this.highlight.remove();
    this.current = null;
    this.hoverBase = null;
  }

  private elementAt(x: number, y: number): Element | null {
    this.capture.style.pointerEvents = 'none';
    try {
      const els = document.elementsFromPoint(x, y);
      return els.find((e) => !this.isOurs(e) && e !== document.documentElement && e !== document.body) ?? null;
    } finally {
      this.capture.style.pointerEvents = '';
    }
  }

  private set(el: Element) {
    this.current = el;
    const box = union(clientRects(el));
    if (!box) {
      this.highlight.style.display = 'none';
      return;
    }
    this.highlight.style.display = '';
    this.highlight.style.transform = `translate(${box.x}px, ${box.y}px)`;
    this.highlight.style.width = `${box.w}px`;
    this.highlight.style.height = `${box.h}px`;
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
    this.tag.textContent = `${el.tagName.toLowerCase()}${id}${cls}  (↑ parent, ↓ child, Esc)`;
  }
}
