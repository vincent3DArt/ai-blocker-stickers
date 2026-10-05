import type { OverlayHost } from './host';

/** What the banner reports. Counts only: no page text ever reaches it. */
export interface BannerState {
  /** Stickers that could not find their content on this page. */
  lost: number;
  /** Lost stickers re-attached automatically by their text HMAC (low confidence). */
  reattached: number;
  /** Moved numbers covered automatically by a lost sticker's pattern backstop. */
  backstop: number;
  /** The last save failed; the store keeps retrying. */
  saveError: boolean;
}

export interface BannerCallbacks {
  /** Start the picker to re-attach the first lost sticker. */
  onReattach(): void;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * A persistent strip at the top of the viewport, inside the overlay's closed
 * shadow root (so `aria-hidden` and invisible to page readers), shown
 * whenever a sticker on this page is not covering what it was placed on, or
 * the stickers could not be saved. It is the opposite of failing silently.
 *
 * "Dismiss for this page" hides the lost/auto lines until the page is
 * reloaded or a different set of stickers goes missing; it is never stored.
 * A save error cannot be dismissed while it lasts.
 */
export class Banner {
  readonly el: HTMLDivElement;
  private msg: HTMLSpanElement;
  private reattach: HTMLButtonElement;
  private dismiss: HTMLButtonElement;
  private state: BannerState = { lost: 0, reattached: 0, backstop: 0, saveError: false };
  /** Signature of the lost/auto state the user dismissed. */
  private dismissed = '';

  constructor(
    private host: OverlayHost,
    private cb: BannerCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'banner';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.setAttribute('role', 'presentation');
    this.msg = document.createElement('span');
    this.msg.className = 'banner-msg';
    this.reattach = document.createElement('button');
    this.reattach.type = 'button';
    this.reattach.textContent = 'Re-attach';
    this.reattach.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.isTrusted) this.cb.onReattach();
    });
    this.msg.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.isTrusted && this.state.lost > 0) this.cb.onReattach();
    });
    this.dismiss = document.createElement('button');
    this.dismiss.type = 'button';
    this.dismiss.className = 'banner-dismiss';
    this.dismiss.textContent = 'Dismiss for this page';
    this.dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!e.isTrusted) return;
      this.dismissed = this.sig();
      this.render();
    });
    this.el.append(this.msg, this.reattach, this.dismiss);
  }

  private sig(): string {
    const s = this.state;
    return `${s.lost}|${s.reattached}|${s.backstop}`;
  }

  set(next: BannerState) {
    this.state = next;
    if (this.dismissed && this.dismissed !== this.sig()) this.dismissed = '';
    this.render();
  }

  /** The last few distinct texts the banner showed (tests: a short-lived message is still seen). */
  readonly shown: string[] = [];

  /** The banner's text when shown, '' when hidden (tests). */
  get text(): string {
    return this.el.isConnected ? (this.msg.textContent ?? '') : '';
  }

  /** Viewport rects of the visible buttons (tests click them for real). */
  buttons(): Record<string, { x: number; y: number; w: number; h: number }> {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    if (!this.el.isConnected) return out;
    for (const [k, b] of [
      ['reattach', this.reattach],
      ['dismiss', this.dismiss],
    ] as const) {
      const r = b.getBoundingClientRect();
      if (r.width > 0) out[k] = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return out;
  }

  private render() {
    const s = this.state;
    const lines: string[] = [];
    const hideAuto = this.dismissed === this.sig();
    if (s.saveError) lines.push('Could not save stickers on this site. Retrying; they stay on this page meanwhile.');
    if (!hideAuto) {
      if (s.lost > 0)
        lines.push(
          `${s.lost} ${plural(s.lost, "sticker couldn't find its content", "stickers couldn't find their content")} on this page. Click to re-attach.`,
        );
      if (s.reattached > 0)
        lines.push(`${s.reattached} ${plural(s.reattached, 'sticker was', 'stickers were')} re-attached automatically; check ${plural(s.reattached, 'it', 'them')}.`);
      if (s.backstop > 0)
        lines.push(`${s.backstop} moved ${plural(s.backstop, 'number was', 'numbers were')} covered automatically while a sticker is lost.`);
    }
    if (!lines.length) {
      this.el.remove();
      return;
    }
    this.msg.textContent = lines.join(' ');
    if (this.shown[this.shown.length - 1] !== this.msg.textContent) {
      this.shown.push(this.msg.textContent);
      if (this.shown.length > 10) this.shown.shift();
    }
    this.reattach.style.display = !hideAuto && s.lost > 0 ? '' : 'none';
    this.dismiss.style.display = !hideAuto && s.lost + s.reattached + s.backstop > 0 ? '' : 'none';
    if (!this.el.isConnected) this.host.ui.appendChild(this.el);
  }

  destroy() {
    this.el.remove();
  }
}
