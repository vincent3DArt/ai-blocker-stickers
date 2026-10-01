import type { SiteRecord, Sticker } from '@/shared/types';
import { cleanDismissed, loadSite, saveSite, siteKey } from '@/shared/storage';
import { matchesPath } from '@/shared/url-match';

/**
 * Content-script view of the site's sticker record. Reads and writes
 * chrome.storage.local directly (no service-worker round trip, which could be
 * asleep while we race first paint) and reconciles remote edits from the popup
 * or another tab through storage.onChanged.
 */
export class SiteStore {
  private record: SiteRecord;
  private ephemeral = new Map<string, Sticker>();
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
      if (this.saveTimer) void this.flush();
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

  /** Stickers that apply to this frame and path, session-scoped ones included. */
  active(pathname: string, frameDepth: number): Sticker[] {
    const applies = (s: Sticker) => s.frame.depth === frameDepth && matchesPath(s.scope.pathPattern, pathname);
    return [...this.record.stickers.filter(applies), ...Array.from(this.ephemeral.values()).filter(applies)];
  }

  get(id: string): Sticker | undefined {
    return this.ephemeral.get(id) ?? this.record.stickers.find((s) => s.id === id);
  }

  upsert(sticker: Sticker) {
    if (this.ephemeral.has(sticker.id)) {
      this.ephemeral.set(sticker.id, sticker);
      return;
    }
    const i = this.record.stickers.findIndex((s) => s.id === sticker.id);
    if (i >= 0) this.record.stickers[i] = sticker;
    else this.record.stickers.push(sticker);
    this.scheduleSave();
  }

  remove(id: string) {
    if (this.ephemeral.delete(id)) return;
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

  get ephemeralIds(): string[] {
    return Array.from(this.ephemeral.keys());
  }

  /** The user kept the session's auto-covered stickers: they become ordinary stored stickers. */
  keepEphemeral(): string[] {
    const ids = this.ephemeralIds;
    if (!ids.length) return ids;
    for (const s of this.ephemeral.values()) this.record.stickers.push(s);
    this.ephemeral.clear();
    this.scheduleSave();
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
    try {
      const { dropped } = await saveSite(this.record);
      ok = dropped.length === 0;
      if (!ok) this.logSaveError(`${dropped.length} sticker(s) could not be stored`);
    } catch (e) {
      ok = false;
      this.logSaveError(e);
    }
    this.setSaveError(!ok);
    return ok;
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
