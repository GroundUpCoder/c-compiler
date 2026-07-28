# 0380 — Same-origin allowlist relay for github.com (the CORS-free substrate for clone/fetch on gucOS)

- **Status**: open
- **Design**: this file.
- **Provenance**: jku has stated he wants to **git clone a repo, compile it, and run it on
  gucOS**. That makes this a stated goal, not a speculative capability — the no-shortcuts rule
  applies in full. Scoping ruled by the inbox-triage Fable decider **D1**, 2026-07-28,
  annotated by master cont-125.
  ⚠️ **Namespace warning:** this "D1" is the *inbox-triage* decider's D1
  (`~/git/meta/meta/notes/fable-decisions-inbox-triage-2026-07-28.md`). It is **not** the
  cpython-clang board's D1 (overturned) and **not** `0378`'s D-batch. Three unrelated
  D-series exist; never carry a bare "D<n>" across them.

## Goal

Give gucOS an origin it is allowed to talk to, so a real `git clone` (and a plain tarball
fetch) works from inside the tab without CORS.

## The ruled fork — build (b), skip (a)

Two paths were on the table:

- **(a) a GitHub REST API-walk fetcher** — walk the contents API, reassemble a tree.
- **(b) a same-origin Cloudflare Worker / Pages Function relay.**

🔴 **(a) is REFUSED on the record. Do not let a lane re-propose it.** It is the
shortcut-shaped path: it is not a real clone, it inherits GitHub REST rate limits, and it
generalizes to nothing else — building it first just means paying twice. **(b) is the honest
general case:** same-origin from the tab means CORS vanishes, which unlocks true git
smart-HTTP (isomorphic-git) *and* clean codeload tarballs through **one** mechanism.

The usual counterweight — "this puts live infra on the gucOS origin" — is weaker than it
sounds: **gucOS already deploys on Cloudflare Pages**, so a Pages Function relay is in-family
infra, not a new platform to operate.

## Plan

1. **Relay endpoint** on the gucOS origin (Cloudflare Pages Function / Worker), streaming
   passthrough — no buffering of whole repos in the worker.
2. 🔴 **Strict allowlist. This is a hard condition of the GO, not a nicety.** Permit only
   `github.com` git-smart-HTTP endpoints (`/info/refs`, `/git-upload-pack`) and
   `codeload.github.com` tarball/zipball paths. **Never an open proxy** — it runs on a public
   origin, so an unrestricted relay is an abuse liability with our name on it.
3. **Abuse limits** — per-IP rate cap and a response-size ceiling, since the origin is public.
4. Stamp the response headers the tab needs; preserve upstream status and content-type.
5. Wire the gucOS-side fetch through it (the clone/compile/run flow itself is **`0381`**).

## Sequencing

**After the current P0 merge train** (`0375` → `0374` → `0376` → `0377`). Nothing here is
urgent enough to contend with a P0, and `0381` cannot start until this exists.

## Acceptance

- A git-smart-HTTP `info/refs` request for a public repo succeeds **from inside the gucOS
  tab**, asserted by a test — not merely observed by hand.
- A codeload tarball fetch for a public repo succeeds from the tab.
- 🔴 **A POSITIVE-CONTROL pair on the allowlist**: a request to a non-allowlisted host is
  **rejected**, *and* an allowlisted request in the same test run **succeeds**. A rejection
  test alone proves nothing — a relay that rejects everything would pass it (lesson (AZ)).
- Rate-limit and size-ceiling behaviour each covered by a test.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS beside each.

## Notes

`todos/LIABILITIES.md` is machine-checked by the `todos` suite — if a change here rewrites an
anchored line the gate goes RED; re-anchor or retire it in the same commit.
