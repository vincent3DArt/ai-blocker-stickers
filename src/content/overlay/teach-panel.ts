import type { OverlayHost } from './host';
import { icon } from '@/shared/icons';
import { DETECTOR_NAME_MAX, type DetectorStrength } from '@/shared/types';

export interface TeachInfo {
  description: string;
  /** The label found next to the example (normalised words), if any. */
  label?: string;
  count: number;
  strength: DetectorStrength;
  name: string;
}

export interface TeachPanelCallbacks {
  onSave(opts: { scope: 'site' | 'global'; name: string }): void;
  onCancel(): void;
}

const STRENGTH_NOTE: Record<DetectorStrength, string> = {
  high: 'Suggested wherever it appears.',
  medium: 'Suggested when a label is nearby.',
  low: 'Suggested only right next to its label.',
};

/**
 * "Cover things like this": the small panel in the overlay's closed shadow
 * root. It shows the derived shape (never the example), the label found, how
 * many elements on this page match, and lets the user pick a scope and a
 * name. Clicks count only when trusted; keys typed in the name field never
 * reach the page.
 */
export class TeachPanel {
  private el: HTMLDivElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private scope: 'site' | 'global' = 'site';
  info: TeachInfo | null = null;

  constructor(
    private host: OverlayHost,
    private cb: TeachPanelCallbacks,
  ) {}

  get open(): boolean {
    return !!this.el;
  }

  show(info: TeachInfo, anchor?: { x: number; y: number }) {
    this.close();
    this.info = info;
    this.scope = 'site';
    const el = document.createElement('div');
    el.className = 'teach';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cover things like this');
    const stop = (e: Event) => e.stopPropagation();
    for (const t of ['keydown', 'keyup', 'keypress', 'input', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) el.addEventListener(t, stop);

    const head = document.createElement('div');
    head.className = 'teach-head';
    const title = document.createElement('strong');
    title.textContent = 'Cover things like this';
    head.append(icon('sparkle', 14), title);

    const row = (label: string, value: string, cls = '') => {
      const r = document.createElement('div');
      r.className = `teach-row ${cls}`.trim();
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = value;
      r.append(k, v);
      return r;
    };
    const shape = row('Shape', info.description, 'teach-shape');
    const label = row('Label', info.label ? info.label : 'none found', 'teach-label');
    const count = row('On this page', `${info.count} match${info.count === 1 ? '' : 'es'}`, 'teach-count');
    const note = document.createElement('p');
    note.className = 'teach-note';
    note.textContent =
      info.strength !== 'high' && !info.label
        ? 'No label nearby: this shape is only suggested with the Aggressive setting.'
        : STRENGTH_NOTE[info.strength];

    const scopeBox = document.createElement('div');
    scopeBox.className = 'teach-scope';
    scopeBox.setAttribute('role', 'radiogroup');
    const mk = (value: 'site' | 'global', text: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.scope = value;
      b.className = value === this.scope ? 'on' : '';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === this.scope));
      b.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        this.setScope(value);
      });
      return b;
    };
    scopeBox.append(mk('site', 'This site'), mk('global', 'All sites'));

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'teach-name';
    name.maxLength = DETECTOR_NAME_MAX;
    name.value = info.name;
    name.setAttribute('aria-label', 'Name');
    name.placeholder = 'Name, e.g. Policy number';
    name.autocomplete = 'off';
    name.spellcheck = false;
    this.nameInput = name;

    const actions = document.createElement('div');
    actions.className = 'teach-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', (e) => e.isTrusted && this.cb.onCancel());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = 'Save';
    save.addEventListener('click', (e) => e.isTrusted && this.save());
    actions.append(cancel, save);
    name.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Enter') this.save();
      else if (e.key === 'Escape') this.cb.onCancel();
    });

    el.append(head, shape, label, count, note, scopeBox, name, actions);
    if (anchor) {
      el.style.left = `${Math.round(Math.max(8, Math.min(anchor.x, window.innerWidth - 300)))}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(anchor.y, window.innerHeight - 280)))}px`;
    }
    this.host.ui.appendChild(el);
    this.el = el;
    name.focus({ preventScroll: true });
  }

  setScope(value: 'site' | 'global') {
    this.scope = value;
    this.el?.querySelectorAll<HTMLButtonElement>('.teach-scope button').forEach((b) => {
      const on = b.dataset.scope === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  /** Save with the panel's current choices (also the dev test hook's way in). */
  save(override?: { scope?: 'site' | 'global'; name?: string }) {
    if (!this.el) return;
    const scope = override?.scope ?? this.scope;
    const name = (override?.name ?? this.nameInput?.value ?? '').replace(/\s+/g, ' ').trim() || this.info?.name || 'Custom pattern';
    this.cb.onSave({ scope, name });
  }

  close() {
    this.el?.remove();
    this.el = null;
    this.nameInput = null;
    this.info = null;
  }
}
