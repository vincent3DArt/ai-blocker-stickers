/**
 * Catalogue of detectors the user can switch on ("Pick from a list").
 *
 * Entries that name existing detectors (`builtin`) are on by default and map
 * to the ids in patterns.ts; switching one off removes it from suggestions
 * (never from the locked auto-cover). The others carry their own regex,
 * validator and label keywords, are off by default, and run through the same
 * path as user-taught detectors (custom.ts).
 *
 * Tracking numbers are never matched by a catalogue entry (`isTracking`).
 */

import { validDob, type PatternId, type Strength } from './patterns';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Only the entries that name existing detectors are on by default. */
  defaultOn: boolean;
  /** Words a search ("insurance policy numbers") is matched against. */
  synonyms: string[];
  /** Existing detectors this entry stands for. */
  builtin?: PatternId[];
  regex?: string;
  flags?: string;
  strength: Strength;
  /** Label keywords (normalised words) that count as evidence. */
  labels: string[];
  validate?: (m: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, '');
const nDigits = (s: string) => digits(s).length;

const DL_LABELS = ['dl', 'dl number', 'driver license', 'drivers license', 'driver licence', 'drivers licence', 'driving licence', 'license number', 'licence number', 'license no', 'lic'];
const DL_SYNONYMS = ['driver license', 'drivers license', 'driving license', 'license', 'dl', 'state id'];

/** VIN check digit (position 9), North American standard. */
export function validVin(s: string): boolean {
  const v = s.toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v) || !/\d/.test(v) || !/[A-Z]/.test(v)) return false;
  const map: Record<string, number> = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  };
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = v[i];
    sum += (c >= '0' && c <= '9' ? Number(c) : map[c]) * weights[i];
  }
  const check = sum % 11;
  return v[8] === (check === 10 ? 'X' : String(check));
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

/** A date that could be a birth date: a real month and day, a year 1900..now. */
export function validBirthDate(s: string): boolean {
  if (validDob(s)) return true;
  const year = Number((s.match(/\b(19|20)\d{2}\b/) ?? [''])[0]);
  const now = new Date().getFullYear();
  if (!year) {
    // Two-digit year: 12/31/80.
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/);
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31;
  }
  if (year < 1900 || year > now) return false;
  const nums = (s.match(/\d+/g) ?? []).map(Number).filter((n) => n !== year);
  return nums.every((n) => n >= 1 && n <= 31);
}

export function validPhoneUs(s: string): boolean {
  const d = digits(s).replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 && /^[2-9]\d{2}[2-9]/.test(d);
}

const atLeast = (n: number) => (s: string) => nDigits(s) >= n;

