import { MAX_CUSTOM_DETECTORS, cleanDetectors, type CustomDetector, type SiteRecord, type Sticker } from '@/shared/types';
import { assertNoCoveredText, cleanDismissed, loadSite, saveSite, siteKey } from '@/shared/storage';
import { frameApplies, scopeApplies, type PathHmacs } from '@/shared/url-match';

/** sessionStorage key of the viewer's memory-only stickers. */
const TAB_MEMORY_KEY = 'aibsTemporaryStickers';

/**
 * Content-script view of the site's sticker record. Reads and writes
 * chrome.storage.local directly (no service-worker round trip, which could be
 * asleep while we race first paint) and reconciles remote edits from the popup
 * or another tab through storage.onChanged.
 */
export class SiteStore {
  private record: SiteRecord;
  private ephemeral = new Map<string, Sticker>();
  /**
   * Stickers the user placed while `remember` was off: memory only (and the
   * tab's memory, see `useTabMemory`), until the page closes. Unlike
   * `ephemeral` (the AI session's auto-covers) they are never counted, kept or
   * dropped at the end of a session.
   */
  private temporary = new Map<string, Sticker>();

  /**
   * False: new stickers stay in `temporary` instead of storage (the PDF viewer,
   * by setting). Turned back on, those stay there until the page closes:
   * saving them then would have every open viewer write at once.
   */
  remember = true;

  /**
   * The PDF viewer: memory-only stickers are also kept in this tab's
   * sessionStorage, so a reload (an agent's, mid-session) still finds them
   * and closing the tab drops them. Read once, at boot.
   */
  useTabMemory(storage: Storage) {
    this.tabMemory = storage;
    try {
      const list = JSON.parse(storage.getItem(TAB_MEMORY_KEY) ?? '[]') as Sticker[];
      for (const s of list) if (typeof s?.id === 'string' && !this.record.stickers.some((r) => r.id === s.id)) this.temporary.set(s.id, s);
    } catch {
      /* unreadable: nothing to restore */
    }
  }
  private tabMemory: Storage | null = null;

