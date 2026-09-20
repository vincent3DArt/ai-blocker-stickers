import type { Settings, ViewRect } from '@/shared/types';
import type { OverlayHost } from './host';
import { comboMatches, comboStillHeld } from '../hotkeys';

export interface PeekTarget {
  id: string;
  /** Union rect of the sticker in viewport coordinates. */
  rect: ViewRect;
  /** Element whose computed font the card copies. */
  anchor: Element | null;
  /** Original text to show; empty for input/visual mode (sticker just hides). */
  text: string;
}

export interface PeekCallbacks {
  /** Sticker under the pointer, or null. */
  hovered(): PeekTarget | null;
  /** All visible stickers. */
  all(): PeekTarget[];
  onPeek(ids: string[], on: boolean): void;
}

/**
 * Hold-to-peek. Originals are rendered inside the shadow root; the page DOM is
 * never unmasked. Ends on any modifier release, blur, tab hide, pointer leave,
 * or the hard cap.
 */
export class Peek {
  private active: PeekTarget[] = [];
  private cards: HTMLDivElement[] = [];
  private holdTimer = 0;
  private capTimer = 0;
  private mode: 'single' | 'all' | null = null;
  private disposers: Array<() => void> = [];

  constructor(
    private host: OverlayHost,
    private settings: () => Settings,
    private cb: PeekCallbacks,
  ) {}

  start() {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn, true);
      this.disposers.push(() => window.removeEventListener(type, fn, true));
    };
    on('keydown', (e) => {
      if (this.mode) return;
      const s = this.settings().peek;
      if (comboMatches(s.all, e)) this.arm('all', e);
      else if (comboMatches(s.single, e)) this.arm('single', e);
    });
    on('keyup', (e) => {
      if (!this.mode) return;
      const combo = this.mode === 'all' ? this.settings().peek.all : this.settings().peek.single;
      if (!comboStillHeld(combo, e)) this.end();
    });
    on('blur', () => this.end());
    on('mousemove', () => {
      if (this.mode === 'single' && this.active.length && !this.cb.hovered()) this.end();
    });
    document.addEventListener('visibilitychange', this.onVis);
    this.disposers.push(() => document.removeEventListener('visibilitychange', this.onVis));
  }

  stop() {
    this.end();
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  get isPeeking() {
    return this.active.length > 0;
  }

  /** Called from the positioner so cards follow scrolling. */
  reposition() {
    if (!this.active.length) return;
    const targets = this.mode === 'all' ? this.cb.all() : [this.cb.hovered()].filter((t): t is PeekTarget => !!t);
    this.active = targets.filter((t) => this.active.some((a) => a.id === t.id));
    this.renderCards();
  }

  private onVis = () => {
    if (document.hidden) this.end();
  };

  private arm(mode: 'single' | 'all', e: KeyboardEvent) {
    if (mode === 'single' && !this.cb.hovered()) return;
    if (mode === 'all') e.preventDefault();
    this.mode = mode;
    clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => this.begin(), this.settings().peek.holdDelayMs);
  }

  private begin() {
    const targets = this.mode === 'all' ? this.cb.all() : [this.cb.hovered()].filter((t): t is PeekTarget => !!t);
    if (targets.length === 0) {
      this.mode = null;
      return;
    }
    this.active = targets;
    this.renderCards();
    this.cb.onPeek(
      targets.map((t) => t.id),
      true,
    );
    clearTimeout(this.capTimer);
    this.capTimer = window.setTimeout(() => this.end(), this.settings().peek.maxHoldMs);
  }

  private end() {
    clearTimeout(this.holdTimer);
    clearTimeout(this.capTimer);
    this.holdTimer = 0;
    this.capTimer = 0;
    this.mode = null;
    if (this.active.length) {
      this.cb.onPeek(
        this.active.map((t) => t.id),
        false,
      );
    }
    this.active = [];
    this.cards.forEach((c) => c.remove());
    this.cards = [];
  }

  private renderCards() {
    while (this.cards.length < this.active.length) {
      const c = document.createElement('div');
      c.className = 'peek-card';
      c.setAttribute('aria-hidden', 'true');
      this.host.ui.appendChild(c);
      this.cards.push(c);
    }
    while (this.cards.length > this.active.length) this.cards.pop()!.remove();
    this.active.forEach((t, i) => {
      const c = this.cards[i];
      if (!t.text) {
        c.style.display = 'none';
        return;
      }
      c.style.display = '';
      c.textContent = t.text;
      c.style.transform = `translate(${Math.round(t.rect.x)}px, ${Math.round(t.rect.y)}px)`;
      c.style.minWidth = `${Math.ceil(t.rect.w)}px`;
      c.style.minHeight = `${Math.ceil(t.rect.h)}px`;
      c.style.maxWidth = `${Math.max(t.rect.w, 320)}px`;
      if (t.anchor) {
        const cs = getComputedStyle(t.anchor);
        c.style.font = cs.font;
        c.style.lineHeight = cs.lineHeight;
        c.style.textAlign = cs.textAlign;
      }
    });
  }
}
