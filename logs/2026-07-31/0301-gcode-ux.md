# #301 — gcode CLI UX assessment: ANSI, colour, scrollback, in gucOS under Playwright

Assessment lane (no fixes here by design — gaps filed as #302–#306). The deliverable is
`tests/browser/os-gcode.mjs` (a permanent sweep file), the screenshot set in
`logs/2026-07-31/0301-gcode-ux/`, and this write-up. Full findings in the ticket's
`## Result`.

## How it was tested (and why this shape)

The canned-SSE fixture from `os/gcode/test/smoke.mjs` was lifted into the browser test:
the same scripted `/v1/messages` SSE server runs in the test process, **plus CORS
handling** — the request comes from the kernel worker (kernel.js defaults to global
`fetch` when the embedder passes no `fetch` opt, kernel-worker passes none), whose origin
is the serve.js port, so the POST to `127.0.0.1:<fixture>` is cross-origin with custom
headers → preflight. No API key anywhere; `ANTHROPIC_BASE_URL` env points gcode at the
fixture.

Interaction is REAL page input throughout (the os-egress rule): typing rides
`page.keyboard` into the focused term window, scrollback rides plain PageUp/PageDown
(term.c:939), the resize is a real SE-corner `page.mouse` drag. Screenshots are taken by
drawImage off the composited canvas (the OffscreenCanvas transfer makes bare
`page.screenshot` blank on VT2).

Gotcha that cost one red run: **term spawns its child with a FIXED env**
(`term.c:2077` — PATH/HOME/TERM only), so `X=1 term gcode` silently drops `X`. The
designed route (0174, noted in the baked `/etc/profile`) is exports in `~/.profile` + the
login shell a bare `term` runs — the test seeds `~/.profile` and types `gcode` at the
windowed hush prompt like a user would.

Second gotcha: typing into gcode before its prompt has rendered garbles the *display*
(the pty echoes keystrokes at the live cursor, interleaved with gcode's banner writes) —
data path stays correct (request bodies carried the full text). The test settles the grid
before each send; the same is true for any real user typing early.

## What works (verified, screenshots numbered)

- **Streaming**: the kernel HTTP transport streams progressively (`resp.body.getReader()`
  pump), SSE deltas render as they arrive. (3)
- **Colour**: SGR 36 cyan tool names and SGR 31 red errors really render in the term grid
  (pixel-scanned, not just asserted). (2, 10)
- **Scrollback is correct**: PageUp walks into history with earlier turns intact (4, 5);
  a >80-col streamed line wraps to three captured-width rows and **survives a live resize
  un-reflowed and uncorrupted** (7 — the per-HistLine captured-width design working as
  specified); any non-scroll key snaps to live (6).
- **Append-only holds**: `/clear` clears the *conversation*, not the screen — history
  stays scrollable. (10)
- **Tool round-trip in-OS**: the bash tool really runs (posix_spawn), `[exit 0]` +
  output round-trips as tool_result with matching id (fixture-verified).
- **VT1 (xterm.js) renders the full intended styling** including SGR 2 dim chrome. (0)

## What does not (filed)

- **#305 (P0)**: the interactive REPL `break`s on any turn error (`gcode.c:1036`) — an
  HTTP 500 dropped gcode back to the hush prompt mid-session. (10)
- **#306 (P0)**: Ctrl+C cannot interrupt an in-flight response in-OS — the veneer's
  `wait_step` retries on EINTR and has no progress callback, so `g_interrupted` is never
  read. Predicted from `os/curl/libcurl.c:200`, then measured: ^C mid-stall, stream ran
  to completion, fixture saw no early close. (8, 9)
- **#304 (P2)**: term.c ignores SGR 2 — gcode's CDIM chrome (its main styling) renders
  as plain full-brightness text in-OS. Compare (0) vs (1).
- **#302 (P2)**: palette gap vs `~/git/chat` ui.py's 8 bold roles; dead `CGRN`; the
  `· bash` line appends to unterminated text; error lines say `code:` not `gcode:`.
- **#303 (P2)**: no `isatty`, no `NO_COLOR` — piped output embeds raw escapes.

## Arm B (real API egress) — measured vs inferred

MEASURED: transport enabled by default in the browser build (kernel-worker passes no
`fetch` opt → bound global fetch); `api.anthropic.com` answers a CORS preflight with
`access-control-allow-origin: *` and allows exactly the headers gcode sends (gcode
already sends `anthropic-dangerous-direct-browser-access: true`). NOT done: a live
conversation — it needs a real key, which must not enter fixtures/logs/screenshots;
stopped per the secrets rule. Verdict: feasible, unexercised by policy; no #155-style
relay is needed for this endpoint.
