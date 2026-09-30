import { describe, expect, it } from 'vitest';
import { AUDIT_CAP, appendAudit, computeLock, lockMessage } from '@/shared/lock';

describe('computeLock', () => {
  it('is unlocked with no signal', () => {
    expect(computeLock({ debuggerAttached: false, webdriver: false, manualSession: false })).toEqual({ locked: false });
    expect(computeLock({})).toEqual({ locked: false });
  });

  it('locks on each signal alone', () => {
    expect(computeLock({ debuggerAttached: true })).toEqual({ locked: true, reason: 'debugger' });
    expect(computeLock({ webdriver: true })).toEqual({ locked: true, reason: 'webdriver' });
    expect(computeLock({ manualSession: true })).toEqual({ locked: true, reason: 'manual' });
  });

  it('auto-lock takes precedence over the manual session', () => {
    expect(computeLock({ debuggerAttached: true, manualSession: true }).reason).toBe('debugger');
    expect(computeLock({ webdriver: true, manualSession: true }).reason).toBe('webdriver');
    expect(computeLock({ debuggerAttached: true, webdriver: true, manualSession: true }).reason).toBe('debugger');
  });

  it('ending the session does not unlock while a debugger is attached', () => {
    expect(computeLock({ debuggerAttached: true, manualSession: false }).locked).toBe(true);
  });

  it('names the refusal', () => {
    expect(lockMessage('manual')).toBe('AI session active');
    expect(lockMessage('debugger')).toBe('Automation detected');
    expect(lockMessage('webdriver')).toBe('Automation detected');
  });
});

describe('appendAudit', () => {
  it('caps the log, dropping the oldest entries', () => {
    let log: unknown = undefined;
    for (let i = 0; i < AUDIT_CAP + 25; i++) log = appendAudit(log, { ts: i, action: 'auto-lock' });
    const arr = log as { ts: number }[];
    expect(arr).toHaveLength(AUDIT_CAP);
    expect(arr[0].ts).toBe(25);
    expect(arr[arr.length - 1].ts).toBe(AUDIT_CAP + 24);
  });

  it('drops malformed entries and unknown fields', () => {
    const out = appendAudit([{ ts: 1, action: 'bogus' }, 'x', { ts: 2, action: 'session-end' }], {
      ts: 3,
      action: 'unlock-refused',
      origin: 'https://example.test',
      reason: 'SET_PAUSED/manual',
      text: '123-45-6789',
    } as never);
    expect(out).toEqual([
      { ts: 2, action: 'session-end' },
      { ts: 3, action: 'unlock-refused', origin: 'https://example.test', reason: 'SET_PAUSED/manual' },
    ]);
  });
});