export const CATALOG: readonly CatalogEntry[] = [
  // ---- existing detectors (on by default) ----
  {
    id: 'ssn',
    name: 'SSN and ITIN',
    description: 'US Social Security and taxpayer numbers (SSA ranges checked).',
    defaultOn: true,
    synonyms: ['ssn', 'social security', 'itin', 'taxpayer id', 'tax id', 'tin'],
    builtin: ['ssn', 'itin', 'ssn-raw'],
    strength: 'high',
    labels: ['ssn', 'social security'],
  },
  {
    id: 'ein',
    name: 'EIN',
    description: 'Employer identification numbers (IRS prefixes checked).',
    defaultOn: true,
    synonyms: ['ein', 'employer id', 'fein', 'tax id'],
    builtin: ['ein'],
    strength: 'medium',
    labels: ['ein'],
  },
  {
    id: 'bank',
    name: 'Bank account and routing',
    description: 'ABA routing numbers (checksum), account numbers next to a label, IBANs (mod-97).',
    defaultOn: true,
    synonyms: ['bank account', 'account number', 'routing number', 'aba', 'iban', 'bank'],
    builtin: ['routing', 'account', 'iban'],
    strength: 'medium',
    labels: ['account', 'routing'],
  },
  {
    id: 'card',
    name: 'Credit card',
    description: 'Card numbers with a known issuer prefix (Luhn checked).',
    defaultOn: true,
    synonyms: ['credit card', 'debit card', 'card number', 'card', 'visa', 'mastercard', 'amex'],
    builtin: ['card'],
    strength: 'high',
    labels: ['card'],
  },
  {
    id: 'dob',
    name: 'Date of birth (MM/DD/YYYY)',
    description: 'US-style dates next to a birth-date label.',
    defaultOn: true,
    synonyms: ['date of birth', 'dob', 'birthday', 'birth date'],
    builtin: ['dob'],
    strength: 'low',
    labels: ['dob'],
  },
  {
    id: 'masked',
    name: 'Masked last four',
    description: 'Values like ***-**-1234 or â€¢â€¢â€¢â€¢1234.',
    defaultOn: true,
    synonyms: ['last four', 'last 4', 'masked'],
    builtin: ['maskedLast4'],
    strength: 'medium',
    labels: ['ssn', 'account', 'card'],
  },
  // ---- additions (off by default) ----
  {
    id: 'phone-us',
    name: 'Phone number (US)',
    description: '(555) 201-4477, 555-201-4477, +1 555 201 4477.',
    defaultOn: false,
    synonyms: ['phone', 'phone number', 'telephone', 'mobile', 'cell', 'fax'],
    regex: '(?<![\\w-])(?:\\+?1[ .-]?)?(?:\\(\\d{3}\\) ?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}(?![\\w-])',
    strength: 'medium',
    labels: ['phone', 'tel', 'telephone', 'mobile', 'cell', 'fax', 'contact'],
    validate: validPhoneUs,
  },
  {
    id: 'phone-intl',
    name: 'Phone number (international)',
    description: 'Numbers written with a + country code, 8 to 15 digits.',
    defaultOn: false,
    synonyms: ['phone', 'international phone', 'telephone', 'mobile', 'whatsapp'],
    regex: '(?<![\\w+])\\+[1-9]\\d{0,2}(?:[ .-]?\\(?\\d{1,4}\\)?){2,5}(?![\\w-])',
    strength: 'medium',
    labels: ['phone', 'tel', 'telephone', 'mobile', 'cell', 'whatsapp'],
    validate: (s) => nDigits(s) >= 8 && nDigits(s) <= 15,
  },
  {
    id: 'email',
    name: 'Email address',
    description: 'Addresses like pat@example.com anywhere on the page.',
    defaultOn: false,
    synonyms: ['email', 'e mail', 'email address', 'mail'],
    regex: '(?<![\\w.+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63})*\\.[A-Za-z]{2,24}(?![\\w-])',
    strength: 'high',
    labels: ['email', 'e mail'],
  },
  {
    id: 'dob-any',
    name: 'Date of birth (other formats)',
    description: '1980-04-18, 18.04.1980, April 18, 1980, 18 Apr 1980, 4/18/80, next to a birth-date label.',
    defaultOn: false,
    synonyms: ['date of birth', 'dob', 'birthday', 'birth date', 'born'],
    regex:
      `(?<![\\w/.-])(?:\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|\\d{4}-\\d{1,2}-\\d{1,2}|(?:${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4}|\\d{1,2} (?:${MONTHS})[a-z]*\\.? \\d{4})(?![\\w/-])`,
    flags: 'i',
    strength: 'low',
    labels: ['date of birth', 'dob', 'birth date', 'birthdate', 'birthday', 'born', 'bday'],
    validate: validBirthDate,
  },
  {
    id: 'address-us',
    name: 'Street address (US)',
    description: '123 Main Street, Apt 4, next to an address label.',
    defaultOn: false,
    synonyms: ['address', 'street address', 'home address', 'mailing address', 'residence'],
    regex:
      '(?<![\\w-])\\d{1,6} (?:[NSEW]\\.? )?[A-Z][a-z]+(?: [A-Z][a-z]+){0,3} (?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Terrace|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Sq|Square|Trl|Trail)\\b\\.?(?:,? (?:Apt|Suite|Ste|Unit|#) ?[A-Za-z0-9-]{1,6})?',
    strength: 'low',
    labels: ['address', 'street', 'home address', 'mailing address', 'residence', 'residential address'],
  },
  {
    id: 'zip4',
    name: 'ZIP+4',
    description: 'Nine-digit ZIP codes like 94107-1234.',
    defaultOn: false,
    synonyms: ['zip', 'zip code', 'postal code', 'zip plus four'],
    regex: '(?<![\\w-])\\d{5}-\\d{4}(?![\\w-])',
    strength: 'medium',
    labels: ['zip', 'zip code', 'postal', 'postcode'],
  },
  {
    id: 'passport-us',
    name: 'US passport',
    description: 'Nine digits, or a letter and eight digits, next to a passport label.',
    defaultOn: false,
    synonyms: ['passport', 'passport number', 'travel document'],
    regex: '(?<![\\w-])(?:[A-Z]\\d{8}|\\d{9})(?![\\w-])',
    strength: 'low',
    labels: ['passport', 'passport number', 'passport no'],
  },
  // Driver's licences, the ten most populous states (formats as printed).
  { id: 'dl-ca', name: "Driver's licence: California", description: 'A letter and 7 digits (D1234567).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'california', 'ca'], regex: '(?<![\\w-])[A-Z]\\d{7}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-tx', name: "Driver's licence: Texas", description: '8 digits.', defaultOn: false, synonyms: [...DL_SYNONYMS, 'texas', 'tx'], regex: '(?<![\\w-])\\d{8}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-fl', name: "Driver's licence: Florida", description: 'A letter and 12 digits (A123-456-78-901-0).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'florida', 'fl'], regex: '(?<![\\w-])[A-Z](?:\\d{12}|\\d{3}-\\d{3}-\\d{2}-\\d{3}-\\d)(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-ny', name: "Driver's licence: New York", description: '9 digits (123 456 789).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'new york', 'ny'], regex: '(?<![\\w-])\\d{3} ?\\d{3} ?\\d{3}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-pa', name: "Driver's licence: Pennsylvania", description: '8 digits (12 345 678).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'pennsylvania', 'pa'], regex: '(?<![\\w-])\\d{2} ?\\d{3} ?\\d{3}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-il', name: "Driver's licence: Illinois", description: 'A letter and 11 digits (A123-4567-8901).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'illinois', 'il'], regex: '(?<![\\w-])[A-Z](?:\\d{11}|\\d{3}-\\d{4}-\\d{4})(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-oh', name: "Driver's licence: Ohio", description: 'Two letters and 6 digits (AB123456).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'ohio', 'oh'], regex: '(?<![\\w-])[A-Z]{2}\\d{6}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-ga', name: "Driver's licence: Georgia", description: '7 to 9 digits.', defaultOn: false, synonyms: [...DL_SYNONYMS, 'georgia', 'ga'], regex: '(?<![\\w-])\\d{7,9}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-nc', name: "Driver's licence: North Carolina", description: '6 to 12 digits.', defaultOn: false, synonyms: [...DL_SYNONYMS, 'north carolina', 'nc'], regex: '(?<![\\w-])\\d{6,12}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  { id: 'dl-mi', name: "Driver's licence: Michigan", description: 'A letter and 12 digits (A 123 456 789 012).', defaultOn: false, synonyms: [...DL_SYNONYMS, 'michigan', 'mi'], regex: '(?<![\\w-])[A-Z] ?\\d{3} ?\\d{3} ?\\d{3} ?\\d{3}(?![\\w-])', strength: 'low', labels: DL_LABELS },
  {
    id: 'insurance',
    name: 'Insurance policy, group and member numbers',
    description: '6 to 20 letters and digits next to a policy, group or member label.',
    defaultOn: false,
    synonyms: ['insurance', 'policy', 'policy number', 'group number', 'member id', 'member number', 'subscriber id', 'health plan'],
    regex: '(?<![\\w-])[A-Z0-9](?:[A-Z0-9-]{4,18})[A-Z0-9](?![\\w-])',
    flags: 'i',
    strength: 'low',
    labels: ['policy', 'policy number', 'group number', 'group id', 'member id', 'member number', 'subscriber id', 'subscriber number', 'insurance', 'plan id', 'certificate number'],
    validate: atLeast(3),
  },
  {
    id: 'mrn',
    name: 'Medical record number',
    description: '6 to 10 digits, optionally after up to 3 letters, next to an MRN label.',
    defaultOn: false,
    synonyms: ['medical record', 'mrn', 'patient id', 'chart number', 'health record'],
    regex: '(?<![\\w-])[A-Z]{0,3}\\d{6,10}(?![\\w-])',
    strength: 'low',
    labels: ['mrn', 'medical record', 'medical record number', 'patient id', 'patient number', 'chart number'],
  },
  {
    id: 'case',
    name: 'Case, claim and docket numbers',
    description: 'Identifiers like 2:24-cv-01234 or CLM-0098123 next to a case, claim or docket label.',
    defaultOn: false,
    synonyms: ['case number', 'claim number', 'docket', 'case', 'claim', 'file number', 'court'],
    regex: '(?<![\\w-])[A-Z0-9](?:[A-Z0-9:/.-]{3,22})[A-Z0-9](?![\\w-])',
    flags: 'i',
    strength: 'low',
    labels: ['case', 'case number', 'case no', 'claim', 'claim number', 'claim no', 'docket', 'docket number', 'file number'],
    validate: atLeast(3),
  },
  {
    id: 'vin',
    name: 'Vehicle identification number (VIN)',
    description: '17 characters with a valid check digit.',
    defaultOn: false,
    synonyms: ['vin', 'vehicle identification', 'vehicle id', 'car', 'vehicle'],
    regex: '(?<![\\w-])[A-HJ-NPR-Z0-9]{17}(?![\\w-])',
    flags: 'i',
    strength: 'high',
    labels: ['vin', 'vehicle identification number', 'vehicle'],
    validate: validVin,
  },
];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(CATALOG.map((e) => [e.id, e]));

