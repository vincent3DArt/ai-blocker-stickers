/**
 * Inline SVG icons shared by the popup, the overlay and the PDF viewer.
 * 24-unit grid drawn at 16px with a 1.75 stroke. Built with createElementNS
 * (never innerHTML) so they also work on pages that enforce Trusted Types.
 */

const PATHS = {
  sticker: ['M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z', 'M15 3v4a2 2 0 0 0 2 2h4'],
  pencil: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z', 'm15 5 4 4'],
  rect: ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M7 12h10'],
  textSelect: ['M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1', 'M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5', 'M9 7v10', 'M15 9h6', 'M15 15h6'],
  sparkle: ['M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z', 'M19 14v6', 'M16 17h6'],
  lock: ['M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M7 11V7a5 5 0 0 1 10 0v4'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  trash: ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6'],
  pause: ['M7 4h3v16H7z', 'M14 4h3v16h-3z'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
  settings: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
  chevron: ['m9 6 6 6-6 6'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  expand: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'],
  locate: ['M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'm9 12 2 2 4-4'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 16v-4', 'M12 8h.01'],
  file: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  upload: ['M12 15V3', 'm7 8 5-5 5 5', 'M5 21h14'],
} as const;

export type IconName = keyof typeof PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'grip' ? '3' : '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  for (const d of PATHS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
