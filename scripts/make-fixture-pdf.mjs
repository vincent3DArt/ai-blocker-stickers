#!/usr/bin/env node
// Generates the PDF fixtures for tests/e2e/pdf.spec.ts with pdf-lib.
// Every number in them is invented (see README, "Test data").
//
//   fixtures/sample.pdf  two pages: page 1 holds "SSN 123-45-6789" as real
//                        text, page 2 a paragraph.
//   fixtures/other.pdf   one page, different bytes: stickers placed on
//                        sample.pdf must not appear on it.
//   fixtures/resume.pdf  one-page resume for tests/e2e/pdf-leak.spec.ts.
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

// A one-page resume (tests/e2e/pdf-leak.spec.ts): a large bold name line
// centred at the top, a contact line, section headings with rules and
// bullet text. The spec measures positions from the text layer.
async function resume() {
  const { doc, font } = await base('Resume');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([612, 792]);
  const centre = (text, f, size, y) => p.drawText(text, { x: (612 - f.widthOfTextAtSize(text, size)) / 2, y, size, font: f });
  centre('JANE Q. EXAMPLE', bold, 26, 730);
  centre('555-0142  |  jane.example@example.com  |  Springfield', font, 11, 708);
  const section = (title, y) => {
    p.drawText(title, { x: 72, y, size: 14, font: bold });
    p.drawLine({ start: { x: 72, y: y - 6 }, end: { x: 540, y: y - 6 }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
  };
  const bullet = (text, y) => p.drawText(`•  ${text}`, { x: 84, y, size: 11, font });
  section('EDUCATION', 660);
  bullet('Bachelor of Science in Applied Widgets, Example State University', 638);
  bullet('Graduated with honours; thesis on reversible paper folding', 622);
  section('EXPERIENCE', 580);
  bullet('Senior Widget Engineer, Placeholder Industries, 2019 to present', 558);
  bullet('Led a team of four building the sprocket inventory service', 542);
  bullet('Junior Widget Engineer, Sample Corp, 2015 to 2019', 520);
  section('SKILLS', 478);
  bullet('Folding, unfolding, refolding', 456);
  return doc.save({ useObjectStreams: false });
}

writeFileSync(out('sample.pdf'), await sample());
writeFileSync(out('other.pdf'), await other());
writeFileSync(out('resume.pdf'), await resume());
console.log('wrote fixtures/sample.pdf, fixtures/other.pdf and fixtures/resume.pdf');
