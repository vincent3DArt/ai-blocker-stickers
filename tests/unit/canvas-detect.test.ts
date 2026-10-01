import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRendering,
  knownCanvasApp,
  measureRendering,
  pageRenderingMode,
  type RenderingOptions,
} from '@/content/detect/canvas-detect';
import type { ViewRect } from '@/shared/types';

const VIEW = { w: 1000, h: 700 };

/**
 * jsdom has no layout: every element is given a box through `data-rect`
 * ("x,y,w,h"), and every text node takes its parent's box.
 */
function rectOf(el: Element): ViewRect {
  const r = el.getAttribute('data-rect');
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  const [x, y, w, h] = r.split(',').map(Number);
  return { x, y, w, h };
}
const textRectsOf = (t: Text): ViewRect[] => {
  const p = t.parentElement;
  return p ? [rectOf(p)] : [];
};
const opts = (extra: Partial<RenderingOptions> = {}) => ({ viewport: VIEW, rectOf, textRectsOf, hostname: 'example.test', pathname: '/', ...extra });

const prose = (n: number, y0 = 0) =>
  Array.from({ length: n }, (_, i) => `<p data-rect="0,${y0 + i * 20},800,18">The quick brown fox jumps over the lazy dog, line ${i}.</p>`).join('');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('pageRenderingMode', () => {
  it('canvas-only page reads canvas', () => {
    document.body.innerHTML = `
      <div data-rect="0,0,1000,700"><canvas data-rect="0,40,1000,640"></canvas></div>
      <p data-rect="0,0,300,20">Quarterly notes</p>`;
    const s = measureRendering(opts());
    expect(s.canvasFraction).toBeGreaterThan(0.85);
    expect(s.textChars).toBeLessThan(20);
    expect(pageRenderingMode(opts())).toBe('canvas');
  });

  it('text-only page reads dom', () => {
    document.body.innerHTML = prose(30);
    expect(measureRendering(opts()).canvasFraction).toBe(0);
    expect(pageRenderingMode(opts())).toBe('dom');
  });

  it('a big canvas beside plenty of text reads mixed', () => {
    document.body.innerHTML = `<canvas data-rect="0,0,1000,400"></canvas>${prose(15, 400)}`;
    const s = measureRendering(opts());
    expect(s.canvasFraction).toBeCloseTo(400 / 700, 2);
    expect(s.textChars).toBeGreaterThan(300);
    expect(pageRenderingMode(opts())).toBe('mixed');
  });

  it('text outside the viewport, hidden text and script text do not count', () => {
    document.body.innerHTML = `
      <canvas data-rect="0,0,1000,700"></canvas>
      <div data-rect="0,900,800,2000">${'Offscreen words '.repeat(100)}</div>
      <div>${'Hidden words '.repeat(100)}</div>
      <script>var a = "${'x'.repeat(2000)}";</script>`;
    expect(measureRendering(opts()).textChars).toBe(0);
    expect(pageRenderingMode(opts())).toBe('canvas');
  });

  it('small canvases (icons, sparklines) are ignored', () => {
    document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<canvas data-rect="${(i % 10) * 100},${Math.floor(i / 10) * 100},40,40"></canvas>`).join('');
    expect(measureRendering(opts()).canvasFraction).toBe(0);
    expect(pageRenderingMode(opts())).toBe('dom');
  });

  it('a PDF embed counts; an object showing an image does not', () => {
    document.body.innerHTML = `<embed type="application/pdf" data-rect="0,0,1000,700">`;
    expect(pageRenderingMode(opts())).toBe('canvas');
    document.body.innerHTML = `<object type="image/png" data="a.png" data-rect="0,0,1000,700"></object>${prose(2)}`;
    expect(pageRenderingMode(opts())).toBe('dom');
    document.body.innerHTML = `<object data="/files/report.pdf" data-rect="0,0,1000,700"></object>`;
    expect(pageRenderingMode(opts())).toBe('canvas');
  });

  it('skips our own overlay', () => {
    document.body.innerHTML = `<canvas id="ours" data-rect="0,0,1000,700"></canvas>`;
    const skip = (n: Node) => n instanceof Element && n.id === 'ours';
    expect(pageRenderingMode(opts({ skip }))).toBe('dom');
  });

  it('known canvas apps short-circuit before measuring', () => {
    document.body.innerHTML = prose(30);
    expect(pageRenderingMode(opts({ hostname: 'docs.google.com', pathname: '/document/d/abc/edit' }))).toBe('canvas');
    expect(pageRenderingMode(opts({ hostname: 'docs.google.com', pathname: '/forms/d/abc' }))).toBe('dom');
  });

  it('classifyRendering thresholds', () => {
    expect(classifyRendering({ canvasFraction: 0.9, textNodes: 3, textChars: 120 })).toBe('canvas');
    expect(classifyRendering({ canvasFraction: 0.9, textNodes: 50, textChars: 2000 })).toBe('mixed');
    expect(classifyRendering({ canvasFraction: 0.2, textNodes: 0, textChars: 0 })).toBe('mixed');
    expect(classifyRendering({ canvasFraction: 0.05, textNodes: 0, textChars: 0 })).toBe('dom');
  });
});

describe('knownCanvasApp', () => {
  it.each([
    ['docs.google.com', '/document/d/1x/edit', true],
    ['docs.google.com', '/presentation/d/1x/edit', true],
    ['docs.google.com', '/spreadsheets/d/1x/edit', true],
    ['docs.google.com', '/document', true],
    ['docs.google.com', '/forms/d/1x', false],
    ['docs.google.com', '/', false],
    ['www.figma.com', '/file/abc', true],
    ['figma.com', '/file/abc', false],
    ['excalidraw.com', '/', true],
    ['miro.com', '/app/board/x', true],
    ['lucid.app', '/lucidchart/x/edit', true],
    ['DOCS.GOOGLE.COM', '/document/d/1x', true],
    ['evil-docs.google.com.example', '/document/d/1x', false],
    ['drive.google.com', '/document/d/1x', false],
  ])('%s %s -> %s', (host, path, want) => {
    expect(knownCanvasApp(host, path)).toBe(want);
  });
});
