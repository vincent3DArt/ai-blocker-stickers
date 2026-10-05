// Shared helpers for the stress fixtures (tests/e2e/stress.spec.ts).
// Every fixture defines window.__fx = { actions, run(name), target(), secrets() }.
// `target()` returns { el, secret, offset } where `el` is the covered element's
// box and `secret` the box of the secret characters, both in the viewport of
// the frame that holds them, and `offset` that frame's origin in the top
// page. It returns null while the target is not in the DOM.
(function () {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function boxOf(el) {
    const rs = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    const x1 = Math.min(...rs.map((r) => r.left));
    const y1 = Math.min(...rs.map((r) => r.top));
    const x2 = Math.max(...rs.map((r) => r.right));
    const y2 = Math.max(...rs.map((r) => r.bottom));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /**
   * Box of the `k`-th whitespace-separated token of `el`'s text. Masking
   * keeps whitespace and length, so the token is found whether or not its
   * characters are bullets right now.
   */
  function tokenBox(el, k) {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let all = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ n, start: all.length });
      all += n.data;
    }
    const re = /\S+/g;
    let m;
    let i = 0;
    let at = -1;
    let end = -1;
    while ((m = re.exec(all))) {
      if (i++ === k) {
        at = m.index;
        end = at + m[0].length;
        break;
      }
    }
    if (at < 0) return null;
    const range = el.ownerDocument.createRange();
    let set = false;
    for (const { n, start } of nodes) {
      const e = start + n.data.length;
      if (!set && at >= start && at < e) {
        range.setStart(n, at - start);
        set = true;
      }
      if (set && end > start && end <= e) {
        range.setEnd(n, end - start);
        break;
      }
    }
    if (!set) return null;
    const rs = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    const x1 = Math.min(...rs.map((r) => r.left));
    const y1 = Math.min(...rs.map((r) => r.top));
    const x2 = Math.max(...rs.map((r) => r.right));
    const y2 = Math.max(...rs.map((r) => r.bottom));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }


  /** Origin of an iframe's content box in the top page's viewport. */
  function frameOffset(win) {
    let x = 0;
    let y = 0;
    let w = win;
    while (w !== w.top) {
      const fe = w.frameElement;
      const r = fe.getBoundingClientRect();
      x += r.left + fe.clientLeft;
      y += r.top + fe.clientTop;
      w = w.parent;
    }
    return { x, y };
  }

  /** Scroll `el` into view when it is not fully inside the viewport, then let layout settle. */
  async function reveal(el) {
    const b = boxOf(el);
    const win = el.ownerDocument.defaultView;
    if (b && b.x >= 0 && b.y >= 0 && b.x + b.w <= win.innerWidth && b.y + b.h <= win.innerHeight) return;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await frames();
  }

  /** Standard target(): the secret is token `k` of `el`'s text. */
  async function targetFor(el, k = 2) {
    if (!el || !el.isConnected) return null;
    await reveal(el);
    const box = boxOf(el);
    const secret = tokenBox(el, k);
    if (!box || !secret) return null;
    return { el: box, secret, offset: frameOffset(el.ownerDocument.defaultView) };
  }

  window.__stress = { wait, frames, boxOf, tokenBox, frameOffset, reveal, targetFor };
})();
