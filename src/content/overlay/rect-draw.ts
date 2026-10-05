import type { ViewRect } from '@/shared/types';
import type { OverlayHost } from './host';

export interface RectDrawCallbacks {
  onDraw(rect: ViewRect): void;
  onCancel(): void;
}

/** Drag a rectangle on a capture layer. Escape cancels; tiny drags are ignored. */
export class RectDraw {
  private capture: HTMLDivElement;
  private box: HTMLDivElement;
  private tag: HTMLSpanElement;
  private start: { x: number; y: number } | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cb.onCancel();
    }
  };

  constructor(
    private host: OverlayHost,
    private cb: RectDrawCallbacks,
  ) {
    this.capture = document.createElement('div');
    this.capture.className = 'capture';
    this.box = document.createElement('div');
    this.box.className = 'drawbox';
    this.box.style.display = 'none';
    this.tag = document.createElement('span');
    this.tag.className = 'tag';
    this.box.appendChild(this.tag);
  }

  begin() {
    this.host.ui.append(this.capture, this.box);
    this.capture.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.start = { x: e.clientX, y: e.clientY };
      this.render(e.clientX, e.clientY);
    });
    this.capture.addEventListener('mousemove', (e) => {
      if (this.start) this.render(e.clientX, e.clientY);
    });
    this.capture.addEventListener('mouseup', (e) => {
      if (!this.start) return;
      const r = this.rectFrom(e.clientX, e.clientY);
      this.start = null;
      this.box.style.display = 'none';
      if (r.w < 6 || r.h < 6) return;
      this.cb.onDraw(r);
    });
    window.addEventListener('keydown', this.onKey, true);
  }

  end() {
    window.removeEventListener('keydown', this.onKey, true);
    this.capture.remove();
    this.box.remove();
    this.start = null;
  }

  private rectFrom(x: number, y: number): ViewRect {
    const s = this.start!;
    return {
      x: Math.min(s.x, x),
      y: Math.min(s.y, y),
      w: Math.abs(x - s.x),
      h: Math.abs(y - s.y),
    };
  }

  private render(x: number, y: number) {
    const r = this.rectFrom(x, y);
    this.box.style.display = '';
    this.box.style.transform = `translate(${r.x}px, ${r.y}px)`;
    this.box.style.width = `${r.w}px`;
    this.box.style.height = `${r.h}px`;
    this.box.classList.toggle('tag-below', r.y < 30);
    this.tag.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}   Esc cancels`;
  }
}
