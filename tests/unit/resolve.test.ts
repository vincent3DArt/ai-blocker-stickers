import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildFingerprint, setFingerprintKey } from '@/content/anchor/fingerprint';
import { resolveFingerprint } from '@/content/anchor/resolve';
import { importKey, randomKeyB64 } from '@/shared/hmac';

// jsdom has no WebCrypto subtle and (depending on the version) no CSS.escape.
function polyfill() {
  const g = globalThis as unknown as { crypto?: Crypto; CSS?: { escape(s: string): string } };
  if (!g.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
  if (!g.CSS) g.CSS = { escape: (s: string) => s };
  if (!g.CSS.escape) g.CSS.escape = (s: string) => s.replace(/([^\w-])/g, '\\$1');
}

const ROWS = [
  { name: 'Alice Example', ssn: '111-22-3333', acct: '1000000001' },
  { name: 'Bob Example', ssn: '123-45-6789', acct: '9876543210' },
  { name: 'Cara Example', ssn: '444-55-6666', acct: '1000000003' },
];

function renderTable(rows: { name: string; ssn: string; acct: string }[]) {
  document.body.innerHTML = `
    <h1>Clients</h1>
    <table id="clients">
      <thead><tr><th>Name</th><th>SSN</th><th>Account</th></tr></thead>
      <tbody id="rows">${rows
        .map(
          (r) =>
            `<tr class="row" data-key="${r.acct}">` +
            `<td class="cell col-name">${r.name}</td>` +
            `<td class="cell col-ssn">${r.ssn}</td>` +
            `<td class="cell col-acct">${r.acct}</td>` +
            `</tr>`,
        )
        .join('')}</tbody>
    </table>`;
  return document.querySelector<HTMLElement>('#rows tr[data-key="9876543210"] td.col-ssn');
}

describe('resolveFingerprint: identity beats position', () => {
  beforeAll(async () => {
    polyfill();
    setFingerprintKey(await importKey(randomKeyB64()));
  });

  it('follows the record when a row is inserted above it', async () => {
    const target = renderTable(ROWS)!;
    const fp = await buildFingerprint(target);
    expect(fp.keyHmac).toBeTruthy();
    expect(fp.labelSource).toBe('column'); // column header only: not an identity signal

    renderTable([{ name: 'New Person', ssn: '000-00-0000', acct: '1000000009' }, ...ROWS]);
    const res = await resolveFingerprint(fp);
    expect(res).not.toBeNull();
    expect(res!.el.textContent).toBe('123-45-6789');
    expect(res!.el.closest('tr')!.getAttribute('data-key')).toBe('9876543210');
  });

  it('gives up rather than jumping to the next row when the row is deleted', async () => {
    const target = renderTable(ROWS)!;
    const fp = await buildFingerprint(target);

    renderTable(ROWS.filter((r) => r.acct !== '9876543210'));
    expect(await resolveFingerprint(fp)).toBeNull();
  });

  it('still resolves a detail row labelled by its own th when the value changes', async () => {
    document.body.innerHTML = `
      <table id="detail"><tbody>
        <tr><th>SSN</th><td class="value">123-45-6789</td></tr>
        <tr><th>Account</th><td class="value">9876543210</td></tr>
      </tbody></table>`;
    const target = document.querySelector<HTMLElement>('#detail td.value')!;
    const fp = await buildFingerprint(target);
    expect(fp.labelContext).toBe('ssn');
    expect(fp.labelSource).toBe('row');

    target.textContent = '999-88-7777';
    const res = await resolveFingerprint(fp);
    expect(res).not.toBeNull();
    expect(res!.el).toBe(target);
  });

  it('still resolves a stable id when the value changes', async () => {
    document.body.innerHTML = `
      <div class="field"><span class="label">SSN</span><span id="client-ssn">123-45-6789</span></div>`;
    const fp = await buildFingerprint(document.getElementById('client-ssn')!);
    expect(fp.id).toBe('client-ssn');

    document.getElementById('client-ssn')!.textContent = '987-65-4321';
    const res = await resolveFingerprint(fp);
    expect(res?.el).toBe(document.getElementById('client-ssn'));
  });
});

describe('M2: attribute values are never stored raw unless identifier-like', () => {
  beforeAll(async () => {
    polyfill();
    setFingerprintKey(await importKey(randomKeyB64()));
  });

  const markup = `
    <form><div>
      <input class="field" name="user.jane@example.com" data-testid="row-123456789"
        aria-label="Email jane.doe@example.com" placeholder="sk-live-4f9a1234" value="x">
      <input class="field" name="other" data-testid="row-2" value="y">
    </div></form>`;

  it('normalises aria-label/placeholder, hashes data-like test ids and names, and still resolves', async () => {
    document.body.innerHTML = markup;
    const el = document.querySelector<HTMLInputElement>('[data-testid="row-123456789"]')!;
    const fp = await buildFingerprint(el);
    const json = JSON.stringify(fp);
    for (const leak of ['jane.doe', 'jane@', '123456789', '4f9a1234', 'example.com']) expect(json, leak).not.toContain(leak);
    expect(fp.testId).toBeUndefined();
    expect(fp.testIdHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.name).toBeUndefined();
    expect(fp.nameHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.ariaLabel).toBe('email jane doe example com');
    expect(fp.placeholder).toBe('sk live f a');

    // Re-render: a fresh node with the same attributes is found through the HMACs.
    document.body.innerHTML = markup;
    const res = await resolveFingerprint(fp);
    expect(res?.el).toBe(document.querySelector('[data-testid="row-123456789"]'));
  });

  it('keeps identifier-like values raw', async () => {
    document.body.innerHTML = `<input id="ssn" name="ssn" data-testid="ssn-input" type="text">`;
    const fp = await buildFingerprint(document.getElementById('ssn')!);
    expect(fp).toMatchObject({ id: 'ssn', name: 'ssn', testId: 'ssn-input', type: 'text' });
    expect(fp.idHmac ?? fp.nameHmac ?? fp.testIdHmac).toBeUndefined();
  });
});
