# Security review: AI Blocker Stickers

Date: 2026-09-30. Reviewer: automated read-only review. No builds or tests were run.

## Scope

- Manifest: `wxt.config.ts`, and the built production manifest `.output/chrome-mv3/manifest.json` (built 2026-09-20 12:00).
- Background: `src/entrypoints/background.ts`
- Content: `src/entrypoints/content.ts`, `src/content/index.ts`, `src/content/state/store.ts`, `src/content/state/session.ts` (sticker creation only), `src/content/overlay/{host,peek,sticker-view,toolbar}.ts`, `src/content/overlay/styles.css`, `src/content/mask/*`, `src/content/anchor/{fingerprint,context,selector,resolve}.ts`, `src/content/hotkeys.ts`
- Shared: `src/shared/{storage,hmac,messages,types,url-match}.ts`
- Popup: `src/entrypoints/popup/main.ts`
- Bundle: `.output/chrome-mv3/content-scripts/content.js`, `background.js`, `chunks/popup-*.js`
- Supply chain: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`

Threat model (from the plan): the agent is honest and the risk is accidental leakage. The extension must not add a weakness of its own. It must not reveal covered content to anything that could not already read it, and it must not silently drop protection.

Other agents were editing `src` while this review ran. Line numbers match the files as read on 2026-09-30.

## Summary

| ID | Severity | Title |
|----|----------|-------|
| H1 | High | The privacy guard throws on save, so the sticker is silently not persisted and every later save for that site fails too |
| M1 | Medium | Synthetic (untrusted) keyboard and mouse events can trigger peek-all and reveal originals on screen |
| M2 | Medium | Raw attribute values of the covered element are stored (`aria-label`, `placeholder`, `name`, `data-testid`, iframe URL) |
| M3 | Medium | The background trusts any extension sender for `ENABLE_ORIGIN`, `DISABLE_ORIGIN` and `GET_TAB_STATE`, and never validates the origin string |
| M4 | Medium | Script ids collide (`a-b.com` and `a.b.com`), so enabling one site silently drops document_start protection on another |
| L1 | Low | A hostile page can undo visual and input masks and hide stickers, and some of that has no watchdog |
| L2 | Low | Input-mode masks leave `.value` readable in the page world |
| L3 | Low | A synthetic `contextmenu` event can retarget "Cover this element" |
| L4 | Low | Length-preserving bullets and the stored `textLen` leak the length and shape of the secret |
| L5 | Low | The peek card has no `user-select: none`, and CDP pierce can read the closed shadow root while a peek is active |
| L6 | Low | Every content script can read all sites' records and the HMAC key |
| I1–I8 | Info | Verified-OK items and notes, listed at the end |

---

## High

### H1. The privacy guard throws on save, so the sticker is silently not persisted and every later save for that site fails too

**Where**
- `src/shared/storage.ts:25-29` (`saveSite` calls `assertNoCoveredText`, which throws)
- `src/shared/storage.ts:64` (`LEAK_PATTERNS`, including `/\b\d{9,}\b/`)
- `src/content/state/store.ts:80-90` (`scheduleSave` calls `void this.flush()`, so the rejection goes unhandled, and the in-memory record already contains the offending sticker)
- `src/content/state/session.ts:295-296` and `:322`: `scope.pathPattern = defaultPathPattern(location.pathname)` generalises only the **last** segment (`src/shared/url-match.ts:30-36`), and `frame.urlPattern = location.origin + location.pathname` is stored raw
- `src/entrypoints/popup/main.ts:136-153`: the "exact" scope option sends the raw pathname back as `SET_SCOPE`

**Why it matters.** Account and record ids with 9 or more digits in a middle path segment are routine, for example `/accounts/123456789/transactions` or `/clients/100200300/profile`. So are iframe URLs of the same shape, and `data-testid="row-123456789"`, which goes into both `testId` and `cssPath`. Any one of these makes `saveSite` throw. The flow then goes like this:

1. The sticker is visible and works for the rest of the page's life, and the popup lists it as healthy.
2. Nothing is written to storage. The throw leaves `this.record.stickers` holding the bad sticker, so **every later save on that origin also throws**: deletes, re-scopes and new stickers.
3. On the next visit the content is uncovered from first paint, which is the exact leak the product exists to prevent. The user gets no toast, badge or console error they would notice.

**Fix.** Sanitise when the sticker is created, and never let the guard destroy availability. Suggested sketch:

```ts
// url-match.ts: generalise EVERY id-like segment, not only the last
export function defaultPathPattern(pathname: string): string {
  const segs = splitPath(pathname).map((s) => (isIdLikeSegment(s) ? '*' : s));
  return segs.length ? '/' + segs.join('/') : '/';
}
// session.ts: same for frame.urlPattern
urlPattern: depth > 0 ? location.origin + defaultPathPattern(location.pathname) : undefined,

