/**
 * Fetching the PDF the user asked to open. The viewer is an extension page,
 * so a cross-origin fetch needs host permission for the PDF's origin (the
 * optional all-sites host permission, granted per origin); `file://` needs the
 * "Allow access to file URLs" switch on chrome://extensions.
 */

export type LoadError =
  | { kind: 'permission'; origin: string }
  | { kind: 'file-access' }
  | { kind: 'status'; status: number }
  | { kind: 'network'; message: string };

export class SourceError extends Error {
  constructor(readonly info: LoadError) {
    super(info.kind);
  }
}

/** `file://` cannot be fetched with fetch(); XHR still works for an extension allowed file access. */
function readFileUrl(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response ? resolve(xhr.response as ArrayBuffer) : reject(new SourceError({ kind: 'file-access' })));
    xhr.onerror = () => reject(new SourceError({ kind: 'file-access' }));
    xhr.send();
  });
}

export async function originPermitted(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

export async function loadPdfBytes(src: string): Promise<Uint8Array> {
  const url = new URL(src);
  if (url.protocol === 'file:') {
    const allowed = await new Promise<boolean>((r) => chrome.extension.isAllowedFileSchemeAccess(r));
    if (!allowed) throw new SourceError({ kind: 'file-access' });
    return new Uint8Array(await readFileUrl(url.href));
  }
  let res: Response;
  try {
    // No cookies are sent cross-origin without permission anyway; `include`
    // lets a signed-in download open the way it would in a tab.
    res = await fetch(url.href, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  } catch (e) {
    if (!(await originPermitted(url.origin))) throw new SourceError({ kind: 'permission', origin: url.origin });
    throw new SourceError({ kind: 'network', message: e instanceof Error ? e.message : String(e) });
  }
  if (!res.ok) throw new SourceError({ kind: 'status', status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}
