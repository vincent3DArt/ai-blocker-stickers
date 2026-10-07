import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveFromExample } from '@/content/detect/derive';
import { checkRegex, templateToRegex } from '@/content/detect/template';
import { CATALOG, CATALOG_BY_ID, builtinOff, findCatalog, isTracking, validVin } from '@/content/detect/catalog';
import { compileCatalog, compileCustom, findUserMatches, keywordTest, newBudget } from '@/content/detect/custom';
import { allBlocks } from '@/content/detect/block-text';
import { scanSync } from '@/content/detect/scanner';
import { assertNoCoveredText, saveSettings, saveSite, siteKey, SETTINGS_KEY } from '@/shared/storage';
import { cleanDetectors, normalizeSettings, type CustomDetector, type SiteRecord } from '@/shared/types';

beforeAll(() => {
  const g = globalThis as unknown as { CSS?: { escape(s: string): string } };
  if (!g.CSS) g.CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
});

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe('deriveFromExample', () => {
  it('the examples from the spec', () => {
    const a = ok(deriveFromExample('AB1234567'));
    expect(a.regex).toBe('\\b[A-Z]{2}\\d{7}\\b');
    expect(a.description).toBe('2 letters, 7 digits');
    expect(a.strength).toBe('medium');

    const b = ok(deriveFromExample('123-45-6789'));
    expect(b.regex).toBe('\\b\\d{3}-\\d{2}-\\d{4}\\b');
    expect(b.description).toBe('3 digits, 2 digits, 4 digits');
    expect(b.strength).toBe('high');

    const c = ok(deriveFromExample('K12-345-678-9'));
    expect(c.regex).toBe('\\b[A-Z]\\d{2}-\\d{3}-\\d{3}-\\d\\b');
    expect(c.strength).toBe('high');

    const d = ok(deriveFromExample('MRN 00912345', 'MRN'));
    expect(d.regex).toBe('\\b\\d{8}\\b');
    expect(d.labels).toEqual(['mrn']);
    expect(d.strength).toBe('medium');

    const e = ok(deriveFromExample('PX-2291-4471', 'policy'));
    expect(e.regex).toBe('\\b[A-Z]{2}-\\d{4}-\\d{4}\\b');
    expect(e.description).toBe('2 letters, 4 digits, 4 digits');
    expect(e.strength).toBe('high');
    expect(e.labels).toEqual(['policy']);
  });

  it('NBSP and other spaces become the space class; typographic dashes match either dash', () => {
    expect(ok(deriveFromExample('123 45 6789')).regex).toBe('\\b\\d{3}[ \\u00a0]\\d{2}[ \\u00a0]\\d{4}\\b');
    expect(ok(deriveFromExample('12 345  678')).regex).toBe('\\b\\d{2}[ \\u00a0]\\d{3}[ \\u00a0]\\d{3}\\b');
    const dash = ok(deriveFromExample('123–45–6789')).regex;
    expect(dash).toBe('\\b\\d{3}[-\\u2010-\\u2015]\\d{2}[-\\u2010-\\u2015]\\d{4}\\b');
    expect(new RegExp(dash).test('123-45-6789')).toBe(true);
    expect(new RegExp(dash).test('123—45—6789')).toBe(true);
  });

  it('mixed case becomes case-insensitive letter classes', () => {
    const r = ok(deriveFromExample('Ab12cD'));
    expect(r.regex).toBe('\\b[A-Za-z]{2}\\d{2}[A-Za-z]{2}\\b');
    expect(ok(deriveFromExample('abc-123')).regex).toBe('\\b[a-z]{3}-\\d{3}\\b');
  });

  it('long runs get a range, short digit-only and letter-only shapes are low', () => {
    const r = ok(deriveFromExample('1234567890123456'));
    expect(r.regex).toBe('\\b\\d{15,17}\\b');
    expect(r.description).toBe('15–17 digits');
    expect(ok(deriveFromExample('123456')).strength).toBe('low');
    expect(ok(deriveFromExample('ABCDEFG')).strength).toBe('low');
    expect(ok(deriveFromExample('1234567')).strength).toBe('medium');
  });

  it('separators: slash, dot and # are literal; non-alphanumeric ends get no \\b', () => {
    expect(ok(deriveFromExample('12/34/5678')).regex).toBe('\\b\\d{2}\\/\\d{2}\\/\\d{4}\\b');
    expect(ok(deriveFromExample('A1.B2.C3')).regex).toBe('\\b[A-Z]\\d\\.[A-Z]\\d\\.[A-Z]\\d\\b');
    expect(ok(deriveFromExample('12#345')).regex).toBe('\\b\\d{2}#\\d{3}\\b');
    // A leading # is label punctuation ("Order #12345"), not part of the shape.
    expect(ok(deriveFromExample('#12345')).regex).toBe('\\b\\d{5}\\b');
  });

  it('refuses empty, tiny and paragraph-sized selections', () => {
    expect(deriveFromExample('   ').ok).toBe(false);
    expect(deriveFromExample('a1').ok).toBe(false);
    expect(deriveFromExample('--//').ok).toBe(false);
    expect(deriveFromExample('x'.repeat(80)).ok).toBe(false);
  });

  it('the result never contains a character of the example except separators', () => {
    for (const ex of ['123-45-6789', 'AB1234567', 'PX-2291-4471', 'MBR00912345', 'K12-345-678-9']) {
      const r = ok(deriveFromExample(ex, 'member id'));
      const json = JSON.stringify(r);
      const runs = ex.match(/[A-Za-z]{2,}|\d{2,}/g) ?? [];
      for (const run of runs) expect(json, `${ex}: ${run}`).not.toContain(run);
    }
  });
});