// storage.ts: redact instead of throwing, and report it
export function redactLeaks(rec: SiteRecord): { rec: SiteRecord; redacted: string[] } { /* replace matching
  strings with '' (or drop the optional field), collect paths */ }
export async function saveSite(rec: SiteRecord) {
  const { rec: safe, redacted } = redactLeaks(rec);
  if (redacted.length) console.warn('[aibs] redacted fields before save', redacted);
  await chrome.storage.local.set({ [siteKey(safe.origin)]: safe });
}

// store.ts: never fire-and-forget; surface failure
private scheduleSave() {
  ...
  this.saveTimer = window.setTimeout(() => this.flush().catch((e) => this.onSaveError?.(e)), 0);
}
// Session: onSaveError -> toolbar.toast('Could not save sticker') + TAB_STATUS lostCount/flag so the badge shows '!'
```

Keep `assertNoCoveredText` as a unit-test assertion over fixtures (`tests/unit/privacy.test.ts`), where a throw is the desired outcome.

---

## Medium

### M1. Synthetic (untrusted) keyboard and mouse events can trigger peek-all and reveal originals on screen

**Where:** `src/content/overlay/peek.ts:47-61` (`keydown`, `keyup`, `mousemove` capture listeners on `window`), `src/content/index.ts:144` (pointer tracking), `src/content/hotkeys.ts:14-22`. `isTrusted` is never checked anywhere in `src` (grep finds no hits).

**Why it matters.** Any page script can run `window.dispatchEvent(new KeyboardEvent('keydown', {ctrlKey:true, shiftKey:true, code:'Space'}))`. That includes third-party analytics and ad scripts, and injected content. After `holdDelayMs` (150 ms) every visible sticker drops to `opacity:0` (`.piece.peek`) and a peek card containing the **original text** is drawn in the top layer. Input-mode fields also get `data-aibs-mask="input-peek"`, which lifts `-webkit-text-security`. This lasts until a keyup, blur or the `maxHoldMs` cap (8 s), and the script can re-arm it straight away. An agent that takes a screenshot during that window sees everything. A synthetic `mousemove` can likewise aim single-peek at a chosen sticker. The page already has the data, but the extension should never let untrusted input turn protection off.

**Fix:**

```ts
// peek.ts
on('keydown', (e) => { if (!e.isTrusted || this.mode) return; ... });
on('keyup',   (e) => { if (!e.isTrusted) return; ... });   // a forged keyup can only END a peek, but keep it symmetric
// index.ts
window.addEventListener('mousemove', (e) => { if (e.isTrusted) pointer = { x: e.clientX, y: e.clientY }; }, ...);
```

Apply the same guard to every listener that changes protection state: `contextmenu` (L3), the picker and rect-draw (if they listen on `window` or `document`), and `focusin`.

### M2. Raw attribute values of the covered element are stored

**Where**
- `src/content/anchor/fingerprint.ts:74-78`: `name`, `ariaLabel` (up to 60 chars), `placeholder` (up to 60 chars), stored raw
- `src/content/anchor/selector.ts:42-48`, `:126`: `testId` stored raw and embedded in `cssPath` (including ancestors' test ids)
- `src/content/anchor/selector.ts:70-73`: input `name` and `type` embedded in `cssPath`
- `src/content/state/session.ts:296`, `:322`: iframe `urlPattern` stored raw

**Why it matters.** The masker scrubs exactly these attributes because they leak the covered content into the accessibility tree (`src/content/mask/attr-mask.ts:2`). The fingerprint then persists them to `chrome.storage.local`, which conflicts with the documented privacy invariant in `types.ts`. Some realistic values: `aria-label="Balance $12,345.67"`, `aria-label="Email jane.doe@example.com"`, `placeholder="sk-live-4f9a…"` on a prefilled key field, `data-testid="user-jdoe"`, or an iframe path `/embed/session/eyJhbGciOi…`. `LEAK_PATTERNS` only recognises SSN, EIN, card and long-digit shapes, so all of these pass.

**Fix.** Store a normalised or keyed form and match on the same form. `resolve.ts:209-219` already compares these with plain equality, so an HMAC or a normalised value drops straight in:

```ts
// fingerprint.ts
ariaLabel: normalizeContext(el.getAttribute('aria-label')),      // digits+punct stripped, <= 40
placeholder: normalizeContext(el.getAttribute('placeholder')),
testId: tid && isStableId(tid) ? tid : undefined,                // reuse the id heuristics (rejects \d{4,}, hex runs)
// resolve.ts
if (fp[k] && normalizeContext(el.getAttribute(attr)) === fp[k]) s += W.attr;
```

Alternatively, pre-compute `ariaLabelHmac` with `textHmacOf` during resolution, which already runs async for `textHmac`. Apply `isStableId`-style filtering to `testId` wherever it enters `cssPath`.

### M3. The background trusts any extension sender and never validates the origin string

**Where:** `src/entrypoints/background.ts:100-126` (no `sender` check on `ENABLE_ORIGIN`, `DISABLE_ORIGIN` or `GET_TAB_STATE`) and `:12-25` (`registerOrigin` interpolates `origin` into `matches` without validation).

**Why it matters.** `chrome.runtime.onMessage` receives messages from every extension context, and that includes content scripts running on every enabled origin. Only the popup should be able to enable or disable sites. With today's code, a content script whose isolated world was compromised could do the following:

- Register a broad pattern such as `origin = "*://*"` or `"https://*.example.com"`. Injection is still limited to host permissions already granted, so this does not break the permission model. It does run the script on origins the user never enabled in the product sense.
- `DISABLE_ORIGIN` any other site, which silently removes document_start protection. That is the more realistic impact.
- `injectNow` into an arbitrary `tabId`, and read any tab's `TabState` through `GET_TAB_STATE`.

Separately, a malformed origin makes `registerContentScripts` throw inside the async IIFE. `sendResponse` is then never called and the popup's `await sendMessage` hangs.

**Fix:**

```ts
const POPUP_URL = chrome.runtime.getURL('popup.html');
const fromPopup = (s: chrome.runtime.MessageSender) =>
  s.id === chrome.runtime.id && !s.tab && s.url?.startsWith(POPUP_URL);

