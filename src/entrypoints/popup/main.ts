import type { GetStickersResponse, GetSuggestionsResponse, SessionInfo, StickerSummary } from '@/shared/messages';
import type { ScanSensitivity, Settings, StrictInputsMode, TabState } from '@/shared/types';
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
function sessionSection(session: SessionInfo | null, autoCount: number): HTMLElement {
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
            // Default keep: OK keeps them (stored like any sticker), Cancel removes them.
            let keepAuto = true;
            if (autoCount > 0) {
              keepAuto = confirm(
                `Keep ${autoCount} auto-covered sticker${autoCount === 1 ? '' : 's'}?\n\nOK keeps them on their sites. Cancel removes them.`,
              );
            }
            await chrome.runtime.sendMessage({ type: 'END_SESSION', keepAllSites: keep.checked, keepAuto });
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
    'canvas-page': 'Canvas page, nothing to auto-cover',
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
  const scan = h('fieldset', { disabled: locked, title: locked ? 'Locked: change settings after the AI session ends' : '' });
  scan.append(
    h('legend', { class: 'muted' }, 'Suggestions'),
    h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        checked: settings.scanDefault,
        onchange: async (e: Event) => {
          const cur = await loadSettings();
          await saveSettings({ ...cur, scanDefault: (e.target as HTMLInputElement).checked });
        },
      }),
      ' Suggest stickers on new sites',
    ),
  );
  for (const c of SENSITIVITY_CHOICES) {
    const radio = h('input', {
      type: 'radio',
      name: 'scanSensitivity',
      value: c.value,
      checked: settings.scanSensitivity === c.value,
      onchange: async () => {
        const cur = await loadSettings();
        await saveSettings({ ...cur, scanSensitivity: c.value });
      },
    });
    scan.append(h('label', {}, radio, ` ${c.label}`, h('span', { class: 'explain' }, c.explain)));
  }
  return h('details', { class: 'settings' }, h('summary', {}, 'Settings'), box, scan, pdfSettingsFieldset());
}

const SENSITIVITY_CHOICES: Array<{ value: ScanSensitivity; label: string; explain: string }> = [
  { value: 'labeled-only', label: 'Labeled only', explain: 'Only numbers next to a label such as "SSN" or "Account number".' },
  {
    value: 'balanced',
    label: 'Balanced (default)',
    explain: 'Checksummed numbers (SSN format, cards, IBAN) on their own; weaker patterns only near a label.',
  },
  { value: 'aggressive', label: 'Aggressive', explain: 'Also EIN and routing-shaped numbers without a label. More false alarms.' },
];

const CANVAS_NOTE =
  "This page draws its content on a canvas (for example Google Docs). Suggestions and Cover element can't see that text. Use Draw rectangle to cover it on screen.";
const MIXED_NOTE = 'Part of this page is drawn on a canvas. Text there can only be covered with Draw rectangle.';

/**
 * Suggestions waiting on this page: count, Cover all, Review, and the per-site switch.
 * On a canvas-drawn page the count is replaced by an explanation and the switch is disabled.
 */
async function suggestionsSection(tabId: number, origin: string, settings: Settings, canvas: boolean): Promise<HTMLElement> {
  const box = h('section', { class: 'suggest' });
  let res: GetSuggestionsResponse | null = null;
  try {
    res = (await chrome.tabs.sendMessage(tabId, { type: 'GET_SUGGESTIONS' }, { frameId: 0 })) as GetSuggestionsResponse;
  } catch {
    res = null;
  }
  const rec = await loadSite(origin);
  const enabled = typeof rec?.scanEnabled === 'boolean' ? rec.scanEnabled : settings.scanDefault;
  const n = res?.suggestions.length ?? 0;
  if (canvas && n === 0) {
    box.append(h('p', { class: 'hint canvas-note', id: 'canvas-note' }, CANVAS_NOTE));
  } else if (enabled && res) {
    const more = res.total > n ? '+' : '';
    const text = n ? `${n}${more} suggestion${n === 1 && !more ? '' : 's'} on this page` : res.scanning ? 'Scanning…' : 'No suggestions on this page.';
    const row = h('div', { class: 'row' }, h('span', { class: n ? 'suggest-count' : 'muted' }, text));
    if (n) {
      row.append(
        h(
          'button',
          {
            class: 'primary',
            onclick: async () => {
              await chrome.tabs.sendMessage(tabId, { type: 'COVER_SUGGESTIONS' }, { frameId: 0 });
              render();
            },
          },
          'Cover all',
        ),
        h(
          'button',
          {
            onclick: async () => {
              await chrome.tabs.sendMessage(tabId, { type: 'REVIEW_SUGGESTIONS' }, { frameId: 0 });
              window.close();
            },
          },
          'Review',
        ),
      );
    }
    box.append(row);
  }
  box.append(
    h(
      'label',
      { class: 'pause', title: canvas ? 'This page is drawn on a canvas: there is no text to scan' : '' },
      h('input', {
        type: 'checkbox',
        id: 'suggest-site',
        checked: enabled,
        disabled: canvas,
        onchange: async (e: Event) => {
          const cur = (await loadSite(origin)) ?? { v: 1 as const, origin, enabled: true, stickers: [], updatedAt: 0 };
          await saveSite({ ...cur, scanEnabled: (e.target as HTMLInputElement).checked, updatedAt: Date.now() });
          setTimeout(render, 150);
        },
      }),
      ' Suggest stickers on this site',
    ),
  );
  return box;
}

