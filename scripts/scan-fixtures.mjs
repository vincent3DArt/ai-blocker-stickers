#!/usr/bin/env node
// Scans the repository for real-looking secrets and personal data.
//
// Tracked and untracked (not ignored) files are checked for SSN-shaped numbers that are
// not on the known-fake allowlist, API-key-like strings, and email addresses
// other than GitHub noreply and reserved example domains. Files under fixtures/ and tests/ are expected to
// hold invented identifiers, so there only API keys and tokens are checked.
//
// Exits 1 and prints file:line for every hit. No dependencies.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FAKE_IDS = new Set([
  '123-45-6789',
  '987-65-4321',
  '111-22-3333',
  '000-00-0000',
  '444-55-6666',
  '12-3456789',
]);

const EXCLUDED = [/^node_modules\//, /^\.output\//, /^\.wxt\//, /^pnpm-lock\.yaml$/];
const TEST_DATA = [/^fixtures\//, /^tests\//];
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|zip|crx|pdf)$/i;

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN = /\b\d{2}-\d{7}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// GitHub noreply, plus the reserved example domains from RFC 2606 / RFC 6761.
const NOREPLY = /@(users\.noreply\.github\.com|example\.(com|org|net)|[\w.-]+\.(example|test|invalid|localhost))$/i;
const KEY_PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub token', re: /\bgh[po]_[A-Za-z0-9]{20,}/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'hex secret', re: /(?:key|token|secret)[\w-]*["']?\s*[:=]?\s*["']?[0-9a-fA-F]{32,}/gi },
];

function listFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  });
  return [...new Set(out.split('\0').filter(Boolean))];
}

function scanLine(line, testData) {
  const hits = [];
  for (const { name, re } of KEY_PATTERNS) {
    for (const m of line.matchAll(re)) hits.push(`${name}: ${m[0].slice(0, 12)}...`);
  }
  if (testData) return hits;
  for (const re of [SSN, EIN]) {
    for (const m of line.matchAll(re)) {
      if (!FAKE_IDS.has(m[0])) hits.push(`SSN/EIN-shaped number: ${m[0]}`);
    }
  }
  for (const m of line.matchAll(EMAIL)) {
    if (!NOREPLY.test(m[0])) hits.push(`email address: ${m[0]}`);
  }
  return hits;
}

let failures = 0;
let scanned = 0;
for (const file of listFiles()) {
  if (EXCLUDED.some((re) => re.test(file)) || BINARY_EXT.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted but still in the index
  }
  if (text.includes('\0')) continue;
  scanned++;
  const testData = TEST_DATA.some((re) => re.test(file));
  text.split(/\r?\n/).forEach((line, i) => {
    for (const hit of scanLine(line, testData)) {
      console.error(`${file}:${i + 1}: ${hit}`);
      failures++;
    }
  });
}

if (failures) {
  console.error(`\nscan-fixtures: ${failures} finding(s). Replace real data with invented values.`);
  process.exit(1);
}
console.log(`scan-fixtures: ${scanned} files clean.`);
