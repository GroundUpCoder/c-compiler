# The clipboard seam — deferred CLIP_GET at the kernel slot + VT1 OSK tty clipboard

Two shipped defects, one root cause (design: the uniform-clipboard design pass;
greenlit as a bug fix): synthetic/mobile paste never produces a native DOM
`paste` event, so the host-clipboard read had to go through the async Clipboard
API — and the old bridge "aimed at the NEXT paste" (a chord-keydown
`clipFromHost()` racing the app's CLIP_GET), making the FIRST paste stale by
construction on VT2; and VT1's OSK had no clipboard keys at all while hiding
the keystrip (a phone's only paste affordance).

## Landing 1 — park the CONSUMER, not the input

`kernel.js` grew `opts.onClipRead(done)`, the inbound twin of `onClipboard`: a
DATA read of the slot (CLIP_GET `off 0`, `peek 0`) parks the caller on
`pcb.waiter = {op:'clipget'}` (the HTTP_STATUS/ttyread pattern) and fires the
hook; `done()` re-checks the waiter (exit-while-parked, double-done) and serves
from the possibly-just-refreshed slot via the extracted `_clipServe`.
`kernel-worker.js` implements the hook as a page round-trip
(`{type:'clip-read'}` → the page's `{type:'clipboard'}` update, FIFO-ordered →
`{type:'clip-read-done'}`), with a 300ms freshness window (the
size-probe-then-read pair in `SDL_GetClipboardText` costs ONE round-trip) and a
10s timeout backstop keeping the always-done contract. `os.html`'s `clip-read`
handler runs `clipFromHost` **inside the still-live transient activation** of
the keystroke/tap that triggered the paste, gated on
`navigator.userActivation.isActive` (gesture-less consumers like a scripted
`clip -o` get an immediate done → cached slot, no prompt spam). The two
aim-at-next-paste hacks (canvas keydown KeyV, OSK sendWmKey wrapper) are
DELETED; the window-focus sync stays (keeps the slot warm for menu graying).

Key ordering, repeat, modifier tracking, VT1 `\x16`: untouched — the pasting
app just blocks one host round-trip like any blocking read, and every consumer
(notepad EDIT chord AND menu, term Ctrl+Shift+V AND Edit▸Paste, `clip -o`,
NetSurf `gui_get_clipboard`) gets consume-time freshness with zero per-app
code.

**Peek vs read.** `SDL_HasClipboardText` used the same `__clip_get(fmt,0,0)`
probe a real read starts with — under the seam, every term Edit-menu open
(mi_paste graying) and every WM_INITMENUPOPUP `IsClipboardFormatAvailable`
would have parked on a host refresh (on iOS: a paste callout per menu open).
New primitive `__clip_has(fmt)` (compiler.js `__SDL.c` + host.js + a `peek`
flag on the CLIP_GET RPC) always serves the cached slot. **Found during the
consumer census:** `fileops.h fo_clip_has()` (fileman/wm.c Paste-gate for
fmt-2 file lists) had the same probe shape and is now a peek too — without
that, every context-menu open would have parked.

## Landing 2 — VT1 OSK tty clipboard

`osk.js` tty backend: Ctrl+Shift+C/V now run the page-injected `ttyClip`
handlers (the extracted keystrip Copy/Paste gesture path: selection/
`clipSynced` export; `readText` → slot → `term.paste`) instead of folding
Ctrl+Shift+V to `\x16` — the fidelity fix mirroring every real terminal
(keys.h KCTX_TERM already encodes the chord). Plain Ctrl+V stays literal-next.
The Fn layer grew Copy/Paste legends (row 2, alongside Ins/Del/Home/End —
discoverability for users who'd never guess the chord on a soft keyboard);
they are TTY-ONLY and render dimmed+inert on the wm backend, because VT2 has
no app-agnostic paste chord (the focused app's own contract governs — a
"Paste" key injecting Ctrl+V into a terminal would type literal-next, and
"Copy"→Ctrl+C would SIGINT; that's the per-surface-affordance trap the design
rejected). `setVt` calls the new `oskComp.refresh()` so the dim state tracks
the VT. The "OSK is a superset of the keystrip" comment is finally TRUE and
now says so; the new keys are `.oskkey` class members, so they inherit the
class-level `touch-action: manipulation` guard (the one legitimate OSK-side
guard — `#osk` is a sibling of `#vtbar`, not a descendant).

## Verification

- `test_hostclip_e2e.js` new phases: parked first read serves the hook-fed
  slot; exactly 4 deferred reads for two GetClipboardText calls with the peek
  contributing ZERO; SIGKILL-while-parked tears down; late done() is a no-op.
  Phase 1 (no hook) unchanged — the pre-seam path is byte-identical.
- `os-clipboard.mjs` rewrote the two superseded aim-at-next-paste legs into
  seam legs: host copy with NO focus event → ONE Ctrl+V into notepad → `wmctl
  gettext` shows the new text on the FIRST paste; an OSK leg drives real
  mouse taps (synthetic probes carry no activation).
- `os-vt1mobile.mjs`: OSK Ctrl+Shift+C/V, the `<paste>`-not-`\x16` sent-log
  assert, one-shot mod consumption, Fn legends live-on-tty/dim-on-wm,
  keystrip restore.
- **A/B vs the unpatched baseline (stash-run-unstash, same harness, 3 runs):**
  the OSK-tap first paste FAILS 3/3 on baseline (pastes the stale slot text)
  and passes patched — deterministic outcome-level proof. The physical-chord
  first paste happens to PASS on baseline in headless (pre-granted permission
  makes `readText` ~1ms and it wins the race 3/3); the race only reliably
  loses where the read is slow (iOS callout, first-time permission prompt),
  which headless cannot reproduce — there the patched build is fresh by
  ORDERING, proven by the `__osClipRead` mechanism probe (baseline fails it
  3/3). Also green: clipboard/fileman-ops/calc/term/user32/recycle kernel
  e2es, the host suite, os-osk.mjs.

## Deploy note (for the merge)

Newly baked binaries import `__clip_has`; a client running a CACHED old
host.js against the new image would fail instantiation on the missing import.
host.js/kernel.js/os.html/kernel-worker.js/osk.js must deploy together with
(or before) the image — the known static-asset cache-lag gap applies.

## Deliberate non-goals (unchanged from the design)

Rich clipboard formats; win32 delayed rendering; re-plumbing VT1 tty paste
through the slot (page-side byte injection is the right layering); suppressing
platform paste-permission UI (it now surfaces AT paste time, which is the
fix, not a leak).

## Needs the on-device session (not headlessly verifiable)

1. iOS paste-callout raise + resolution timing from the parked-CLIP_GET read
   (VT2 notepad/term paste; the 10s backstop covers a wedged callout).
2. Whether a chord/tap-driven copy's `writeText` echo succeeds inside the
   activation window on iOS Safari (expected yes; the strip Copy retry stays
   as the manual fallback either way).
3. BT hardware-keyboard Cmd+V on iOS Safari reaching xterm as a native paste.
4. Android Chrome equivalents of 1–3.

## Post-gate addendum — the OSK Ctrl+V leg exposed a pre-existing user32 bug

The rewritten (no-longer-vacuous) OSK leg failed on @master's gate run with a
literal `v` in the EDIT: the paste chord decomposed. Probe evidence
(page-side `__osOskSent` log perfect in every round, real AND synthetic taps;
identical failure on a prebaked BASE worktree at 4bc04fc4): PRE-EXISTING, not
a lane regression — the old leg's `check(..., true)` assertion had hidden it.

Root cause: `pump_sdl` drains every pending SDL event in one loop, stamping
the ONE global `g_mod` per event while messages queue; a starved worker
(load, slow box) drains a whole `[Ctrl dn, V dn, V up, Ctrl up]` chord in one
wake, so `g_mod` is 0 by the time the queued `WM_KEYDOWN V` reaches
`TranslateMessage` → WM_CHAR 'v', not the 0x16 paste fold. Idle boxes get
one event per wake and never see it; under load it hit 80% of runs.

Fix (the existing `g_lastSym` pattern, and real Windows semantics — key
state changes as the thread reads key messages): `QMsg` carries the SDL
modifier word as of enqueue and `q_get` restores it per retrieved message,
so TranslateMessage, GetKeyState-driven accelerators and EDIT chords see
their own event's state. Flake gate: os-clipboard.mjs 1/5 → 5/5 stable
under load ×10.

Also hardened: `.oskkey` joined os-vt1mobile's enumerated TOUCH_MANIP table
(the class guard the Copy/Paste legends inherit was asserted nowhere).