function parseOrigin(o: unknown): string | null {
  if (typeof o !== 'string') return null;
  try {
    const u = new URL(o);
    return /^https?:$/.test(u.protocol) && u.origin === o ? u.origin : null;
  } catch { return null; }
}

case 'ENABLE_ORIGIN': {
  if (!fromPopup(sender)) return;
  const origin = parseOrigin(msg.origin);
  if (!origin) { sendResponse({ ok: false }); return; }
  (async () => {
    try {
      if (!(await hasOriginPermission(origin))) throw new Error('no permission');
      await registerOrigin(origin);
      if (typeof msg.tabId === 'number') await injectNow(msg.tabId).catch(() => {});
      sendResponse({ ok: true });
    } catch (e) { sendResponse({ ok: false, error: String(e) }); }
  })();
  return true;
}
// same fromPopup + parseOrigin gate for DISABLE_ORIGIN; GET_TAB_STATE: fromPopup only
```

`reconcile()` should also run `parseOrigin` on `s.origin` read from storage, because storage is writable by content scripts (see L6).

### M4. Script ids collide, so enabling one site can silently drop protection on another

**Where:** `src/entrypoints/background.ts:8-10`: `'aibs-' + origin.replace(/[^a-z0-9]/gi, '_')`.

**Why it matters.** `https://my-bank.com` and `https://my.bank.com` both map to `aibs-https___my_bank_com`, and so do `https://a-b.example.com` and `https://a.b.example.com`. When the second origin is enabled, `registerOrigin` finds the "existing" id and calls `updateContentScripts`, which **replaces** the first site's `matches`. The first site loses its document_start injection, stickers stop being applied before first paint, and the popup still reports the site as enabled. `permissions.onRemoved` for either origin also unregisters both.