describe('templateToRegex', () => {
  it('classes, literals and repeats', () => {
    expect(ok(templateToRegex('AA-####-####')).regex).toBe('\\b[A-Z]{2}-\\d{4}-\\d{4}\\b');
    expect(ok(templateToRegex('A##-####-####')).regex).toBe('\\b[A-Z]\\d{2}-\\d{4}-\\d{4}\\b');
    expect(ok(templateToRegex('aaXX?')).regex).toBe('\\b[a-z]{2}[A-Za-z0-9]{2}.');
    expect(ok(templateToRegex('##*')).regex).toBe('\\b\\d+\\b');
    expect(ok(templateToRegex('A#*')).regex).toBe('\\b[A-Z]\\d*');
    expect(ok(templateToRegex('### ##')).regex).toBe('\\b\\d{3}[ \\u00a0]\\d{2}\\b');
  });

  it('literal letters stay literal and are quoted in the description; \\ escapes a class letter', () => {
    const r = ok(templateToRegex('MBR########'));
    expect(r.regex).toBe('\\bMBR\\d{8}\\b');
    expect(r.description).toBe('"MBR", 8 digits');
    expect(new RegExp(r.regex).test('Member MBR00912345')).toBe(true);
    expect(ok(templateToRegex('\\A-###')).regex).toBe('\\bA-\\d{3}\\b');
  });

  it('a typed digit stands for any digit: a format never stores data', () => {
    const r = ok(templateToRegex('123-45-6789'));
    expect(r.regex).toBe('\\b\\d{3}-\\d{2}-\\d{4}\\b');
    expect(r.regex).not.toMatch(/\d{2}/);
  });

  it('refuses empty, separator-only, too long and a leading *', () => {
    expect(templateToRegex('').ok).toBe(false);
    expect(templateToRegex('---').ok).toBe(false);
    expect(templateToRegex('*A').ok).toBe(false);
    expect(templateToRegex('#'.repeat(61)).ok).toBe(false);
  });

  it('the same shape as an example: a template and an example agree', () => {
    expect(ok(templateToRegex('AA-####-####')).regex).toBe(ok(deriveFromExample('PX-2291-4471')).regex);
  });
});

