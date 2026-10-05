/*
 * Development builds only (imported behind `import.meta.env.DEV` in main.ts):
 * `popup.html?demo=<variant>` swaps the chrome.* calls the popup makes for
 * mock data, so the popup can be opened in a tab and screenshotted without an
 * active page. Variants: 1 (default, protected with stickers), off, locked,
 * canvas, pdf.
 */
import type { GetStickersResponse, GetSuggestionsResponse, SessionInfo } from '@/shared/messages';
import { DEFAULT_TAB_STATE } from '@/shared/types';

export function installDemo(variant: string) {
  const c = chrome as unknown as Record<string, Record<string, unknown>>;
  const url = variant === 'pdf' ? 'https://files.example.com/statements/2026-09.pdf' : 'https://mail.example.com/inbox/42';
  const tab = { id: 4242, index: 0, url, active: true } as chrome.tabs.Tab;
  const locked = variant === 'locked';
  const canvas = variant === 'canvas';
  const now = Date.now();

  const stickers: GetStickersResponse = {
    stickers: canvas
      ? []
      : [
          { id: 'a', kind: 'element', label: 'Account number', source: 'manual', status: 'resolved', pathPattern: '/inbox/*', scopeKind: 'pattern', currentPath: '/inbox/42' },
          { id: 'b', kind: 'element', source: 'suggest', status: 'resolved', pathPattern: '/**', scopeKind: 'pattern', currentPath: '/inbox/42' },
          { id: 'c', kind: 'rect', status: 'lost', pathPattern: '/inbox/42', scopeKind: 'exact', currentPath: '/inbox/42' },
        ],
    state: {
      ...DEFAULT_TAB_STATE,
      stickerCount: canvas ? 0 : 3,
      lostCount: canvas ? 0 : 1,
      locked,
      lockReason: locked ? 'manual' : undefined,
      rendering: canvas ? 'canvas' : 'dom',
      autoCount: locked ? 2 : 0,
    },
  };
  const suggestions: GetSuggestionsResponse = {
    suggestions:
      locked || canvas
        ? []
        : [
            { id: 's1', name: 'SSN', pattern: 'ssn', score: 3 },
            { id: 's2', name: 'Card', pattern: 'card', score: 3 },
          ],
    total: locked || canvas ? 0 : 2,
    scanEnabled: true,
    scanning: false,
  };
  const session: SessionInfo = {
    active: locked,
    startedAt: locked ? now - 25 * 60_000 : undefined,
    keepAllSites: false,
    allSitesGranted: true,
    debuggerGranted: false,
  };

  c.tabs.query = async () => [tab];
  c.tabs.sendMessage = async (_id: number, msg: { type: string }) => {
    if (msg.type === 'GET_STICKERS') return variant === 'off' ? undefined : stickers;
    if (msg.type === 'GET_SUGGESTIONS') return suggestions;
    return { ok: true };
  };
  c.tabs.create = async () => ({});
  c.runtime.sendMessage = async (msg: { type: string }) => {
    if (msg.type === 'GET_SESSION') return { ok: true, session };
    if (msg.type === 'GET_PDF_REDIRECT') return { on: false, active: false };
    return { ok: true };
  };
  c.permissions.contains = async () => variant !== 'off';
  c.permissions.request = async () => false;
  c.scripting.executeScript = async () => [{ result: variant === 'pdf' ? 'application/pdf' : 'text/html' }];
  const audit = [
    { ts: now - 3_600_000, action: 'session-start' },
    { ts: now - 3_000_000, action: 'unlock-refused', reason: 'peek', origin: 'https://mail.example.com' },
    { ts: now - 2_400_000, action: 'session-end' },
  ];
  const realGet = chrome.storage.local.get.bind(chrome.storage.local);
  (chrome.storage.local as unknown as Record<string, unknown>).get = async (key: unknown) =>
    key === 'audit' ? { audit } : realGet(key as string);
  window.close = () => undefined;
}
