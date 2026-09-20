import type { AnchorStatus, Confidence, Sticker, ViewRect } from '@/shared/types';
import type { OverlayHost } from './host';

export interface StickerViewOptions {
  showLabel: boolean;
  onGhostClick?: (sticker: Sticker) => void;
}

/**
 * Renders one sticker as N opaque pieces (one per client rect of the anchor).
 * Positioning is done with transform + width/height so updates never trigger
 * layout on the page.
 */
export class StickerView {
  readonly el: HTMLDivElement;
  private pieces: HTMLDivElement[] = [];
  private status: AnchorStatus = 'resolving';
  private confidence: Confidence = 'high';
  private peeking = false;
  private editing = false;
  private lastRects: ViewRect[] = [];

  constructor(
    private host: OverlayHost,
    public sticker: Sticker,
    private opts: StickerViewOptions,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'sticker';
    this.el.dataset.id = sticker.id;
    this.el.setAttribute('aria-hidden', 'true');
    host.layer.appendChild(this.el);
  }

  get rects(): ViewRect[] {
    return this.lastRects;
  }

  update(rects: ViewRect[], status: AnchorStatus, confidence: Confidence = 'high') {
    this.status = status;
    this.confidence = confidence;
    this.lastRects = rects;
    while (this.pieces.length < rects.length) this.pieces.push(this.createPiece());
    while (this.pieces.length > rects.length) this.pieces.pop()!.remove();
    rects.forEach((r, i) => {
      const p = this.pieces[i];
      const pad = this.sticker.padding;
      p.style.transform = `translate(${Math.round(r.x - pad)}px, ${Math.round(r.y - pad)}px)`;
      p.style.width = `${Math.ceil(r.w + pad * 2)}px`;
      p.style.height = `${Math.ceil(r.h + pad * 2)}px`;
      p.classList.toggle('lost', status === 'lost');
      p.classList.toggle('low', status === 'resolved' && confidence === 'low');
      p.classList.toggle('peek', this.peeking);
      const label = p.querySelector<HTMLSpanElement>('.label');
      if (label) {
        const text = status === 'lost' ? 'sticker lost, click to re-attach' : i === 0 ? this.labelText() : '';
        label.textContent = text;
        label.style.display = text && r.w >= 40 && r.h >= 12 ? '' : 'none';
      }
    });
    this.el.classList.toggle('edit', this.editing);
  }

  hide() {
    this.update([], this.status, this.confidence);
  }

  setPeeking(on: boolean) {
    this.peeking = on;
    this.pieces.forEach((p) => p.classList.toggle('peek', on));
  }

  setEditing(on: boolean) {
    this.editing = on;
    this.el.classList.toggle('edit', on);
  }

  setSticker(s: Sticker) {
    this.sticker = s;
  }

  contains(node: Node | null): boolean {
    return !!node && this.el.contains(node);
  }

  destroy() {
    this.el.remove();
    this.pieces = [];
  }

  private labelText(): string {
    if (!this.opts.showLabel) return '';
    return this.sticker.label ?? '';
  }

  private createPiece(): HTMLDivElement {
    const p = document.createElement('div');
    p.className = 'piece';
    p.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'label';
    p.appendChild(label);
    p.addEventListener('click', (e) => {
      if (this.status === 'lost') {
        e.stopPropagation();
        this.opts.onGhostClick?.(this.sticker);
      }
    });
    this.el.appendChild(p);
    return p;
  }
}
