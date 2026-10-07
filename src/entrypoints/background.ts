import type { ContentToBackground, LockUpdate, SessionInfo } from '@/shared/messages';
import { listSites, loadSite } from '@/shared/storage';
import { DEFAULT_TAB_STATE, type SiteRecord, type TabState } from '@/shared/types';
import { parseOrigin, scriptId } from '@/shared/origin';
import { AUDIT_KEY, SESSION_ACTIVE_KEY, appendAudit, computeLock, type AuditEntry } from '@/shared/lock';

const CONTENT_SCRIPT = 'content-scripts/content.js';
const CLOAK_CSS = 'cloak.css';
const ALL_SITES = '*://*/*';
/** Script id for the all-sites registration made while an AI session runs. */
const ALL_SITES_ID = 'aibs-all-sites';
/** storage.session: the manual session (trusted contexts only, unlike storage.local). */
const SESSION_KEY = 'aibsSession';
/** storage.session: tabs a debugger was attached to at the last poll. */
const DEBUGGER_TABS_KEY = 'aibsDebuggerTabs';
/** storage.local: keep the all-sites registration after the session ends. */
const KEEP_ALL_SITES_KEY = 'keepAllSites';
/*
 * Development-only values (the fixture origins, the `aibsNoAutoLock` storage
 * flag that the e2e suite sets because Playwright is itself a debugger, and
 * the TEST_SESSION message) appear only inside `if (import.meta.env.DEV)`
 * blocks, as literals, so production builds drop them entirely
 * (scripts/check-prod-bundle.mjs).
 */
/** Fixture server port of a development build (wxt.config.ts); read inside DEV blocks only. */
declare const __AIBS_FIXTURES_PORT__: string;
const POLL_MS = 2_000;
const POLL_ALARM = 'aibs-lock-poll';

/** The popup (or another extension page): same extension, not a content script. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && (!sender.url || sender.url.startsWith(chrome.runtime.getURL('')));
}

/**
 * Any page of this extension, including the popup opened in a tab. A content
 * script's sender URL is always its web page, so it can never pass.
 */
function fromExtensionUrl(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

async function registerScript(id: string, matches: string[], cloak = false): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const script: chrome.scripting.RegisteredContentScript = {
    id,
    matches,
    js: [CONTENT_SCRIPT],
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true,
  };
  // The boot cloak (public/cloak.css): applied before the first parse, lifted
  // by the content script once the stickers are in place. Only origins that
  // have stickers get it (and every site while an AI session runs, when
  // anything may be auto-covered); a page with nothing to cover is never hidden.
  if (cloak) script.css = [CLOAK_CSS];
  const had = existing[0];
  if (had && !cloak && had.css?.length) {
    // An update cannot drop a field: replace the registration.
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
    await chrome.scripting.registerContentScripts([script]);
  } else if (had) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

const hasStickers = (rec: SiteRecord | undefined) => !!rec && rec.v === 1 && Array.isArray(rec.stickers) && rec.stickers.length > 0;

/** Some detector the user taught applies everywhere (Settings.customDetectors). */
let globalDetectors = false;
async function loadGlobalDetectors(): Promise<void> {
  const s = (await chrome.storage.local.get('settings').catch(() => ({}) as Record<string, unknown>)).settings as { customDetectors?: unknown } | undefined;
  globalDetectors = Array.isArray(s?.customDetectors) && s.customDetectors.length > 0;
}

/**
 * The boot cloak: on an origin with stickers, and, during an AI session, on
 * an origin where a user-taught detector applies (its matches are
 * auto-covered before the first paint, see content/index.ts holdCloak).
 */
function wantsCloak(rec: SiteRecord | undefined): boolean {
  if (hasStickers(rec)) return true;
  if (!lock.session) return false;
  return globalDetectors || (Array.isArray(rec?.customDetectors) && rec.customDetectors.length > 0);
}

async function registerOrigin(origin: string, rec?: SiteRecord): Promise<void> {
  const site = rec ?? (await loadSite(origin).catch(() => undefined));
  await registerScript(scriptId(origin), [`${origin}/*`], wantsCloak(site));
}

/**
 * A site's first sticker turns the cloak on for its next page load, its last
 * one turns it off. Only origins that are already registered are touched.
 */
async function syncCloak(origin: string, rec: SiteRecord | undefined): Promise<void> {
  const id = scriptId(origin);
  const [had] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!had) return;
  if (!!had.css?.length === wantsCloak(rec)) return;
  await registerOrigin(origin, rec);
}

