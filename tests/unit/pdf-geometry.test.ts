import { describe, expect, it } from 'vitest';
import {
  docPath,
  fileNameFromUrl,
  editPad,
  fillRects,
  inkColors,
  looksLikePdfUrl,
  parseSrc,
  redactedFileName,
  sha256Hex,
  viewRectsToPageRects,
  type PageBox,
} from '@/pdf/geometry';
import { isIdLikeSegment, sanitizePathPattern, matchesPath } from '@/shared/url-match';

// A US Letter page (612 x 792 pt) shown at 1.5x, scrolled so it starts at (41, -300).
const letter: PageBox = { box: { x: 41, y: -300, w: 918, h: 1188 }, width: 612, height: 792 };
const second: PageBox = { box: { x: 41, y: 904, w: 918, h: 1188 }, width: 612, height: 792 };

describe('viewRectsToPageRects', () => {
  it('converts viewport px to PDF points from the top-left of the page', () => {
    const [r] = viewRectsToPageRects([{ x: 41 + 108, y: -300 + 237, w: 150, h: 30 }], [letter]);
    expect(r.page).toBe(0);
    expect(r.x).toBeCloseTo(72);
    expect(r.y).toBeCloseTo(158);
    expect(r.w).toBeCloseTo(100);
    expect(r.h).toBeCloseTo(20);
  });

  it('clips to the page and drops what lies outside every page', () => {
    const out = viewRectsToPageRects([{ x: 0, y: -400, w: 100, h: 150 }, { x: 0, y: 890, w: 30, h: 10 }], [letter, second]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ page: 0, x: 0, y: 0 });
    expect(out[0].w).toBeCloseTo((100 - 41) / 1.5);
    expect(out[0].h).toBeCloseTo(50 / 1.5);
  });

  it('splits a rectangle that spans two pages', () => {
    const out = viewRectsToPageRects([{ x: 100, y: 870, w: 60, h: 60 }], [letter, second]);
    expect(out.map((r) => r.page)).toEqual([0, 1]);
    expect(out[0].y + out[0].h).toBeCloseTo(792);
    expect(out[1].y).toBeCloseTo(0);
    expect(out[1].h).toBeCloseTo(26 / 1.5);
  });

  it('handles non-uniform scale (landscape page, rotated in the viewer)', () => {
    const land: PageBox = { box: { x: 0, y: 0, w: 792, h: 612 }, width: 792, height: 612 };
    const [r] = viewRectsToPageRects([{ x: 396, y: 306, w: 10, h: 10 }], [land]);
    expect(r).toMatchObject({ x: 396, y: 306, w: 10, h: 10 });
  });

  it('ignores pages with no size', () => {
    expect(viewRectsToPageRects([{ x: 0, y: 0, w: 10, h: 10 }], [{ box: { x: 0, y: 0, w: 0, h: 0 }, width: 612, height: 792 }])).toEqual([]);
  });
});

describe('fillRects (flattened redaction geometry)', () => {
  it('scales to device px and rounds outward', () => {
    const [f] = fillRects([{ x: 72.3, y: 158.6, w: 100.2, h: 20.1 }], 2, 1224, 1584);
    expect(f).toEqual({ x: 144, y: 317, w: 201, h: 41 });
    // Every corner of the sticker is inside the fill.
    expect(f.x).toBeLessThanOrEqual(72.3 * 2);
    expect(f.x + f.w).toBeGreaterThanOrEqual((72.3 + 100.2) * 2);
    expect(f.y + f.h).toBeGreaterThanOrEqual((158.6 + 20.1) * 2);
  });

  it('clamps to the canvas and drops empty fills', () => {
    const out = fillRects(
      [
        { x: -5, y: -5, w: 20, h: 20 },
        { x: 600, y: 780, w: 50, h: 50 },
        { x: 700, y: 10, w: 5, h: 5 },
      ],
      2,
      1224,
      1584,
    );
    expect(out).toEqual([
      { x: 0, y: 0, w: 30, h: 30 },
      { x: 1200, y: 1560, w: 24, h: 24 },
    ]);
  });
});

describe('file names', () => {
  it('derives <original>-redacted.pdf', () => {
    expect(redactedFileName('report.pdf')).toBe('report-redacted.pdf');
    expect(redactedFileName('Tax Return 2023.PDF')).toBe('Tax Return 2023-redacted.pdf');
    expect(redactedFileName('archive.tar')).toBe('archive.tar-redacted.pdf');
    expect(redactedFileName('my%20file.pdf')).toBe('my file-redacted.pdf');
    expect(redactedFileName('a:b*c?.pdf')).toBe('a_b_c_-redacted.pdf');
    expect(redactedFileName('')).toBe('document-redacted.pdf');
    expect(redactedFileName(undefined)).toBe('document-redacted.pdf');
    expect(redactedFileName('..')).toBe('document-redacted.pdf');
    expect(redactedFileName('C:\\Users\\me\\scan.pdf')).toBe('scan-redacted.pdf');
  });

  it('takes the last path segment of a URL', () => {
    expect(fileNameFromUrl('https://example.com/docs/form.pdf?dl=1#page=2')).toBe('form.pdf');
    expect(fileNameFromUrl('https://example.com/')).toBeUndefined();
    expect(fileNameFromUrl('not a url')).toBeUndefined();
  });
});

