# AI Blocker Stickers

**Status:** in testing with one user. Not on the Chrome Web Store.

An AI blocker sticker is an opaque patch you place by hand over a sensitive region of a web page.
It is for people who let an AI agent drive their browser but cannot let it see everything. A tax
preparer, for example, can open a client file and let an agent work in it, while the client's SSN
stays covered. The extension defends in two layers at once. An opaque overlay sits in the browser's
top layer, so screenshot-driven agents see a solid block instead of the number. At the same time the
covered content is rewritten in the real DOM: text nodes become bullets, attributes are blanked, and
the region is marked `aria-hidden`, so page-reading agents get nothing useful either. Each layer
backs up the other. Phase 1 is manual placement only.

## How a sticker stays put

A sticker attaches to content, not to screen coordinates. When you place one, the extension builds a
fingerprint of the covered element. The fingerprint records a stable id or test id, a `name` or role,
a structural CSS path, an XPath, the nearest label, heading, and table context, and a short list of
class tokens. Unstable values are rejected on purpose: generated ids, hashed class names, and
framework prefixes never enter the fingerprint. The element's text is stored only as an HMAC, keyed
by a per-install secret, alongside its length. A row key attribute gets the same treatment. No
covered text is ever written to storage, and a unit test asserts that invariant.

On every mutation batch, navigation, and reload, the extension gathers candidate elements and scores
them. Identity signals outrank position: id, test id, text HMAC, and row-key HMAC carry the most
weight, while XPath, table column, and geometry are deliberately weak. A candidate that matches only
positional signals is discounted further, because a shifted row is a different record sitting in the
old slot. A match is accepted only above a score threshold and with a clear margin over the
runner-up. Close calls are flagged low confidence and marked on the sticker.

If the anchor disappears, the sticker waits out a short grace period for framework re-renders, then
enters the lost state. A lost sticker draws a hatched amber ghost at the remembered rectangle and
never masks anything. It will not cover the wrong content to stay useful. Click the ghost to
re-attach it with the element picker.

Free-drawn rectangles work the same way. At draw time the extension finds the deepest element that
fully contains the rectangle and stores the rectangle as fractions of that element's box, plus the
absolute pixel size and a full fingerprint of the container. Each frame the container is resolved
and the fractions are re-applied. If the container's aspect ratio changes sharply, the sticker falls
back to its pixel size so it does not stretch into nonsense.

## Install (developer)

Prerequisites: Node 20 or newer and pnpm.

```
pnpm install
pnpm build
```

Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and select
`.output/chrome-mv3`.

For a live-reloading dev loop:

```
pnpm dev
```

## Usage

**Enable a site.** Open the popup and click "Enable on this site". The extension asks for host
permission for that origin only. It needs that permission to register a content script that runs at
`document_start`, so stickers are in place before the page first paints. Without it, sensitive
content would be visible for a frame or two on every load.

**Edit mode.** Press `Alt+Shift+S`, or use the popup button. A small toolbar appears.

**Cover element.** Hover to highlight a candidate. Arrow keys expand the selection to the parent or
shrink it back. Click to place the sticker.

**Draw rectangle.** Drag a box over any region. Text under the box is masked too.

**Cover selection.** Select text and press `Alt+Shift+C`. If the selection covers most of one
element, you get an element sticker; otherwise you get a rectangle.

**Right-click.** The context menu offers "Cover this element with a sticker".

**Peek.** Hover a sticker and hold `Ctrl+Shift` to reveal it briefly. `Ctrl+Shift+Space` reveals all
of them. Peeking ends on key release, blur, tab switch, or an 8 second cap. The reveal is drawn
inside the extension's own shadow root. The page DOM stays masked the whole time, so a page reader
still sees bullets while you are peeking.

**Pause.** A popup checkbox pauses protection on the current tab and reveals everything. The toolbar
badge turns red while it is paused.

**AI session lock.** Agents that drive the browser through the DevTools protocol (Claude in Chrome,
Playwright, Puppeteer) send input the page cannot tell from yours. So while a lock is on, nothing
can lift a sticker. Peek is refused. So are edit mode, the picker, rectangles, cover selection,
delete, scope changes, pause, and disabling the site. Stickers stay applied, the toolbar is hidden,
and the badge shows a lock. Weak anchors over-mask: the match threshold drops, and when two
elements tie, both are covered.

The lock comes on in three ways:

- **Debugger attached.** Grant the optional `debugger` permission and the extension checks every
  2 seconds whether a debugger is attached to a tab with stickers. That tab locks until it
  detaches. Opening DevTools on a tab locks it too.
