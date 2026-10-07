#!/usr/bin/env node
// Checks the production build for development-only code: test message names,
// the storage switches that turn auto-lock or scanning off, the fixture
// origins, the hidden-tab emulation and the popup demo mode. Builds nothing: run `pnpm build` first.
//
// Exits 1 and prints file: identifier x count for every hit. No dependencies.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const OUT = '.output/chrome-mv3';
const DENY = [
  'TEST_COVER_SUGGESTIONS',
  'TEST_RESCAN',
  'TEST_COVER',
  'TEST_RECT',
  'TEST_STATE',
  'TEST_SESSION',
  'TEST_FREEZE_OVERLAY',
  'aibsNoScan',
  'aibsNoAutoLock',
  'emulateHidden',
  'aibsEmulateHidden',
  'aibsFailNextSave',
  'aibsFailBoot',
  'bannerButtons',
  'bannerShown',
  '127.0.0.1:4173',
  'localhost:4173',
  // Popup demo mode (src/entrypoints/popup/demo.ts).
  'installDemo',
  'mail.example.com/inbox',
];
const TEXT = /\.(js|mjs|cjs|json|html|css|map|txt)$/i;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(OUT);
} catch {
  console.error(`check-prod-bundle: ${OUT} not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

let hits = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const id of DENY) {
    const n = text.split(id).length - 1;
    if (n) {
      console.error(`${relative('.', file)}: ${id} x${n}`);
      hits++;
    }
  }
}

if (hits) {
  console.error(`\ncheck-prod-bundle: ${hits} development-only identifier(s) in the production build.`);
  process.exit(1);
}
console.log(`check-prod-bundle: ${files.length} files clean (${DENY.length} identifiers checked).`);