async function unregisterId(id: string): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    /* not registered */
  }
}

async function unregisterOrigin(origin: string): Promise<void> {
  await unregisterId(scriptId(origin));
}

async function hasOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

const hasAllSites = () => chrome.permissions.contains({ origins: [ALL_SITES] }).catch(() => false);
const hasDebugger = () => chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false);

/**
 * Register every enabled site we still have permission for, and unregister
 * every other script id: disabled sites, sites without permission, and ids
 * left over from the old (colliding) naming scheme. Origins read from storage
 * are validated like message input, because content scripts can write it.
 */
async function reconcile(): Promise<void> {
  await ready;
  await loadGlobalDetectors();
  const wanted = new Set<string>();
  const sites = await listSites();
  for (const s of sites) {
    const origin = parseOrigin(s.origin);
    if (!origin || !s.enabled) continue;
    if (!(await hasOriginPermission(origin))) continue;
    await registerOrigin(origin, s);
    wanted.add(scriptId(origin));
  }
  if (import.meta.env.DEV) {
    for (const o of [`http://127.0.0.1:${__AIBS_FIXTURES_PORT__}`, `http://localhost:${__AIBS_FIXTURES_PORT__}`]) {
      if (await hasOriginPermission(o)) {
        await registerOrigin(o);
        wanted.add(scriptId(o));
      }
    }
  }
  const keep = (await chrome.storage.local.get(KEEP_ALL_SITES_KEY))[KEEP_ALL_SITES_KEY] === true;
  if ((lock.session || keep) && (await hasAllSites())) {
    await registerScript(ALL_SITES_ID, [ALL_SITES], true);
    wanted.add(ALL_SITES_ID);
  }
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered.map((r) => r.id).filter((id) => !wanted.has(id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
}

async function injectNow(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [CONTENT_SCRIPT] });
}

// ---- lock state ----

/**
 * The background's half of the lock: the manual session and attached
 * debuggers. The content script adds `navigator.webdriver` on its own.
 * Rebuilt from storage every time the service worker starts.
 */
const lock = {
  session: false,
  startedAt: 0,
  debuggerTabs: new Set<number>(),
  stickerTabs: new Set<number>(),
  noAutoLock: false,
};

async function loadLock(): Promise<void> {
  const [ses, loc, devLoc] = await Promise.all([
    chrome.storage.session.get(null),
    chrome.storage.local.get(SESSION_ACTIVE_KEY),
    import.meta.env.DEV ? chrome.storage.local.get('aibsNoAutoLock') : Promise.resolve({} as Record<string, unknown>),
  ]);
  const s = ses[SESSION_KEY] as { active?: boolean; startedAt?: number } | undefined;
  // Fail closed: either copy saying "active" keeps the session on. The local
  // mirror survives a browser restart; the session copy cannot be written by
  // a content script.
  lock.session = s?.active === true || loc[SESSION_ACTIVE_KEY] === true;
  lock.startedAt = s?.startedAt ?? 0;
  const dbg = ses[DEBUGGER_TABS_KEY];
  lock.debuggerTabs = new Set(Array.isArray(dbg) ? dbg.filter((n): n is number => typeof n === 'number') : []);
  for (const [k, v] of Object.entries(ses)) {
    if (k.startsWith('tab:') && (v as TabState | undefined)?.stickerCount) lock.stickerTabs.add(Number(k.slice(4)));
  }
  lock.noAutoLock = import.meta.env.DEV && devLoc.aibsNoAutoLock === true;
}

const ready = loadLock().catch(() => {});

function lockFor(tabId: number | undefined): LockUpdate {
  const dbg = tabId !== undefined && lock.debuggerTabs.has(tabId);
  const l = computeLock({ debuggerAttached: dbg, manualSession: lock.session });
  return { locked: l.locked, reason: l.reason, debugger: dbg, manual: lock.session };
}

function pushLock(tabId: number) {
  chrome.tabs.sendMessage(tabId, { type: 'SET_LOCK', ...lockFor(tabId) }).catch(() => {});
  paintBadgeFor(tabId).catch(() => {});
}

