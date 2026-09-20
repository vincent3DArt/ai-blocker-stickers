/**
 * Schedules sticker recomputation. Any layout-affecting signal marks the
 * positioner dirty; the actual work runs once per animation frame. A slow
 * tick catches anything that has no event (e.g. compositor-only changes) and
 * runs the host watchdog.
 */
export class Positioner {
  private dirty = false;
  private raf = 0;
  private slow = 0;
  private ro: ResizeObserver | null = null;
  private observed = new Set<Element>();
  private disposers: Array<() => void> = [];
  private running = false;

  constructor(
    private recompute: () => void,
    private slowTick: () => void,
    private slowIntervalMs = 300,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    const mark = () => this.markDirty();
    const on = (target: EventTarget, type: string, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, mark, opts);
      this.disposers.push(() => target.removeEventListener(type, mark, opts));
    };
    on(window, 'scroll', { capture: true, passive: true });
    on(window, 'resize', { passive: true });
    on(window, 'load');
    on(window, 'orientationchange');
    on(document, 'transitionend', { capture: true, passive: true });
    on(document, 'animationend', { capture: true, passive: true });
    on(document, 'toggle', { capture: true });
    if (window.visualViewport) {
      on(window.visualViewport, 'resize', { passive: true });
      on(window.visualViewport, 'scroll', { passive: true });
    }
    document.fonts?.ready.then(mark).catch(() => {});

    this.ro = new ResizeObserver(() => this.markDirty());
    this.ro.observe(document.documentElement);
    if (document.body) this.ro.observe(document.body);

    this.slow = window.setInterval(() => {
      if (document.hidden) return;
      this.slowTick();
      this.recompute();
    }, this.slowIntervalMs);
    this.markDirty();
  }

  stop() {
    this.running = false;
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.ro?.disconnect();
    this.ro = null;
    this.observed.clear();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.slow) clearInterval(this.slow);
    this.slow = 0;
  }

  observe(el: Element) {
    if (!this.ro || this.observed.has(el)) return;
    this.observed.add(el);
    this.ro.observe(el);
  }

  unobserve(el: Element) {
    if (!this.ro || !this.observed.has(el)) return;
    this.observed.delete(el);
    this.ro.unobserve(el);
  }

  markDirty() {
    if (!this.running) return;
    this.dirty = true;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.dirty) return;
      this.dirty = false;
      this.recompute();
    });
  }

  /** Synchronous recompute, used right after placing or resolving a sticker. */
  flush() {
    this.dirty = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.recompute();
  }
}
