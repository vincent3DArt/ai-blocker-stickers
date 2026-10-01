/**
 * Idle-time scheduling for the scanner.
 *
 * Work runs in `requestIdleCallback` chunks, each bounded by the idle
 * deadline and by `CHUNK_MS`, so no chunk becomes a long task (> 50 ms). The
 * callback has a timeout, so a page that is never idle (or a hidden tab,
 * where idle callbacks are throttled) still gets scanned, just more slowly.
 */

/** Hard cap per chunk (one `step` call), whatever the idle deadline offers. */
export const CHUNK_MS = 10;
/** Hard cap per idle callback (one task), well under the 50 ms long-task line. */
export const CALLBACK_MS = 30;

type IdleDeadlineLike = { timeRemaining(): number; didTimeout: boolean };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** requestIdleCallback with a timeout, or a timer where it does not exist (jsdom). */
export function onIdle(cb: (d: IdleDeadlineLike) => void, timeout = 500): () => void {
  const w = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const h = w.requestIdleCallback(cb, { timeout });
    return () => w.cancelIdleCallback?.(h);
  }
  const t = setTimeout(() => cb({ timeRemaining: () => CHUNK_MS, didTimeout: true }), 1);
  return () => clearTimeout(t);
}

/**
 * Runs `step` in idle chunks until it returns false. `step` gets a `timeUp()`
 * predicate and should return as soon as it answers true.
 */
export class IdleJob {
  private cancelIdle: (() => void) | null = null;
  private stopped = false;

  constructor(
    private step: (timeUp: () => boolean) => boolean,
    private onDone: () => void = () => {},
  ) {}

  start() {
    this.schedule();
  }

  cancel() {
    this.stopped = true;
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  get running(): boolean {
    return !this.stopped;
  }

  private schedule() {
    if (this.stopped) return;
    this.cancelIdle = onIdle((d) => {
      this.cancelIdle = null;
      if (this.stopped) return;
      // One idle period can take several chunks: as many as fit in what the
      // browser offers, never more than CALLBACK_MS in one task.
      const start = now();
      const budget = d.didTimeout ? CHUNK_MS : Math.min(CALLBACK_MS, Math.max(1, d.timeRemaining() - 1));
      const until = start + budget;
      let more = false;
      try {
        do {
          const chunkEnd = Math.min(until, now() + CHUNK_MS);
          more = this.step(() => now() >= chunkEnd);
        } while (more && !this.stopped && now() < until - 1);
      } catch (e) {
        console.error('[aibs] scan chunk failed', e);
        more = false;
      }
      if (more) this.schedule();
      else {
        this.stopped = true;
        this.onDone();
      }
    });
  }
}

/**
 * Viewport-first ordering. Candidates are observed with an
 * IntersectionObserver while they are collected; the ones reported visible
 * are processed first. The observer only ever reorders work: in a hidden tab
 * it never fires and everything runs in document order.
 */
export class ViewportOrder<T extends { el: Element }> {
  private io: IntersectionObserver | null = null;
  private visible = new Set<Element>();
  private queue: T[] = [];
  private byEl = new Map<Element, T>();
  private taken = new Set<T>();
  private head = 0;
  private observed = 0;

  constructor(private maxObserved = 1000) {
    if (typeof IntersectionObserver === 'function') {
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.visible.add(e.target);
      });
    }
  }

  push(item: T) {
    this.queue.push(item);
    if (!this.byEl.has(item.el)) this.byEl.set(item.el, item);
    if (this.io && this.observed < this.maxObserved) {
      this.observed++;
      this.io.observe(item.el);
    }
  }

  get size(): number {
    return this.queue.length - this.taken.size;
  }

  /** Next item: a visible one if any is known, else the next in document order. */
  take(): T | undefined {
    if (this.visible.size) {
      for (const el of this.visible) {
        this.visible.delete(el);
        const item = this.byEl.get(el);
        if (item && !this.taken.has(item)) {
          this.taken.add(item);
          return item;
        }
      }
    }
    while (this.head < this.queue.length) {
      const item = this.queue[this.head++];
      if (!this.taken.has(item)) {
        this.taken.add(item);
        return item;
      }
    }
    return undefined;
  }

  /** Stop observing: collection is over, the order is settled. */
  settle() {
    this.io?.disconnect();
    this.io = null;
  }

  dispose() {
    this.settle();
    this.queue = [];
    this.taken.clear();
    this.byEl.clear();
    this.visible.clear();
  }
}
