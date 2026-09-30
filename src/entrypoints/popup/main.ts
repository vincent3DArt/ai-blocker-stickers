import type { GetStickersResponse, StickerSummary } from '@/shared/messages';
import type { TabState } from '@/shared/types';
import { loadSite, saveSite } from '@/shared/storage';
import { defaultPathPattern, prefixPathPattern, sanitizePathPattern } from '@/shared/url-match';

const app = document.querySelector<HTMLDivElement>('#app')!;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  el.append(...children);
  return el;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function originOf(url: string | undefined): string | null {
  try {
    if (!url) return null;
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function queryContent(tabId: number): Promise<GetStickersResponse | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'GET_STICKERS' }, { frameId: 0 })) as GetStickersResponse;
  } catch {
    return null;
  }
}

async function render() {
  app.replaceChildren();
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  if (!tab?.id || !origin) {
    app.append(h('p', { class: 'muted' }, 'Stickers work on http(s) pages only.'));
    return;
  }
  const tabId = tab.id;
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  const content = granted ? await queryContent(tabId) : null;

  app.append(h('h1', {}, 'AI Blocker Stickers'), h('div', { class: 'origin' }, origin));
  if (content?.state.saveError) {
    app.append(h('p', { class: 'error' }, 'Could not save stickers on this site. They protect this page now but may not return after a reload.'));
  }

  if (!granted || !content) {
    app.append(
      h('p', { class: 'muted' }, 'Not enabled on this site yet. Enabling lets stickers apply before the page paints.'),
      h(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
            if (!ok) return;
            let res: { ok?: boolean; error?: string } | undefined;
            try {
              const rec = (await loadSite(origin)) ?? { v: 1 as const, origin, enabled: true, stickers: [], updatedAt: 0 };
              rec.enabled = true;
              rec.updatedAt = Date.now();
              await saveSite(rec);
              res = await chrome.runtime.sendMessage({ type: 'ENABLE_ORIGIN', origin, tabId });
            } catch (e) {
              res = { ok: false, error: String(e) };
            }
            if (!res?.ok) {
              app.append(h('p', { class: 'error' }, `Could not enable this site: ${res?.error ?? 'no response'}`));
              return;
            }
            setTimeout(render, 300);
          },
        },
        'Enable on this site',
      ),
    );
    return;
  }

  const state: TabState = content.state;
  const actions = h('div', { class: 'row' });
  actions.append(
    h(
      'button',
      {
        class: state.editMode ? 'active' : '',
        onclick: async () => {
          await chrome.tabs.sendMessage(tabId, { type: 'SET_EDIT_MODE', enabled: !state.editMode }, { frameId: 0 });
          window.close();
        },
      },
      state.editMode ? 'Exit edit mode' : 'Edit stickers',
    ),
    h(
      'button',
      {
        onclick: async () => {
          await chrome.tabs.sendMessage(tabId, { type: 'START_PICK' }, { frameId: 0 });
          window.close();
        },
      },
      'Cover element',
    ),
    h(
      'button',
      {
        onclick: async () => {
          await chrome.tabs.sendMessage(tabId, { type: 'START_RECT' }, { frameId: 0 });
          window.close();
        },
      },
      'Draw rectangle',
    ),
  );
  app.append(actions);

  const list = h('ul', { class: 'list' });
  if (content.stickers.length === 0) list.append(h('li', { class: 'muted' }, 'No stickers on this page.'));
  for (const s of content.stickers) list.append(stickerRow(tabId, s));
  app.append(list);

  app.append(
    h('label', { class: 'pause' }, h('input', {
      type: 'checkbox',
      checked: state.paused,
      onchange: async (e: Event) => {
        const paused = (e.target as HTMLInputElement).checked;
        await chrome.tabs.sendMessage(tabId, { type: 'SET_PAUSED', paused });
        render();
      },
    }), ' Pause protection on this tab (reveals everything)'),
    h('p', { class: 'hint' }, 'Peek: hover a sticker and hold Ctrl+Shift. Edit mode: Alt+Shift+S.'),
  );
}

/** Scope choices for a sticker: this exact page, its default pattern, its section, the whole site. */
function scopeOptions(s: StickerSummary): string[] {
  // The exact path goes through the same sanitiser as every stored scope, so
  // an account number in the URL is never offered (or stored) verbatim.
  const exact = sanitizePathPattern(s.currentPath || '/');

  const out = [exact];
  for (const p of [defaultPathPattern(exact), prefixPathPattern(exact), '/**', s.pathPattern]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function scopeSelect(tabId: number, s: StickerSummary): HTMLSelectElement {
  const sel = h('select', { class: 'scope', title: `Applies to ${s.pathPattern}` });
  for (const value of scopeOptions(s)) sel.append(h('option', { value }, value));
  sel.value = s.pathPattern;
  sel.onchange = async () => {
    await chrome.tabs.sendMessage(tabId, { type: 'SET_SCOPE', id: s.id, pathPattern: sel.value }, { frameId: 0 });
    render();
  };
  return sel;
}

function stickerRow(tabId: number, s: StickerSummary): HTMLElement {
  const dot = h('span', { class: `dot ${s.status}`, title: s.status });
  const name = h('span', { class: 'name' }, s.label || (s.kind === 'rect' ? 'Rectangle' : 'Element'));
  const scope = scopeSelect(tabId, s);
  const locate = h('button', { class: 'small', onclick: () => chrome.tabs.sendMessage(tabId, { type: 'LOCATE_STICKER', id: s.id }) }, 'Show');
  const del = h(
    'button',
    {
      class: 'small danger',
      onclick: async () => {
        await chrome.tabs.sendMessage(tabId, { type: 'DELETE_STICKER', id: s.id });
        render();
      },
    },
    'Delete',
  );
  return h('li', {}, dot, name, scope, locate, del);
}

render();