**Fix.** Use an injective encoding:

```ts
function scriptId(origin: string): string {
  return 'aibs-' + Array.from(new TextEncoder().encode(origin), (b) => b.toString(16).padStart(2, '0')).join('');
}
```

On upgrade, `reconcile()` should unregister any `aibs-*` id that is no longer produced by an enabled site. You can list them with `getRegisteredContentScripts()`.

---

## Low

### L1. A hostile page can undo masks and hide stickers, and some of that has no watchdog

**Where:** `src/content/overlay/host.ts:122-140` (inline host styles have no `!important`), `src/content/mask/sheet.ts:15-31` (the `installed` flag prevents the sheet from being reinstalled), `src/content/mask/guard.ts:14` (the observer is bound to the original `documentElement`).

Here is what a page can do. It can hide every sticker without removing the host, by adding `aibs-host{display:none!important}` or `opacity:0!important`, because author `!important` beats non-important inline styles. It can clear the mask sheet with `document.adoptedStyleSheets = []`, which undoes `visual` and `input` masks. It can also replace `document.documentElement`, which silently disconnects the MutationObserver. Removing the host, or stripping `aria-hidden` or `data-aibs-mask`, **is** repaired: `Positioner` calls `host.reassert()` on its slow interval, and `Masker.onMutations` re-asserts both attributes. The `setInterval` returns early while `document.hidden`, so in a background tab host re-mounting waits until the tab becomes visible. Text-mode bullets are unaffected by all of this, because they are real DOM rewrites. Originals never reach the page DOM or any page-visible attribute. They exist only in `Masker.records` and `rec.texts`/`rec.attrs` (isolated-world memory) and in the peek card (closed shadow root).

The page owns this data, so the impact is limited. The practical risk is buggy site CSS, such as a reset like `* { opacity: 1 !important }` or a framework that rebuilds `<html>`.

**Fix (cheap hardening):**

```ts
// host.ts: make every declaration important
el.style.cssText = [...].map((d) => d + ' !important').join(';');
// sheet.ts: export ensureMaskSheet() that re-adds the sheet if missing; call it from host.reassert()
if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
// guard.ts: in the slow tick, if (observedRoot !== document.documentElement) { mo.disconnect(); mo.observe(document.documentElement, opts); }
```

### L2. Input-mode masks leave `.value` readable in the page world

**Where:** `src/content/mask/masker.ts:285-292`.

