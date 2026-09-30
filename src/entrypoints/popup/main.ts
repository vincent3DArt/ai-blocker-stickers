import type { GetStickersResponse, SessionInfo, StickerSummary } from '@/shared/messages';
import type { Settings, StrictInputsMode, TabState } from '@/shared/types';
import { loadSettings, loadSite, saveSettings, saveSite } from '@/shared/storage';
import { defaultPathPattern, prefixPathPattern, sanitizePathPattern } from '@/shared/url-match';
import { AUDIT_KEY, isAuditEntry, lockMessage, type AuditEntry } from '@/shared/lock';

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

async function getSession(): Promise<SessionInfo | null> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'GET_SESSION' })) as { ok: boolean; session?: SessionInfo };
    return r?.session ?? null;
  } catch {
    return null;
  }
}

/** Show a refusal from the content script (or background) under the controls. */
function showRefusal(res: unknown) {
  const r = res as { ok?: boolean; locked?: boolean; error?: string } | undefined;
  if (r && r.ok === false) app.append(h('p', { class: 'error' }, `Refused: ${r.error ?? 'locked'}`));
  return !(r && r.ok === false);
}

/**
 * AI session controls. Start runs inside the click's user gesture so the
 * permission prompts are allowed: all sites (stickers and the lock apply
 * everywhere) and, the first time, the optional debugger permission.
 */
function sessionSection(session: SessionInfo | null): HTMLElement {
  const box = h('section', { class: 'session' });
  if (!session) return box;
  if (session.active) {
    const keep = h('input', { type: 'checkbox', checked: session.keepAllSites });
    box.append(
      h('p', { class: 'locked' }, 'AI session active. Peek, edit, pause and delete are locked in every tab.'),
      h(
        'button',
        {
          class: 'danger',
          onclick: async () => {
            if (!confirm('End the AI session? Peek, edit, pause and delete will work again.')) return;
            await chrome.runtime.sendMessage({ type: 'END_SESSION', keepAllSites: keep.checked });
            render();
          },
        },
        'End session',
      ),
      h('label', { class: 'keep' }, keep, ' Keep protection on all sites'),
    );
    return box;
  }
  const needDebugger = !session.debuggerGranted;
  box.append(
    h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          // One prompt, requested before any other await so the gesture holds.
          const request: chrome.permissions.Permissions = {};
          if (!session.allSitesGranted) request.origins = ['*://*/*'];
          if (needDebugger) request.permissions = ['debugger'];
          let granted = session.allSitesGranted;
          if (request.origins || request.permissions) {
            try {
              await chrome.permissions.request(request);
            } catch {
              /* declined or unavailable: the session still locks */
            }
            granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
          }
          await chrome.runtime.sendMessage({ type: 'START_SESSION', allSites: granted });
          render();
        },
      },
      'Start AI session',
    ),
    h(
      'p',
      { class: 'hint' },
      'Locks peek, edit, pause and delete in every tab until you end it. It asks for access to all sites so stickers apply everywhere',
      needDebugger ? ', and for the debugger permission, to detect when an AI agent is driving the browser.' : '.',
    ),
  );
  return box;
}

function describeAudit(e: AuditEntry): string {
  const when = new Date(e.ts).toLocaleTimeString();
  const what: Record<AuditEntry['action'], string> = {
    'session-start': 'Session started',
    'session-end': 'Session ended',
    'auto-lock': 'Automation detected, locked',
    'auto-unlock': 'Automation gone, unlocked',
    'unlock-refused': 'Refused',
  };
  return `${when} ${what[e.action]}${e.reason ? ` (${e.reason})` : ''}${e.origin ? ` ${e.origin}` : ''}`;
}

async function auditSection(): Promise<HTMLElement> {
  const raw = (await chrome.storage.local.get(AUDIT_KEY))[AUDIT_KEY];
  const entries = (Array.isArray(raw) ? raw.filter(isAuditEntry) : []).slice(-5).reverse();
  const list = h('ul', { class: 'audit' });
  if (!entries.length) list.append(h('li', { class: 'muted' }, 'Nothing yet.'));
  for (const e of entries) list.append(h('li', {}, describeAudit(e)));
  return h('details', { class: 'audit' }, h('summary', {}, 'Lock activity'), list);
}

const STRICT_CHOICES: Array<{ value: StrictInputsMode; label: string; explain: string }> = [
  {
    value: 'locked',
    label: 'While locked (default)',
    explain: 'During an AI session or detected automation, covered text fields read back as bullets. Forms still submit the real value.',
  },
  {
    value: 'always',
    label: 'Always',
    explain: 'Covered text fields always read back as bullets. Some sites that re-read their own fields may break.',
  },
  {
    value: 'never',
    label: 'Never',
    explain: 'Covered fields are hidden on screen and from the accessibility tree, but scripts can still read their value.',
  },
];

/**
 * Settings disclosure. Weakening protection is an unlock, so the choice is
 * disabled while locked (the content script also defers any downgrade until
 * the lock ends).
 */
