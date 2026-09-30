# Security policy

AI Blocker Stickers exists to keep covered content away from automated agents. A way around it is a
security bug, and it should be reported privately.

## What counts as a leak

A leak is any way an automated agent can read content that a sticker covers. That includes, but is
not limited to:

- a screenshot or screen capture that shows covered pixels,
- `innerText`, `textContent`, or other DOM reads that return the original text,
- the accessibility tree exposing covered text or input values outside the known limitations,
- clipboard, drag, or selection paths that carry covered text out,
- a sticker that silently masks the wrong content after a layout change.

The "Known limitations" section of the [README](README.md) lists gaps that are already documented.
A new way to exploit one of them, or a way past one that is marked as blocked, is still welcome.

## How to report

Do not open a public issue. Use GitHub's private reporting instead: go to the repository's
**Security** tab and choose **Report a vulnerability**. This opens a private security advisory that
only the maintainer can see.

Please include the page type, the sticker kind (element, rectangle, or selection), the read channel
that leaked, your Chrome version, and steps to reproduce. Use invented data only. Never send a real
SSN, account number, or other personal identifier.

## What to expect

Response time is best effort. This is a personal project maintained by one person. Confirmed issues
are fixed in the repository, and the reporter is credited in the advisory unless they ask not to be.

## Supported versions

Only the latest commit on the default branch is supported.
