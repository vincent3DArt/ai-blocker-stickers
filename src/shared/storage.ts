import { normalizeSettings, type Settings, type SiteRecord } from './types';
import { randomKeyB64 } from './hmac';

export const siteKey = (origin: string) => `site:${origin}`;
export const SETTINGS_KEY = 'settings';
export const SECRET_KEY = 'secret';

interface Secret {
  hmacKey: string;
}

export async function loadSite(origin: string): Promise<SiteRecord | undefined> {
  const key = siteKey(origin);
  const res = await chrome.storage.local.get(key);
  const rec = res[key] as SiteRecord | undefined;
  return rec && rec.v === 1 ? rec : undefined;
}

/**
 * Splits a record into what may be persisted and what may not. Each sticker is
 * checked on its own against the privacy guard, so one bad sticker (a raw id
 * that slipped into a selector, say) is left out of the stored copy instead of
 * blocking every other sticker on the site. The record-level fields are
 * checked last; if they fail, the throw is the caller's to surface.
 */
export function sanitizeForSave(rec: SiteRecord): { rec: SiteRecord; dropped: string[] } {
  const dropped: string[] = [];
  const stickers = rec.stickers.filter((s) => {
    try {
      assertNoCoveredText({ ...rec, stickers: [s] });
      return true;
    } catch (e) {
      console.warn('[aibs] sticker left out of storage by the privacy guard', s.id, (e as Error).message);
      dropped.push(s.id);
      return false;
    }
  });
  const safe: SiteRecord = { ...rec, stickers };
  // Dismissals are skipped by the leak scan (HMACs), so only HMAC-shaped entries are kept.
  if (rec.dismissedSuggestions) safe.dismissedSuggestions = cleanDismissed(rec.dismissedSuggestions);
  assertNoCoveredText(safe);
  return { rec: safe, dropped };
}

export const DISMISSED_CAP = 500;

/** HMAC-shaped (64 lowercase hex) entries only, newest `DISMISSED_CAP` kept. */
export function cleanDismissed(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = list.filter((v): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v));
  return out.length > DISMISSED_CAP ? out.slice(out.length - DISMISSED_CAP) : out;
}

/**
 * Writes the record, minus any sticker the privacy guard rejects (their ids
 * are returned). `updatedAt` is the caller's: the content script compares it
 * against the value in storage.onChanged to recognise its own writes, and
 * stamping a second, different timestamp here made every save look like a
 * remote edit and triggered a needless reload of the whole session.
 *
 * Throws only when the record itself (not one sticker) fails the guard, or
 * when storage rejects the write.
 */
export async function saveSite(rec: SiteRecord): Promise<{ dropped: string[] }> {
  const { rec: safe, dropped } = sanitizeForSave(rec);
  const record: SiteRecord = { ...safe, updatedAt: safe.updatedAt || Date.now() };
  await chrome.storage.local.set({ [siteKey(record.origin)]: record });
  return { dropped };
}

export async function listSites(): Promise<SiteRecord[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('site:'))
    .map(([, v]) => v as SiteRecord)
    .filter((r) => r && r.v === 1);
}

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(res[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

/** Returns the per-install HMAC key, creating it on first use. */
export async function loadOrCreateSecret(): Promise<string> {
  const res = await chrome.storage.local.get(SECRET_KEY);
  const existing = res[SECRET_KEY] as Secret | undefined;
  if (existing?.hmacKey) return existing.hmacKey;
  const hmacKey = randomKeyB64();
  await chrome.storage.local.set({ [SECRET_KEY]: { hmacKey } satisfies Secret });
  return hmacKey;
}

/**
 * Runtime guard for the privacy invariant. Stored records may only contain
 * structure, selectors, HMACs, and digit-stripped context. Anything that looks
 * like an SSN, EIN, card or long account number in a stored string is a bug.
 */
const LEAK_PATTERNS = [/\b\d{3}[- ]\d{2}[- ]\d{4}\b/, /\b\d{2}-\d{7}\b/, /\b\d{9,}\b/, /\b(?:\d[ -]?){13,19}\b/];

/**
 * Keys whose value is an HMAC: 64 hex characters, which can contain a long run
 * of digits by chance. Numbers are skipped wholesale: every numeric field is a
 * timestamp, a length or a layout coordinate (an epoch in milliseconds is 13
 * digits, and matching it here used to abort every single save).
 */
const HMAC_KEYS = new Set(['textHmac', 'keyHmac', 'idHmac', 'testIdHmac', 'nameHmac', 'dismissedSuggestions', 'pathHmac', 'urlHmac']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertNoCoveredText(rec: SiteRecord): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      // Sticker ids are random UUIDs, and one whose leading groups happen to
      // be all digits ("36069472-3493-4228-…") reads as a card number to the
      // patterns below: the sticker was silently left out of storage.
      if (UUID.test(value)) return;
      for (const re of LEAK_PATTERNS) {
        if (re.test(value)) {
          throw new Error(`Privacy invariant violated: stored field ${path || 'record'} matches ${re}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        // Only a real HMAC (64 hex) is exempt; anything else under an HMAC key is scanned.
        if (HMAC_KEYS.has(k) && !(typeof v === 'string' && !/^[0-9a-f]{64}$/.test(v))) continue;
        visit(v, path ? `${path}.${k}` : k);
      }
    }
  };
  visit(rec, '');
}
