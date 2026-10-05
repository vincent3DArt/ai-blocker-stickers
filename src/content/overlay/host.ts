import css from './styles.css?inline';

export interface OverlayHost {
  readonly el: HTMLElement;
  readonly root: ShadowRoot;
  /** Sticker pieces live here. */
  readonly layer: HTMLElement;
  /** Edit-mode chrome (toolbar, highlights, handles) lives here. */
  readonly ui: HTMLElement;
  /** True for our host element and anything inside its shadow tree. */
  isOurs(node: Node | null | undefined): boolean;
  /** Re-mount and re-promote to the top layer if the page displaced us. */
  reassert(): void;
  setColor(color: string): void;
  destroy(): void;
}

const TAG = 'aibs-host';
const DEFAULT_COLOR = '#1f2937';

const HOST_ATTRS: Array<[string, string]> = [
  ['popover', 'manual'],
  ['aria-hidden', 'true'],
  ['role', 'presentation'],
  ['data-aibs', ''],
];

export function mountHost(): OverlayHost {
  const el = document.createElement(TAG);
  for (const [a, v] of HOST_ATTRS) el.setAttribute(a, v);
  let color = '';
  let fallbackZ = false;
  let expectedStyle: string | null = null;
  /** (Re)write every inline declaration; afterwards the attribute is known to be ours. */
  function styleHost() {
    applyHostStyle(el);
    // !important: an inline normal declaration loses to a page's `aibs-host{--aibs-color:… !important}`.
    if (color) el.style.setProperty('--aibs-color', color, 'important');
    if (fallbackZ) el.style.setProperty('z-index', '2147483647', 'important');
    expectedStyle = el.getAttribute('style');
  }
  styleHost();

  const root = el.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }
  const layer = document.createElement('div');
  layer.id = 'layer';
  layer.setAttribute('aria-hidden', 'true');
  const ui = document.createElement('div');
  ui.id = 'ui';
  ui.setAttribute('aria-hidden', 'true');
  root.append(layer, ui);
  /**
   * The colour pieces actually paint with lives on #layer, inside the closed
   * shadow root, where no page rule can reach. Custom properties inherit
   * through the host, so reading `--aibs-color` from the host would let a
   * page stylesheet make every sticker transparent.
   */
  const setPieceColor = (c: string) => layer.style.setProperty('--aibs-piece', c || DEFAULT_COLOR, 'important');
  setPieceColor('');

  let usingTopLayer = false;
  let lastTopLayerSignature = '';
  let selfHiding = false;
  let destroyed = false;

  function mount() {
    if (!el.isConnected) document.documentElement.appendChild(el);
    if (el.parentElement !== document.documentElement) document.documentElement.appendChild(el);
    promote();
  }

  function promote() {
    try {
      if (usingTopLayer && el.matches(':popover-open')) {
        selfHiding = true;
        try {
          el.hidePopover();
        } finally {
          selfHiding = false;
        }
      }
      el.showPopover();
      usingTopLayer = true;
      if (fallbackZ) {
        fallbackZ = false;
        styleHost();
      }
    } catch {
      usingTopLayer = false;
      if (!fallbackZ) {
        fallbackZ = true;
        styleHost();
      }
    }
  }

  // The page (or a script injected into it) can take the overlay away:
  // remove the host, close its popover, strip `popover`, or restyle it. Undo
  // each of those in the same microtask, before the next frame is painted,
  // instead of waiting for the positioner's slow tick. Page STYLESHEETS lose to
  // the host's inline !important declarations and need no watching.
  el.addEventListener('beforetoggle', (e) => {
    if (destroyed || selfHiding || (e as Event & { newState?: string }).newState !== 'closed') return;
    queueMicrotask(() => {
      if (!destroyed && !el.matches(':popover-open')) promote();
    });
  });
  const watchdog = new MutationObserver((records) => {
    if (destroyed) return;
    let remount = false;
    let restyle = false;
    let reattr = false;
    for (const r of records) {
      if (r.type === 'childList') remount = true;
      else if (r.attributeName === 'style') restyle = el.getAttribute('style') !== expectedStyle;
      else if (r.attributeName) reattr = true;
    }
    if (reattr) {
      for (const [a, v] of HOST_ATTRS) if (el.getAttribute(a) !== v) el.setAttribute(a, v);
      for (const a of ['hidden', 'inert']) if (el.hasAttribute(a)) el.removeAttribute(a);
      promote();
    }
    if (restyle) styleHost();
    if (remount && el.parentElement !== document.documentElement) mount();
  });
  watchdog.observe(document.documentElement, { childList: true });
  watchdog.observe(el, { attributes: true, attributeFilter: ['style', ...HOST_ATTRS.map(([a]) => a), 'hidden', 'inert'] });

  function topLayerSignature(): string {
    // Anything the page pushed into the top layer after us stacks above us.
    const nodes = document.querySelectorAll(':modal, :popover-open, :fullscreen');
    let sig = '';
    nodes.forEach((n) => {
      if (n !== el) sig += n.tagName + '|';
    });
    return sig;
  }

  function reassert() {
    if (!el.isConnected || el.parentElement !== document.documentElement) {
      mount();
      return;
    }
    const sig = topLayerSignature();
    if (sig !== lastTopLayerSignature) {
      lastTopLayerSignature = sig;
      promote();
    } else if (usingTopLayer && !el.matches(':popover-open')) {
      promote();
    }
  }

  mount();
  lastTopLayerSignature = topLayerSignature();

  return {
    el,
    root,
    layer,
    ui,
    isOurs(node) {
      if (!node) return false;
      if (node === el) return true;
      const r = (node as Node).getRootNode?.();
      return r === root;
    },
    reassert,
    setColor(c) {
      color = c;
      setPieceColor(c);
      styleHost();
    },
    destroy() {
      destroyed = true;
      watchdog.disconnect();
      try {
        if (el.matches(':popover-open')) el.hidePopover();
      } catch {
        /* ignore */
      }
      el.remove();
    },
  };
}

function applyHostStyle(el: HTMLElement) {
  // Override the UA popover styles (border, padding, fit-content sizing), and
  // make every declaration inline !important: that beats any page stylesheet
  // rule, `!important` and `all:` included, so a page cannot hide, shrink,
  // fade or move the overlay with CSS.
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'margin:0',
    'padding:0',
    'border:0',
    'width:100vw',
    'height:100vh',
    'min-width:0',
    'min-height:0',
    'max-width:none',
    'max-height:none',
    'background:transparent',
    'color:initial',
    'overflow:visible',
    'pointer-events:none',
    'display:block',
    'visibility:visible',
    'opacity:1',
    'transform:none',
    'translate:none',
    'scale:none',
    'rotate:none',
    'filter:none',
    'clip-path:none',
    'mask:none',
    'zoom:1',
    'content-visibility:visible',
    'contain:layout style',
  ]
    .map((d) => `${d} !important`)
    .join(';');
}

export function isHostElement(node: Node | null): boolean {
  return node instanceof Element && node.tagName.toLowerCase() === TAG;
}
