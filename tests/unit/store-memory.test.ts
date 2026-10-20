import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteStore } from '@/content/state/store';
import type { SiteRecord, Sticker } from '@/shared/types';

const ORIGIN = 'chrome-extension://viewer';
const sticker = (id: string) =>
  ({ id, kind: 'element', scope: { pathPattern: '/pdf/abcdefghijklmnop' }, frame: { depth: 0 }, source: 'manual', anchor: {} }) as unknown as Sticker;

let set: ReturnType<typeof vi.fn>;
async function open(stored: Sticker[] = []) {
  set = vi.fn(async () => {});
  const rec: SiteRecord = { v: 1, origin: ORIGIN, enabled: true, stickers: stored, updatedAt: 1 };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get: vi.fn(async () => ({ [`site:${ORIGIN}`]: rec })), set },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return SiteStore.open(ORIGIN);
}
const settle = () => new Promise((r) => setTimeout(r, 30));
let store: SiteStore | undefined;
afterEach(() => store?.destroy());

describe('SiteStore with remember off (PDF viewer, "Remember stickers on PDFs")', () => {
  it('keeps a new sticker in memory only: it applies, but is never written', async () => {
    store = await open();
    store.remember = false;
    store.upsert(sticker('new'));
    await settle();
    expect(store.active('/pdf/abcdefghijklmnop', 0).map((s) => s.id)).toEqual(['new']);
    expect(store.isTemporary('new')).toBe(true);
    expect(set).not.toHaveBeenCalled();
    store.remove('new');
    expect(store.active('/pdf/abcdefghijklmnop', 0)).toHaveLength(0);
  });

  it('still saves changes to, and removals of, stickers that were already saved', async () => {
    store = await open([sticker('saved')]);
    store.remember = false;
    store.remove('saved');
    await settle();
    expect(set).toHaveBeenCalled();
  });

  it('memory-only stickers are not auto-covers: never counted, and keeping auto-covers does not save them', async () => {
    store = await open();
    store.remember = false;
    store.upsert(sticker('mine'));
    expect(store.ephemeralIds).toEqual([]);
    expect(store.keepEphemeral()).toEqual([]);
    await settle();
    expect(set).not.toHaveBeenCalled();
  });

  it('auto-covers kept at the end of an AI session stay in memory too', async () => {
    store = await open();
    store.remember = false;
    store.addEphemeral({ ...sticker('auto'), source: 'session-auto' } as Sticker);
    expect(store.keepEphemeral()).toEqual(['auto']);
    await settle();
    expect(set).not.toHaveBeenCalled();
    expect(store.isTemporary('auto')).toBe(true);
    expect(store.ephemeralIds).toEqual([]);
    expect(store.active('/pdf/abcdefghijklmnop', 0).map((s) => s.id)).toEqual(['auto']);
  });

  it('turned back on, the stickers placed meanwhile stay in memory; new ones are saved', async () => {
    store = await open();
    store.remember = false;
    store.upsert(sticker('meanwhile'));
    store.remember = true;
    store.upsert(sticker('after'));
    await settle();
    expect(store.isTemporary('meanwhile')).toBe(true);
    expect(store.all.map((s) => s.id)).toEqual(['after']);
  });

  /** sessionStorage of one tab. */
  const tabMemory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size } as unknown as Storage & { size(): number };
  };

  it('memory-only stickers are kept in the tab memory: the next page of the tab (a reload) restores them', async () => {
    const mem = tabMemory();
    store = await open();
    store.useTabMemory(mem);
    store.remember = false;
    store.upsert(sticker('placed'));
    store.addEphemeral({ ...sticker('auto'), source: 'session-auto' } as Sticker);
    store.keepEphemeral();
    store.destroy();

    store = await open();
    store.useTabMemory(mem);
    store.remember = false;
    expect(store.active('/pdf/abcdefghijklmnop', 0).map((s) => s.id).sort()).toEqual(['auto', 'placed']);
    expect(store.isTemporary('placed')).toBe(true);
    store.remove('placed');
    store.remove('auto');
    expect(mem.size()).toBe(0);
    await settle();
    expect(set).not.toHaveBeenCalled();
  });

  it('the tab memory leaves out a sticker the privacy guard rejects, and one that is saved meanwhile', async () => {
    const mem = tabMemory();
    store = await open();
    store.useTabMemory(mem);
    store.remember = false;
    store.upsert({ ...sticker('leaky'), label: 'SSN 123-45-6789' } as Sticker);
    store.upsert(sticker('fine'));
    store.destroy();
    store = await open([sticker('fine')]);
    store.useTabMemory(mem);
    expect(store.isTemporary('leaky')).toBe(false);
    expect(store.isTemporary('fine')).toBe(false);
  });

  it('remembers by default', async () => {
    store = await open();
    store.upsert(sticker('kept'));
    await settle();
    expect(set).toHaveBeenCalled();
  });
});
