import { afterEach, describe, expect, it } from 'vitest';
import { Masker } from '@/content/mask/masker';
import { MutationHub } from '@/content/mask/guard';
import { STRICT_ATTR, StrictInputs } from '@/content/mask/strict-input';

const SSN = '123-45-6789';
const BULLETS = '•'.repeat(SSN.length);

let masker: Masker | null = null;

afterEach(() => {
  masker?.stop();
  masker = null;
  document.body.innerHTML = '';
});

function setup(extra = '') {
  document.body.innerHTML = `<form id="intake"><input id="ssn" name="ssn" value="${SSN}"><input id="other" name="other" value="plain">${extra}</form>`;
  return {
    form: document.getElementById('intake') as HTMLFormElement,
    ssn: document.getElementById('ssn') as HTMLInputElement,
  };
}

/** jsdom never fires a trusted `formdata`; the masker is told to accept these. */
function strictMasker(): Masker {
  masker = new Masker(new MutationHub(), { trusted: () => true });
  masker.start();
  masker.setStrict(true);
  return masker;
}

/** What `new FormData(form)` does in a browser: build from live values, then fire `formdata`. */
function formDataOf(form: HTMLFormElement): FormData {
  const fd = new FormData(form);
  const ev = new Event('formdata', { bubbles: true });
  Object.defineProperty(ev, 'formData', { value: fd });
  form.dispatchEvent(ev);
  return fd;
}

describe('strict input masking', () => {
  it('swaps the live value for bullets through the native setter and restores it', () => {
    const { ssn } = setup();
    // A framework-style setter hook on the instance: must never run.
    let hookCalls = 0;
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(ssn, 'value', {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v) {
        hookCalls++;
        proto.set!.call(this, v);
      },
    });
    let inputEvents = 0;
    ssn.addEventListener('input', () => inputEvents++);
    ssn.addEventListener('change', () => inputEvents++);

    const m = strictMasker();
    m.apply('a', ssn, 'input');
    expect(ssn.value).toBe(BULLETS);
    expect(ssn.getAttribute(STRICT_ATTR)).toBe('1');
    expect(ssn.getAttribute('value')).toBe('');
    expect(ssn.defaultValue).toBe('');
    expect(m.originals('a')).toBe(SSN);
    expect(m.strictCount()).toBe(1);

    m.restore('a');
    expect(ssn.value).toBe(SSN);
    expect(ssn.getAttribute(STRICT_ATTR)).toBeNull();
    expect(ssn.getAttribute('value')).toBe(SSN);
    expect(hookCalls).toBe(0);
    expect(inputEvents).toBe(0);
  });

  it('follows setStrict: off restores the real value, on masks fields already covered', () => {
    const { ssn } = setup();
    masker = new Masker(new MutationHub(), { trusted: () => true });
    masker.start();
    masker.apply('a', ssn, 'input');
    expect(ssn.value).toBe(SSN);
    masker.setStrict(true);
    expect(ssn.value).toBe(BULLETS);
    masker.setStrict(false);
    expect(ssn.value).toBe(SSN);
    expect(ssn.hasAttribute(STRICT_ATTR)).toBe(false);
  });

  it('puts the real value into FormData on formdata, leaving the DOM masked', () => {
    const { form, ssn } = setup();
    strictMasker().apply('a', ssn, 'input');
    const fd = formDataOf(form);
    expect(fd.get('ssn')).toBe(SSN);
    expect(fd.get('other')).toBe('plain');
    expect(Array.from(fd.keys())).toEqual(['ssn', 'other']); // order kept
    expect(ssn.value).toBe(BULLETS);
  });

  it('restores the value for a submit and masks again once it has propagated', () => {
    const { form, ssn } = setup();
    strictMasker().apply('a', ssn, 'input');
    let during = '';
    form.addEventListener('submit', (e) => {
      during = ssn.value;
      e.preventDefault();
    });
    form.requestSubmit();
    expect(during).toBe(SSN);
    expect(ssn.value).toBe(BULLETS);
  });

  it('ignores a script-dispatched submit event', () => {
    const { form, ssn } = setup();
    const s = new StrictInputs(() => {}); // default: only trusted events
    s.install();
    try {
      s.engage(ssn);
      let during = '';
      form.addEventListener('submit', () => (during = ssn.value));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(during).toBe(BULLETS);
      const fd = new FormData(form);
      const ev = new Event('formdata', { bubbles: true });
      Object.defineProperty(ev, 'formData', { value: fd });
      form.dispatchEvent(ev);
      expect(fd.get('ssn')).toBe(BULLETS);
    } finally {
      s.dispose();
    }
  });

  it('adopts a value the page writes itself as the new real value', () => {
    const { form, ssn } = setup();
    const m = strictMasker();
    m.apply('a', ssn, 'input');
    // A controlled input re-rendering: the page writes a new value, then an input event goes by.
    ssn.value = 'NEW-0000';
    ssn.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ssn.value).toBe('•'.repeat('NEW-0000'.length));
    expect(m.originals('a')).toBe('NEW-0000');
    expect(formDataOf(form).get('ssn')).toBe('NEW-0000');
    // Even with no event at all, the next formdata keeps the raw value the page wrote.
    ssn.value = 'NEWER-11';
    expect(formDataOf(form).get('ssn')).toBe('NEWER-11');
    expect(ssn.value).toBe('•'.repeat('NEWER-11'.length));
    m.restore('a');
    expect(ssn.value).toBe('NEWER-11');
  });

  it('peek puts the real value in the field; what it holds afterwards becomes the real value', () => {
    const { ssn } = setup();
    const m = strictMasker();
    m.apply('a', ssn, 'input');
    m.setPeek('a', true);
    expect(ssn.value).toBe(SSN);
    ssn.value = '999-88-7777'; // the user edits while peeking
    m.setPeek('a', false);
    expect(ssn.value).toBe(BULLETS);
    expect(m.originals('a')).toBe('999-88-7777');
  });

  it('leaves a field alone when bullets would fail its pattern and block submission', () => {
    document.body.innerHTML = `<form><input id="p" name="p" pattern="\\d{3}-\\d{2}-\\d{4}" value="${SSN}"><textarea id="t" name="t">Spouse SSN 987-65-4321</textarea></form>`;
    const p = document.getElementById('p') as HTMLInputElement;
    const t = document.getElementById('t') as HTMLTextAreaElement;
    const m = strictMasker();
    m.apply('p', p, 'input');
    m.apply('t', t, 'input');
    expect(p.value).toBe(SSN);
    expect(p.hasAttribute(STRICT_ATTR)).toBe(false);
    // A textarea has no such constraint.
    expect(t.value).toBe('•'.repeat('Spouse SSN 987-65-4321'.length));
    expect(t.textContent).not.toContain('987-65-4321');
    expect(m.strictCount()).toBe(1);
  });
});
