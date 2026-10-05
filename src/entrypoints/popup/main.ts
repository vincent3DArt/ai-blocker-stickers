import './popup.css';
import type { GetStickersResponse, GetSuggestionsResponse, SessionInfo, StickerSummary } from '@/shared/messages';
import type { ScanSensitivity, Settings, StrictInputsMode, TabState } from '@/shared/types';
import { loadSettings, loadSite, saveSettings, saveSite } from '@/shared/storage';
import { defaultPathPattern, prefixPathPattern, sanitizePathPattern } from '@/shared/url-match';
import { AUDIT_KEY, isAuditEntry, lockMessage, type AuditEntry } from '@/shared/lock';
import { icon, type IconName } from '@/shared/icons';

const app = document.querySelector<HTMLDivElement>('#app')!;
const README_URL = 'https://github.com/vincent3DArt/ai-blocker-stickers#usage';

type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { class?: string; tip?: string };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  const { class: cls, tip, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  if (tip) {
    el.dataset.tip = tip;
    el.setAttribute('aria-description', tip);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** A switch: a real checkbox (keeps its id and state for tests and keyboards) drawn as a track. */
function toggle(input: HTMLInputElement, text: string, props: Props<'label'> = {}): HTMLLabelElement {
  input.type = 'checkbox';
  return h('label', { ...props, class: `switch ${props.class ?? ''}`.trim() }, input, h('span', { class: 'track' }), h('span', {}, text));
}

function kbd(...keys: string[]): Node[] {
  const out: Node[] = [];
  keys.forEach((k, i) => {
    if (i) out.push(document.createTextNode('+'));
    out.push(h('kbd', {}, k));
  });
  return out;
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

function notice(kind: 'error' | 'warn' | 'locked' | 'info', text: string | Node[], props: Props<'p'> = {}): HTMLElement {
  const ic: IconName = kind === 'locked' ? 'lock' : kind === 'info' ? 'info' : 'alert';
  const body = h('span', {});
  if (typeof text === 'string') body.textContent = text;
  else body.append(...text);
  return h('p', { ...props, class: `notice ${kind} ${props.class ?? ''}`.trim() }, icon(ic), body);
}

/** Show a refusal from the content script (or background) under the controls. */
function showRefusal(res: unknown) {
  const r = res as { ok?: boolean; locked?: boolean; error?: string } | undefined;
  if (r && r.ok === false) app.append(notice('error', `Refused: ${r.error ?? 'locked'}`));
  return !(r && r.ok === false);
}

// ---- header ----

type StatusKind = 'protected' | 'paused' | 'locked' | 'off' | 'canvas';

function header(origin: string | null): { el: HTMLElement; setStatus(kind: StatusKind, label: string, title?: string): void } {
  const chip = h('span', { class: 'chip off', id: 'status-chip' }, 'Not enabled');
  const brand = h(
    'div',
    { class: 'brand' },
    h('h1', {}, 'AI Blocker Stickers'),
    origin ? h('span', { class: 'origin', title: origin }, origin.replace(/^https?:\/\//, '')) : null,
  );
  const mark = h('img', { class: 'brand-mark', src: '/icon/48.png', alt: '' });
  const el = h('header', { class: 'top' }, mark, brand, chip);
  return {
    el,
    setStatus(kind, label, title = '') {
      chip.className = `chip ${kind}`;
      chip.textContent = label;
      chip.title = title;
    },
  };
}

/**
 * AI session controls. Start runs inside the click's user gesture so the
 * permission prompts are allowed: all sites (stickers and the lock apply
 * everywhere) and, the first time, the optional debugger permission.
 */
function sessionSection(session: SessionInfo | null, autoCount: number): HTMLElement {
  const box = h('section', { class: 'card session' });
  if (!session) {
    box.hidden = true;
    return box;
  }
  if (session.active) {
    box.classList.add('active');
    const keep = h('input', { checked: session.keepAllSites });
    const since = session.startedAt
      ? h('span', { class: 'since' }, `since ${new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
      : null;
    box.append(
      h('div', { class: 'session-head' }, icon('lock'), h('strong', {}, 'AI session active'), since),
      h('p', { class: 'lines locked' }, 'Peek, edit, pause and delete are locked in every tab.'),
      h(
        'button',
        {
          class: 'danger block',
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
      toggle(keep, 'Keep protection on all sites', { class: 'keep' }),
    );
    return box;
  }
  const needDebugger = !session.debuggerGranted;
  box.append(
    h('div', { class: 'session-head' }, icon('lock'), h('strong', {}, 'AI session')),
    h(
      'p',
      { class: 'lines' },
      'Locks peek, edit, pause and delete in every tab until you end it. ',
      needDebugger ? 'Asks for all-sites access and the debugger permission, to spot AI agents. ' : 'Asks for access to all sites. ',
      h('a', { href: README_URL, target: '_blank', rel: 'noopener' }, 'Learn more'),
    ),
    h(
      'button',
      {
        class: 'primary block',
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
      icon('lock'),
      'Start AI session',
    ),
  );
  return box;
}

function describeAudit(e: AuditEntry): { when: string; text: string } {
  const when = new Date(e.ts).toLocaleTimeString();
  const what: Record<AuditEntry['action'], string> = {
    'session-start': 'Session started',
    'session-end': 'Session ended',
    'auto-lock': 'Automation detected, locked',
    'auto-unlock': 'Automation gone, unlocked',
    'unlock-refused': 'Refused',
    'canvas-page': 'Canvas page, nothing to auto-cover',
  };
  return { when, text: `${what[e.action]}${e.reason ? ` (${e.reason})` : ''}${e.origin ? ` ${e.origin}` : ''}` };
}

function disclosure(cls: string, ic: IconName, title: string, ...content: Node[]): HTMLDetailsElement {
  const chev = icon('chevron', 14);
  chev.classList.add('chev');
  return h(
    'details',
    { class: `disclosure ${cls}` },
    h('summary', {}, icon(ic), title, chev),
    h('div', { class: 'content' }, ...content),
  );
}

async function auditSection(): Promise<HTMLElement> {
  const raw = (await chrome.storage.local.get(AUDIT_KEY))[AUDIT_KEY];
  const entries = (Array.isArray(raw) ? raw.filter(isAuditEntry) : []).slice(-5).reverse();
  const list = h('ul', { class: 'audit' });
  if (!entries.length) list.append(h('li', { class: 'muted' }, 'Nothing yet.'));
  for (const e of entries) {
    const d = describeAudit(e);
    list.append(h('li', {}, h('time', {}, d.when), d.text));
  }
  return disclosure('audit', 'lock', 'Lock activity', list);
}

const STRICT_CHOICES: Array<{ value: StrictInputsMode; label: string; explain: string }> = [
  {
    value: 'locked',
    label: 'While locked',
    explain: 'Default. During an AI session or detected automation, covered fields read back as bullets. Forms still submit the real value.',
  },
  {
    value: 'always',
    label: 'Always',
    explain: 'Covered fields always read back as bullets. Some sites that re-read their own fields may break.',
  },
  {
    value: 'never',
    label: 'Never',
    explain: 'Covered fields are hidden on screen and from the accessibility tree, but scripts can still read their value.',
  },
];

const SENSITIVITY_CHOICES: Array<{ value: ScanSensitivity; label: string; explain: string }> = [
  { value: 'labeled-only', label: 'Labeled only', explain: 'Only numbers next to a label such as "SSN" or "Account number".' },
  {
    value: 'balanced',
    label: 'Balanced',
    explain: 'Default. Checksummed numbers (SSN format, cards, IBAN) on their own; weaker patterns only near a label.',
  },
  { value: 'aggressive', label: 'Aggressive', explain: 'Also EIN and routing-shaped numbers without a label. More false alarms.' },
];

/** Segmented radio group with a one-line description of the current choice. */
function segmented<T extends string>(
  name: string,
  choices: Array<{ value: T; label: string; explain: string }>,
  current: T,
  save: (v: T) => Promise<void>,
): Node[] {
  const explain = h('span', { class: 'explain' }, choices.find((c) => c.value === current)?.explain ?? '');
  const seg = h('div', { class: 'seg', role: 'radiogroup' });
  for (const c of choices) {
    const radio = h('input', {
      type: 'radio',
      name,
      value: c.value,
      checked: current === c.value,
      onchange: async () => {
        explain.textContent = c.explain;
        await save(c.value);
      },
    });
    seg.append(h('label', { title: c.explain }, radio, h('span', {}, c.label)));
  }
  return [seg, explain];
}

/**
 * Settings disclosure. Weakening protection is an unlock, so the choice is
 * disabled while locked (the content script also defers any downgrade until
 * the lock ends).
 */
function settingsSection(settings: Settings, locked: boolean): HTMLElement {
  const lockedTitle = locked ? 'Locked: change settings after the AI session ends' : '';
  const box = h('fieldset', { disabled: locked, title: lockedTitle });
  box.append(
    h('legend', {}, 'Strict input masking'),
    ...segmented('strictInputs', STRICT_CHOICES, settings.strictInputs, async (v) => {
      const cur = await loadSettings();
      await saveSettings({ ...cur, strictInputs: v });
    }),
  );
  const scan = h('fieldset', { disabled: locked, title: lockedTitle });
  scan.append(
    h('legend', {}, 'Suggestions'),
    toggle(
      h('input', {
        checked: settings.scanDefault,
        onchange: async (e: Event) => {
          const cur = await loadSettings();
          await saveSettings({ ...cur, scanDefault: (e.target as HTMLInputElement).checked });
        },
      }),
      'Suggest stickers on new sites',
    ),
    ...segmented('scanSensitivity', SENSITIVITY_CHOICES, settings.scanSensitivity, async (v) => {
      const cur = await loadSettings();
      await saveSettings({ ...cur, scanSensitivity: v });
    }),
  );
  return disclosure('settings', 'settings', 'Settings', box, scan, pdfSettingsFieldset());
}

const CANVAS_NOTE =
  "This page draws its content on a canvas (for example Google Docs). Suggestions and Cover element can't see that text. Use Draw rectangle to cover it on screen.";
const MIXED_NOTE = 'Part of this page is drawn on a canvas. Text there can only be covered with Draw rectangle.';

async function fetchSuggestions(tabId: number): Promise<GetSuggestionsResponse | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'GET_SUGGESTIONS' }, { frameId: 0 })) as GetSuggestionsResponse;
  } catch {
    return null;
  }
}

async function scanEnabledFor(origin: string, settings: Settings): Promise<boolean> {
  const rec = await loadSite(origin);
  return typeof rec?.scanEnabled === 'boolean' ? rec.scanEnabled : settings.scanDefault;
}

/**
 * Suggestions waiting on this page: count, Cover all, Review, and the per-site switch.
 * On a canvas-drawn page the count is replaced by an explanation and the switch is disabled.
 */
function suggestionsSection(tabId: number, origin: string, enabled: boolean, canvas: boolean, res: GetSuggestionsResponse | null): HTMLElement {
  const box = h('section', { class: 'suggest' });
  const n = res?.suggestions.length ?? 0;
  if (canvas && n === 0) {
    box.append(notice('info', CANVAS_NOTE, { class: 'canvas-note', id: 'canvas-note' }));
  } else if (enabled && res) {
    const more = res.total > n ? '+' : '';
    const text = n ? `${n}${more} suggestion${n === 1 && !more ? '' : 's'} on this page` : res.scanning ? 'Scanning…' : 'No suggestions on this page.';
    const row = h('div', { class: `suggest-row ${n ? '' : 'empty'}` }, h('span', { class: 'suggest-count' }, icon('sparkle'), text));
    if (n) {
      row.append(
        h(
          'button',
          {
            class: 'primary small',
            onclick: async () => {
              await chrome.tabs.sendMessage(tabId, { type: 'COVER_SUGGESTIONS' }, { frameId: 0 });
              render();
            },
          },
          'Cover all',
        ),
      );
    }
    box.append(row);
  }
  box.append(
    toggle(
      h('input', {
        id: 'suggest-site',
        checked: enabled,
        disabled: canvas,
        onchange: async (e: Event) => {
          const cur = (await loadSite(origin)) ?? { v: 1 as const, origin, enabled: true, stickers: [], updatedAt: 0 };
          await saveSite({ ...cur, scanEnabled: (e.target as HTMLInputElement).checked, updatedAt: Date.now() });
          setTimeout(render, 150);
        },
      }),
      'Suggest stickers on this site',
      { title: canvas ? 'This page is drawn on a canvas: there is no text to scan' : '' },
    ),
  );
  return box;
}

function tile(id: string, ic: IconName, label: string, opts: { disabled?: boolean; tip?: string; primary?: boolean; count?: string; onclick: () => void }): HTMLButtonElement {
  const b = h(
    'button',
    { id, class: `tile ${opts.primary ? 'primary' : ''}`.trim(), disabled: !!opts.disabled, tip: opts.tip || undefined, onclick: opts.onclick },
    icon(ic, 18),
    h('span', {}, label, opts.count ? h('span', { class: 'count' }, opts.count) : null),
  );
  return b;
}

async function render() {
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  const session = await getSession();
  const audit = await auditSection();
  const settings = await loadSettings();
  const head = header(origin);
  const view = document.createDocumentFragment();
  view.append(head.el, pdfOpenSection(tab));
  let tabLocked = false;
  let autoCount = 0;
  const finish = () => {
    view.append(sessionSection(session, autoCount), settingsSection(settings, tabLocked || session?.active === true), audit);
    app.replaceChildren(view);
  };

  if (!tab?.id || !origin) {
    head.setStatus('off', 'Not available');
    view.append(notice('info', 'Stickers work on http(s) pages only.'));
    finish();
    return;
  }
  const tabId = tab.id;
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  const content = granted ? await queryContent(tabId) : null;

  if (content?.state.saveError) {
    view.append(notice('error', 'Could not save stickers on this site. They protect this page now but may not return after a reload.'));
  }

  if (!granted || !content) {
    head.setStatus('off', 'Not enabled');
    const card = h(
      'section',
      { class: 'card enable' },
      h(
        'button',
        {
          class: 'primary large block',
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
              app.append(notice('error', `Could not enable this site: ${res?.error ?? 'no response'}`));
              return;
            }
            setTimeout(render, 300);
          },
        },
        icon('shield'),
        'Enable on this site',
      ),
      h('p', { class: 'hint' }, 'Not enabled on this site yet. Enabling lets stickers apply before the page paints.'),
    );
    view.append(card);
    finish();
    return;
  }

  const state: TabState = content.state;
  const locked = state.locked === true;
  tabLocked = locked;
  autoCount = state.autoCount ?? 0;
  const lockTitle = locked ? lockMessage(state.lockReason) : '';
  const canvas = state.rendering === 'canvas';
  if (locked) head.setStatus('locked', session?.active ? 'Locked (AI session)' : 'Locked', lockTitle);
  else if (state.paused) head.setStatus('paused', 'Paused');
  else if (canvas) head.setStatus('canvas', 'Canvas page', 'Text on this page is drawn as pixels');
  else head.setStatus('protected', 'Protected');

  if (locked) view.append(notice('locked', `Locked: ${lockTitle}. Stickers stay on.`));
  if (autoCount > 0) {
    view.append(
      notice(
        'info',
        `${autoCount} sensitive number${autoCount === 1 ? ' was' : 's were'} covered automatically on this page${locked ? ' during the lock' : ''}. They are kept only if you choose to when the session ends.`,
      ),
    );
  }
  const strictCount = state.strictInputs ?? 0;
  if (strictCount > 0) {
    view.append(
      notice(
        'warn',
        `Strict input masking is on for ${strictCount} field${strictCount === 1 ? '' : 's'}: page scripts read bullets, forms submit the real value. A site that re-reads its own fields may misbehave.`,
      ),
    );
  }

  const scanOn = await scanEnabledFor(origin, settings);
  const sugg = locked ? null : await fetchSuggestions(tabId);
  const n = sugg?.suggestions.length ?? 0;
  const more = (sugg?.total ?? 0) > n ? '+' : '';

  const run = (msg: Record<string, unknown>) => async () => {
    const res = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    if (showRefusal(res)) window.close();
  };
  const canvasTip = "This page is drawn on a canvas: there are no elements to cover. Use Draw rectangle.";
  const suggestTip = locked
    ? lockTitle
    : canvas
      ? 'This page is drawn on a canvas: there is no text to scan.'
      : !scanOn
        ? 'Suggestions are off for this site.'
        : n === 0
          ? 'Nothing to review on this page.'
          : 'Step through the suggestions on the page.';
  view.append(
    h(
      'div',
      { class: 'tiles' },
      tile('cover-element', 'sticker', 'Cover element', {
        disabled: locked || canvas,
        tip: locked ? lockTitle : canvas ? canvasTip : '',
        onclick: run({ type: 'START_PICK' }),
      }),
      tile('draw-rect', 'rect', 'Draw rectangle', {
        primary: canvas,
        disabled: locked,
        tip: lockTitle,
        onclick: run({ type: 'START_RECT' }),
      }),
      tile('cover-selection', 'textSelect', 'Cover selection', {
        disabled: locked || canvas,
        tip: locked ? lockTitle : canvas ? 'This page is drawn on a canvas: there is no text to select. Use Draw rectangle.' : 'Select text on the page first. Shortcut: Alt+Shift+C.',
        onclick: run({ type: 'COMMAND', name: 'cover-selection' }),
      }),
      tile('review-suggestions', 'sparkle', 'Suggestions', {
        disabled: locked || canvas || !scanOn || n === 0,
        tip: suggestTip,
        count: n ? `${n}${more}` : '',
        onclick: run({ type: 'REVIEW_SUGGESTIONS' }),
      }),
    ),
  );

  const editBtn = h(
    'button',
    {
      id: 'edit-mode',
      class: `ghost small ${state.editMode ? 'active' : ''}`.trim(),
      disabled: locked,
      tip: locked ? lockTitle : 'Shortcut: Alt+Shift+S',
      onclick: run({ type: 'SET_EDIT_MODE', enabled: !state.editMode }),
    },
    icon('pencil'),
    state.editMode ? 'Exit edit mode' : 'Edit stickers',
  );
  editBtn.classList.add('tip-left');

  if (!locked) view.append(suggestionsSection(tabId, origin, scanOn, canvas, sugg));
  else if (canvas) view.append(notice('info', CANVAS_NOTE, { class: 'canvas-note', id: 'canvas-note' }));
  if (state.rendering === 'mixed') view.append(notice('info', MIXED_NOTE, { id: 'mixed-note' }));

  view.append(
    h('div', { class: 'section-head' }, 'Stickers on this page', h('span', { class: 'n' }, String(content.stickers.length)), h('span', { class: 'spacer' }), editBtn),
  );
  const list = h('ul', { class: 'list' });
  if (content.stickers.length === 0) {
    list.append(
      h(
        'li',
        { class: 'empty muted' },
        icon('sticker', 20),
        h('strong', {}, 'No stickers on this page.'),
        h('span', { class: 'hint' }, canvas ? 'Draw a rectangle over anything you want hidden.' : 'Cover an element or draw a rectangle over anything you want hidden.'),
      ),
    );
  }
  for (const s of content.stickers) list.append(stickerRow(tabId, s, locked, lockTitle));
  view.append(list);
  // Stickers placed inside an in-page viewer (a Drive file preview) for a
  // document that is not open: not counted above, one collapsed line here.
  const other = state.otherViews ?? 0;
  if (other > 0) {
    view.append(
      h(
        'details',
        { class: 'muted other', id: 'other-views' },
        h('summary', {}, `${other} sticker${other === 1 ? '' : 's'} for other views`),
        h('p', { class: 'hint' }, 'Placed inside a document preview on this page. They come back when that document is open again.'),
      ),
    );
  }

  view.append(
    h(
      'div',
      { class: 'pause-row' },
      toggle(
        h('input', {
          checked: state.paused,
          disabled: locked,
          onchange: async (e: Event) => {
            const paused = (e.target as HTMLInputElement).checked;
            const res = await chrome.tabs.sendMessage(tabId, { type: 'SET_PAUSED', paused });
            showRefusal(res);
            render();
          },
        }),
        'Pause protection on this tab (reveals everything)',
        { class: 'pause warn', title: lockTitle },
      ),
      h('p', { class: 'hint' }, 'Peek: hover a sticker and hold ', ...kbd('Ctrl', 'Shift'), '. Edit mode: ', ...kbd('Alt', 'Shift', 'S'), '.'),
    ),
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
  sel.setAttribute('aria-label', 'Where this sticker applies');
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
  const statusText = s.status === 'lost' ? 'Lost: open edit mode and click it to re-attach' : s.status === 'resolving' ? 'Looking for its content' : 'Attached';
  const dot = h('span', { class: `dot ${s.status}`, title: statusText });
  const kindName = s.kind === 'rect' ? 'Rectangle' : s.source === 'session-auto' ? 'Auto-covered' : s.source === 'suggest' ? 'Suggested' : 'Element';
  const name = h('span', { class: 'name', title: s.label || kindName }, s.label || kindName);
  const scope = scopeSelect(tabId, s, locked, lockTitle);
  const locate = h(
    'button',
    { class: 'icon-btn tip-left', tip: 'Show on page', onclick: () => chrome.tabs.sendMessage(tabId, { type: 'LOCATE_STICKER', id: s.id }) },
    icon('locate'),
  );
  locate.setAttribute('aria-label', 'Show');
  const del = h(
    'button',
    {
      class: 'icon-btn danger tip-left',
      disabled: locked,
      tip: locked ? lockTitle : 'Delete sticker',
      onclick: async () => {
        await chrome.tabs.sendMessage(tabId, { type: 'DELETE_STICKER', id: s.id });
        render();
      },
    },
    icon('trash'),
  );
  del.setAttribute('aria-label', 'Delete');
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
      h(
        'div',
        { class: 'pdf-card' },
        icon('file', 18),
        h(
          'div',
          { class: 'body' },
          h('p', { class: 'hint' }, "Chrome's PDF viewer can't take stickers. The sticker viewer can, and downloads a redacted copy."),
          h(
            'button',
            {
              id: 'open-pdf-viewer',
              class: 'primary block',
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
            },
            'Open in sticker PDF viewer',
            icon('arrowRight'),
          ),
        ),
      ),
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
    h('legend', {}, 'PDFs'),
    toggle(check, 'Always open PDFs in the sticker viewer'),
    h(
      'span',
      { class: 'explain' },
      'Links ending in .pdf open in the extension\'s viewer instead of Chrome\'s. Needs access to all sites. Local files also need "Allow access to file URLs" in chrome://extensions.',
    ),
  );
  return box;
}
// ==== PDF viewer (end) ====

// Development builds only: `popup.html?demo=1` (or `=off`, `=locked`, `=canvas`)
// renders with mock data, for screenshots. Stripped from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
  void import('./demo').then((m) => {
    m.installDemo(new URLSearchParams(location.search).get('demo') ?? '1');
    render();
  });
} else {
  render();
}