describe('regex safety', () => {
  it('accepts ordinary patterns', () => {
    expect(checkRegex('\\b[A-Z]{2}\\d{6}\\b').ok).toBe(true);
    expect(checkRegex('MBR\\d{8}').ok).toBe(true);
    expect(checkRegex('(?:\\d{3}-){2}\\d{4}').ok).toBe(true);
    expect(checkRegex('[a-z]+@corp', 'i').ok).toBe(true);
  });

  it('rejects catastrophic, invalid, empty-matching and data-carrying patterns', () => {
    const bad = (src: string, flags = '') => {
      const r = checkRegex(src, flags);
      expect(r.ok, src).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(bad('(a+)+$')).toMatch(/Nested/);
    expect(bad('(\\d+)*x')).toMatch(/Nested/);
    expect(bad('(?:\\w+\\s?)+$')).toMatch(/Nested/);
    expect(bad('(a|aa)+b')).toMatch(/alternation/);
    expect(bad('(\\d)\\1')).toMatch(/Backreference/);
    expect(bad('a*')).toMatch(/empty/);
    expect(bad('([a-z')).toBeTruthy();
    expect(bad('x'.repeat(201))).toMatch(/under/);
    expect(bad('SSN 123456789')).toMatch(/literal digits/);
    expect(bad('\\d{3}', 'g')).toMatch(/flags/);
    expect(bad('')).toBeTruthy();
  });

  it('unicode escapes are not mistaken for literal digits', () => {
    expect(checkRegex('\\d{3}[ \\u2007]\\d{2}').ok).toBe(true);
  });

  it('an invalid stored detector compiles to null (skipped at run time)', () => {
    const d: CustomDetector = { id: 'x', name: 'Bad', source: 'regex', regex: '(a+)+', labels: [], strength: 'high', scope: 'global', createdAt: 0 };
    expect(compileCustom(d)).toBeNull();
    expect(compileCustom({ ...d, regex: '\\b[A-Z]{2}\\d{6}\\b' })).not.toBeNull();
  });
});

describe('catalogue', () => {
  it('keyword lookup by synonyms', () => {
    expect(findCatalog('insurance policy numbers')[0].id).toBe('insurance');
    const dl = findCatalog('driver license').map((e) => e.id);
    expect(dl.slice(0, 10).every((id) => id.startsWith('dl-'))).toBe(true);
    expect(dl).toContain('dl-ca');
    expect(findCatalog("driver's licence")[0].id).toMatch(/^dl-/);
    expect(findCatalog('phone numbers').map((e) => e.id).slice(0, 2).sort()).toEqual(['phone-intl', 'phone-us']);
    expect(findCatalog('medical record')[0].id).toBe('mrn');
    expect(findCatalog('VIN')[0].id).toBe('vin');
    expect(findCatalog('claim number')[0].id).toBe('case');
    expect(findCatalog('email addresses')[0].id).toBe('email');
    expect(findCatalog('number')).toEqual([]);
    expect(findCatalog('').length).toBe(CATALOG.length);
  });

  it('only the existing detectors are on by default; switching one off lists its pattern ids', () => {
    expect(CATALOG.filter((e) => e.defaultOn).every((e) => !!e.builtin)).toBe(true);
    expect(CATALOG.filter((e) => !e.defaultOn).every((e) => !!e.regex)).toBe(true);
    expect([...builtinOff({ bank: false })].sort()).toEqual(['account', 'iban', 'routing']);
    expect(builtinOff({}).size).toBe(0);
    expect(CATALOG.filter((e) => e.id.startsWith('dl-'))).toHaveLength(10);
  });

  it('every catalogue regex compiles', () => {
    for (const e of CATALOG) if (e.regex) expect(compileCatalog(e), e.id).not.toBeNull();
  });

  it('VIN check digit', () => {
    expect(validVin('1M8GDM9AXKP042788')).toBe(true);
    expect(validVin('1M8GDM9AYKP042788')).toBe(false);
    expect(validVin('11111111111111111')).toBe(false);
  });

  it('formats match, tracking numbers never do', () => {
    const m = (id: string, text: string) => findUserMatches(text, [compileCatalog(CATALOG_BY_ID.get(id)!)!]).length;
    expect(m('dl-ca', 'DL D1234567')).toBe(1);
    expect(m('dl-oh', 'license AB123456')).toBe(1);
    expect(m('phone-us', 'call (415) 555-2671')).toBe(1);
    expect(m('phone-us', 'call (015) 555-2671')).toBe(0);
    expect(m('email', 'write to pat@example.com')).toBe(1);
    expect(m('dob-any', 'born April 18, 1980')).toBe(1);
    expect(m('dob-any', 'born 1980-04-18')).toBe(1);
    expect(m('vin', 'VIN 1M8GDM9AXKP042788')).toBe(1);
    expect(m('insurance', 'Tracking 1Z999AA10123456784')).toBe(0);
    expect(m('insurance', 'Policy ABC123456')).toBe(1);
    expect(m('mrn', 'tracking 9400111899223197428490')).toBe(0);
    expect(isTracking('9400111899223197428490', '')).toBe(true);
  });
});

describe('scanner integration', () => {
  const policy = () => compileCustom({ id: 'p1', name: 'Policy', source: 'example', regex: ok(deriveFromExample('PX-2291-4471')).regex, labels: ['policy'], strength: 'high', scope: 'site', createdAt: 0 })!;

  it('custom detectors are scored like the built-ins, with their id in the pattern', () => {
    document.body.innerHTML = `
      <p>Policy # <span id="a">PX-2291-4471</span></p>
      <p>Other policy <span id="b">QR-1029-3847</span></p>
      <p>Order <span id="c">ORD-55821</span> placed 2024-05-02</p>`;
    const hits = scanSync(document, { sensitivity: 'balanced', user: [policy()] });
    const custom = hits.filter((h) => h.pattern === 'custom:p1');
    expect(custom.map((h) => h.el.id).sort()).toEqual(['a', 'b']);
    expect(custom[0].name).toBe('Policy');
  });

  it('a medium detector needs its label; a low one needs it close', () => {
    const member = compileCustom({ id: 'm', name: 'Member', source: 'example', regex: '\\bMBR\\d{8}\\b', labels: ['member id'], strength: 'medium', scope: 'site', createdAt: 0 })!;
    document.body.innerHTML = '<p>Member ID: <span id="m1">MBR00912345</span></p><div>Unrelated paragraph text that is long enough not to read as a label for anything.</div><p>The archive lists <span id="m2">MBR00912346</span> among many other records.</p>';
    const ids = scanSync(document, { sensitivity: 'balanced', user: [member] }).map((h) => h.el.id);
    expect(ids).toEqual(['m1']);
    expect(keywordTest(['member id'])('Member ID:')).toBe(true);
    expect(keywordTest(['member id'])('member identifier')).toBe(false);
  });

  it('a spent budget stops user detectors', () => {
    document.body.innerHTML = '<p>Policy # <span>PX-2291-4471</span></p>';
    const budget = newBudget(0);
    expect(scanSync(document, { sensitivity: 'balanced', user: [policy()], budget })).toEqual([]);
    const [block] = allBlocks(document.body);
    expect(findUserMatches(block.text, [policy()], newBudget()).length).toBe(1);
  });
});

/** Minimal chrome.storage mock. */
function mockChrome() {
  const data: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, JSON.parse(JSON.stringify(items)))),
        get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return data;
}

