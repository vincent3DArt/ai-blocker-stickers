# AI Blocker Stickers

**Status:** in testing with one user. Not on the Chrome Web Store.

An AI blocker sticker is an opaque patch you place by hand over a sensitive region of a web page.
It is for people who let an AI agent drive their browser but cannot let it see everything. A tax
preparer, for example, can open a client file and let an agent work in it, while the client's SSN
stays covered. The extension defends in two layers at once. An opaque overlay sits in the browser's
top layer, so screenshot-driven agents see a solid block instead of the number. At the same time the
covered content is rewritten in the real DOM: text nodes become bullets, attributes are blanked, and
the region is marked `aria-hidden`, so page-reading agents get nothing useful either. Each layer
backs up the other. You place stickers by hand, or accept the ones the extension suggests for
numbers that look sensitive; during an AI session it covers those on its own.

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

**Suggestions.** Once a page has loaded, the extension scans it in idle time for numbers that look
sensitive: SSNs and ITINs, EINs, bank routing and account numbers, IBANs, card numbers, dates of
birth, and masked last-four values such as `***-**-1234`. Every pattern has a validator (SSA number
ranges, the ABA checksum, mod-97 for IBANs, Luhn plus a known issuer prefix for cards), and phone
numbers, ZIP+4 codes, dates, UUIDs, hashes and link targets are ruled out first. A nearby label
("SSN", "Routing", "Account number", a table header, a `<label>`, an `autocomplete` token) raises
a match's score. Numbers split across inline elements are joined before matching. Each suggestion
gets a dashed amber outline and a small chip with **Cover** and **×**. The outline never takes
clicks; only the chip does. Cover turns it into an ordinary element sticker. × dismisses it on this
site for good. The dismissal is stored as an HMAC of the pattern, the element's position and its
label, never the number. In edit mode the toolbar shows "Suggestions (n)" and steps through them.
Text fields are checked by value in memory: every field against the strong patterns, labelled
fields against all of them.

The popup shows how many suggestions the page has, with **Cover all** and **Review**, and a switch
to turn suggestions off for the site. Under **Settings**, "Suggest stickers on new sites" sets the
default and the sensitivity picks the threshold:

- *Labeled only*: only numbers right next to a matching label.
- *Balanced* (default): strong patterns (SSN format, ITIN, card, IBAN) on their own; EIN, routing
  and masked numbers with any nearby label; bare nine-digit numbers, account numbers and dates of
  birth only next to their label.
- *Aggressive*: EIN, routing and masked numbers without a label too.

A page shows at most 200 suggestions, and a scan stops after 20,000 text nodes. Chunks stay under
the browser's long-task limit, visible content is scanned first, and changed content is rescanned
750 ms after it settles.

**During an AI session.** While a tab is locked, no suggestion or chip is ever drawn. Every
detection at or above the balanced threshold is covered at once instead, as a session sticker,
whether or not suggestions are on for the site. Content that arrives while locked is checked inside
the mutation callback that reports it, before the browser can paint it: strong patterns always, and
every pattern when the block already shows a keyword label. This does not depend on animation frames
or tab visibility, so it works in a background tab an agent drives. Session stickers live in memory
only. When you end the session, the popup asks "Keep N auto-covered stickers?". OK (the default)
stores them like any other sticker; Cancel removes them once the lock is off. The popup lists them
as "Auto-covered" in the meantime.

**Scope.** Each sticker is scoped to a URL path pattern or to one exact page. Record ids are
generalised by default, so `/clients/123` becomes `/clients/*`. A path that names a document (a
Google Drive/Docs id, a UUID, long hex) or a known document host (Drive, Docs, SharePoint, Dropbox,
Box, Notion, HubSpot) defaults to "This page only", stored as an HMAC of the path, never the path
itself. The popup offers This page only, Pages like this, This section and Whole site. A sticker
placed inside an in-page viewer that keeps the page's URL (Drive's file preview) also remembers an
HMAC of that document's first-page text and applies only while the same document is open there.

## PDFs

Chrome's built-in PDF viewer can't be scripted, so no extension can put a sticker on it. The
extension ships its own viewer, built on pdf.js, and stickers work there.

**Opening a PDF.** Any of these works:

- On a tab showing a PDF, open the popup and click **Open in sticker PDF viewer**. The popup asks
  for access to that site, because the viewer has to download the file again.
