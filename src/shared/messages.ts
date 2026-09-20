import type { Sticker, TabState } from './types';

/** Content script -> background. */
export type ContentToBackground =
  | { type: 'TAB_STATUS'; state: Partial<TabState> }
  | { type: 'ENSURE_ORIGIN'; origin: string };

/** Background/popup -> content script (delivered to every frame in the tab). */
export type ToContent =
  | { type: 'COMMAND'; name: 'toggle-edit-mode' | 'cover-selection' }
  | { type: 'SET_EDIT_MODE'; enabled: boolean }
  | { type: 'SET_PAUSED'; paused: boolean }
  | { type: 'GET_STICKERS' }
  | { type: 'LOCATE_STICKER'; id: string }
  | { type: 'DELETE_STICKER'; id: string }
  | { type: 'SET_SCOPE'; id: string; pathPattern: string }
  | { type: 'COVER_CONTEXT_TARGET' }
  | { type: 'START_RECT' }
  | { type: 'START_PICK' }
  // Development builds only: drive placement from tests.
  | { type: 'TEST_COVER'; selector: string }
  | { type: 'TEST_RECT'; rect: { x: number; y: number; w: number; h: number } }
  | { type: 'TEST_STATE' };

export interface StickerSummary {
  id: string;
  kind: Sticker['kind'];
  label?: string;
  status: 'resolving' | 'resolved' | 'lost';
  pathPattern: string;
  /** `location.pathname` of the page the sticker lives on. */
  currentPath: string;
}

export type GetStickersResponse = { stickers: StickerSummary[]; state: TabState };

export function isToContent(msg: unknown): msg is ToContent {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
