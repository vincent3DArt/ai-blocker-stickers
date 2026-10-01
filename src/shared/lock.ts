/**
 * AI-session lock: pure state machine shared by the background, the content
 * script and the unit tests.
 *
 * Browser agents that drive the page through CDP (Claude in Chrome,
 * Playwright, Puppeteer) produce TRUSTED input events, so `isTrusted` cannot
 * tell them from the user. While any lock signal is up, nothing that would
 * reveal covered content (peek, pause, delete, edit tools) is allowed.
 */

export type LockReason = 'debugger' | 'webdriver' | 'manual';

export interface LockInputs {
  /** `chrome.debugger.getTargets()` reports a client attached to this tab. */
  debuggerAttached: boolean;
  /** `navigator.webdriver === true` in the page. */
  webdriver: boolean;
  /** The user started an AI session in the popup. */
  manualSession: boolean;
}

export interface LockState {
  locked: boolean;
  reason?: LockReason;
}

/**
 * Locked when any signal is up. The reason shown is the strongest one: an
 * automation signal outranks the manual session, because ending the session
 * does not unlock while a debugger is still attached or webdriver is set.
 */
export function computeLock(i: Partial<LockInputs>): LockState {
  if (i.debuggerAttached) return { locked: true, reason: 'debugger' };
  if (i.webdriver) return { locked: true, reason: 'webdriver' };
  if (i.manualSession) return { locked: true, reason: 'manual' };
  return { locked: false };
}

/** Human-readable refusal reason for the popup and the in-page toast. */
export function lockMessage(reason: LockReason | undefined): string {
  return reason === 'manual' ? 'AI session active' : 'Automation detected';
}

/** `canvas-page`: locked on a page drawn on a canvas, so the auto-cover could find nothing. */
export type AuditAction = 'session-start' | 'session-end' | 'auto-lock' | 'auto-unlock' | 'unlock-refused' | 'canvas-page';

/** One audit record. Never holds covered text: an origin and a short reason at most. */
export interface AuditEntry {
  ts: number;
  action: AuditAction;
  origin?: string;
  reason?: string;
}

export const AUDIT_KEY = 'audit';
export const AUDIT_CAP = 200;
/** Local-storage mirror of the manual session, so it survives a browser restart. */
export const SESSION_ACTIVE_KEY = 'sessionActive';

const AUDIT_ACTIONS = new Set<AuditAction>(['session-start', 'session-end', 'auto-lock', 'auto-unlock', 'unlock-refused', 'canvas-page']);

/** Append, dropping the oldest entries beyond `cap`. Inputs are validated: storage is writable by content scripts. */
export function appendAudit(list: unknown, entry: AuditEntry, cap = AUDIT_CAP): AuditEntry[] {
  const prev = Array.isArray(list) ? list.filter(isAuditEntry) : [];
  const clean: AuditEntry = { ts: entry.ts, action: entry.action };
  if (entry.origin) clean.origin = String(entry.origin).slice(0, 200);
  if (entry.reason) clean.reason = String(entry.reason).slice(0, 60);
  const out = [...prev, clean];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function isAuditEntry(e: unknown): e is AuditEntry {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as AuditEntry).ts === 'number' &&
    AUDIT_ACTIONS.has((e as AuditEntry).action)
  );
}
