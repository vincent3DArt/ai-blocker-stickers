/**
 * URL change detection that works from the isolated world. Patching
 * history.pushState here would not see the page's calls, so we rely on the
 * Navigation API (its events reach isolated-world listeners), popstate,
 * hashchange, and an href comparison from the positioner's slow tick.
 */
export class SpaNav {
  private lastHref = location.href;
  private listeners = new Set<(url: URL, prev: URL) => void>();
  private disposers: Array<() => void> = [];

  start() {
    const check = () => this.check();
    const on = (target: EventTarget, type: string) => {
      target.addEventListener(type, check);
      this.disposers.push(() => target.removeEventListener(type, check));
    };
    const nav = (window as unknown as { navigation?: EventTarget }).navigation;
    if (nav) {
      on(nav, 'navigatesuccess');
      on(nav, 'currententrychange');
    }
    on(window, 'popstate');
    on(window, 'hashchange');
  }

  stop() {
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  onChange(fn: (url: URL, prev: URL) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called from the slow tick and after mutation batches. */
  check() {
    if (location.href === this.lastHref) return;
    const prev = new URL(this.lastHref);
    this.lastHref = location.href;
    const next = new URL(location.href);
    this.listeners.forEach((l) => l(next, prev));
  }
}