- **`navigator.webdriver`.** A page driven by WebDriver or Playwright locks itself.
- **AI session.** Click "Start AI session" in the popup before you hand the browser to an agent.
  Every tab locks until you click "End session" and confirm. The first start asks for access to all
  sites, so stickers apply everywhere, and for the `debugger` permission. Tick "Keep protection on
  all sites" when you end it to keep the all-sites content script.

The popup's "Lock activity" section shows the last five lock events: session start and end,
auto-lock and unlock, and refused actions. The log keeps 200 entries and records only the origin
and the action, never covered text.

**Scope.** Each sticker is scoped to a URL path pattern. The default replaces an ID-like last
segment with a wildcard, so `/clients/123` becomes `/clients/*`. The popup also offers an exact path
or the whole site.

## What the AI sees

| Mode | Applies to | What happens |
|---|---|---|
| `text` | Elements with text, and rectangles over text | Every non-space character becomes a bullet, so the layout does not reflow. `title`, `alt`, `aria-label`, and `placeholder` are blanked. The root becomes `aria-hidden` and unselectable, and copy, cut, and drag are cancelled. |
| `input` | `input`, `textarea`, `select`, `contenteditable` | Characters render as discs. The field is `aria-hidden`, removed from the tab order, and blurred on focus. Attributes are blanked. The `.value` is left untouched so form submission still works. |
| `visual-only` | `img`, `canvas`, `video`, `svg`, and similar | The element itself is hidden, plus `aria-hidden` and blanked `alt` and `title`, so overlay drift cannot expose pixels. |

A single mutation observer keeps masks in place. When a framework rewrites a masked text node, the
new value is stored and the mask is re-applied in the same microtask, before paint. Originals live
only in content-script memory, in the isolated world, where page scripts cannot reach them.

## Known limitations

1. Input values remain readable via `.value`, `FormData`, and CDP, and in the accessibility tree
   while focused. Only pixels, the a11y node, and the clipboard are blocked.
2. Peek is visible to screenshots while held. It is time-bounded, and the DOM is never unmasked.
3. Length-preserving bullets leak the length of the secret and its word breaks. Every
   non-space character, including punctuation, becomes a bullet, so an SSN shows as eleven bullets.
4. Raw HTML over the network (view-source, a page fetch, debugger response bodies), hidden inputs,
   secrets in the URL or tab title, downloads, Chrome's PDF viewer, and `chrome://` pages are out of
   any extension's reach.
5. Anchoring is heuristic. Virtualised lists that recycle rows can attach to the wrong row. The
   confidence flag and the lost state make that visible.
6. Cross-origin iframes need their own origin enabled. Modal dialogs make the host inert; it renders
   fine, but hover-peek is disabled until the dialog closes.

## Testing

Unit tests run under Vitest:

```
pnpm test
```

End-to-end tests build the extension in development mode, then drive it with Playwright:

```
pnpm e2e
```

The suite launches Microsoft Edge, not Google Chrome. Chrome 137 and later ignore
`--load-extension`, so an unpacked extension cannot be loaded from the command line there. Edge
still honours the switch. Set `AIBS_CHANNEL=chromium` to use Playwright's bundled Chromium instead,
or `AIBS_HEADED=1` to watch the run.

The fixture server on port 4173 starts automatically through Playwright's `webServer` config. The
development build alone pre-authorises `http://127.0.0.1:4173`, so the tests never hit a permission
prompt; production builds request every origin from the user.

Playwright is itself a debugger on every tab and sets `navigator.webdriver`, so the suite would run
permanently locked. The development build honours a storage flag that turns auto-lock off, and the
test fixture sets it. `tests/e2e/lock.spec.ts` clears it to test the lock.

The main anchoring test uses the layout-shift matrix fixture at `fixtures/layout-shift.html`. Its
buttons reproduce each row of the design's layout matrix: insert content above, reorder columns,
swap fonts, toggle a responsive breakpoint, move a cell into a modal, re-render with new class
hashes, and delete a row. After each change the test asserts that the sticker still covers the
target and nothing else.

**Test data.** Every SSN, EIN, and account number in `fixtures/` is invented. None of them is a real
identifier. `pnpm scan` checks the rest of the repository for real-looking numbers, keys, and email
addresses, and CI runs it on every push.

## Roadmap (Phase 2)

- **Auto-suggest scanner.** Idle-chunked scanning for SSN, EIN, routing, account, IBAN, card, and
  date-of-birth patterns, with validators and label keywords, offered as dashed suggestion chips.
- **Strict input masking.** An opt-in mode that swaps `.value` outright and restores it from the
  `formdata` event at submission time.

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use,
modify, and share it for any noncommercial purpose. Commercial use needs written permission from the
author. To ask, open an issue on GitHub.

See [SECURITY.md](SECURITY.md) to report a leak and [CONTRIBUTING.md](CONTRIBUTING.md) to send a
change.
