import type { LockReason } from './lock';
import type { ScopeKind, Sticker, TabState } from './types';

/** Content script -> background. */
export type ContentToBackground =
  | { type: 'TAB_STATUS'; state: Partial<TabState> }
  | { type: 'ENSURE_ORIGIN'; origin: string }
  /** Ask for this tab's lock; also the keep-alive ping while stickers or a lock are present. */
  | { type: 'LOCK_SYNC' }
  /** A lifting action was refused while locked; the background appends an audit entry. */
  | { type: 'LOCK_REFUSED'; what: string }
  /** Locked on a canvas-drawn page: the auto-cover has nothing to find. Audited with the origin only. */
  | { type: 'CANVAS_PAGE' };

/** Popup -> background. */
export type PopupToBackground =
  | { type: 'START_SESSION'; allSites: boolean }
  /** `keepAuto`: keep the stickers auto-covered during the session (default true). */
  | { type: 'END_SESSION'; keepAllSites: boolean; keepAuto?: boolean }
  | { type: 'GET_SESSION' }
  // Development builds only: start or end the manual session without the popup's prompts.
  | { type: 'TEST_SESSION'; active: boolean; keepAuto?: boolean };

/** Background's view of one tab's lock, sent as SET_LOCK and as the LOCK_SYNC reply. */
export interface LockUpdate {
  locked: boolean;
  reason?: LockReason;
  /** The raw signals, so the content script can combine them with its own `navigator.webdriver`. */
  debugger: boolean;
  manual: boolean;
}

export interface SessionInfo {
  active: boolean;
  startedAt?: number;
  keepAllSites: boolean;
  allSitesGranted: boolean;
  debuggerGranted: boolean;
}

/** Background/popup -> content script (delivered to every frame in the tab). */
export type ToContent =
  | { type: 'COMMAND'; name: 'toggle-edit-mode' | 'cover-selection' }
  | { type: 'SET_EDIT_MODE'; enabled: boolean }
  | { type: 'SET_PAUSED'; paused: boolean }
  | ({ type: 'SET_LOCK' } & LockUpdate)
  | { type: 'GET_STICKERS' }
  | { type: 'LOCATE_STICKER'; id: string }
  | { type: 'DELETE_STICKER'; id: string }
  /** `exact`: this page only (the content script computes the path HMAC). `pattern` (default): `pathPattern`, sanitised. */
  | { type: 'SET_SCOPE'; id: string; kind?: ScopeKind; pathPattern?: string }
  | { type: 'COVER_CONTEXT_TARGET' }
  | { type: 'START_RECT' }
  | { type: 'START_PICK' }
  /** The manual AI session ended: keep (store) or drop the auto-covered stickers. */
  | { type: 'SESSION_ENDED'; keepAuto: boolean }
  // Auto-suggest.
  | { type: 'GET_SUGGESTIONS' }
  | { type: 'COVER_SUGGESTIONS' }
  | { type: 'REVIEW_SUGGESTIONS' }
  | { type: 'DISMISS_SUGGESTION'; id: string }
  // Development builds only: drive placement from tests.
  | { type: 'TEST_COVER'; selector: string; shadowHost?: string; shadowPath?: string[] }
  | { type: 'TEST_RECT'; rect: { x: number; y: number; w: number; h: number } }
  | { type: 'TEST_STATE' }
  | { type: 'TEST_COVER_SUGGESTIONS' }
  | { type: 'TEST_RESCAN' };

export interface SuggestionSummary {
  /** HMAC identity; what DISMISS_SUGGESTION takes. */
  id: string;
  /** Chip name, e.g. "SSN". Never the matched text. */
  name: string;
  pattern: string;
  score: number;
}

export interface GetSuggestionsResponse {
  suggestions: SuggestionSummary[];
  /** Detections on the page, including those beyond the display cap. */
  total: number;
  scanEnabled: boolean;
  scanning: boolean;
}

/** Reply to a command the content script refused because the tab is locked. */
export interface LockedReply {
  ok: false;
  locked: true;
  error: string;
}

export interface StickerSummary {
  id: string;
  kind: Sticker['kind'];
  label?: string;
  source?: Sticker['source'];
  status: 'resolving' | 'resolved' | 'lost';
  /** Sanitised pattern; for `exact` scopes only the display form. */
  pathPattern: string;
  scopeKind: ScopeKind;
  /** `location.pathname` of the page the sticker lives on. */
  currentPath: string;
}

export type GetStickersResponse = { stickers: StickerSummary[]; state: TabState };

export function isToContent(msg: unknown): msg is ToContent {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
