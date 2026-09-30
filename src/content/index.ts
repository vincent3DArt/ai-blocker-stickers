import type { Settings, Sticker, TabState } from '@/shared/types';
import { DEFAULT_TAB_STATE } from '@/shared/types';
import { isToContent, type GetStickersResponse, type ToContent } from '@/shared/messages';
import { loadOrCreateSecret, loadSettings } from '@/shared/storage';
import { importKey } from '@/shared/hmac';
import { mountHost } from './overlay/host';
import { Positioner } from './overlay/positioner';
import { Picker } from './overlay/picker';
import { RectDraw } from './overlay/rect-draw';
import { Toolbar, type ToolbarAction } from './overlay/toolbar';
import { Peek, type PeekTarget } from './overlay/peek';
import { MutationHub } from './mask/guard';
import { Masker } from './mask/masker';
import { setFingerprintKey } from './anchor/fingerprint';
import { SiteStore } from './state/store';
import { Session } from './state/session';
import { SpaNav } from './state/spa-nav';
import { clientRects, union } from './anchor/geometry';

declare global {
  interface Window {
    __aibsBooted?: boolean;
  }
}

function frameDepth(): number {
  let d = 0;
  let w: Window = window;
  while (w !== w.parent) {
    d++;
    w = w.parent;
  }
  return d;
}

/**
 * Dev-only: make our own world look like a background tab.
 *
 * A tab an AI agent drives without fronting it has no animation frames and a
 * hidden `document`, and that is the environment masking must survive. It
 * cannot be produced under Playwright — every page it drives stays `visible`
 * and keeps getting frames, whichever tab is in front — and an init script
 * cannot help either, because it runs in the page's world while our code runs
 * in the extension's isolated one.
 *
 * So the e2e suite sets `aibsEmulateHidden` in extension storage and we take
 * away here, in our world only and before anything starts, exactly what a real
 * background tab takes away. The page's own world is untouched.
 */
async function emulateHiddenTab() {
  const got = await chrome.storage.local.get('aibsEmulateHidden').catch(() => ({}) as Record<string, unknown>);
  if (!got.aibsEmulateHidden) return;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
  console.debug('[aibs] emulating a hidden tab (dev only)');
}