describe('privacy: saved detectors hold the shape, never the example', () => {
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  const fromExample = (example: string, scope: 'site' | 'global'): CustomDetector => {
    const r = ok(deriveFromExample(example));
    return {
      id: '6f1d2c3b-aaaa-4bbb-8ccc-0123456789ab',
      name: 'Taught pattern',
      source: 'example',
      regex: r.regex,
      labels: r.labels,
      strength: r.strength,
      scope,
      createdAt: 1758193000000,
    };
  };

  /** No two consecutive characters of the example's digit or letter runs survive in what was stored. */
  const leaks = (stored: unknown, example: string) => {
    const json = JSON.stringify(stored, (k, v) => (k === 'createdAt' || k === 'updatedAt' || k === 'id' ? undefined : v));
    const runs = example.match(/\d+|[A-Za-z]+/g) ?? [];
    const pairs = runs.flatMap((r) => Array.from({ length: r.length - 1 }, (_, i) => r.slice(i, i + 2)));
    return pairs.filter((p) => json.includes(p));
  };

  it('"123-45-6789" and "AB1234567": no digits of the example in the stored site record or settings', async () => {
    const data = mockChrome();
    for (const ex of ['123-45-6789', 'AB1234567']) {
      const site: SiteRecord = { v: 1, origin: 'https://example.test', enabled: true, stickers: [], updatedAt: 1, customDetectors: [fromExample(ex, 'site')] };
      await saveSite(site);
      const stored = data[siteKey(site.origin)] as SiteRecord;
      expect(stored.customDetectors).toHaveLength(1);
      expect(() => assertNoCoveredText(stored)).not.toThrow();
      expect(leaks(stored.customDetectors, ex)).toEqual([]);

      await saveSettings({ ...normalizeSettings({}), customDetectors: [fromExample(ex, 'global')] });
      const settings = data[SETTINGS_KEY] as { customDetectors: CustomDetector[] };
      expect(settings.customDetectors).toHaveLength(1);
      expect(leaks(settings.customDetectors, ex)).toEqual([]);
    }
  });

  it('a detector carrying a raw identifier is left out of storage', async () => {
    const data = mockChrome();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad: CustomDetector = { ...fromExample('AB1234567', 'site'), name: 'mine 123-45-6789' };
    const good = { ...fromExample('AB1234567', 'site'), id: 'good' };
    await saveSite({ v: 1, origin: 'https://example.test', enabled: true, stickers: [], updatedAt: 1, customDetectors: [bad, good] });
    expect((data[siteKey('https://example.test')] as SiteRecord).customDetectors!.map((d) => d.id)).toEqual(['good']);
  });

  it('stored lists are cleaned: unknown fields dropped, at most 50 kept', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...fromExample('AB1234567', 'global'), id: `d${i}`, example: 'AB1234567' }));
    const clean = cleanDetectors(many, 'global');
    expect(clean).toHaveLength(50);
    expect(clean[0].id).toBe('d10');
    expect(JSON.stringify(clean)).not.toContain('AB1234567');
  });
});
