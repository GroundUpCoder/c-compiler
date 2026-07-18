# Host ↔ gucOS clipboard bridge (ticket #79, todos/0265)

Bidirectional clipboard sharing between the browser host and gucOS: a host
copy pastes into gucOS, a gucOS copy (`clip`, notepad ^C/^X, term
Ctrl+Shift+C — anything committing the 0090 kernel slot) lands on the host
clipboard.

## The seam

Three layers, one message shape:

- **kernel.js** — the 0090 clipboard is ONE kernel-private slot mutated in
  exactly one place (the CLIP_SET commit), so the "change signal" the ticket
  asked to reuse didn't need inventing: `opts.onClipboard` fires at that
  choke with the new slot (`{fmt, bytes}`, null on clear), AFTER the RPC
  reply so the copying process is never held hostage by the mirror. The
  reverse direction is `Kernel.clipSet(fmt, bytes)` / `clipGet()` — the
  embedder-side twin of a CLIP_SET commit, same last-write-wins semantics,
  and deliberately does NOT fire the hook: a bidirectional bridge that
  echoed its own writes would loop.
- **os/kernel-worker.js** — `{type:'clipboard', text}` both directions.
  Policy lives here: only fmt 1 (UTF-8 text) crosses to the host (fmt 2
  file lists carry OS-absolute paths that mean nothing outside), and OS-side
  clears never blank the HOST clipboard (an EmptyClipboard in gucOS is not
  host intent). Inbound host text lands as a fmt-1 `kernel.clipSet`.
- **os/os.html** — the only layer that touches `navigator.clipboard`, and
  the one that has to be honest about browser policy (secure context,
  document focus, a grantable permission, NO host-clipboard change event):
  - gucOS → host: `writeText` on the commit message. A user-driven gucOS
    copy implies the tab is focused, so this just works; a rejection is
    logged and dropped, never retried (by the time focus returns, the host
    clipboard may be the newer intent).
  - host → gucOS: `readText` on window FOCUS. This is the load-bearing
    design point: to paste into gucOS the user must focus the tab, and
    copying in any other app unfocuses it — so the focus sync lands in the
    kernel slot long before any humanly possible paste chord. The desktop
    paste chords (Ctrl/Cmd+V) also re-read best-effort (async, aims at the
    NEXT paste — reordering input behind a clipboard read would be worse).
    VT1 needs nothing: xterm's native DOM paste already feeds host text
    into the tty as input.
  - `clipSynced` (last text both sides agreed on) de-dups both directions
    and is the loop guard: our own writeText round-trips through the next
    focus read as an identical no-op. When the sides genuinely diverge,
    focus wins — entering the tab imports the host clipboard ("last copy
    wins", with the host copy presumed the fresher intent on arrival).

## Rejected alternatives

- **DOM `copy`/`paste` events** (the synchronous, prompt-free classic):
  dead on arrival here — the desktop canvas preventDefaults every keydown
  (the OS gets the raw keys), which suppresses the browser's paste action,
  and a synchronous `copy` handler can't fetch the slot from a worker.
- **Polling `readText`**: rejected for the same reason FS_WATCH exists —
  the scrub directive says reuse a change signal, and focus IS the signal
  the browser gives us for "the host clipboard may have changed".
- **Retrying failed writeText on refocus**: actively wrong — it would
  clobber whatever the user copied in the host while away.

## Tests

- `tests/kernel/test_hostclip_e2e.js` (in-process Kernel + real C over the
  SDL clipboard API): hook fires once per commit with the committed bytes,
  embedder clipSet reaches `SDL_GetClipboardText` withOUT firing the hook,
  clear reports null. Gotcha: the loop-guard assert must run while the C
  side is PARKED (it polls for a second feed as the go signal) — the first
  version raced the app's next copy and read 3 events instead of 1.
- `tests/browser/os-clipboard.mjs` (real Chromium, permissions granted):
  host→gucOS via a real window-focus dispatch then `clip -o`, gucOS→host
  via `printf | clip` then `readText`, the loop-guard counter, and the VT2
  Ctrl+V chord refresh. The needles arrive from the CLIPBOARD, not the
  typed line — no typed-echo self-satisfaction.

**Honest limit (needs a human/real-browser check, like the 0149
macOS-Chrome keymap step):** headless `grantPermissions` bypasses Chrome's
real clipboard-read permission PROMPT, and Playwright pages are always
"focused" — the user-facing flow (⌘Tab into the tab fires focus → sync;
the one-time prompt on first sync; a deny leaving host→gucOS quietly off
until re-granted) is not exercisable headless. The plumbing on both sides
of those browser gates is what the sweep proves.

## Gate

No bake-relevant change (kernel.js + os runtime JS/page only — image stays
v125; the fixture rebake in the runners is mtime staleness, not content).
kernel 91/91 (test_hostclip_e2e new), sweep 30/30 (os-clipboard new), both
new files stable 3× (kernel leg under load), `tests/flake.js` tripwire
green. compiler.js untouched.