For input mode the mask sets `-webkit-text-security` (visual only), `tabindex=-1` and `aria-hidden`. The field's `.value` is untouched, so any agent that evaluates JS in the page (`document.querySelector('input').value`) or reads DOM properties over CDP gets the plaintext. The accessibility tree is covered by `aria-hidden`. This is a design limitation: rewriting `.value` would break the page's own form. **Fix:** document it in the README threat model. Optionally, offer a "strict" input mode that swaps in a disabled clone showing bullets and moves the real input off-screen with `inert`.

### L3. A synthetic `contextmenu` event can retarget "Cover this element"

**Where:** `src/content/index.ts:272-279`. A page can listen for the user's right-click and immediately dispatch a synthetic `contextmenu` on a decoy element. `contextTarget` then points at the decoy, and the menu covers the wrong element. **Fix:** `if (!e.isTrusted) return;`.

### L4. Length-preserving bullets and stored `textLen` leak the length and shape of the secret

**Where:** `src/content/mask/text-mask.ts:2-4` (each non-space character becomes a bullet and whitespace is kept) and `fingerprint.ts:89` (`textLen`).

`•••••••••••` (11 characters) next to the label "ssn" all but confirms the format. **Fix (optional):** bullets are length-preserving by design for layout stability, so accept this. Alternatively, collapse each whitespace-delimited token to a fixed width inside `display:inline-block` wrappers. Note that `textLen` combined with `textHmac` makes brute force slightly cheaper (see accepted risks).

### L5. The peek card has no `user-select: none`, and CDP pierce reads the closed shadow root while a peek is active

**Where:** `src/content/overlay/styles.css:68-81`.

The card is `aria-hidden`, has `pointer-events:none`, and lives in a **closed** shadow root inside an `aria-hidden` host. Page scripts cannot reach it: `el.shadowRoot` is null, `elementFromPoint` and `caretRangeFromPoint` retarget to `aibs-host`, and a document select-all does not cross the shadow boundary. Two gaps remain. `.peek-card` does not set `user-select:none`, so keyboard selection APIs have nothing explicit stopping them. And an agent using CDP `DOM.getDocument({pierce:true})` or `DOMSnapshot` can read closed shadow roots. The card only exists while the user holds the peek keys, so the exposure is tiny. **Fix:** add `user-select:none; -webkit-user-select:none;` to `.peek-card`. Keep removing cards on `end()`, which the code already does.

### L6. Every content script can read all sites' records and the HMAC key

**Where:** `src/content/state/store.ts:15-24`, `:37-39` and `src/content/index.ts:81-85`.

Content scripts read `chrome.storage.local` directly, which covers every `site:*` record and `secret.hmacKey`. `storage.onChanged` also delivers every site's changes to every content script. If one origin's isolated world were compromised, it could read the structure of every protected site and the key needed to brute-force `textHmac`. **Fix (defense in depth):** move the HMAC key and cross-site reads behind the background, for example `GET_SITE` with the origin taken from `sender.origin` and never from the message body, and `HMAC` requests. Then call `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` if the targeted Chrome version supports it for `local`. This does cost the "no service-worker round trip before first paint" property that `store.ts:5-10` relies on, so it is a trade-off, not a free fix.

---

## Info (verified OK, or notes)

