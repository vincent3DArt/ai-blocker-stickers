import { defineConfig } from 'wxt';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Port of the e2e fixtures server. Development builds pre-authorise it;
 * FIXTURES_PORT lets a second checkout run its suite next to the first.
 */
const FIXTURES_PORT = /^\d{2,5}$/.test(process.env.FIXTURES_PORT ?? '') ? process.env.FIXTURES_PORT! : '4173';

/** pdf.js data the viewer loads from the package, never from a CDN. */
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
      for (const d of PDFJS_DIRS) {
        for (const abs of filesUnder(join(root, d))) {
          // The PDF-JavaScript sandbox engine: the viewer never runs a PDF's scripts.
          if (/quickjs/i.test(abs)) continue;
          files.push({ absoluteSrc: abs, relativeDest: `pdfjs/${relative(root, abs).replace(/\\/g, '/')}` });
        }
      }
    },
  },
  vite: () => ({
    define: { __AIBS_FIXTURES_PORT__: JSON.stringify(FIXTURES_PORT) },
  }),
  manifest: ({ mode }) => {
    const dev = mode === 'development';
    const fixtures = [`http://127.0.0.1:${FIXTURES_PORT}/*`, `http://localhost:${FIXTURES_PORT}/*`];
    return {
      name: 'AI Blocker Stickers',
      description:
        'Place opaque stickers over sensitive page content. They stay attached to that content and hide it from AI agents (screenshots and page readers).',
      minimum_chrome_version: '120',
      // declarativeNetRequest: the opt-in "Always open PDFs in the sticker
      // viewer" redirect. No rule exists until the user turns it on.
      permissions: ['storage', 'scripting', 'activeTab', 'contextMenus', 'alarms', 'declarativeNetRequest', ...(dev ? ['debugger'] : [])],
      // Lets the AI-session lock see an attached debugger (a CDP-driven agent).
      // Requested from the popup at the first session start; dev builds list it above.
      optional_permissions: dev ? [] : ['debugger'],
      optional_host_permissions: ['*://*/*'],
      // Development builds pre-authorise the local fixtures server so the e2e
      // suite and manual testing don't need the permission prompt.
      host_permissions: dev ? fixtures : [],
      // A redirect rule can only send a navigation to an extension page that
      // is web-accessible. The viewer refuses to run inside a frame.
      web_accessible_resources: [{ resources: ['pdf.html'], matches: ['*://*/*'] }],
      commands: {
        'toggle-edit-mode': {
          suggested_key: { default: 'Alt+Shift+S' },
          description: 'Toggle sticker edit mode on this page',
        },
        'cover-selection': {
          suggested_key: { default: 'Alt+Shift+C' },
          description: 'Cover the current text selection',
        },
      },
    };
  },
});
