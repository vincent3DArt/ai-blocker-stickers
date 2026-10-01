import type { Settings, Sticker, TabState } from '@/shared/types';
import { DEFAULT_TAB_STATE, normalizeSettings } from '@/shared/types';
import { isToContent, type GetStickersResponse, type GetSuggestionsResponse, type LockUpdate, type LockedReply, type ToContent } from '@/shared/messages';
import { SESSION_ACTIVE_KEY, computeLock, lockMessage, type LockState } from '@/shared/lock';
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
import { Scanner } from './detect/scanner';
import { SuggestView } from './overlay/suggest-view';

/*
 * Development-only switches live inside `if (import.meta.env.DEV)` blocks
 * and nowhere else, as string literals, so a production build contains
 * neither the code nor the storage key names (scripts/check-prod-bundle.mjs):
 *  - `aibsNoAutoLock`: the e2e suite runs under Playwright, a debugger; see background.ts.
 *  - `aibsNoScan`: the fixture turns the auto-suggest scanner off; suggest.spec clears it.
 */
/** Keep-alive / resync ping to the background while stickers or a lock are present. */
const LOCK_PING_MS = 20_000;

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
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isToContent(msg) || sender.id !== chrome.runtime.id) return;
    ready.then(() => {
      const handledAsync = handleMessage?.(msg, sendResponse);
      if (handledAsync !== true) sendResponse(undefined);
    });
    return true;
  });

  // Ask the background for this tab's lock right away; the answer is applied
  // whenever it arrives, without holding boot up.
  const lockSync = chrome.runtime.sendMessage({ type: 'LOCK_SYNC' }).catch(() => undefined) as Promise<LockUpdate | undefined>;

  const depth = frameDepth();
  const [store, settingsLoaded, secret, lockLocal, devLocal] = await Promise.all([
    SiteStore.open(location.origin),
    loadSettings(),
    loadOrCreateSecret(),
    chrome.storage.local.get(SESSION_ACTIVE_KEY).catch(() => ({}) as Record<string, unknown>),
    // Folded to the empty object in production: the keys never reach the bundle.
    import.meta.env.DEV
      ? chrome.storage.local.get(['aibsNoAutoLock', 'aibsNoScan']).catch(() => ({}) as Record<string, unknown>)
      : Promise.resolve({} as Record<string, unknown>),
  ]);
  const devNoAutoLock = import.meta.env.DEV && devLocal.aibsNoAutoLock === true;
  const devNoScan = import.meta.env.DEV && devLocal.aibsNoScan === true;
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
  let scanner: Scanner | undefined;
  const sendState = (partial: Partial<TabState>) => {
    // Auto-covered content includes what the scanner masked without a sticker.
    if (partial.autoCount !== undefined) partial = { ...partial, autoCount: partial.autoCount + (scanner?.autoMaskOnly ?? 0) };
    tabState = { ...tabState, ...partial };
    if (depth === 0) chrome.runtime.sendMessage({ type: 'TAB_STATUS', state: tabState }).catch(() => {});
  };

  const spa = new SpaNav();
  let peek: Peek | undefined;
  let suggestView: SuggestView | undefined;
  const positioner = new Positioner(
    () => {
      session.recompute();
      peek?.reposition();
      if (!lock.locked) suggestView?.reposition();
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

  // ---- AI-session lock: signals ----
  // The background knows about attached debuggers and the manual session; the
  // local mirror of the session lets a fresh tab lock before the background
  // answers; `navigator.webdriver` is ours to read.
  let bgLock: LockUpdate = { locked: false, debugger: false, manual: false };
  let localSession = lockLocal[SESSION_ACTIVE_KEY] === true;
  let noAutoLock = devNoAutoLock;
  const webdriver = () => navigator.webdriver === true && !noAutoLock;
  const currentLock = (): LockState =>
    computeLock({ debuggerAttached: bgLock.debugger, manualSession: bgLock.manual || localSession, webdriver: webdriver() });
  let lock: LockState = currentLock();
  session.setLocked(lock.locked);
  tabState = { ...tabState, locked: lock.locked, lockReason: lock.reason };

  /**
   * Strict input masking follows the setting: always, never, or (default)
   * only while the tab is locked. A settings change can never turn it OFF
   * while locked: that would lift protection, which the lock forbids; it
   * takes effect when the lock ends.
   */
  const updateStrict = () => {
    const mode = settings.strictInputs;
    let on = mode === 'always' || (mode === 'locked' && lock.locked);
    if (!on && lock.locked && masker.isStrict) on = true;
    masker.setStrict(on);
  };
  updateStrict();

  // ---- auto-suggest scanner ----
  // Registered before the first sticker load so its mutation listener is in
  // place for the rest of the parse: while locked it masks as content arrives.
  const toolbar = new Toolbar(host, { onAction: (a) => onToolbar(a) });
  suggestView = new SuggestView(host, {
    onCover: (id) => void scanner?.cover(id).then(() => positioner.flush()),
    onDismiss: (id) => scanner?.dismiss(id),
  });
  let reviewIndex = 0;
  const refreshSuggestions = () => {
    const list = !lock.locked && !session.isPaused && scanner ? scanner.list() : [];
    suggestView?.set(list);
    toolbar.setSuggestions(list.length, (scanner?.total ?? 0) > list.length);
    sendState({ suggestionCount: list.length, autoCount: session.ephemeralCount });
  };
  scanner = new Scanner({
    hub,
    masker,
    isOurs,
    settings: () => settings,
    site: () => ({ scanEnabled: store.scanEnabled, dismissed: store.dismissed }),
    dismiss: (id) => store.dismiss(id),
    locked: () => lock.locked,
    paused: () => session.isPaused,
    autoStickers: () => session.ephemeralCount,
    onChange: refreshSuggestions,
    cover: async (el, source, o) => {
      await session.addElementSticker(el, source, { id: o?.maskId, ephemeral: o?.ephemeral });
      positioner.markDirty();
    },
    coverRect: async (rect) => {
      await session.addRectSticker(rect);
      positioner.markDirty();
    },
  });
  scanner.start(devNoScan);
  // Field values change without a mutation record.
  window.addEventListener('change', (e) => e.target instanceof Element && scanner?.recheckField(e.target), true);
  /** Scroll the next suggestion into view. */
  const reviewNext = () => {
    const list = scanner?.list() ?? [];
    if (!list.length || lock.locked) return false;
    const s = list[reviewIndex++ % list.length];
    s.hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  };
  /** SESSION_ENDED without keeping: drop the session's auto-covers once the lock is really off. */
  let discardAutoOnUnlock = false;

  hub.onBatch(() => {
    session.onMutationBatch();
    positioner.markDirty();
    spa.check();
  }, 50);

  store.subscribe(() => {
    void session.load();
    // The popup may have switched suggestions on or off for this site.
    scanner?.rescan();
  });
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
    locked: () => lock.locked,
  });
  peek.start();

  // ---- edit mode ----
  let editing = false;
  let picker: Picker | null = null;
  let rectDraw: RectDraw | null = null;
  let reattachId: string | null = null;
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

  /**
   * A lifting action was attempted while locked: refuse it visibly, record it
   * in the audit log (no content, just the action), and answer the sender.
   */
  function refuse(what: string, sendResponse?: (r?: unknown) => void): true {
    const error = lockMessage(lock.reason);
    if (depth === 0) toolbar.toast(`${error}: stickers stay on`);
    chrome.runtime.sendMessage({ type: 'LOCK_REFUSED', what: `${what}/${lock.reason ?? ''}` }).catch(() => {});
    const reply: LockedReply = { ok: false, locked: true, error };
    sendResponse?.(reply);
    return true;
  }

  function setEditing(on: boolean) {
    if (on && lock.locked) {
      refuse('edit-mode');
      return;
    }
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
    if (lock.locked) {
      refuse(forId ? 'reattach' : 'START_PICK');
      return;
    }
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
    if (lock.locked) {
      refuse('START_RECT');
      return;
    }
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
    if (lock.locked) {
      refuse('cover-selection');
      return;
    }
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
      case 'suggestions':
        reviewNext();
        break;
      case 'done':
        setEditing(false);
        break;
    }
  }

  // ---- AI-session lock: enforcement ----
  function applyLock(next: LockState) {
    const changed = next.locked !== lock.locked || next.reason !== lock.reason;
    lock = next;
    if (!changed) return;
    if (lock.locked) {
      // Nothing that lifts a sticker survives the lock coming on.
      peek?.cancel();
      stopTools();
      editing = false;
      session.setEditing(false);
      toolbar.hide();
    }
    session.setLocked(lock.locked);
    updateStrict();
    // Locked: no suggestion is ever drawn, detections are covered instead.
    if (lock.locked) suggestView?.clear();
    scanner?.setLocked(lock.locked);
    if (!lock.locked && discardAutoOnUnlock) {
      discardAutoOnUnlock = false;
      session.dropEphemeral();
      scanner?.dropAuto();
    }
    refreshSuggestions();
    sendState({ locked: lock.locked, lockReason: lock.reason, paused: session.isPaused, strictInputs: masker.strictCount() });
    positioner.flush();
  }
  const relock = () => applyLock(currentLock());
  const takeBgLock = (r: LockUpdate | undefined) => {
    if (!r || typeof r.locked !== 'boolean') return;
    bgLock = { locked: r.locked, reason: r.reason, debugger: r.debugger === true, manual: r.manual === true };
    relock();
  };
  lockSync.then(takeBgLock);
  // Keep the service worker (and its 2 s debugger poll) awake while there is
  // something to protect, and resync in case a SET_LOCK was missed.
  if (depth === 0) {
    window.setInterval(() => {
      if (!lock.locked && session.state().stickerCount === 0) return;
      (chrome.runtime.sendMessage({ type: 'LOCK_SYNC' }) as Promise<LockUpdate | undefined>).then(takeBgLock).catch(() => {});
    }, LOCK_PING_MS);
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
    // Development builds only: test hooks. The whole block (and its message
    // names) is dropped from production builds.
    if (import.meta.env.DEV) {
      switch (m.type) {
        case 'TEST_RESCAN':
          scanner?.rescan();
          sendResponse({ ok: true });
          return true;
        case 'TEST_COVER': {
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
          session.addRectSticker(m.rect).then((s) => {
            positioner.flush();
            sendResponse({ ok: true, id: s.id, kind: s.kind });
          });
          return true;
        }
        case 'TEST_STATE': {
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
          sendResponse({
            stickers: session.summaries(),
            state: { ...tabState, ...session.state() },
            pieces,
            lock: { ...lock, signals: { debugger: bgLock.debugger, manual: bgLock.manual, localSession, webdriver: webdriver() } },
            strict: { on: masker.isStrict, count: masker.strictCount() },
            scan: {
              active: scanner?.active() ?? false,
              scanning: scanner?.scanning ?? false,
              total: scanner?.total ?? 0,
              chips: suggestView?.chipCount() ?? 0,
              autoCount: session.ephemeralCount + (scanner?.autoMaskOnly ?? 0),
              stats: scanner?.stats,
              suggestions: (scanner?.list() ?? []).map((s) => ({
                id: s.id,
                pattern: s.hit.pattern,
                name: s.name,
                score: s.hit.score,
                bonus: s.hit.bonus,
                tag: s.hit.el.tagName.toLowerCase(),
                elId: s.hit.el.id || undefined,
              })),
            },
          });
          return true;
        }
        case 'TEST_COVER_SUGGESTIONS':
          if (lock.locked || !scanner) {
            sendResponse({ ok: false, covered: 0 });
            return true;
          }
          scanner.coverAll().then((covered) => {
            positioner.flush();
            sendResponse({ ok: true, covered, ids: session.summaries().map((s) => s.id) });
          });
          return true;
      }
    }
    switch (m.type) {
      case 'SET_LOCK':
        takeBgLock(m);
        sendResponse({ ok: true, locked: lock.locked, reason: lock.reason });
        return true;
      case 'COMMAND':
        if (depth !== 0) return;
        if (m.name === 'toggle-edit-mode') setEditing(!editing);
        else if (m.name === 'cover-selection') coverSelection();
        break;
      case 'SET_EDIT_MODE':
        if (m.enabled && lock.locked) return refuse('SET_EDIT_MODE', sendResponse);
        setEditing(m.enabled);
        break;
      case 'SET_PAUSED':
        if (m.paused && lock.locked) return refuse('SET_PAUSED', sendResponse);
        session.setPaused(m.paused);
        scanner?.rescan();
        refreshSuggestions();
        break;
      case 'SESSION_ENDED': {
        // Keeping only adds protection and is done at once. Dropping lifts
        // it, so it waits for the lock to be off (the SET_LOCK may come later,
        // and a debugger may keep the tab locked after the session).
        let kept = 0;
        if (m.keepAuto) {
          discardAutoOnUnlock = false;
          kept = session.keepEphemeral();
          scanner?.keepAuto();
        } else if (lock.locked) {
          discardAutoOnUnlock = true;
        } else {
          session.dropEphemeral();
          scanner?.dropAuto();
        }
        refreshSuggestions();
        sendResponse({ ok: true, kept });
        return true;
      }
      case 'GET_SUGGESTIONS': {
        if (depth !== 0) return;
        const list = lock.locked || !scanner ? [] : scanner.list();
        const res: GetSuggestionsResponse = {
          suggestions: list.map((s) => ({ id: s.id, name: s.name, pattern: s.hit.pattern, score: s.hit.score })),
          total: scanner?.total ?? 0,
          scanEnabled: scanner?.siteEnabled() ?? false,
          scanning: scanner?.scanning ?? false,
        };
        sendResponse(res);
        return true;
      }
      case 'COVER_SUGGESTIONS': {
        if (lock.locked || !scanner) {
          sendResponse({ ok: false, covered: 0 });
          return true;
        }
        scanner.coverAll().then((covered) => {
          positioner.flush();
          sendResponse({ ok: true, covered, ids: session.summaries().map((s) => s.id) });
        });
        return true;
      }
      case 'REVIEW_SUGGESTIONS':
        reviewIndex = 0;
        sendResponse({ ok: reviewNext() });
        return true;
      case 'DISMISS_SUGGESTION':
        if (typeof m.id === 'string') scanner?.dismiss(m.id);
        break;
      case 'GET_STICKERS': {
        if (depth !== 0) return;
        const st = session.state();
        const res: GetStickersResponse = {
          stickers: session.summaries(),
          state: { ...tabState, ...st, autoCount: (st.autoCount ?? 0) + (scanner?.autoMaskOnly ?? 0) },
        };
        sendResponse(res);
        return true;
      }
      case 'LOCATE_STICKER':
        session.locate(m.id);
        break;
      case 'DELETE_STICKER':
        if (lock.locked) return refuse('DELETE_STICKER', sendResponse);
        session.remove(m.id);
        break;
      case 'SET_SCOPE':
        if (lock.locked) return refuse('SET_SCOPE', sendResponse);
        session.setScope(m.id, m.pathPattern);
        sendResponse({ ok: true });
        return true;
      case 'COVER_CONTEXT_TARGET':
        if (contextTarget) {
          session.addElementSticker(contextTarget, 'context-menu').then(() => positioner.flush());
        }
        break;
      case 'START_PICK':
        if (lock.locked) return refuse('START_PICK', sendResponse);
        if (depth === 0) startPick();
        break;
      case 'START_RECT':
        if (lock.locked) return refuse('START_RECT', sendResponse);
        if (depth === 0) startRect();
        break;
    }
    return undefined;
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      const prev = settings;
      settings = normalizeSettings(changes.settings.newValue as Partial<Settings>);
      host.setColor(settings.appearance.color);
      updateStrict();
      sendState({ strictInputs: masker.strictCount() });
      if (prev.scanDefault !== settings.scanDefault || prev.scanSensitivity !== settings.scanSensitivity) scanner?.rescan();
    }
    if (area === 'local' && SESSION_ACTIVE_KEY in changes) {
      localSession = changes[SESSION_ACTIVE_KEY].newValue === true;
      relock();
    }
    if (import.meta.env.DEV) {
      if (area === 'local' && 'aibsNoScan' in changes) scanner?.setDevOff(changes.aibsNoScan.newValue === true);
      if (area === 'local' && 'aibsNoAutoLock' in changes) {
        noAutoLock = changes.aibsNoAutoLock.newValue === true;
        relock();
      }
    }
  });

  markReady();
  sendState(session.state());
  console.debug('[aibs] ready', { depth, stickers: session.summaries().length });
}