- **I1. The production manifest is clean.** `.output/chrome-mv3/manifest.json` has permissions `storage, scripting, activeTab, contextMenus`, **no `debugger`**, `host_permissions: []`, `optional_host_permissions: ["*://*/*"]`, and **no `externally_connectable`** and no `web_accessible_resources`. The build is dated 2026-09-20 12:00:18, after the last edit to `src/content/index.ts` (11:56). Other agents are still editing, so rebuild with `pnpm build` (not `build:dev`) and recheck before any release. Consider a CI assertion: `jq -e '(.permissions|index("debugger"))==null and (.host_permissions|length)==0' manifest.json`.
- **I2. Dev-only code is stripped.** In the production `content.js`, `TEST_COVER`, `TEST_RECT` and `TEST_STATE` survive only as dead labels (`case\`TEST_COVER\`:return;`). The `document.querySelector(m.selector)` body, the piece geometry dump, `emulateHiddenTab` and `aibsEmulateHidden` are absent, and so are the `4173` fixture origins and `DEV_FIXTURE_ORIGINS` in `background.js`. Optional: wrap the three cases so the labels disappear as well.
- **I3. The WXT runtime shim has a page-reachable listener.** `ContentScriptContext` in the bundle listens on `document` for the CustomEvent `wxt:content-script-started` and posts it with `window.postMessage(..., '*')`. A page can forge it and abort the context's `AbortSignal`. This is harmless today, because `content.ts` ignores `ctx` and `boot()` binds no teardown to it. **Do not** hook masking teardown to `ctx.onInvalidated` or `ctx.signal` without checking `isTrusted` or the event's origin, or a page could switch protection off.
- **I4. No page-to-extension messaging surface.** `src` contains no `postMessage`, `message` listeners, `CustomEvent` handlers, `innerHTML`, `eval` or `new Function` (grep of `src` returns nothing). `chrome.runtime.onMessage` in the content script only receives messages from this extension. `window.__aibsBooted` lives in the isolated world, so a page cannot pre-set it to stop the boot.
- **I5. No popup XSS.** `h()` (`popup/main.ts:8-15`) appends children as strings, which become text nodes, and assigns only fixed property names. Sticker `label`, page-controlled `currentPath` (pages can set it with `history.pushState`) and `pathPattern` reach the DOM only as text nodes, `option.value`, or `title` set as a property. `sticker-view.ts:57` and `toolbar.ts:24,35,61` use `textContent`. No `innerHTML` appears in the source or in any built chunk. Keep `h()` from ever receiving `innerHTML` in `props`.
- **I6. Supply chain.** Zero runtime `dependencies` and 8 `devDependencies` (wxt, vite, vitest, typescript, playwright, jsdom, and two type packages). `pnpm-lock.yaml` is present with about 287 resolved packages, and `onlyBuiltDependencies: [esbuild]` limits install scripts. The bundle contains first-party code plus WXT's generated runtime shim (content-script context and location watcher), with no third-party libraries. Suggested: CI with `pnpm install --frozen-lockfile` and `pnpm audit --prod`, which should be empty.
- **I7. Cross-origin iframes are not masked unless their own origin is enabled.** Registered scripts match `${origin}/*` with `allFrames:true`. A rect sticker drawn over a third-party iframe hides it visually only, and page readers that descend into frames still see the content. Document this in the README.
- **I8. The peek trigger needs a 150 ms hold.** Agents' synthetic key presses (CDP `Input.dispatchKeyEvent`) are trusted but usually release within milliseconds, so accidental peeks by an agent pressing Ctrl+Shift shortcuts are unlikely. That remains true after the M1 fix.

## Accepted risks

1. **The HMAC key is not protectable against local access.** `secret.hmacKey` sits in `chrome.storage.local`, readable by anyone with the profile directory or with code execution as the user. With the key, a 9-digit SSN `textHmac` can be brute-forced in seconds. The HMAC only protects records that leave the machine without the key, such as an export or sync.
2. **A hostile page can defeat or detect the extension.** It can find `aibs-host`, `[data-aibs]` and `[data-aibs-mask]`, strip styles, and so on (L1). The page already owns the data. The threat model is an honest agent.
3. **An agent that runs arbitrary JS or CDP in the page** can read input `.value` (L2), dispatch trusted input, or read closed shadow roots during a peek. That is not an honest agent.
4. **Length and shape leak through bullets** (L4), kept for layout stability.
5. **Label, heading and column context** is stored lowercased, with digits and punctuation stripped, capped at 40 characters. It can still contain words such as a person's name next to a field.
6. **User-entered sticker labels** are stored and drawn as written. The UI warns users to keep them non-sensitive.
7. **Screenshots taken while the user is actively peeking** will show the originals. That is by design.