/** Whether an entry is on, given the user's toggles. */
export function catalogOn(e: CatalogEntry, toggles: Readonly<Record<string, boolean>> | undefined): boolean {
  const v = toggles?.[e.id];
  return typeof v === 'boolean' ? v : e.defaultOn;
}

/** Built-in pattern ids the user switched off (suggestions only). */
export function builtinOff(toggles: Readonly<Record<string, boolean>> | undefined): Set<PatternId> {
  const out = new Set<PatternId>();
  for (const e of CATALOG) if (e.builtin && !catalogOn(e, toggles)) e.builtin.forEach((id) => out.add(id));
  return out;
}

// ---- tracking numbers: never a catalogue match ----

const TRACKING = [
  /^1Z[0-9A-Z]{16}$/i, // UPS
  /^(?:94|93|92|95|82)\d{18,20}$/, // USPS
  /^[A-Z]{2}\d{9}[A-Z]{2}$/, // S10 international mail
];

/** The match is a parcel tracking number, or the text right before it says "tracking". */
export function isTracking(match: string, before: string): boolean {
  const compact = match.replace(/[\s-]/g, '');
  if (TRACKING.some((re) => re.test(compact))) return true;
  return /\btracking\b|\bshipment\b|\bwaybill\b/i.test(before.slice(-40));
}