async function render() {
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  const session = await getSession();
  const audit = await auditSection();
  const settings = await loadSettings();
  app.replaceChildren(h('h1', {}, 'AI Blocker Stickers'), pdfOpenSection(tab));
  let tabLocked = false;
  let autoCount = 0;
  const finish = () => app.append(sessionSection(session, autoCount), settingsSection(settings, tabLocked || session?.active === true), audit);

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
  autoCount = state.autoCount ?? 0;
  const lockTitle = locked ? lockMessage(state.lockReason) : '';
  const canvas = state.rendering === 'canvas';
  if (locked) app.append(h('p', { class: 'locked' }, `Locked: ${lockTitle}. Stickers stay on.`));
  if (autoCount > 0) {
    app.append(
      h(
        'p',
        { class: 'hint' },
        `${autoCount} sensitive number${autoCount === 1 ? ' was' : 's were'} covered automatically on this page${locked ? ' during the lock' : ''}. They are kept only if you choose to when the session ends.`,
      ),
    );
  }
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
        id: 'cover-element',
        disabled: locked || canvas,
        title: locked ? lockTitle : canvas ? "This page is drawn on a canvas: there are no elements to cover. Use Draw rectangle." : '',
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
        id: 'draw-rect',
        class: canvas ? 'primary' : '',
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
  if (!locked) app.append(await suggestionsSection(tabId, origin, settings, canvas));
  else if (canvas) app.append(h('p', { class: 'hint canvas-note', id: 'canvas-note' }, CANVAS_NOTE));
  if (state.rendering === 'mixed') app.append(h('p', { class: 'hint', id: 'mixed-note' }, MIXED_NOTE));

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

const EXACT = 'exact';

/**
 * Scope choices for a sticker: this page only (exact, matched by an HMAC the
 * content script computes), pages like this (ids generalised), this section,
 * the whole site. Pattern options are valued `pattern:<glob>`; every glob
 * goes through the same sanitiser as stored scopes, so no account number or
 * document id is ever offered (or stored) verbatim.
 */
function scopeOptions(s: StickerSummary): { value: string; label: string; title: string }[] {
  const path = s.currentPath || '/';
  const like = defaultPathPattern(path);
  const section = prefixPathPattern(path);
  const out: { value: string; label: string; title: string }[] = [
    { value: EXACT, label: 'This page only', title: 'Only this exact page' },
  ];
  const add = (pattern: string, label: string) => {
    const value = 'pattern:' + pattern;
    if (!out.some((o) => o.value === value)) out.push({ value, label, title: pattern });
  };
  add(like, 'Pages like this');
  add(section, 'This section');
  add('/**', 'Whole site');
  if (s.scopeKind !== 'exact') add(sanitizePathPattern(s.pathPattern), s.pathPattern);
  return out;
}

function scopeSelect(tabId: number, s: StickerSummary, locked: boolean, lockTitle: string): HTMLSelectElement {
  const applies = s.scopeKind === 'exact' ? 'this page only' : s.pathPattern;
  const sel = h('select', { class: 'scope', title: locked ? lockTitle : `Applies to ${applies}`, disabled: locked });
  for (const o of scopeOptions(s)) sel.append(h('option', { value: o.value, title: o.title }, o.label));
  sel.value = s.scopeKind === 'exact' ? EXACT : 'pattern:' + sanitizePathPattern(s.pathPattern);
  sel.onchange = async () => {
    const msg =
      sel.value === EXACT
        ? { type: 'SET_SCOPE', id: s.id, kind: 'exact' }
        : { type: 'SET_SCOPE', id: s.id, kind: 'pattern', pathPattern: sel.value.slice('pattern:'.length) };
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    render();
  };
  return sel;
}

function stickerRow(tabId: number, s: StickerSummary, locked: boolean, lockTitle: string): HTMLElement {
  const dot = h('span', { class: `dot ${s.status}`, title: s.status });
  const kindName = s.kind === 'rect' ? 'Rectangle' : s.source === 'session-auto' ? 'Auto-covered' : s.source === 'suggest' ? 'Suggested' : 'Element';
  const name = h('span', { class: 'name' }, s.label || kindName);
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

// ==== PDF viewer (begin) ====
// "Open in sticker PDF viewer" for a PDF tab, and the "Always open PDFs in
// the sticker viewer" setting. Self-contained: render() only places these.

function tabLooksLikePdf(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? '');
    return /^(https?|file):$/.test(u.protocol) && /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Asks the tab for `document.contentType` when it can be scripted (PDFs whose URL has no .pdf). */
async function tabContentIsPdf(tabId: number): Promise<boolean> {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
    return r?.result === 'application/pdf';
  } catch {
    return false;
  }
}

function pdfOpenSection(tab: chrome.tabs.Tab | undefined): HTMLElement {
  const box = h('section', { class: 'pdf-open' });
  const url = tab?.url;
  if (!tab?.id || !url || !/^(https?|file):/i.test(url)) return box;
  const tabId = tab.id;
  const show = () =>
    box.replaceChildren(
      h('div', { class: 'row' },
        h('button', {
          id: 'open-pdf-viewer',
          class: 'primary',
          onclick: async () => {
            // Permission prompt first, inside the click's user gesture: the
            // viewer fetches the PDF and needs access to its origin.
            const u = new URL(url);
            if (u.protocol !== 'file:') {
              try {
                await chrome.permissions.request({ origins: [`${u.origin}/*`] });
              } catch {
                /* declined: the viewer explains and offers the prompt again */
              }
            }
            await chrome.tabs.create({ url: chrome.runtime.getURL('pdf.html') + '?src=' + encodeURIComponent(url), index: tab.index + 1 });
            window.close();
          },
        }, 'Open in sticker PDF viewer'),
      ),
      h('p', { class: 'hint' }, "Chrome's PDF viewer can't take stickers. The sticker viewer can, and downloads a redacted copy."),
    );
  if (tabLooksLikePdf(url)) show();
  else void tabContentIsPdf(tabId).then((pdf) => pdf && show());
  return box;
}

function pdfSettingsFieldset(): HTMLElement {
  const box = h('fieldset', {});
  const check = h('input', {
    type: 'checkbox',
    id: 'pdf-redirect',
    onchange: async () => {
      const on = check.checked;
      if (on) {
        // A redirect rule needs host access to every page it redirects.
        let granted = false;
        try {
          granted = await chrome.permissions.request({ origins: ['*://*/*'] });
        } catch {
          granted = false;
        }
        if (!granted) {
          check.checked = false;
          return;
        }
      }
      await chrome.runtime.sendMessage({ type: 'SET_PDF_REDIRECT', on }).catch(() => undefined);
    },
  });
  void (chrome.runtime.sendMessage({ type: 'GET_PDF_REDIRECT' }) as Promise<{ on?: boolean; active?: boolean } | undefined>)
    .then((r) => (check.checked = r?.active === true))
    .catch(() => {});
  box.append(
    h('legend', { class: 'muted' }, 'PDFs'),
    h('label', {}, check, ' Always open PDFs in the sticker viewer',
      h('span', { class: 'explain' }, 'Links ending in .pdf open in the extension\'s viewer instead of Chrome\'s. Needs access to all sites. Local files also need "Allow access to file URLs" in chrome://extensions.')),
  );
  return box;
}
// ==== PDF viewer (end) ====

render();
