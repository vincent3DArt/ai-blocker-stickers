# Known limitations: what a sticker cannot hide

A sticker hides covered content from screenshots, from the DOM a page script
reads (`innerText`, `textContent`, `outerHTML`, `XMLSerializer`, TreeWalkers,
Ranges, the selection), from the accessibility tree (Playwright
`ariaSnapshot`, CDP `Accessibility.getFullAXTree`), from attributes that
repeat the covered value, and from copy and drag. `tests/e2e/redteam.spec.ts`
checks all of that from the page's own (MAIN) world, the world a browser
agent's injected script runs in.

The channels below stay open. A content script cannot close them, or can only
close them by breaking the page.

## Readable by design (Phase 1)

1. **Input values.** Outside strict mode, `.value`, `FormData`, and CDP
   `Runtime.evaluate` of `.value` all return the real value. The `value`
   *attribute* (the default) is blanked while the input is covered. A covered
   `contenteditable` keeps its text in the DOM, because rewriting it would
   break editing.

   **Strict input masking** (setting `strictInputs`: `locked` by default,
   which means on while the tab is locked by an AI session or detected
   automation; or `always` / `never`) narrows this for covered text fields
   (`text`, `search`, `tel`, `url`, `email`, `password`, `textarea`):
   - The live `.value` holds bullets of the same length. Every script reading
     it gets bullets, and so does CDP (Playwright `inputValue()`,
     `Runtime.evaluate`). The field carries `data-aibs-strict="1"`. The real
     value stays in content-script memory, never in storage.
   - `new FormData(form)` and every native submission get the real value. The
     `formdata` event puts it into the FormData object, and the DOM stays
     masked. A trusted `submit` event also puts it into the field while the
     event propagates. So a submit handler that reads `.value` works, and so
     does any script that builds a FormData. That is by design: the form has
     to submit. A synthetic `submit` or `formdata` event gets nothing.
   - Code that reads `.value` directly outside a submit event gets bullets,
     for example a button handler that `fetch`es the field values. That is the
     point of strict mode, but it also breaks such a page's submission.
   - A value the page writes itself (a framework re-rendering a controlled
     input) becomes the new real value and is masked again. The check runs on
     input and change events, on every mutation batch, and on a 250 ms timer,
     so a page write stays readable for at most that long. What cannot be
     told apart from a real change is a page that reads `.value` (bullets)
     and writes it back or into its own state, as React-style `onChange`
     handlers do. The page's state then holds bullets. This is why strict
     mode is off outside locked sessions by default.
   - While you peek (unlocked, `always` only, because peek is refused while
     locked), the field holds the real value so you can read and edit it.
     Whatever it holds when the peek ends becomes the new real value.
   - Not covered: fields whose `pattern`, email, or URL check the bullets
     would fail (they would block submission), `select`, `contenteditable`,
     and number, date and similar inputs.
   - A settings change can't turn strict mode off while the tab is locked.
     The change takes effect when the lock ends.
2. **Shape.** Bullets keep the length of the text (`•••-••-••••` becomes
   `•••••••••••`), so the length and the word breaks still show.

## Beyond any content script

3. **MutationObserver `oldValue`.** When the page writes raw text into a
   covered node, the extension masks it again in the same microtask, before
   any other task or frame. A MAIN-world observer that sets
   `characterDataOldValue: true` still gets a record for that re-mask write,
   and the record's `oldValue` is the raw text the page just wrote. Any change
   to a node (writing its data, replacing it, removing it) reports the node's
   previous state to every observer of the subtree, transient observers
   included. What such an observer sees at callback time (`target.data`,
   `addedNodes`) is already masked (see the passing channel-12 test), unless
   it was registered before the extension booted: page scripts that run
   before our `document_start` setup finishes get their callbacks first. The
   channel-12 `oldValue` test is `test.fixme` for this reason.
4. **Reads in the same task as the write.** Code that reads a node straight
   after writing raw text into it, in the same task, sees the raw text. Only
   the page's own code can do this, and it already knows the value.
5. **Page state outside the DOM.** The page's JavaScript variables, framework
   state stored on DOM nodes (for example React's `__reactProps$…` and fiber
   objects), `fetch(location.href)` / view-source, network response bodies,
   `performance.getEntriesByType('resource')` (image URLs), and anything else
   the page keeps.
6. **Pixels behind their own API.** Covered `<canvas>` elements (through
   `getImageData`/`toDataURL`), `<video>` frames (drawn onto a canvas) and
   inline `<svg>` markup. A covered `<img>` gets a transparent placeholder in
   place of its `src`/`srcset` (and those of its `<picture>` sources), but the
   original URL is still in resource timing and the network log.
7. **Trusted synthetic input.** Peek only answers trusted keystrokes. Keyboard
   and mouse events that a page script dispatches are ignored. Input
   injected through CDP (`Input.dispatchKeyEvent`/`dispatchMouseEvent`, as
   Playwright and debugger-attached agents do it) is trusted and cannot be
   told apart from a person. An agent like that can hold the peek combo and
   screenshot the original for up to 8 s. While a peek is showing, the peek
   card's text is also inside our closed shadow root, which CDP
   `DOM.getDocument({pierce:true})` can read. Phase 2's AI-session lock
   refuses peeks while a debugger is attached.

