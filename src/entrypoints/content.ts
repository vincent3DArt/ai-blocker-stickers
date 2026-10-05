import { boot } from '@/content/index';

/**
 * Lift the boot cloak when boot fails before it could. The stylesheet's own
 * 1.5 s animation does the same for a script that never runs, but it only
 * starts with the page's first rendered frame, which a hidden page can be
 * late to produce.
 */
function cloakFailsafe() {
  const root = document.documentElement;
  if (!root) return;
  const cs = getComputedStyle(root);
  // Only our cloak: a page that hides itself on purpose is left alone.
  if (cs.visibility !== 'hidden' || !cs.animationName.split(',').some((n) => n.trim() === 'aibs-uncloak')) return;
  const style = document.createElement('style');
  style.textContent = ':root{visibility:visible!important;animation:none!important}';
  root.appendChild(style);
}

// Registered at runtime per origin by the background script (document_start,
// all frames). In development builds the fixtures origin is registered
// automatically on install.
export default defineContentScript({
  registration: 'runtime',
  main() {
    boot().catch((e) => {
      console.error('[aibs] boot failed', e);
      cloakFailsafe();
    });
  },
});
