/**
 * HMAC-SHA256 with a per-install random key. Used to fingerprint covered text
 * without ever storing it. A plain hash is not enough: the SSN space is small
 * enough to brute-force, an HMAC with a local secret is not.
 */

const enc = new TextEncoder();

export function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
}

export async function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBytes(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(key: CryptoKey, text: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whitespace-collapsed, trimmed, lowercased text used for text fingerprints. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
