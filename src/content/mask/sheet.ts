/**
 * Page-level stylesheet hooked by the data-aibs-mask attribute. Adopted into
 * the document so page CSS can't accidentally override it, with a <style>
 * fallback when adoptedStyleSheets isn't writable.
 */
export const MASK_ATTR = 'data-aibs-mask';

const CSS = `
[${MASK_ATTR}="text"], [${MASK_ATTR}="text"] * { user-select: none !important; -webkit-user-select: none !important; }
[${MASK_ATTR}="input"] { -webkit-text-security: disc !important; user-select: none !important; -webkit-user-select: none !important; }
[${MASK_ATTR}="input-peek"] { -webkit-text-security: none !important; }
[${MASK_ATTR}="visual"] { visibility: hidden !important; }
`;

let sheet: CSSStyleSheet | null = null;
let style: HTMLStyleElement | null = null;

export function installMaskSheet() {
  ensureMaskSheet();
}

/**
 * Install the mask sheet, or put it back if the page took it away: a script
 * can clear `document.adoptedStyleSheets`, remove our `<style>`, or replace
 * `<html>` wholesale. Cheap enough to call on every mutation batch and on a
 * timer. The properties that actually hide content are also set inline
 * `!important` by the masker; this sheet adds the rest (user-select) and is
 * the first line of defence before the inline styles land.
 */
export function ensureMaskSheet() {
  if (!style) {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
      }
      if (!document.adoptedStyleSheets.includes(sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      return;
    } catch {
      sheet = null;
      /* fall through to a <style> element */
    }
    style = document.createElement('style');
    style.setAttribute('data-aibs', '');
    style.textContent = CSS;
  }
  if (!style.isConnected || style.textContent !== CSS) {
    style.textContent = CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
}

