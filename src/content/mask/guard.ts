const OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeOldValue: false,
};

/**
 * One MutationObserver for the whole frame. Consumers register synchronous
 * listeners (the masker must re-mask inside the same microtask, before paint)
 * or debounced batch listeners (resolver, positioner, scanner).
 */
export class MutationHub {
  private mo: MutationObserver | null = null;
  private sync = new Set<(records: MutationRecord[]) => void>();
  private batches = new Map<() => void, { delay: number; timer: number }>();
  /** Shadow roots observed on top of the document (masked content lives inside them). */
  private extra = new WeakSet<Node>();

  start() {
    if (this.mo) return;
    this.mo = new MutationObserver((records) => this.dispatch(records));
    this.mo.observe(document.documentElement, OPTIONS);
  }

  /**
   * Also watch a shadow root. A document-level subtree observer never sees
   * mutations inside shadow trees, so a framework re-rendering masked text
   * there would otherwise go unnoticed.
   */
  observe(root: Node) {
    if (!this.mo || this.extra.has(root)) return;
    this.extra.add(root);
    this.mo.observe(root, OPTIONS);
  }

  stop() {
    this.mo?.disconnect();
    this.mo = null;
    this.extra = new WeakSet();
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.batches.clear();
  }

  addListener(fn: (records: MutationRecord[]) => void): () => void {
    this.sync.add(fn);
    return () => this.sync.delete(fn);
  }

  onBatch(fn: () => void, delay = 50): () => void {
    this.batches.set(fn, { delay, timer: 0 });
    return () => {
      const b = this.batches.get(fn);
      if (b?.timer) clearTimeout(b.timer);
      this.batches.delete(fn);
    };
  }

  /** Records already queued but not yet delivered, so callers can act before the callback. */
  takeRecords(): MutationRecord[] {
    return this.mo?.takeRecords() ?? [];
  }

  private dispatch(records: MutationRecord[]) {
    for (const fn of this.sync) {
      try {
        fn(records);
      } catch (e) {
        console.error('[aibs] mutation listener failed', e);
      }
    }
    for (const [fn, b] of this.batches) {
      if (b.timer) continue;
      b.timer = window.setTimeout(() => {
        b.timer = 0;
        fn();
      }, b.delay);
    }
  }
}