## Narrowed, not closed

8. **Attributes.** `title`, `alt`, `aria-label`, `aria-description`,
   `placeholder` and tooltip attributes are always blanked under a covered
   element. So is any other attribute that repeats the covered text, such as
   `data-value`, `aria-valuetext` or `href`. The exceptions stay readable:
   identity and styling hooks (`id`, `class`, `style`, `name`, `for`, `role`),
   `value` on form controls inside a covered element, record-key attributes
   (`data-key`, `data-id`, … on the element or its ancestors; re-anchoring
   after a re-render depends on them), and attributes on ancestors outside
   the covered element. Rect stickers mask text only; they do not scrub
   attributes.
9. **Re-render churn.** A framework can replace the covered element or its
   parent with a fresh, raw copy. If the copy lands in the same mutation
   record, in the same slot with the same tag path and the same content, the
   mask moves to it in that same callback. Other re-renders fall back to the
   resolver (a 50 ms debounced batch), which leaves the copy readable for
   that window. Examples: the removal and the insertion arrive as separate
   records, the value changed, or two identical copies appeared.
10. **Shadow DOM.** Open shadow roots are masked and watched. Closed shadow
    roots are entered only on custom elements (through `chrome.dom`). An
    element sticker inside a shadow root follows in-place re-renders but
    cannot be re-found by selector after a reload.
11. **Frames.** Same-origin frames run their own copy of the content script.
    Cross-origin frames need their origin enabled separately.

## Auto-suggest and the locked auto-cover

12. **Detection is heuristic.** The scanner knows a fixed set of formats
    (SSN, ITIN, EIN, ABA routing, account, IBAN, card, US-style date of
    birth, masked last four). Anything else (passport and licence numbers
    without a matching label, non-US identifiers, numbers in images or
    canvases) is never suggested and never auto-covered. Account numbers,
    bare nine-digit numbers and dates of birth need a label next to them.
    A false negative while locked means that number is not covered: the
    auto-cover adds protection, it is not a guarantee.
13. **Scan limits.** A full scan stops after 20,000 text nodes and a page
    shows at most 200 suggestions. Text inside shadow roots and the text
    content of `<textarea>`/`<select>` elements are not block-scanned (text
    fields are checked by value instead). A number written into a field by
    script, with no `change` event, is seen at the next scan.
14. **Pre-paint has a start-up window.** The locked check runs inside the
    mutation callback, before paint, from the moment the content script has
    read its settings. Content parsed before that (a few milliseconds after
    `document_start`) is covered by the synchronous full pass that runs as
    soon as the script is ready, not before its first paint. A MAIN-world
    `MutationObserver` with `characterDataOldValue` still sees the raw text
    in the record of the masking write (see 3).
15. **Locked over-masks.** While locked, a number inside a long block with
    no tighter element is covered by masking the whole block; on the body
    itself only the matched characters are masked. More than 200 auto-covers
    on one page are masked without an overlay sticker. The per-site
    "Suggest" switch and dismissals do not apply while locked.
16. **Session stickers are in memory.** Auto-covers made during a lock are
    not stored until you keep them at the end of the session. A reload
    during the session drops them and the page is scanned and covered again.
17. **Dismissals.** A dismissal is an HMAC of pattern, element position and
    label. If the page moves the number to a different position, it is
    suggested again.

## Canvas-drawn pages

18. **No DOM text to work on.** Google Docs, Sheets and Slides, Figma,
    Excalidraw, Miro, Lucid, PDF viewers and other canvas or WebGL apps draw
    the document onto a `<canvas>` (or into a plugin). What you read is
    pixels. The scanner, Cover element, Cover selection and text masking
    have nothing to act on. The extension detects these pages (a short list
    of known apps by hostname, otherwise the share of the viewport covered
    by `canvas` / PDF `embed` / `object` against the amount of visible DOM
    text). The popup then explains this, disables Cover element and the
    per-site Suggest switch, and makes Draw rectangle the main action. In
    edit mode the toolbar hides Cover element and Suggestions.
19. **A rectangle covers screenshots only.** On a canvas page a rectangle
    sticker anchors to the canvas (or its wrapper) and follows it through
    reloads and resizes, but it only hides pixels. Nothing in the DOM is
    masked, because nothing there holds the text. The canvas pixels stay
    readable through `getImageData` / `toDataURL` (see 6). Google Docs also
    keeps the document text in its own JavaScript state, sends it over the
    network, and exposes it through the Docs and Drive APIs and its
    screen-reader / braille support mode (which adds an accessible text
    copy of the document to the page). An agent with API access or with
    accessibility mode turned on reads the document directly. That is
    outside any extension's reach.
20. **The locked auto-cover finds nothing.** While locked, a canvas page
    gets no automatic covers. The lock still applies (badge, refusals,
    rectangle stickers stay on), and the audit log records one `canvas-page`
    entry per tab and session, with the origin only and never the path, so
    you can see why nothing was covered.
