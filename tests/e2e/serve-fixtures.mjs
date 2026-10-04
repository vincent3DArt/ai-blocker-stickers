// Minimal static server for the fixtures directory. No dependencies, so the
// e2e suite can start it without a build step.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const port = Number(process.env.FIXTURES_PORT ?? 4173);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    // SPA fixture: any /app/* route serves spa.html
    if (pathname.startsWith('/app/')) pathname = '/spa.html';
    // Drive-like fixture: /drive/file/d/<id>/view (and /preview) serve drive.html
    if (/^\/drive\/file\/d\/[^/]+\/(view|preview)$/.test(pathname)) pathname = '/drive.html';
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root)) throw new Error('outside root');
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`fixtures at http://127.0.0.1:${port}/`);
});
