import { boot } from '@/content/index';

// Registered at runtime per origin by the background script (document_start,
// all frames). In development builds the fixtures origin is registered
// automatically on install.
export default defineContentScript({
  registration: 'runtime',
  main() {
    boot().catch((e) => console.error('[aibs] boot failed', e));
  },
});
