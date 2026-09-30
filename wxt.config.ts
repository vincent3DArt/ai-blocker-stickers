import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: ({ mode }) => {
    const dev = mode === 'development';
    return {
      name: 'AI Blocker Stickers',
      description:
        'Place opaque stickers over sensitive page content. They stay attached to that content and hide it from AI agents (screenshots and page readers).',
      minimum_chrome_version: '120',
      permissions: ['storage', 'scripting', 'activeTab', 'contextMenus', 'alarms', ...(dev ? ['debugger'] : [])],
      // Lets the AI-session lock see an attached debugger (a CDP-driven agent).
      // Requested from the popup at the first session start; dev builds list it above.
      optional_permissions: dev ? [] : ['debugger'],
      optional_host_permissions: ['*://*/*'],
      // Development builds pre-authorise the local fixtures server so the e2e
      // suite and manual testing don't need the permission prompt.
      host_permissions: dev ? ['http://127.0.0.1:4173/*', 'http://localhost:4173/*'] : [],
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
