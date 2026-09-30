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
