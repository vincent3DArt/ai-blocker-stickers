/**
 * Strict input masking.
 *
 * Plain input mode hides a covered field's pixels, its accessibility node, its
 * clipboard and its default (`value` attribute), but the live `.value` still
 * reads back the real text, for any script and for CDP. Strict mode closes
 * that: the live value is swapped for bullets of the same length, the real
 * value is kept here, in content-script memory only, and handed back exactly
 * where the page legitimately needs it:
 *
 * - `formdata` (fires for `new FormData(form)` and every native submission):
 *   the real value goes into that FormData object; the DOM stays masked.
 * - `submit` (trusted only): the real value sits in the element for the
 *   duration of the submit event, so submit handlers that read `.value` work,
 *   and is masked again when the event has finished propagating.
 * - peek: while the user holds the peek combo the field shows and holds the
 *   real value so it can be read and edited; whatever it holds when the peek
 *   ends becomes the new real value.
 *
 * A value the page writes itself (a framework re-rendering a controlled input)
 * is adopted as the new real value and masked again (`sync`), so a controlled
 * input does not end up holding stale bullets. What cannot be told apart is a
 * page that reads `.value` (bullets) and writes it back into its own state;
 * see docs/LIMITATIONS.md.
 *
 * Writes go through the native setters from our (isolated) world, so setter
 * hooks a page or framework installed on the element never run, and no
 * `input`/`change` event is dispatched.
 */

/** Marks a field whose live value currently holds bullets. */
export const STRICT_ATTR = 'data-aibs-strict';

/** Input types whose value accepts arbitrary text, so bullets survive value sanitisation. */
const STRICT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);

export type StrictField = HTMLInputElement | HTMLTextAreaElement;

type LiftReason = 'peek' | 'submit';

interface Entry {
  real: string;
  mask: string;
  lifts: Set<LiftReason>;
}

const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
const areaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;

export function readValue(el: StrictField): string {
  return (el instanceof HTMLTextAreaElement ? areaValue : inputValue).get!.call(el) as string;
}

/** Native setter: bypasses page-installed setters and dispatches no events. */
export function writeValue(el: StrictField, v: string) {
  (el instanceof HTMLTextAreaElement ? areaValue : inputValue).set!.call(el, v);
}

/** Bullets of the same length (in code points) as `v`. */
export function maskValue(v: string): string {
  return '•'.repeat(Array.from(v).length);
}

export function strictEligible(el: Element): el is StrictField {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && STRICT_TYPES.has(el.type);
}

/** Constraint failures that bullets can introduce on their own. */
function mismatch(el: StrictField): boolean {
  const v = el.validity;
  return !!v && (v.patternMismatch || v.typeMismatch);
}

export interface StrictOptions {
  /** Which submit / formdata events are the browser's own. Injected by unit tests (jsdom cannot fire a trusted formdata). */
  trusted?: (e: Event) => boolean;
}

export class StrictInputs {
  private fields = new Map<StrictField, Entry>();
  private submitting = new Set<StrictField>();
  private submitTimer = 0;
  private disposers: Array<() => void> = [];
  private trusted: (e: Event) => boolean;

  constructor(
    private writeAttr: (el: Element, attr: string, value: string | null) => void,
    opts: StrictOptions = {},
  ) {
    this.trusted = opts.trusted ?? ((e) => e.isTrusted);
  }

  get count(): number {
    return this.fields.size;
  }

  has(el: Element): boolean {
    return this.fields.has(el as StrictField);
  }

  /** The real value of a strict field (what the user typed), or undefined when `el` is not strict. */
  real(el: Element): string | undefined {
    const e = this.fields.get(el as StrictField);
    if (!e) return undefined;
    return e.lifts.size ? readValue(el as StrictField) : e.real;
  }

  /**
   * Swap the live value for bullets. Returns false (and leaves the field
   * alone) when the field cannot hold bullets: a non-text type, or a
   * `pattern` / `type=email|url` constraint the bullets would fail, which
   * would block the form's own submission.
   */
  engage(el: Element): boolean {
    if (!strictEligible(el)) return false;
    if (this.fields.has(el)) {
      this.sync(el);
      return true;
    }
    const real = readValue(el);
    const mask = maskValue(real);
    if (mask !== real) {
      const before = mismatch(el);
      writeValue(el, mask);
      if (!before && mismatch(el)) {
        writeValue(el, real);
        return false;
      }
    }
    this.fields.set(el, { real, mask, lifts: new Set() });
    this.writeAttr(el, STRICT_ATTR, '1');
    return true;
  }

  /** Put the real value back and stop tracking the field. */
  release(el: Element) {
    const f = el as StrictField;
    const e = this.fields.get(f);
    if (!e) return;
    if (!e.lifts.size) {
      this.sync(f);
      const cur = this.fields.get(f);
      if (cur && readValue(f) === cur.mask) writeValue(f, cur.real);
    }
    this.fields.delete(f);
    this.submitting.delete(f);
    this.writeAttr(f, STRICT_ATTR, null);
  }

