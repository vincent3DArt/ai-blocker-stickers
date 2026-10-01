import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from "node:path";
import {
  accepts,
  findMatches,
  luhn,
  validAba,
  validCard,
  validEin,
  validIban,
  validItin,
  validSsn,
  type PatternId,
  type Sensitivity,
} from '@/content/detect/patterns';
import { labelKinds } from '@/content/detect/labels';
import { allBlocks, targetFor } from '@/content/detect/block-text';
import { detectBlock, scanSync, type Hit } from '@/content/detect/scanner';

// jsdom has no CSS.escape (labelInfo uses it).
beforeAll(() => {
  const g = globalThis as unknown as { CSS?: { escape(s: string): string } };
  if (!g.CSS) g.CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
});

const ids = (text: string) => findMatches(text).map((m) => m.id);
const has = (text: string, id: PatternId) => ids(text).includes(id);

describe('validators', () => {
  it('SSN: area, group and serial rules', () => {
    expect(validSsn('123-45-6789')).toBe(true);
    expect(validSsn('000-12-3456')).toBe(false);
    expect(validSsn('666-12-3456')).toBe(false);
    expect(validSsn('900-12-3456')).toBe(false);
    expect(validSsn('123-00-4567')).toBe(false);
    expect(validSsn('123-45-0000')).toBe(false);
    // 9xx is not an SSN but can be an ITIN (group 50-65, 70-88, 90-92, 94-99).
    expect(validItin('987-65-4321')).toBe(true);
    expect(validItin('987-12-4321')).toBe(false);
  });

  it('Luhn and card issuer prefixes', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(validCard('4111 1111 1111 1111')).toBe(true);
    expect(validCard('5500-0000-0000-0004')).toBe(true);
    expect(validCard('378282246310005')).toBe(true);
    // Luhn-valid but no issuer uses the prefix: a tracking number.
    expect(validCard('1234567812345670')).toBe(false);
    expect(validCard('4111 11111 1111111')).toBe(false);
  });

  it('ABA routing checksum and prefix', () => {
    expect(validAba('021000021')).toBe(true);
    expect(validAba('011000015')).toBe(true);
    expect(validAba('021000022')).toBe(false);
    expect(validAba('991000021')).toBe(false);
  });

  it('IBAN mod-97 and country length', () => {
    expect(validIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(validIban('GB82WEST12345698765432')).toBe(true);
    expect(validIban('GB82WEST12345698765433')).toBe(false);
    expect(validIban('DE89 3704 0044 0532 0130')).toBe(false);
  });

  it('EIN prefixes', () => {
    expect(validEin('12-3456789')).toBe(true);
    expect(validEin('07-1234567')).toBe(false);
    expect(validEin('00-1234567')).toBe(false);
  });
});

describe('findMatches', () => {
  it('finds the positives', () => {
    expect(has('SSN 123-45-6789', 'ssn')).toBe(true);
    expect(has('123 45 6789', 'ssn')).toBe(true);
    expect(has('spouse 987-65-4321', 'itin')).toBe(true);
    expect(has('EIN 12-3456789', 'ein')).toBe(true);
    expect(has('routing 021000021', 'routing')).toBe(true);
    expect(has('IBAN DE89 3704 0044 0532 0130 00', 'iban')).toBe(true);
    expect(has('card 4111 1111 1111 1111 on file', 'card')).toBe(true);
    expect(has('SSN ***-**-1234', 'maskedLast4')).toBe(true);
    expect(has('ending ••••1234', 'maskedLast4')).toBe(true);
    expect(has('born 04/18/1980', 'dob')).toBe(true);
  });

  it('explicit negatives: phone, ZIP+4, dates, UUID, hex, longer numbers', () => {
    expect(ids('Call (555) 010-4477 or 555-010-9911 or 555.010.2288')).toEqual([]);
    expect(ids('Ship to 94107-1234')).toEqual([]);
    expect(ids('Placed 03-14-2024, due 2024-05-02, paid 11.30.2023')).toEqual([]);
    expect(ids('Ref 7f3c9a2e-4b1d-4c8e-9a6f-0d2e5b7c1a93')).toEqual([]);
    expect(ids('checksum 5d41402abc4b2a76b9719d911017c592')).toEqual([]);
    expect(ids('order 112-4567890-1234567')).toEqual([]);
    expect(ids('123-45-6789-01')).toEqual([]);
    expect(ids('tracking 9400111899223197428490')).toEqual([]);
    expect(has('tracking 123456789012345', 'card')).toBe(false);
  });
});

