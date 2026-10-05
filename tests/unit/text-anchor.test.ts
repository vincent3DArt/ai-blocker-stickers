import { describe, expect, it } from 'vitest';
import { coveredKey, coveredTokens, locateByHash, locateExact, rangesForSpan, startOf, stripped } from '@/content/anchor/text-anchor';

describe('text anchoring for rect stickers', () => {
  it('strips whitespace and maps every character back to its node and offset', () => {
    document.body.innerHTML = '<p id="p">Taxpayer SSN <b>123-45-6789</b> (primary)</p>';
    const st = stripped(document.getElementById('p')!)!;
    expect(st.s).toBe('TaxpayerSSN123-45-6789(primary)');
    const i = locateExact(st, '123-45-6789', 0);
    expect(i).toBe(11);
    const ranges = rangesForSpan(st, i, 11);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].node.data.slice(ranges[0].start, ranges[0].end)).toBe('123-45-6789');
    expect(coveredKey(ranges)).toBe('123-45-6789');
    expect(coveredTokens(ranges)).toEqual(['123-45-6789']);
    expect(startOf(st, ranges)).toBe(11);
  });

  it('picks the occurrence nearest to the guess', () => {
    document.body.innerHTML = '<p id="p">AAA xyz BBB xyz CCC</p>';
    const st = stripped(document.getElementById('p')!)!;
    expect(locateExact(st, 'xyz', 0)).toBe(3);
    expect(locateExact(st, 'xyz', 12)).toBe(9);
  });

  it('finds a window by its hash without knowing the text', () => {
    document.body.innerHTML = '<p id="p">Dear client, your number 123-45-6789 is on file.</p>';
    const st = stripped(document.getElementById('p')!)!;
    const hash = (s: string) => (s === '123-45-6789' ? 'H' : 'x' + s.length);
    expect(locateByHash(st, 11, 'H', hash, 0)).toBe(st.s.indexOf('123-45-6789'));
    expect(locateByHash(st, 11, 'nope', hash, 5)).toBe(-1);
  });
});