  private saveTabMemory() {
    if (!this.tabMemory) return;
    // The same privacy guard as chrome.storage: structure and HMACs only.
    const safe = Array.from(this.temporary.values()).filter((s) => {
      try {
        assertNoCoveredText(s);
        return true;
      } catch {
        return false;
      }
    });
    try {
      if (safe.length) this.tabMemory.setItem(TAB_MEMORY_KEY, JSON.stringify(safe));
      else this.tabMemory.removeItem(TAB_MEMORY_KEY);
    } catch {
      /* quota or blocked: still covered in memory */
    }
  }
  /** `updatedAt` of every write this store made that storage has not echoed back yet. */
  private ownWrites = new Set<number>();
  private saveTimer = 0;
  private listeners = new Set<(rec: SiteRecord) => void>();
  private saveErrorLogged = false;
  /**
   * True while the last save left something out of storage: a write that
   * failed outright, or a sticker the privacy guard would not persist. The
   * in-memory record is kept either way, so the page stays covered.
   */
  saveError = false;
  /** Called whenever `saveError` changes. */
  onSaveStatus: ((error: boolean) => void) | null = null;
  private onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const c = changes[siteKey(this.origin)];
    if (!c) return;
    const next = c.newValue as SiteRecord | undefined;
    if (!next || next.v !== 1) return;
    // Our own write. Compared against every write still in flight, not just
    // the latest: with two saves in flight, the first one's change event would
    // otherwise look remote and roll the record back to its older copy.
    if (next.updatedAt === this.record.updatedAt || this.ownWrites.delete(next.updatedAt)) return;
    this.record = next;
    this.listeners.forEach((l) => l(next));
  };

  private constructor(
    readonly origin: string,
    record: SiteRecord | undefined,
  ) {
    this.record = record ?? { v: 1, origin, enabled: true, stickers: [], updatedAt: 0 };
    chrome.storage.onChanged.addListener(this.onChanged);
    window.addEventListener('pagehide', () => {
      if (this.saveTimer || this.retryTimer) void this.flush();
    });
  }

  static async open(origin: string): Promise<SiteStore> {
    return new SiteStore(origin, await loadSite(origin));
  }

  get all(): Sticker[] {
    return this.record.stickers;
  }

  get enabled(): boolean {
    return this.record.enabled;
  }

  /**
   * Stickers that apply to this frame and path, session-scoped ones included.
   * `hmacs` are the current location's path HMACs (precomputed by
   * Session.load), needed by `exact` scopes and document frames; without
   * them those stickers never apply. Stickers stored without `scope.kind`
   * are pattern scopes, as before.
   */
  active(pathname: string, frameDepth: number, hmacs: PathHmacs = {}): Sticker[] {
    const applies = (s: Sticker) => frameApplies(s.frame, frameDepth, hmacs) && scopeApplies(s.scope, pathname, hmacs);
    return [
      ...this.record.stickers.filter(applies),
      ...Array.from(this.ephemeral.values()).filter(applies),
      ...Array.from(this.temporary.values()).filter(applies),
    ];
  }

  get(id: string): Sticker | undefined {
    return this.ephemeral.get(id) ?? this.temporary.get(id) ?? this.record.stickers.find((s) => s.id === id);
  }

  upsert(sticker: Sticker) {
    for (const memory of [this.ephemeral, this.temporary]) {
      if (!memory.has(sticker.id)) continue;
      memory.set(sticker.id, sticker);
      if (memory === this.temporary) this.saveTabMemory();
      return;
    }
    const i = this.record.stickers.findIndex((s) => s.id === sticker.id);
    if (i >= 0) this.record.stickers[i] = sticker;
    else if (!this.remember) {
      this.temporary.set(sticker.id, sticker);
      return this.saveTabMemory();
    } else this.record.stickers.push(sticker);
    this.scheduleSave();
  }

  /** Held in memory because stickers were not being remembered when it was placed. */
  isTemporary(id: string): boolean {
    return this.temporary.has(id);
  }

  remove(id: string) {
    if (this.ephemeral.delete(id)) return;
    if (this.temporary.delete(id)) return this.saveTabMemory();
    this.record.stickers = this.record.stickers.filter((s) => s.id !== id);
    this.scheduleSave();
  }

  // ---- session-scoped stickers (auto-covered while locked) ----

  /** Kept in memory only: never written to storage unless `keepEphemeral` is called. */
  addEphemeral(sticker: Sticker) {
    this.ephemeral.set(sticker.id, sticker);
  }

  isEphemeral(id: string): boolean {
    return this.ephemeral.has(id);
  }

  /** Session-scoped stickers covered automatically while locked (backstop covers are not counted). */
  get ephemeralIds(): string[] {
    return Array.from(this.ephemeral.values())
      .filter((s) => s.source !== 'backstop')
      .map((s) => s.id);
  }

  /** The user kept the session's auto-covered stickers: they become ordinary stored stickers. */
  keepEphemeral(): string[] {
    const ids = this.ephemeralIds;
    if (!ids.length) return ids;
    // Backstop covers belong to a lost sticker and stay session-only.
    for (const id of ids) {
      const s = this.ephemeral.get(id)!;
      this.ephemeral.delete(id);
      // Not remembering (the PDF viewer, by setting): kept until the page closes, never saved.
      if (this.remember) this.record.stickers.push(s);
      else this.temporary.set(id, s);
    }
    if (this.remember) this.scheduleSave();
    else this.saveTabMemory();
    return ids;
  }

  // ---- auto-suggest ----

  /** Per-site choice, or undefined when the site follows `Settings.scanDefault`. */
  get scanEnabled(): boolean | undefined {
    return typeof this.record.scanEnabled === 'boolean' ? this.record.scanEnabled : undefined;
  }

  get dismissed(): ReadonlySet<string> {
    return new Set(this.record.dismissedSuggestions ?? []);
  }

  dismiss(hmac: string) {
    if (!/^[0-9a-f]{64}$/.test(hmac)) return;
    const list = this.record.dismissedSuggestions ?? [];
    if (list.includes(hmac)) return;
    this.record = { ...this.record, dismissedSuggestions: cleanDismissed([...list, hmac]) };
    this.scheduleSave();
  }

  // ---- custom detectors (scope: this site) ----

  get customDetectors(): CustomDetector[] {
    return this.record.customDetectors ?? [];
  }

  /** Adds (or replaces, by id) a site-scoped detector. Refuses past the cap. */
  addDetector(d: CustomDetector): boolean {
    const list = this.customDetectors.filter((x) => x.id !== d.id);
    if (list.length >= MAX_CUSTOM_DETECTORS) return false;
    this.record = { ...this.record, customDetectors: cleanDetectors([...list, { ...d, scope: 'site', origin: this.origin }], 'site') };
    this.scheduleSave();
    return true;
  }

  removeDetector(id: string) {
    const list = this.customDetectors;
    if (!list.some((d) => d.id === id)) return;
    this.record = { ...this.record, customDetectors: list.filter((d) => d.id !== id) };
    this.scheduleSave();
  }

  subscribe(fn: (rec: SiteRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Coalesce writes that happen in the same task, but no longer than that: a
   * sticker placed and then followed by a reload must already be in storage.
   * A 300 ms debounce lost it, because the timer dies with the document.
   */
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 0);
  }

  /**
   * Persist the record. Never rejects: a failure keeps the record in memory,
   * logs once, and raises `saveError` so the popup and badge can say so.
   * Resolves to true when everything in memory reached storage.
   */
  async flush(): Promise<boolean> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.record = { ...this.record, updatedAt: Math.max(Date.now(), this.record.updatedAt + 1) };
    this.ownWrites.add(this.record.updatedAt);
    if (this.ownWrites.size > 50) this.ownWrites.delete(this.ownWrites.values().next().value!);
    let ok: boolean;
    let writeFailed = false;
    try {
      const { dropped } = await saveSite(this.record);
      ok = dropped.length === 0;
      if (!ok) this.logSaveError(`${dropped.length} sticker(s) could not be stored`);
    } catch (e) {
      ok = false;
      writeFailed = true;
      this.logSaveError(e);
    }
    // A rejected write (quota, a storage hiccup) is retried with backoff
    // until it lands; the record stays in memory and the page stays covered
    // meanwhile. A sticker the privacy guard refuses is not retried: it
    // would be refused again.
    if (writeFailed) this.scheduleRetry();
    else this.clearRetry();
    this.setSaveError(!ok);
    return ok;
  }

  private retryTimer = 0;
  private retryDelay = 0;

  private scheduleRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, 30_000) : 1000;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      void this.flush();
    }, this.retryDelay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.retryDelay = 0;
    this.saveErrorLogged = false;
  }

  private logSaveError(e: unknown) {
    if (this.saveErrorLogged) return;
    this.saveErrorLogged = true;
    console.error('[aibs] could not save stickers for this site', e);
  }

  private setSaveError(v: boolean) {
    if (this.saveError === v) return;
    this.saveError = v;
    this.onSaveStatus?.(v);
  }

  destroy() {
    chrome.storage.onChanged.removeListener(this.onChanged);
    this.listeners.clear();
  }
}
