/**
 * Update notice for unpacked installs. Chrome never auto-updates an unpacked
 * extension, so the background asks GitHub once a day for the latest release
 * and the popup links to it. The request carries no user data: it is an
 * anonymous GET of public release metadata. api.github.com answers with
 * `Access-Control-Allow-Origin: *`, so no host permission is needed.
 */

export const REPO = 'vincent3DArt/ai-blocker-stickers';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const UPDATE_KEY = 'updateCheck';
export const UPDATE_ALARM = 'aibs-update-check';
export const UPDATE_PERIOD_MIN = 24 * 60;

export interface UpdateInfo {
  checkedAt: number;
  /** Newest release version ("0.2.0"), without the leading "v". Absent: no release found. */
  latest?: string;
}

/** Release tags are `v1.2.3` (or `1.2.3`). Anything else, prereleases included, is ignored. */
const VERSION = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;

export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = VERSION.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewer(latest: string | undefined, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The release page, built from the validated version so a response can't point the link elsewhere. */
export function releaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`;
}

/** Normalises a stored record; anything malformed reads as "never checked". */
export function readUpdateInfo(raw: unknown): UpdateInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<UpdateInfo>;
  if (typeof r.checkedAt !== 'number') return undefined;
  const v = parseVersion(r.latest);
  return v ? { checkedAt: r.checkedAt, latest: v.join('.') } : { checkedAt: r.checkedAt };
}

/** The version to offer, or null when the install is current (or nothing is known). */
export function availableUpdate(info: UpdateInfo | undefined, current: string): string | null {
  return info?.latest && isNewer(info.latest, current) ? info.latest : null;
}

/**
 * Asks GitHub for the latest release. A repo with no release yet answers 404,
 * which reads as "nothing newer". Throws on network errors and other
 * statuses (rate limits included), so the caller keeps its previous result.
 */
export async function fetchLatestRelease(fetchFn: typeof fetch = fetch, now = Date.now()): Promise<UpdateInfo> {
  const res = await fetchFn(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (res.status === 404) return { checkedAt: now };
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  const v = body.draft || body.prerelease ? null : parseVersion(body.tag_name);
  return v ? { checkedAt: now, latest: v.join('.') } : { checkedAt: now };
}