async function pushLockAll() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id !== undefined) pushLock(t.id);
}

// ---- audit log ----
let auditChain: Promise<unknown> = Promise.resolve();
/** `tabId|origin` pairs already logged as `canvas-page` (per service-worker life). */
const canvasAudited = new Set<string>();
/** Append one entry. Writes are serialised so concurrent events do not drop each other. */
function audit(entry: Omit<AuditEntry, 'ts'>): Promise<unknown> {
  auditChain = auditChain
    .then(async () => {
      const cur = (await chrome.storage.local.get(AUDIT_KEY))[AUDIT_KEY];
      await chrome.storage.local.set({ [AUDIT_KEY]: appendAudit(cur, { ts: Date.now(), ...entry }) });
    })
    .catch(() => {});
  return auditChain;
}

async function originOfTab(tabId: number): Promise<string | undefined> {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.url ? (parseOrigin(new URL(t.url).origin) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

function originOfSender(sender: chrome.runtime.MessageSender): string | undefined {
  try {
    return (sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined)) || undefined;
  } catch {
    return undefined;
  }
}

// ---- debugger polling ----
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;

/**
 * Lock every tab a debugger is attached to. CDP-driven agents (Claude in
 * Chrome, Playwright, Puppeteer) attach one; so does DevTools. Only
 * available once the optional `debugger` permission is granted.
 */
async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await ready;
    if (!chrome.debugger?.getTargets || !(await hasDebugger())) return;
    const targets = await chrome.debugger.getTargets();
    const attached = new Set<number>();
    if (!lock.noAutoLock) {
      for (const t of targets) if (t.attached && typeof t.tabId === 'number') attached.add(t.tabId);
    }
    const changed: number[] = [];
    for (const id of attached) {
      if (lock.debuggerTabs.has(id)) continue;
      changed.push(id);
      void originOfTab(id).then((origin) => audit({ action: 'auto-lock', origin, reason: 'debugger' }));
    }
    for (const id of lock.debuggerTabs) {
      if (attached.has(id)) continue;
      changed.push(id);
      void originOfTab(id).then((origin) => audit({ action: 'auto-unlock', origin, reason: 'debugger' }));
    }
    if (!changed.length) return;
    lock.debuggerTabs = attached;
    await chrome.storage.session.set({ [DEBUGGER_TABS_KEY]: Array.from(attached) });
    for (const id of changed) pushLock(id);
  } catch {
    /* getTargets can fail transiently; the next tick retries */
  } finally {
    polling = false;
    void ensurePolling();
  }
}

/**
 * Poll every 2 s while any tab has stickers (or is still debugger-locked).
 * The interval dies with the service worker; the 30 s alarm wakes it again,
 * and content scripts ping (LOCK_SYNC) every 20 s while they hold stickers
 * or a lock, which keeps it alive in between.
 */
async function ensurePolling(): Promise<void> {
  await ready;
  const need = (lock.stickerTabs.size > 0 || lock.debuggerTabs.size > 0) && !!chrome.debugger && (await hasDebugger());
  if (need) {
    if (!pollTimer) {
      pollTimer = setInterval(() => void poll(), POLL_MS);
      void poll();
    }
    if (!(await chrome.alarms.get(POLL_ALARM))) await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  } else {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    await chrome.alarms.clear(POLL_ALARM).catch(() => false);
  }
}

// ---- manual session ----
async function startSession(allSites: boolean): Promise<void> {
  await ready;
  lock.session = true;
  lock.startedAt = Date.now();
  canvasAudited.clear();
  await chrome.storage.session.set({ [SESSION_KEY]: { active: true, startedAt: lock.startedAt } });
  await chrome.storage.local.set({ [SESSION_ACTIVE_KEY]: true });
  if (allSites && (await hasAllSites())) await registerScript(ALL_SITES_ID, [ALL_SITES], true).catch(() => {});
  // Origins with user-taught detectors get the boot cloak while the session runs.
  await reconcile().catch(() => {});
  await audit({ action: 'session-start' });
  await pushLockAll();
  void ensurePolling();
}

