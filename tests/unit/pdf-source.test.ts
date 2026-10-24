import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPdfBytes, SourceError, type LoadError } from '@/pdf/source';

/** XHR stand-in: jsdom cannot read file:// URLs, and the point is what loadPdfBytes does with each outcome. */
class FakeXHR {
  static readable = true;
  responseType = '';
  response: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {}
  send() {
    setTimeout(() => {
      if (!FakeXHR.readable) return this.onerror?.();
      this.response = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; // %PDF
      this.onload?.();
    }, 0);
  }
}

function setup(fileAccess: boolean, readable = true) {
  FakeXHR.readable = readable;
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('chrome', {
    extension: { isAllowedFileSchemeAccess: (cb: (allowed: boolean) => void) => cb(fileAccess) },
    permissions: { contains: async () => false },
  });
}

async function failure(src: string): Promise<LoadError['kind'] | 'none'> {
  try {
    await loadPdfBytes(src);
    return 'none';
  } catch (e) {
    return e instanceof SourceError ? e.info.kind : 'none';
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('loadPdfBytes for a file:// link', () => {
  it('asks for "Allow access to file URLs" when the switch is off', async () => {
    setup(false);
    expect(await failure('file:///Users/me/client.pdf')).toBe('file-access');
  });

  it('reports the file itself, not the switch, when access is on but the read fails', async () => {
    setup(true, false);
    expect(await failure('file:///Users/me/moved.pdf')).toBe('file-read');
  });

  it('returns the bytes when access is on and the file is there', async () => {
    setup(true);
    expect(Array.from(await loadPdfBytes('file:///Users/me/client.pdf'))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});
