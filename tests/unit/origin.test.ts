import { describe, expect, it } from 'vitest';
import { parseOrigin, scriptId } from '@/shared/origin';

describe('M3: parseOrigin', () => {
  it('accepts bare http(s) origins', () => {
    expect(parseOrigin('https://example.com')).toBe('https://example.com');
    expect(parseOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
  });
  it('rejects paths, wildcards, other schemes and non-strings', () => {
    const bad: unknown[] = [
      'https://example.com/',
      'https://example.com/a',
      'https://example.com?q',
      '*://*',
      'https://*.example.com',
      'file:///c:/x',
      'chrome://settings',
      'https://u:p@example.com',
      'HTTPS://EXAMPLE.COM',
      '',
      42,
      null,
    ];
    for (const o of bad) expect(parseOrigin(o), String(o)).toBeNull();
  });
});

describe('M4: scriptId', () => {
  it('never collides for origins the old scheme merged', () => {
    const pairs = [
      ['https://my-bank.com', 'https://my.bank.com'],
      ['https://a-b.example.com', 'https://a.b.example.com'],
      ['http://example.com', 'https://example.com'],
    ];
    for (const [a, b] of pairs) expect(scriptId(a)).not.toBe(scriptId(b));
  });
  it('is stable and uses the versioned prefix', () => {
    expect(scriptId('https://example.com')).toBe(scriptId('https://example.com'));
    expect(scriptId('https://example.com')).toMatch(/^aibs-v2-example_com-[0-9a-z]+$/);
  });
});
