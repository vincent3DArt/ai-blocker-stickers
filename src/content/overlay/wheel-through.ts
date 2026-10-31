/**
 * Tool capture layers cover the viewport, so the wheel hits them instead of
 * the page. The browser still scrolls the document from there, but never an
 * inner scroller (app shells, mail panes, the PDF viewer). Find the scroller
 * under the pointer and scroll it ourselves; the document is left to the
 * browser's default.
 */
export function wheelThrough(capture: HTMLElement, isOurs: (n: Node | null) => boolean): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // pinch / ctrl+wheel zoom
    const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const target = scrollerAt(capture, isOurs, e.clientX, e.clientY, dx, dy);
    if (!target) return;
    e.preventDefault();
    target.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  };
  capture.addEventListener('wheel', onWheel, { passive: false });
  return () => capture.removeEventListener('wheel', onWheel);
}

function scrollerAt(
  capture: HTMLElement,
  isOurs: (n: Node | null) => boolean,
  x: number,
  y: number,
  dx: number,
  dy: number,
): Element | null {
  capture.style.pointerEvents = 'none';
  let el: Element | null;
  try {
    el = document.elementsFromPoint(x, y).find((e) => !isOurs(e)) ?? null;
    // Descend into open shadow roots so their inner scrollers are found too.
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementsFromPoint(x, y)[0];
      if (!inner || inner === el) break;
      el = inner;
    }
  } finally {
    capture.style.pointerEvents = '';
  }
  const root = document.scrollingElement;
  for (; el; el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null)) {
    if (el === root || el === document.body || el === document.documentElement) return null;
    if (canScroll(el, dx, dy)) return el;
  }
  return null;
}

function canScroll(el: Element, dx: number, dy: number): boolean {
  const cs = getComputedStyle(el);
  const scrollable = (o: string) => o === 'auto' || o === 'scroll' || o === 'overlay';
  if (dy && scrollable(cs.overflowY) && el.scrollHeight > el.clientHeight) {
    if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
  }
  if (dx && scrollable(cs.overflowX) && el.scrollWidth > el.clientWidth) {
    // RTL scrollers run from -(range) to 0.
    const range = el.scrollWidth - el.clientWidth;
    const [min, max] = cs.direction === 'rtl' ? [-range, 0] : [0, range];
    if (dx > 0 ? el.scrollLeft < max - 1 : el.scrollLeft > min + 1) return true;
  }
  return false;
}
