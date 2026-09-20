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

export function mountHost(): OverlayHost {
  const el = document.createElement(TAG);
  el.setAttribute('popover', 'manual');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('role', 'presentation');
  el.setAttribute('data-aibs', '');
  applyHostStyle(el);

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

  let usingTopLayer = false;
  let lastTopLayerSignature = '';

  function mount() {
    if (!el.isConnected) document.documentElement.appendChild(el);
    if (el.parentElement !== document.documentElement) document.documentElement.appendChild(el);
    promote();
  }

  function promote() {
    try {
      if (usingTopLayer && el.matches(':popover-open')) {
        el.hidePopover();
      }
      el.showPopover();
      usingTopLayer = true;
      el.style.zIndex = '';
    } catch {
      usingTopLayer = false;
      el.style.zIndex = '2147483647';
    }
  }

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
    setColor(color) {
      el.style.setProperty('--aibs-color', color);
    },
    destroy() {
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
  // Override the UA popover styles (border, padding, fit-content sizing).
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'margin:0',
    'padding:0',
    'border:0',
    'width:100vw',
    'height:100vh',
    'max-width:none',
    'max-height:none',
    'background:transparent',
    'color:initial',
    'overflow:visible',
    'pointer-events:none',
    'display:block',
    'contain:layout style',
  ].join(';');
}

export function isHostElement(node: Node | null): boolean {
  return node instanceof Element && node.tagName.toLowerCase() === TAG;
}
