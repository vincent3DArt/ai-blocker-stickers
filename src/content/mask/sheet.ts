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

let installed = false;

export function installMaskSheet() {
  if (installed) return;
  installed = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  } catch {
    /* fall through */
  }
  const style = document.createElement('style');
  style.setAttribute('data-aibs', '');
  style.textContent = CSS;
  (document.head ?? document.documentElement).appendChild(style);
}