function settingsSection(settings: Settings, locked: boolean): HTMLElement {
  const box = h('fieldset', { disabled: locked, title: locked ? 'Locked: change settings after the AI session ends' : '' });
  box.append(h('legend', { class: 'muted' }, 'Strict input masking'));
  for (const c of STRICT_CHOICES) {
    const radio = h('input', {
      type: 'radio',
      name: 'strictInputs',
      value: c.value,
      checked: settings.strictInputs === c.value,
      onchange: async () => {
        const cur = await loadSettings();
        await saveSettings({ ...cur, strictInputs: c.value });
      },
    });
    box.append(h('label', {}, radio, ` ${c.label}`, h('span', { class: 'explain' }, c.explain)));
  }
  return h('details', { class: 'settings' }, h('summary', {}, 'Settings'), box);
}

async function render() {
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  const session = await getSession();
  const audit = await auditSection();
  const settings = await loadSettings();
  app.replaceChildren(h('h1', {}, 'AI Blocker Stickers'));
  let tabLocked = false;
  const finish = () => app.append(sessionSection(session), settingsSection(settings, tabLocked || session?.active === true), audit);

  if (!tab?.id || !origin) {
    app.append(h('p', { class: 'muted' }, 'Stickers work on http(s) pages only.'));
    finish();
    return;
  }
  const tabId = tab.id;
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  const content = granted ? await queryContent(tabId) : null;

  app.append(h('div', { class: 'origin' }, origin));
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
    finish();
    return;
  }

  const state: TabState = content.state;
  const locked = state.locked === true;
  tabLocked = locked;
  const lockTitle = locked ? lockMessage(state.lockReason) : '';
  if (locked) app.append(h('p', { class: 'locked' }, `Locked: ${lockTitle}. Stickers stay on.`));
  const strictCount = state.strictInputs ?? 0;
  if (strictCount > 0) {
    app.append(
      h(
        'p',
        { class: 'warn' },
        `Strict input masking is on for ${strictCount} field${strictCount === 1 ? '' : 's'}: page scripts read bullets, forms submit the real value. A site that re-reads its own fields may misbehave.`,
      ),
    );
  }

  const actions = h('div', { class: 'row' });
  actions.append(
    h(
      'button',
      {
        class: state.editMode ? 'active' : '',
        disabled: locked,
        title: lockTitle,
        onclick: async () => {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'SET_EDIT_MODE', enabled: !state.editMode }, { frameId: 0 });
          if (showRefusal(res)) window.close();
        },
      },
      state.editMode ? 'Exit edit mode' : 'Edit stickers',
    ),
    h(
      'button',
      {
        disabled: locked,
        title: lockTitle,
        onclick: async () => {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'START_PICK' }, { frameId: 0 });
          if (showRefusal(res)) window.close();
        },
      },
      'Cover element',
    ),
    h(
      'button',
      {
        disabled: locked,
        title: lockTitle,
        onclick: async () => {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'START_RECT' }, { frameId: 0 });
          if (showRefusal(res)) window.close();
        },
      },
      'Draw rectangle',
    ),
  );
  app.append(actions);

  const list = h('ul', { class: 'list' });
  if (content.stickers.length === 0) list.append(h('li', { class: 'muted' }, 'No stickers on this page.'));
  for (const s of content.stickers) list.append(stickerRow(tabId, s, locked, lockTitle));
  app.append(list);

  app.append(
    h(
      'label',
      { class: 'pause', title: lockTitle },
      h('input', {
        type: 'checkbox',
        checked: state.paused,
        disabled: locked,
        onchange: async (e: Event) => {
          const paused = (e.target as HTMLInputElement).checked;
          const res = await chrome.tabs.sendMessage(tabId, { type: 'SET_PAUSED', paused });
          showRefusal(res);
          render();
        },
      }),
      ' Pause protection on this tab (reveals everything)',
    ),
    h('p', { class: 'hint' }, 'Peek: hover a sticker and hold Ctrl+Shift. Edit mode: Alt+Shift+S.'),
  );
  finish();
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

function scopeSelect(tabId: number, s: StickerSummary, locked: boolean, lockTitle: string): HTMLSelectElement {
  const sel = h('select', { class: 'scope', title: locked ? lockTitle : `Applies to ${s.pathPattern}`, disabled: locked });
  for (const value of scopeOptions(s)) sel.append(h('option', { value }, value));
  sel.value = s.pathPattern;
  sel.onchange = async () => {
    await chrome.tabs.sendMessage(tabId, { type: 'SET_SCOPE', id: s.id, pathPattern: sel.value }, { frameId: 0 });
    render();
  };
  return sel;
}

function stickerRow(tabId: number, s: StickerSummary, locked: boolean, lockTitle: string): HTMLElement {
  const dot = h('span', { class: `dot ${s.status}`, title: s.status });
  const name = h('span', { class: 'name' }, s.label || (s.kind === 'rect' ? 'Rectangle' : 'Element'));
  const scope = scopeSelect(tabId, s, locked, lockTitle);
  const locate = h('button', { class: 'small', onclick: () => chrome.tabs.sendMessage(tabId, { type: 'LOCATE_STICKER', id: s.id }) }, 'Show');
  const del = h(
    'button',
    {
      class: 'small danger',
      disabled: locked,
      title: lockTitle,
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