  releaseAll() {
    for (const el of Array.from(this.fields.keys())) this.release(el);
  }

  /**
   * The page wrote a value of its own (anything but our bullets): adopt it as
   * the real value and mask again. Returns true when it adopted something.
   */
  sync(el: Element): boolean {
    const f = el as StrictField;
    const e = this.fields.get(f);
    if (!e || e.lifts.size) return false;
    const cur = readValue(f);
    if (cur === e.mask) return false;
    e.real = cur;
    e.mask = maskValue(cur);
    if (e.mask !== cur) {
      writeValue(f, e.mask);
      if (mismatch(f)) {
        // The new value fits a constraint the bullets fail: stop being strict
        // for this field rather than block the form's submission.
        writeValue(f, cur);
        this.fields.delete(f);
        this.writeAttr(f, STRICT_ATTR, null);
      }
    }
    return true;
  }

  syncAll() {
    for (const el of Array.from(this.fields.keys())) this.sync(el);
  }

  /** Put the real value into the element until `settle(el, reason)`. */
  lift(el: Element, reason: LiftReason) {
    const f = el as StrictField;
    const e = this.fields.get(f);
    if (!e || e.lifts.has(reason)) return;
    if (!e.lifts.size) {
      this.sync(f);
      const cur = this.fields.get(f);
      if (!cur) return;
      writeValue(f, cur.real);
      cur.lifts.add(reason);
      return;
    }
    e.lifts.add(reason);
  }

  /** End a lift. Whatever the field holds now (typed by the user, or written by the page) is the new real value. */
  settle(el: Element, reason: LiftReason) {
    const f = el as StrictField;
    const e = this.fields.get(f);
    if (!e || !e.lifts.delete(reason) || e.lifts.size) return;
    e.real = readValue(f);
    e.mask = maskValue(e.real);
    if (e.mask !== e.real) writeValue(f, e.mask);
  }

  install() {
    const on = (type: string, fn: (e: Event) => void, capture: boolean) => {
      window.addEventListener(type, fn, capture);
      this.disposers.push(() => window.removeEventListener(type, fn, capture));
    };
    on('formdata', (e) => this.onFormData(e), true);
    on('submit', (e) => this.onSubmitStart(e), true);
    // Bubble phase on window: the last listener of the dispatch, after the
    // page's own handlers. A timer backs it up for a handler that stopped
    // propagation.
    on('submit', () => this.onSubmitEnd(), false);
    // Late in the dispatch too, so a controlled-input handler that rewrites
    // the value in response has already run.
    const onEdit = (e: Event) => {
      const t = e.target as Element | null;
      if (t && this.fields.has(t as StrictField)) this.sync(t);
    };
    on('input', onEdit, false);
    on('change', onEdit, false);
  }

  dispose() {
    this.releaseAll();
    clearTimeout(this.submitTimer);
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  /**
   * `new FormData(form)` and every native submission build the entry list
   * from the live values (bullets), then fire `formdata` at the form with the
   * FormData object that will be returned or sent. Swap the bullets for the
   * real value there; the DOM is not touched.
   */
  onFormData(e: Event) {
    const form = e.target as HTMLFormElement | null;
    const fd = (e as FormDataEvent).formData as FormData | undefined;
    // The browser fires this one itself; a script-made FormDataEvent carries
    // a FormData of the script's choosing and is not a submission.
    if (!form || !fd || !this.trusted(e)) return;
    for (const [el, entry] of Array.from(this.fields)) {
      if (el.form !== form || !el.name || el.disabled || entry.lifts.size) continue;
      // A value the page wrote since the last sync went into the entry list
      // raw; that raw value is the real one and stays.
      if (this.sync(el)) continue;
      const vals = fd.getAll(el.name);
      const i = vals.indexOf(entry.mask);
      if (i < 0) continue;
      if (vals.length === 1) {
        fd.set(el.name, entry.real);
      } else {
        vals[i] = entry.real;
        fd.delete(el.name);
        for (const v of vals) fd.append(el.name, v);
      }
    }
  }

  onSubmitStart(e: Event) {
    // A script-dispatched submit event submits nothing: lifting for it would
    // only hand the real value to whoever dispatched it.
    if (!this.trusted(e)) return;
    const form = e.target as HTMLFormElement | null;
    if (!form) return;
    for (const el of Array.from(this.fields.keys())) {
      if (el.form !== form) continue;
      this.lift(el, 'submit');
      this.submitting.add(el);
    }
    if (this.submitting.size && !this.submitTimer) this.submitTimer = window.setTimeout(() => this.onSubmitEnd(), 0);
  }

  onSubmitEnd() {
    clearTimeout(this.submitTimer);
    this.submitTimer = 0;
    const els = Array.from(this.submitting);
    this.submitting.clear();
    for (const el of els) this.settle(el, 'submit');
  }
}
