#!/usr/bin/env node
// Generates the PDF fixtures for tests/e2e/pdf.spec.ts with pdf-lib.
// Every number in them is invented (see README, "Test data").
//
//   fixtures/sample.pdf  two pages: page 1 holds "SSN 123-45-6789" as real
//                        text, page 2 a paragraph.
//   fixtures/other.pdf   one page, different bytes: stickers placed on
//                        sample.pdf must not appear on it.
//
// Output is deterministic (fixed dates and ids), so re-running it only
// changes the files when this script changes.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const out = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const FIXED = new Date('2024-01-01T00:00:00Z');

async function base(title) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  doc.setProducer('make-fixture-pdf');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

async function sample() {
  const { doc, font } = await base('Sticker viewer sample');
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Client intake form', { x: 72, y: 700, size: 22, font });
  p1.drawText('Name: Jordan Example', { x: 72, y: 650, size: 14, font });
  p1.drawText('SSN 123-45-6789', { x: 72, y: 620, size: 14, font, color: rgb(0, 0, 0) });
  p1.drawText('Filing status: single', { x: 72, y: 590, size: 14, font });

  const p2 = doc.addPage([612, 792]);
  p2.drawText('Notes', { x: 72, y: 700, size: 22, font });
  const para = [
    'The client asked for the paper copies to be returned after the',
    'appointment. Bring the signed engagement letter to the next',
    'meeting and confirm the mailing address on file before sending',
    'anything by post.',
  ];
  para.forEach((line, i) => p2.drawText(line, { x: 72, y: 650 - i * 20, size: 13, font }));
  return doc.save({ useObjectStreams: false });
}

async function other() {
  const { doc, font } = await base('Sticker viewer other');
  const p = doc.addPage([612, 792]);
  p.drawText('A different document', { x: 72, y: 700, size: 22, font });
  p.drawText('Nothing to cover here.', { x: 72, y: 650, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

writeFileSync(out('sample.pdf'), await sample());
writeFileSync(out('other.pdf'), await other());
console.log('wrote fixtures/sample.pdf and fixtures/other.pdf');