- Right-click a link to a `.pdf` and choose **Open PDF link in sticker viewer**.
- Under **Settings → PDFs**, tick **Always open PDFs in the sticker viewer**. Top-level navigations
  to an http(s) URL ending in `.pdf` then open in the viewer. This needs access to all sites, and
  the redirect rule only exists while the option is on.
- In the viewer, use **Open file…** or drop a PDF onto the page.

For a local `file://` PDF opened by link, turn on **Allow access to file URLs** for the extension in
`chrome://extensions`. Without it the viewer says so, and **Open file…** still works.

**Stickers in the viewer.** Each page is drawn to a canvas, and pdf.js's text layer sits on top of
it, so the page has real DOM text. The usual engine runs in the viewer: **Cover element** on a line
of text masks it and covers its glyphs, **Draw rectangle** covers any region (images, scans,
signatures), suggestions and the locked-session auto-cover work on the text layer, and peek and the
AI-session lock behave as on any site. **Remove stickers** clears the document's stickers (refused
while locked). Stickers belong to one document: they are keyed by the first
16 hex digits of the file's SHA-256, so they come back when you open the same file again, from any
URL or from disk, and never appear on a different file.

**Download redacted PDF.** The toolbar button builds a new file, named `<original>-redacted.pdf`.
By default every page is re-rendered at twice its size, the stickers are painted into the pixels as
solid black, and the image becomes the whole page. That is a real redaction: the new file has no
text layer, fonts, links, form fields, metadata or attachments from the original, so nothing under a
sticker can be copied or extracted. The cost is a larger file and text you can no longer select
anywhere on the page, as the toolbar note says. The download is assembled in the page and saved
with a link, so the extension needs no `downloads` permission.

**Keep text outside stickers (vector)** draws black boxes over the original pages instead, without
flattening. It is *not* a redaction: the text under each box stays in the file and can still be
selected, copied and extracted. It is off by default and refused while the tab is locked.

**What the viewer stores and sends.** It downloads the PDF you opened and nothing else: pdf.js's
worker, CMaps, standard fonts and image decoders are packaged with the extension, and none of them
is fetched from a CDN. Storage gets the document key and the stickers' geometry. The file name,
the URL and the document's text are never stored.

## What the AI sees

| Mode | Applies to | What happens |
|---|---|---|
| `text` | Elements with text, and rectangles over text | Every non-space character becomes a bullet, so the layout does not reflow. `title`, `alt`, `aria-label`, and `placeholder` are blanked. The root becomes `aria-hidden` and unselectable, and copy, cut, and drag are cancelled. |
| `input` | `input`, `textarea`, `select`, `contenteditable` | Characters render as discs. The field is `aria-hidden`, removed from the tab order, and blurred on focus. Attributes and the default value are blanked. Outside strict mode the live `.value` is left untouched. With **strict input masking** (on while the tab is locked, by default), a text field's `.value` reads back as bullets of the same length, while `FormData` and form submission still get the real value. |
| `visual-only` | `img`, `canvas`, `video`, `svg`, and similar | The element itself is hidden, plus `aria-hidden` and blanked `alt` and `title`, so overlay drift cannot expose pixels. |

A single mutation observer keeps masks in place. When a framework rewrites a masked text node, the
new value is stored and the mask is re-applied in the same microtask, before paint. Originals live
only in content-script memory, in the isolated world, where page scripts cannot reach them.

## Known limitations

1. Input values. Outside strict mode, a covered field's value stays readable via `.value`,
   `FormData`, and CDP. Only pixels, the a11y node, the default value, and the clipboard are
   blocked. **Strict input masking** swaps the live `.value` of covered text fields (`text`,
   `search`, `tel`, `url`, `email`, `password`, `textarea`) for bullets of the same length. The
   real value stays in content-script memory. It goes back into `FormData` through the `formdata`
   event, into the field for the length of a real `submit` event, and into the field while you
   peek. Forms still submit the real value. The setting is under **Settings** in the popup:
   *While locked* (default) turns it on only during an AI session or detected automation;
   *Always* and *Never* do what they say. You cannot weaken it while locked. Caveats:
   - `new FormData(form)` and submit handlers still see the real value, on purpose.
   - Code that reads `.value` directly to send it (a fetch-style submit) gets bullets.
   - A value the page writes into the field is taken as the new real value and masked again.
     A page that reads `.value` and stores it (common in React controlled inputs) stores bullets
     in its own state. That is why strict mode is off outside locked sessions by default.
   - Fields where bullets would fail a `pattern`, email, or URL check are left as they are, so
     they don't block submission. So are `select`, `contenteditable`, and number or date inputs.
     The popup counts the fields that are strict right now.