export async function boot() {
  if (window.__aibsBooted) return;
  window.__aibsBooted = true;
  if (!location.origin || location.origin === 'null') return;
  if (import.meta.env.DEV) await emulateHiddenTab();

  // Register the message listener before any await so messages that arrive
  // during boot are answered once boot completes instead of being dropped.
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  let handleMessage: ((m: ToContent, sendResponse: (r?: unknown) => void) => boolean | void) | null = null;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isToContent(msg)) return;
    ready.then(() => {
      const handledAsync = handleMessage?.(msg, sendResponse);
      if (handledAsync !== true) sendResponse(undefined);
    });
    return true;
  });

  const depth = frameDepth();
  const [store, settingsLoaded, secret] = await Promise.all([
    SiteStore.open(location.origin),
    loadSettings(),
    loadOrCreateSecret(),
  ]);
  let settings: Settings = settingsLoaded;
  setFingerprintKey(await importKey(secret));

  const host = mountHost();
  host.setColor(settings.appearance.color);
  const isOurs = (n: Node | null) => host.isOurs(n);

  const hub = new MutationHub();
  hub.start();
  const masker = new Masker(hub);
  masker.start();

  let tabState: TabState = { ...DEFAULT_TAB_STATE };
  const sendState = (partial: Partial<TabState>) => {
    tabState = { ...tabState, ...partial };
    if (depth === 0) chrome.runtime.sendMessage({ type: 'TAB_STATUS', state: tabState }).catch(() => {});
  };

  const spa = new SpaNav();
  let peek: Peek | undefined;
  const positioner = new Positioner(
    () => {
      session.recompute();
      peek?.reposition();
    },
    () => {
      host.reassert();
      spa.check();
      if (document.body) positioner.observe(document.body);
    },
  );

  const session = new Session({
    host,
    store,
    settings: () => settings,
    masker,
    positioner,
    frameDepth: depth,
    isOurs,
    onState: sendState,
    onGhostClick: (s) => startPick(s.id),
  });

  hub.onBatch(() => {
    session.onMutationBatch();
    positioner.markDirty();
    spa.check();
  }, 50);

  store.subscribe(() => session.load());
  spa.onChange(() => session.handleNavigation());
  spa.start();
  positioner.start();
  await session.load();

  // ---- peek ----
  let pointer = { x: -1, y: -1 };
  // Untrusted (script-dispatched) moves must not aim a peek at a sticker.
  window.addEventListener('mousemove', (e) => e.isTrusted && (pointer = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });
  const toTarget = (hit: { sticker: Sticker; rect: { x: number; y: number; w: number; h: number }; el: Element | null }): PeekTarget => ({
    id: hit.sticker.id,
    rect: hit.rect,
    anchor: hit.el,
    text: hit.sticker.kind === 'element' && hit.sticker.maskMode !== 'text' ? '' : session.originals(hit.sticker.id),
  });
  peek = new Peek(host, () => settings, {
    hovered: () => {
      const hit = session.stickerAt(pointer.x, pointer.y);
      return hit ? toTarget(hit) : null;
    },
    all: () => session.visible().map(toTarget),
    onPeek: (ids, on) => session.setPeek(ids, on),
  });
  peek.start();

  // ---- edit mode ----
  let editing = false;
  let picker: Picker | null = null;
  let rectDraw: RectDraw | null = null;
  let reattachId: string | null = null;
  const toolbar = new Toolbar(host, { onAction: (a) => onToolbar(a) });
  store.onSaveStatus = (error) => {
    sendState({ saveError: error });
    if (error && depth === 0) toolbar.toast('Could not save stickers on this site');
  };

  function stopTools() {
    picker?.stop();
    picker = null;
    rectDraw?.end();
    rectDraw = null;
    reattachId = null;
    toolbar.setActive(null);
  }

  function setEditing(on: boolean) {
    if (editing === on) return;
    editing = on;
    session.setEditing(on);
    if (on) {
      if (depth === 0) toolbar.show();
    } else {
      stopTools();
      toolbar.hide();
    }
  }

  function startPick(forId: string | null = null) {
    stopTools();
    if (!editing) setEditing(true);
    reattachId = forId;
    toolbar.setActive('pick');
    picker = new Picker(host, isOurs, {
      onPick: async (el) => {
        const id = reattachId;
        stopTools();
        if (id) {
          await session.reattach(id, el);
          toolbar.toast('Sticker re-attached');
        } else {
          await session.addElementSticker(el, 'manual');
          toolbar.toast('Sticker placed. It follows this element.');
        }
        positioner.flush();
      },
      onCancel: () => stopTools(),
    });
    picker.start();
  }

  function startRect() {
    stopTools();
    if (!editing) setEditing(true);
    toolbar.setActive('rect');
    rectDraw = new RectDraw(host, {
      onDraw: async (rect) => {
        stopTools();
        await session.addRectSticker(rect);
        toolbar.toast('Rectangle sticker placed.');
        positioner.flush();
      },
      onCancel: () => stopTools(),
    });
    rectDraw.begin();
  }

  async function coverSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      toolbar.toast('Select some text first.');
      return;
    }
    const range = sel.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const el = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
    if (!el || isOurs(el)) return;
    const selectedText = sel.toString().replace(/\s+/g, ' ').trim();
    const elText = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    sel.removeAllRanges();
    if (elText.length > 0 && selectedText.length / elText.length >= 0.8) {
      await session.addElementSticker(el, 'selection');
    } else {
      const rects = Array.from(range.getClientRects()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
      const u = union(rects.filter((r) => r.w > 0 && r.h > 0));
      if (!u) return;
      await session.addRectSticker(u);
    }
    toolbar.toast('Selection covered.');
    positioner.flush();
  }

  function onToolbar(action: ToolbarAction) {
    switch (action) {
      case 'pick':
        startPick();
        break;
      case 'rect':
        startRect();
        break;
      case 'selection':
        coverSelection();
        break;
      case 'done':
        setEditing(false);
        break;
    }
  }

  // ---- context menu target ----
  let contextTarget: Element | null = null;
  window.addEventListener(
    'contextmenu',
    (e) => {
      // A page can answer the user's right-click by dispatching its own
      // contextmenu on a decoy; only the real one may aim "Cover this element".
      if (!e.isTrusted) return;
      const t = e.target as Element | null;
      contextTarget = t && !isOurs(t) ? t : null;

    },
    true,
  );

  // ---- messages ----
  handleMessage = (m, sendResponse) => {
    switch (m.type) {
      case 'COMMAND':
        if (depth !== 0) return;
        if (m.name === 'toggle-edit-mode') setEditing(!editing);
        else if (m.name === 'cover-selection') coverSelection();
        break;
      case 'SET_EDIT_MODE':
        setEditing(m.enabled);
        break;
      case 'SET_PAUSED':
        session.setPaused(m.paused);
        break;
      case 'GET_STICKERS': {
        if (depth !== 0) return;
        const res: GetStickersResponse = { stickers: session.summaries(), state: { ...tabState, ...session.state() } };
        sendResponse(res);
        return true;
      }
      case 'LOCATE_STICKER':
        session.locate(m.id);
        break;
      case 'DELETE_STICKER':
        session.remove(m.id);
        break;
      case 'SET_SCOPE':
        session.setScope(m.id, m.pathPattern);
        sendResponse({ ok: true });
        return true;
      case 'COVER_CONTEXT_TARGET':
        if (contextTarget) {
          session.addElementSticker(contextTarget, 'context-menu').then(() => positioner.flush());
        }
        break;
      case 'START_PICK':
        if (depth === 0) startPick();
        break;
      case 'START_RECT':
        if (depth === 0) startRect();
        break;
      case 'TEST_COVER': {
        if (!import.meta.env.DEV) return;
        const scope = m.shadowHost ? document.querySelector(m.shadowHost)?.shadowRoot : document;
        const el = scope?.querySelector(m.selector);
        if (!el) {
          sendResponse({ ok: false, error: 'no element' });
          return true;
        }
        session.addElementSticker(el, 'manual').then((s) => {
          positioner.flush();
          sendResponse({ ok: true, id: s.id });
        });
        return true;
      }
      case 'TEST_RECT': {
        if (!import.meta.env.DEV) return;
        session.addRectSticker(m.rect).then((s) => {
          positioner.flush();
          sendResponse({ ok: true, id: s.id, kind: s.kind });
        });
        return true;
      }
      case 'TEST_STATE': {
        if (!import.meta.env.DEV) return;
        positioner.flush();
        const pieces = Array.from(host.layer.querySelectorAll<HTMLElement>('.piece')).map((p) => {
          const r = p.getBoundingClientRect();
          return {
            id: (p.parentElement as HTMLElement).dataset.id,
            x: r.left,
            y: r.top,
            w: r.width,
            h: r.height,
            lost: p.classList.contains('lost'),
            low: p.classList.contains('low'),
          };
        });
        sendResponse({ stickers: session.summaries(), state: session.state(), pieces });
        return true;
      }
    }
    return undefined;
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      settings = changes.settings.newValue as Settings;
      host.setColor(settings.appearance.color);
    }
  });

  markReady();
  sendState(session.state());
  console.debug('[aibs] ready', { depth, stickers: session.summaries().length });
}