// ---- keyword search ----

function stem(w: string): string {
  let s = w.toLowerCase().replace(/licence/g, 'license').replace(/['â€™]s$/, '');
  s = s.replace(/ies$/, 'y');
  if (!s.endsWith('ss')) s = s.replace(/s$/, '');
  return s.replace(/e$/, '');
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['â€™]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(stem);
}

const STOP = new Set(['number', 'no', 'num', 'id', 'the', 'a', 'an', 'my', 'of', 'and', 'or', 'for', 'code'].map(stem));

/**
 * Catalogue entries for free text such as "insurance policy numbers" or
 * "driver license", best first. A synonym counts when all of its words appear
 * in the query (plurals and licence/license folded); generic words such as
 * "number" or "id" alone never match.
 */
export function findCatalog(query: string): CatalogEntry[] {
  const q = words(query);
  if (!q.length) return [...CATALOG];
  const qs = new Set(q);
  const scored: Array<{ e: CatalogEntry; score: number; i: number }> = [];
  CATALOG.forEach((e, i) => {
    let score = 0;
    for (const syn of [...e.synonyms, e.name]) {
      const sw = words(syn);
      const meaningful = sw.filter((w) => !STOP.has(w));
      if (!meaningful.length) continue;
      if (sw.every((w) => qs.has(w) || STOP.has(w)) && meaningful.every((w) => qs.has(w))) score += meaningful.length * 2;
      else if (meaningful.some((w) => qs.has(w))) score += 1;
    }
    if (score > 0) scored.push({ e, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.e);
}

