import type { ContentToBackground } from '@/shared/messages';
import { listSites } from '@/shared/storage';
import { DEFAULT_TAB_STATE, type TabState } from '@/shared/types';
import { parseOrigin, scriptId } from '@/shared/origin';

const CONTENT_SCRIPT = 'content-scripts/content.js';
const DEV_FIXTURE_ORIGINS = ['http://127.0.0.1:4173', 'http://localhost:4173'];

/** The popup (or another extension page): same extension, not a content script. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && (!sender.url || sender.url.startsWith(chrome.runtime.getURL('')));
}

async function registerOrigin(origin: string): Promise<void> {
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const script: chrome.scripting.RegisteredContentScript = {
    id,
    matches: [`${origin}/*`],
    js: [CONTENT_SCRIPT],
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

async function unregisterOrigin(origin: string): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] });
  } catch {
    /* not registered */
  }
}

async function hasOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

/**
 * Register every enabled site we still have permission for, and unregister
 * every other script id: disabled sites, sites without permission, and ids
 * left over from the old (colliding) naming scheme. Origins read from storage
 * are validated like message input, because content scripts can write it.
 */
async function reconcile(): Promise<void> {
  const wanted = new Set<string>();
  const sites = await listSites();
  for (const s of sites) {
    const origin = parseOrigin(s.origin);
    if (!origin || !s.enabled) continue;
    if (!(await hasOriginPermission(origin))) continue;
    await registerOrigin(origin);
    wanted.add(scriptId(origin));
  }
  if (import.meta.env.DEV) {
    for (const o of DEV_FIXTURE_ORIGINS) {
      if (await hasOriginPermission(o)) {
        await registerOrigin(o);
        wanted.add(scriptId(o));
      }
    }
  }
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered.map((r) => r.id).filter((id) => !wanted.has(id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
}

async function injectNow(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [CONTENT_SCRIPT] });
}

// ---- badge ----
const tabKey = (tabId: number) => `tab:${tabId}`;

async function setTabState(tabId: number, state: TabState) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
  let text = state.stickerCount ? String(state.stickerCount) : '';
  let color = '#374151';
  if (state.paused) {
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

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(async () => {
    chrome.contextMenus.create({
      id: 'aibs-cover',
      title: 'Cover this element with a sticker',
      contexts: ['all'],
    });
    await reconcile();
  });
  chrome.runtime.onStartup.addListener(() => reconcile());

  chrome.permissions.onRemoved.addListener(async (perm) => {
    for (const pattern of perm.origins ?? []) {
      const origin = parseOrigin(pattern.replace(/\/\*$/, ''));
      if (origin) await unregisterOrigin(origin);
    }
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const msg = raw as { type: string; [k: string]: unknown };
    switch (msg.type) {
      case 'TAB_STATUS': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && sender.frameId === 0) setTabState(tabId, (msg as unknown as ContentToBackground & { type: 'TAB_STATUS' }).state as TabState);
        break;
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
              await unregisterOrigin(origin);
            }
            sendResponse({ ok: true });
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
        getTabState(msg.tabId).then(sendResponse, () => sendResponse(undefined));
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
    if (info.menuItemId !== 'aibs-cover' || tab?.id === undefined) return;
    chrome.tabs.sendMessage(tab.id, { type: 'COVER_CONTEXT_TARGET' }, { frameId: info.frameId ?? 0 }).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
  });
});