async function endSession(keepAllSites: boolean, keepAuto = true): Promise<void> {
  await ready;
  lock.session = false;
  lock.startedAt = 0;
  await chrome.storage.session.set({ [SESSION_KEY]: { active: false } });
  await chrome.storage.local.set({ [SESSION_ACTIVE_KEY]: false, [KEEP_ALL_SITES_KEY]: keepAllSites });
  if (!keepAllSites) await unregisterId(ALL_SITES_ID);
  await reconcile().catch(() => {});
  await audit({ action: 'session-end' });
  // Every tab decides about the stickers it auto-covered during the session:
  // stored for good, or dropped once its lock is really off.
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => (t.id === undefined ? undefined : chrome.tabs.sendMessage(t.id, { type: 'SESSION_ENDED', keepAuto }).catch(() => undefined))),
  );
  await pushLockAll();
}

async function sessionInfo(): Promise<SessionInfo> {
  await ready;
  const keep = (await chrome.storage.local.get(KEEP_ALL_SITES_KEY))[KEEP_ALL_SITES_KEY] === true;
  return {
    active: lock.session,
    startedAt: lock.startedAt || undefined,
    keepAllSites: keep,
    allSitesGranted: await hasAllSites(),
    debuggerGranted: await hasDebugger(),
  };
}

// ---- badge ----
const tabKey = (tabId: number) => `tab:${tabId}`;

async function setTabState(tabId: number, state: TabState) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
  if (state.stickerCount > 0) lock.stickerTabs.add(tabId);
  else lock.stickerTabs.delete(tabId);
  void ensurePolling();
  await paintBadge(tabId, state);
}

async function paintBadgeFor(tabId: number) {
  await paintBadge(tabId, await getTabState(tabId));
}

async function paintBadge(tabId: number, state: TabState) {
  let text = state.stickerCount ? String(state.stickerCount) : '';
  let color = '#374151';
  if (state.locked || lockFor(tabId).locked) {
    text = '\u{1F512}';
    color = '#7c3aed';
  } else if (state.paused) {
    text = '||';
    color = '#b91c1c';
  } else if (state.saveError || state.lostCount > 0) {
    text = '!';
    color = '#d97706';
  } else if (state.editMode) {
    color = '#2563eb';
  }
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
}

export async function getTabState(tabId: number): Promise<TabState> {
  const res = await chrome.storage.session.get(tabKey(tabId));
  return (res[tabKey(tabId)] as TabState | undefined) ?? { ...DEFAULT_TAB_STATE };
}

/** Locked for the background: its own signals say so, or the tab's content script reported a lock. */
async function tabLocked(tabId: number | undefined): Promise<boolean> {
  await ready;
  if (lock.session || lockFor(tabId).locked) return true;
  return tabId !== undefined && (await getTabState(tabId)).locked === true;
}

// ---- PDF viewer ----
/** storage.local: the user turned on "Always open PDFs in the sticker viewer". */
const PDF_REDIRECT_KEY = 'pdfRedirect';
const PDF_RULE_ID = 1;
const PDF_MENU_ID = 'aibs-pdf-link';
const TEACH_MENU_ID = 'aibs-teach';

function viewerUrl(src: string): string {
  return chrome.runtime.getURL('pdf.html') + '?src=' + encodeURIComponent(src);
}

/**
 * Add or remove the dynamic redirect rule: top-level navigations to an
 * http(s) URL whose path ends in .pdf open in the viewer instead. A redirect
 * needs host access to the request, so the rule only exists while the
 * option is on AND the all-sites permission is granted.
 */
async function reconcilePdfRedirect(): Promise<boolean> {
  const want = (await chrome.storage.local.get(PDF_REDIRECT_KEY))[PDF_REDIRECT_KEY] === true && (await hasAllSites());
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const has = rules.some((r) => r.id === PDF_RULE_ID);
  if (want && !has) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PDF_RULE_ID],
      addRules: [
        {
          id: PDF_RULE_ID,
          priority: 1,
          action: {
            type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
            // \0 is the whole matched URL, unencoded: the viewer takes
            // everything after `?src=` in that case.
            redirect: { regexSubstitution: chrome.runtime.getURL('pdf.html') + '?src=\\0' },
          },
          condition: {
            regexFilter: '^https?://[^?#]*\\.[pP][dD][fF](\\?[^#]*)?$',
            resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
          },
        },
      ],
    });
  } else if (!want && has) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PDF_RULE_ID] });
  }
  return want;
}

