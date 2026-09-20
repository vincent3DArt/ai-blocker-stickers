import type { KeyCombo } from '@/shared/types';

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export function comboMatches(combo: KeyCombo, e: KeyboardEvent): boolean {
  if (!!combo.ctrl !== e.ctrlKey) return false;
  if (!!combo.shift !== e.shiftKey) return false;
  if (!!combo.alt !== e.altKey) return false;
  if (!!combo.meta !== e.metaKey) return false;
  if (combo.code) return e.code === combo.code;
  // Modifier-only combo: the last key pressed must be a modifier.
  return MODIFIER_CODES.has(e.code);
}

export function comboLabel(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  if (combo.meta) parts.push('Meta');
  if (combo.code) parts.push(combo.code.replace(/^Key|^Digit/, ''));
  return parts.join('+');
}

/** True while every modifier in the combo is still held. */
export function comboStillHeld(combo: KeyCombo, e: KeyboardEvent): boolean {
  if (combo.ctrl && !e.ctrlKey) return false;
  if (combo.shift && !e.shiftKey) return false;
  if (combo.alt && !e.altKey) return false;
  if (combo.meta && !e.metaKey) return false;
  if (combo.code && e.type === 'keyup' && e.code === combo.code) return false;
  return true;
}