describe('document scope key', () => {
  it('spells the hash prefix with letters, which the scope sanitiser keeps', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const p = docPath(hex);
    expect(p).toMatch(/^\/pdf\/[g-v]{16}$/);
    // b->r, a->q, 7->n, 8->o ...
    expect(p.startsWith('/pdf/rqno')).toBe(true);
    const seg = p.split('/')[2];
    expect(isIdLikeSegment(seg)).toBe(false);
    expect(sanitizePathPattern(p)).toBe(p);
    expect(matchesPath(p, p)).toBe(true);
    expect(matchesPath(p, docPath('0'.repeat(64)))).toBe(false);
  });

  it('rejects anything that is not a hex digest', () => {
    expect(() => docPath('xyz')).toThrow();
  });
});

describe('parseSrc', () => {
  it('reads an encoded URL', () => {
    expect(parseSrc('?src=' + encodeURIComponent('https://example.com/a b.pdf?x=1&y=2'))).toBe('https://example.com/a%20b.pdf?x=1&y=2');
  });
  it('reads a raw URL substituted by the redirect rule, own query included', () => {
    expect(parseSrc('?src=https://example.com/f.pdf?x=1&y=2')).toBe('https://example.com/f.pdf?x=1&y=2');
  });
  it('accepts file URLs and refuses other schemes', () => {
    expect(parseSrc('?src=' + encodeURIComponent('file:///C:/docs/x.pdf'))).toBe('file:///C:/docs/x.pdf');
    expect(parseSrc('?src=' + encodeURIComponent('javascript:alert(1)'))).toBeNull();
    expect(parseSrc('?src=chrome://settings')).toBeNull();
    expect(parseSrc('')).toBeNull();
    expect(parseSrc('?other=1')).toBeNull();
  });
  it('recognises PDF links', () => {
    expect(looksLikePdfUrl('https://example.com/x.PDF?dl=1')).toBe(true);
    expect(looksLikePdfUrl('https://example.com/pdf')).toBe(false);
    expect(looksLikePdfUrl('ftp://example.com/x.pdf')).toBe(false);
  });
});

describe('inkColors (live PDF edits)', () => {
  /** w × h RGBA pixels: `ring` everywhere, `ink` at the listed inner pixels. */
  function pixels(w: number, h: number, ring: number[], inkAt: Array<[number, number, number[]]> = []): Uint8ClampedArray {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([...ring, 255], i * 4);
    for (const [x, y, c] of inkAt) px.set([...c, 255], (y * w + x) * 4);
    return px;
  }
  const inner = { x: 2, y: 2, w: 6, h: 4 };

  it('white page with black ink', () => {
    const px = pixels(10, 8, [255, 255, 255], [[3, 3, [0, 0, 0]], [4, 3, [20, 20, 20]]]);
    expect(inkColors(px, 10, 8, inner)).toEqual({ bg: 'rgb(255,255,255)', fg: 'rgb(0,0,0)' });
  });

  it('the most common ring colour wins, and blue ink is kept', () => {
    const px = pixels(10, 8, [200, 200, 200], [[0, 0, [10, 10, 10]], [1, 0, [10, 10, 10]], [5, 4, [20, 40, 220]]]);
    expect(inkColors(px, 10, 8, inner)).toEqual({ bg: 'rgb(200,200,200)', fg: 'rgb(20,40,220)' });
  });

  it('no ink: black on a light page, white on a dark one', () => {
    expect(inkColors(pixels(10, 8, [240, 240, 230]), 10, 8, inner).fg).toBe('rgb(0,0,0)');
    expect(inkColors(pixels(10, 8, [20, 30, 40]), 10, 8, inner).fg).toBe('rgb(255,255,255)');
  });
});

describe('editPad (live PDF edit covers)', () => {
  const line = { x: 72, y: 160, w: 100, h: 14 };
  it('pads by a share of the font size when nothing is near', () => {
    const p = editPad(line, 14, []);
    for (const [k, v] of Object.entries({ t: 1.4, r: 0.7, b: 1.4, l: 0.7 })) expect(p[k as keyof typeof p]).toBeCloseTo(v);
  });
  it('stops short of the lines above and below in tight leading, and of the next word', () => {
    const above = { x: 72, y: 145, w: 120, h: 14.5 }; // ends 0.5pt above the edit
    const below = { x: 80, y: 174.3, w: 50, h: 14 }; // starts 0.3pt below
    const next = { x: 172.2, y: 160, w: 30, h: 14 }; // same line, 0.2pt to the right
    const far = { x: 400, y: 100, w: 30, h: 14 };
    const p = editPad(line, 14, [above, below, next, far]);
    expect(p.t).toBeCloseTo(0.5);
    expect(p.b).toBeCloseTo(0.3);
    expect(p.r).toBeCloseTo(0.2);
    expect(p.l).toBeCloseTo(0.7);
  });
});