function createMenus() {
  chrome.contextMenus.create({
    id: 'aibs-cover',
    title: 'Cover this element with a sticker',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: TEACH_MENU_ID,
    title: 'Cover things like this…',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: PDF_MENU_ID,
    title: 'Open PDF link in sticker viewer',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', '*://*/*.PDF?*', 'file:///*.pdf', 'file:///*.PDF'],
  });
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(async () => {
    createMenus();
    await reconcile();
    await reconcilePdfRedirect().catch(() => {});
  });
  chrome.runtime.onStartup.addListener(() => {
    void reconcile();
    void reconcilePdfRedirect().catch(() => {});
  });

  // Every service-worker start: resume polling if a sticker tab or a lock survived.
  void ensurePolling();
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === POLL_ALARM) void poll();
  });

  chrome.permissions.onAdded.addListener((perm) => {
    if (perm.permissions?.includes('debugger')) void ensurePolling();
  });

  chrome.permissions.onRemoved.addListener(async (perm) => {
    for (const pattern of perm.origins ?? []) {
      if (pattern === ALL_SITES) {
        await unregisterId(ALL_SITES_ID);
        await reconcilePdfRedirect().catch(() => {});
        continue;
      }
      const origin = parseOrigin(pattern.replace(/\/\*$/, ''));
      if (origin) await unregisterOrigin(origin);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const had = globalDetectors;
      void loadGlobalDetectors().then(() => {
        if (had !== globalDetectors && lock.session) void reconcile().catch(() => {});
      });
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith('site:')) continue;
      const origin = parseOrigin(key.slice('site:'.length));
      if (origin) void syncCloak(origin, change.newValue as SiteRecord | undefined).catch(() => {});
    }
  });

  if (import.meta.env.DEV) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !('aibsNoAutoLock' in changes)) return;
      lock.noAutoLock = changes.aibsNoAutoLock.newValue === true;
      void poll();
    });
  }

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const msg = raw as { type: string; [k: string]: unknown };
    // Development builds only: start or end the manual session without the
    // popup's prompts. Dropped, message name included, from production builds.
    if (import.meta.env.DEV && msg.type === 'TEST_SESSION') {
      if (!fromExtensionUrl(sender)) {
        sendResponse({ ok: false, error: 'sender not allowed' });
        return undefined;
      }
      (async () => {
        try {
          if (msg.active === true) await startSession(false);
          else await endSession(false, msg.keepAuto !== false);
          sendResponse({ ok: true, session: await sessionInfo() });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }
    switch (msg.type) {
      case 'TAB_STATUS': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && sender.frameId === 0) setTabState(tabId, (msg as unknown as ContentToBackground & { type: 'TAB_STATUS' }).state as TabState);
        break;
      }
      case 'LOCK_SYNC': {
        // A content script asking for its own tab's lock. Doubles as the
        // keep-alive ping that holds the service worker, and polling, up.
        const tabId = sender.tab?.id;
        if (sender.id !== chrome.runtime.id || tabId === undefined) {
          sendResponse(undefined);
          return undefined;
        }
        ready.then(() => {
          void ensurePolling();
          sendResponse(lockFor(tabId));
        });
        return true;
      }
      case 'LOCK_REFUSED': {
        if (sender.id !== chrome.runtime.id || !sender.tab) break;
        const what = typeof msg.what === 'string' ? msg.what.replace(/[^\w:/ -]/g, '').slice(0, 40) : 'unknown';
        void audit({ action: 'unlock-refused', origin: originOfSender(sender), reason: what });
        break;
      }
      case 'CANVAS_PAGE': {
        // Top frame only, origin only (never the path), once per tab and origin.
        if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) break;
        const origin = originOfSender(sender);
        const key = `${sender.tab.id}|${origin ?? ''}`;
        if (canvasAudited.has(key)) break;
        canvasAudited.add(key);
        void audit({ action: 'canvas-page', origin });
        break;
      }
      case 'START_SESSION':
      case 'END_SESSION':
      case 'GET_SESSION': {
        if (!fromExtensionUrl(sender)) {
          sendResponse({ ok: false, error: 'sender not allowed' });
          return undefined;
        }
        (async () => {
          try {
            if (msg.type === 'START_SESSION') await startSession(msg.allSites === true);
            else if (msg.type === 'END_SESSION') await endSession(msg.keepAllSites === true, msg.keepAuto !== false);
            sendResponse({ ok: true, session: await sessionInfo() });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
        return true;
      }
      case 'ENABLE_ORIGIN':
      case 'DISABLE_ORIGIN': {
        // Only the popup may change which sites are protected: a content
        // script (any enabled origin's isolated world) must not be able to
        // switch another site's document_start protection off, or register a
        // pattern of its choosing.
        if (!fromExtensionPage(sender)) {
          sendResponse({ ok: false, error: 'sender not allowed' });
          return undefined;
        }
        const origin = parseOrigin(msg.origin);
        if (!origin) {
          sendResponse({ ok: false, error: 'invalid origin' });
          return undefined;
        }
        const tabId = typeof msg.tabId === 'number' ? msg.tabId : undefined;
        (async () => {
          try {
            if (msg.type === 'ENABLE_ORIGIN') {
              if (!(await hasOriginPermission(origin))) throw new Error('no host permission for ' + origin);
              await registerOrigin(origin);
              if (tabId !== undefined) await injectNow(tabId).catch(() => {});
            } else {
              // Disabling a site lifts its stickers: refused while locked.
              if (await tabLocked(tabId)) {
                void audit({ action: 'unlock-refused', origin, reason: 'DISABLE_ORIGIN' });
                throw new Error('locked');
              }
              await unregisterOrigin(origin);
            }
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
        return true;
      }
      case 'SET_PDF_REDIRECT':
      case 'GET_PDF_REDIRECT': {
        // Popup only. Turning it on needs the all-sites permission, which the
        // popup requests in the click's user gesture before sending this.
        if (!fromExtensionPage(sender)) {
          sendResponse({ ok: false, error: 'sender not allowed' });
          return undefined;
        }
        (async () => {
          try {
            if (msg.type === 'SET_PDF_REDIRECT') await chrome.storage.local.set({ [PDF_REDIRECT_KEY]: msg.on === true });
            const active = await reconcilePdfRedirect();
            const on = (await chrome.storage.local.get(PDF_REDIRECT_KEY))[PDF_REDIRECT_KEY] === true;
            sendResponse({ ok: true, on, active });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
        return true;
      }
      case 'GET_TAB_STATE': {
        if (!fromExtensionPage(sender) || typeof msg.tabId !== 'number') {
          sendResponse(undefined);
          return undefined;
        }
        const tabId = msg.tabId;
        getTabState(tabId).then(
          (s) => {
            const l = lockFor(tabId);
            sendResponse(s.locked || !l.locked ? s : { ...s, locked: true, lockReason: l.reason });
          },
          () => sendResponse(undefined),
        );
        return true;
      }
    }
    return undefined;
  });

  chrome.commands.onCommand.addListener(async (name, tab) => {
    const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId === undefined) return;
    if (name === 'toggle-edit-mode' || name === 'cover-selection') {
      chrome.tabs.sendMessage(tabId, { type: 'COMMAND', name }).catch(() => {});
    }
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === PDF_MENU_ID) {
      if (info.linkUrl && /^(https?|file):/i.test(info.linkUrl)) {
        void chrome.tabs.create({ url: viewerUrl(info.linkUrl), index: tab ? tab.index + 1 : undefined });
      }
      return;
    }
    if (info.menuItemId === TEACH_MENU_ID) {
      if (tab?.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'TEACH_SELECTION' }, { frameId: info.frameId ?? 0 }).catch(() => {});
      return;
    }
    if (info.menuItemId !== 'aibs-cover' || tab?.id === undefined) return;
    chrome.tabs.sendMessage(tab.id, { type: 'COVER_CONTEXT_TARGET' }, { frameId: info.frameId ?? 0 }).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
    lock.stickerTabs.delete(tabId);
    if (lock.debuggerTabs.delete(tabId)) {
      chrome.storage.session.set({ [DEBUGGER_TABS_KEY]: Array.from(lock.debuggerTabs) }).catch(() => {});
    }
    void ensurePolling();
  });
});