describe('labels and scoring', () => {
  it('label keywords', () => {
    expect([...labelKinds('Social Security #')]).toContain('ssn');
    expect([...labelKinds('Acct #')]).toContain('account');
    expect([...labelKinds('ABA routing')]).toContain('routing');
    expect([...labelKinds("Driver's license")]).toContain('id');
    expect([...labelKinds('Date of birth')]).toContain('dob');
    expect([...labelKinds('Order number')]).toEqual([]);
    expect([...labelKinds('Tracking number')]).toEqual([]);
  });

  it('sensitivity thresholds', () => {
    const t = (s: 'high' | 'medium' | 'low', b: number, sens: Sensitivity, gated = false) => accepts(s, b, sens, gated);
    // balanced: high alone, medium with any label, low with 2.
    expect(t('high', 0, 'balanced')).toBe(true);
    expect(t('medium', 0, 'balanced')).toBe(false);
    expect(t('medium', 1, 'balanced')).toBe(true);
    expect(t('low', 1, 'balanced')).toBe(false);
    expect(t('low', 2, 'balanced')).toBe(true);
    // labeled-only: 2 or more, whatever the strength.
    expect(t('high', 1, 'labeled-only')).toBe(false);
    expect(t('high', 2, 'labeled-only')).toBe(true);
    expect(t('low', 3, 'labeled-only')).toBe(true);
    // aggressive: medium alone; label-gated still needs a label.
    expect(t('medium', 0, 'aggressive')).toBe(true);
    expect(t('low', 0, 'aggressive')).toBe(false);
    expect(t('low', 1, 'aggressive', true)).toBe(true);
    expect(t('low', 0, 'aggressive', true)).toBe(false);
    expect(t('low', 1, 'balanced', true)).toBe(false);
  });

  it('label proximity: same element 3, adjacent label 2, same block 1', () => {
    // One snippet at a time: labelInfo also looks at the previous sibling block.
    const bonus = (html: string) => {
      document.body.innerHTML = `<main>${html}</main>`;
      const hits = allBlocks(document.body).flatMap((b) => detectBlock(b, { sensitivity: 'aggressive' }));
      return hits.length ? Math.max(...hits.map((h) => h.bonus)) : -1;
    };
    expect(bonus('<div>Routing: 021000021</div>')).toBe(3);
    expect(bonus('<table><tr><th>Routing</th><td>021000021</td></tr></table>')).toBe(2);
    expect(bonus('<p>Routing: payroll goes through <b>021000021</b> as of this year.</p>')).toBe(1);
    // aggressive accepts a medium routing number with no label at all.
    expect(bonus('<p>Reference number 021000021 printed on the form.</p>')).toBe(0);
    // balanced does not.
    document.body.innerHTML = '<p>Reference number 021000021 printed on the form.</p>';
    expect(allBlocks(document.body).flatMap((b) => detectBlock(b, { sensitivity: 'balanced' }))).toEqual([]);
  });

  it('assembles numbers split across inline elements', () => {
    document.body.innerHTML = '<p id="p"><span class="l">SSN</span><span>123</span>-<span>45</span>-<span>6789</span></p>';
    const [block] = allBlocks(document.body);
    expect(block.text).toBe('SSN 123-45-6789');
    const m = findMatches(block.text)[0];
    expect(m.id).toBe('ssn');
    expect(targetFor(block, m.start, m.end)?.el.id).toBe('p');
  });
});

// ---- labelled corpus ----

const fixture = (name: string) => readFileSync(resolve(process.cwd(), "fixtures", name), "utf8");

function load(name: string) {
  const html = fixture(name)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>[\s\S]*$/i, '');
  document.documentElement.innerHTML = html;
}

const CORPUS: Array<{ file: string; positives: string[] }> = [
  {
    file: 'static.html',
    positives: [
      '#ssn-cell',
      '#identity tbody tr:nth-child(2) td',
      '#identity tbody tr:nth-child(3) td',
      '#identity tbody tr:nth-child(4) td',
      '#wrapped-span',
      '#dep-ssn',
      '#hdr-account',
      '#bottom-account',
    ],
  },
  { file: 'forms.html', positives: ['#ssn', '#acct', '#notes', '#editor', '#ctrl', '#live'] },
  { file: 'fp-corpus.html', positives: [] },
];

describe('corpus precision / recall at balanced', () => {
  it('precision >= 0.95 and recall >= 0.9', () => {
    let tp = 0;
    let fp = 0;
    let found = 0;
    let positives = 0;
    const misses: string[] = [];
    const falses: string[] = [];
    for (const { file, positives: sels } of CORPUS) {
      load(file);
      const hits: Hit[] = scanSync(document, { sensitivity: 'balanced' });
      const pos = sels.map((s) => {
        const el = document.querySelector(s);
        if (!el) throw new Error(`${file}: no ${s}`);
        return el;
      });
      const matches = (h: Hit, p: Element) => h.el === p || p.contains(h.el) || h.el.contains(p);
      for (const h of hits) {
        if (pos.some((p) => matches(h, p))) tp++;
        else {
          fp++;
          falses.push(`${file}: ${h.pattern} on <${h.el.tagName.toLowerCase()}> "${(h.el.textContent ?? '').trim().slice(0, 40)}"`);
        }
      }
      positives += pos.length;
      pos.forEach((p, i) => {
        if (hits.some((h) => matches(h, p))) found++;
        else misses.push(`${file}: ${sels[i]}`);
      });
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = found / Math.max(1, positives);
    // Printed so the achieved numbers are visible in the run.
    console.info(`[detect corpus] precision ${precision.toFixed(3)} (${tp}/${tp + fp}), recall ${recall.toFixed(3)} (${found}/${positives})`);
    expect(falses, 'false positives').toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall, `missed: ${misses.join(', ')}`).toBeGreaterThanOrEqual(0.9);
  });

  it('nothing on the false-positive corpus at any sensitivity but aggressive', () => {
    load('fp-corpus.html');
    for (const s of ['labeled-only', 'balanced'] as Sensitivity[]) {
      expect(scanSync(document, { sensitivity: s }).map((h) => h.pattern)).toEqual([]);
    }
  });
});
