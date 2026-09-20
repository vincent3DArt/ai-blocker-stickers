import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: ({ mode }) => ({
    name: 'AI Blocker Stickers',
    description:
      'Place opaque stickers over sensitive page content. They stay attached to that content and hide it from AI agents (screenshots and page readers).',
    minimum_chrome_version: '120',
    permissions: ['storage', 'scripting', 'activeTab', 'contextMenus', ...(mode === 'development' ? ['debugger'] : [])],
    optional_host_permissions: ['*://*/*'],
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
  }),
});