2. Peek is visible to screenshots while held. It is time-bounded, and the DOM is never unmasked.
3. Length-preserving bullets leak the length of the secret and its word breaks. Every
   non-space character, including punctuation, becomes a bullet, so an SSN shows as eleven bullets.
4. Raw HTML over the network (view-source, a page fetch, debugger response bodies), hidden inputs,
   secrets in the URL or tab title, downloads, Chrome's PDF viewer, and `chrome://` pages are out of
   any extension's reach. Open a PDF in the extension's own viewer to sticker it (see [PDFs](#pdfs));
   the original file is still on the server or the disk, and an agent can fetch that.
5. Anchoring is heuristic. Virtualised lists that recycle rows can attach to the wrong row. The
   confidence flag and the lost state make that visible.
6. Cross-origin iframes need their own origin enabled. Modal dialogs make the host inert; it renders
   fine, but hover-peek is disabled until the dialog closes.
7. Canvas apps (Google Docs, Sheets and Slides, Figma, Excalidraw, Miro, Lucid, PDF viewers, WebGL
   apps) draw their text as pixels, so there is no DOM text to scan, cover by element, or mask. The
   popup says so and offers **Draw rectangle**, which hides the region from screenshots only. An
   agent can still read such a document through the app's own APIs or accessibility mode. While
   locked, the audit log records `canvas-page` (origin only) to explain why nothing was
   auto-covered. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md#canvas-drawn-pages).
8. PDF vector mode is not a redaction. **Keep text outside stickers (vector)** only draws boxes on
   top of the page; the covered text stays in the file and can be copied or extracted. Only the
   default, flattened download removes it. A flattened page is an image: larger, and not
   searchable. A sticker that is lost when you download is not redacted; the viewer warns first.
9. PDFs from `file://` links need **Allow access to file URLs** in `chrome://extensions`, and PDFs
   from a site need access to that site. **Always open PDFs in the sticker viewer** only catches
   URLs whose path ends in `.pdf`; a PDF served from another URL, or embedded in a page, still opens
   in Chrome's viewer. Pages with more than pdf.js's text-span limit, scanned PDFs (no text layer:
   use Draw rectangle) and rotated text are covered less precisely than plain text.

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
prompt; production builds request every origin from the user. To run a second checkout's suite at
the same time, set `FIXTURES_PORT` (for example `4180`) for both the development build and
Playwright.

`tests/e2e/pdf.spec.ts` opens `fixtures/sample.pdf` in the viewer, covers the SSN in its text layer
and a paragraph with a rectangle, downloads the redacted file and checks with pdf.js in Node that it
has two pages and no text, then that the region is black in its pixels, that the stickers return
for the same file and not for `fixtures/other.pdf`. `node scripts/make-fixture-pdf.mjs` regenerates
both PDFs (deterministically).

Playwright is itself a debugger on every tab and sets `navigator.webdriver`, so the suite would run
permanently locked. The development build honours a storage flag that turns auto-lock off, and the
test fixture sets it. `tests/e2e/lock.spec.ts` clears it to test the lock.

The fixture also turns the auto-suggest scanner off with a second development-only flag, so the
other suites see no chips and no auto-covers. `tests/e2e/suggest.spec.ts` turns it back on. It
checks the suggestions on `static.html`, that `fixtures/fp-corpus.html` (phones, dates, ZIP+4
codes, order and tracking numbers, UUIDs) gets none, that a locked SPA route is covered before
its SSN can be read, and that `fixtures/big-table.html` (5000 generated rows) scans with no long
task in under 2 seconds. `tests/unit/detect.test.ts` measures precision and recall on a labelled
corpus built from the fixtures.

The main anchoring test uses the layout-shift matrix fixture at `fixtures/layout-shift.html`. Its
buttons reproduce each row of the design's layout matrix: insert content above, reorder columns,
swap fonts, toggle a responsive breakpoint, move a cell into a modal, re-render with new class
hashes, and delete a row. After each change the test asserts that the sticker still covers the
target and nothing else.

**Test data.** Every SSN, EIN, and account number in `fixtures/` is invented. None of them is a real
identifier. `pnpm scan` checks the rest of the repository for real-looking numbers, keys, and email
addresses, and CI runs it on every push.

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use,
modify, and share it for any noncommercial purpose. Commercial use needs written permission from the
author. To ask, open an issue on GitHub.

See [SECURITY.md](SECURITY.md) to report a leak and [CONTRIBUTING.md](CONTRIBUTING.md) to send a
change.
