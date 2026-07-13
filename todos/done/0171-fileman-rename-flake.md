# 0171 — VT1-typed command flows flake under load (os-fileman ~33%, os-doom ~12-37%; pre-existing at 23315f1)

- **Status**: done (2026-07-13)
- **Design**: — (found during 0167's gates, 2026-07-13; evidence in
  logs/2026-07-13/0167-vsync-shim-browser.md; root cause + fix in
  logs/2026-07-13/0171-tty-stranding.md)

## Resolution (2026-07-13) — TWO product bugs

1. **Kernel tty: canonical edit-buffer stranding** (the wedge class),
   reproduced headless (browser exonerated): `Tty.setattr` STRANDED the
   canonical `_line` edit buffer across a cooked→raw switch, so a typed
   line straddling hush's between-reads cooked window and lineedit's raw
   entry lost its head — the tail executed alone, and an unbalanced-quote
   tail wedged hush in PS2 continuation forever (the captured "echo alive,
   reader dead"). Fixed in kernel.js: ICANON on→off flushes `_line` to the
   reader path (Linux n_tty semantics), and TCSAFLUSH now clears the
   brokered `_cooked` queue too. Regression tests: test_tty.js (ring) +
   test_pty.js (brokered) legs, failing pre-fix. Post-fix paced repro:
   200/200 clean under full-core load.
2. **user32 agent protocol: popup items invisible to waits** (surfaced by
   the leg conversion): AQ_GETTEXT — behind `wmctl wait label`/`text` —
   only walked HWNDs, so every kernel-e2e wait on a popup item silently
   ran out its full timeout (a fixed sleep in disguise). Now resolves the
   OPEN menu's items (g_menu.open gated; closed bar items stay invisible
   by design — `wait label Save` must keep meaning the dialog button).
   test_fileman_ops_e2e: 117s → 27s. image.json → v85.

Both flaky legs converted off fixed sleeps (shLine markers / wmctl wait
guards; CLOSE-SENT echoes before VT2-away). tools/os-drive.mjs +
tools/os-drive-scripts/doom-close-probe.mjs landed per the scope addition.
Full story: logs/2026-07-13/0171-tty-stranding.md.

## Goal

Two browser-sweep files fail intermittently in legs that type multi-command
shell sequences on VT1, **at baseline commit 23315f1 with no working-tree
diff** (both verified by stash-baseline reruns; identical failure signatures
with and without the 0167 host.js change, so 0167 is exonerated — but
0170's "sweep green" was a single lucky run):

- `os-fileman.mjs` ~33% (idle machine, no load): the rename-dialog region —
  either `waitOut('RENAME-DLG-OK')` (dialog never listed) or
  `waitOut('RENAMED-OK')` (settext+OK never commits) times out at 20s.
- `os-doom.mjs` under `--under-load` (the flake-gate config): baseline 1/8
  fail, with-0167 3/8 fail (Fisher p≈0.28 — rate difference not
  established): `waitFrame(DOOM_REGION, h === baseDoom.h, 30000)` times out
  with the doom window still fully composited — the `wmctl close` flow
  never took effect.

## Diagnostics so far (one captured wedge)

A launch→close→probe loop under load captured the failure live ONCE
(12-iteration variants then ran clean ×36 with AND without 0167 — it's
rarer than the real test's rate, so the test's full sequence — audio
gesture, Escape-to-VT2-doom, ~20s demo runtime — is part of the repro):

- doom itself closed CLEANLY ("Quit requested", "[1] Done doom" — QUIT
  delivered and processed); the failure is in the SHELL/tty afterwards.
- The next typed command's echo lost its LEADING bytes ("ps " swallowed:
  echo shows `| grep -c "doom$" ; echo P-1-0`), then every subsequent
  typed line echoed (with trailing `\r`) but was never consumed — hush
  never read again; no prompt, no error. Kernel/tty echo path alive,
  read/consume path wedged.
- So the class is: under CPU contention, a VT1-typed line can lose
  leading bytes and/or hush's tty read can wedge after a background
  child's exit+reap raced concurrent typing. Product (tty read-waiter /
  SIGCHLD-EINTR race) vs harness (page→xterm→postMessage focus race on
  VT-switch) is NOT yet established.

## Plan

- First split product vs harness: drive the same flows headless
  (`test_fileman_ops_e2e.js`, a pty-typed doom-close e2e) `--repeat`
  `--under-load` — no browser page in the path. If headless wedges, it's
  the tty/hush read path (kernel); if only the browser wedges, it's the
  page input path or the tests' fixed `pause(400/500)`s (0083-class).
- The captured-wedge signature (leading-byte loss + dead reader) points at
  the tty input/reader machinery around child exit — audit the read-waiter
  requeue on EINTR/SIGCHLD and the page→tty input handoff ordering.
- os-doom.mjs could also wait on a `S""ENT` echo needle after typing
  `wmctl close ...` (it currently fires close and immediately VT2s away —
  a lost close is indistinguishable from a stuck app).

## Scope additions (2026-07-13, approved): the driver tool + leg conversion

The 0167 investigation hand-built four throwaway boot-type-probe scripts
and stepped on every rake (forgotten `setVt(1)`, needle matching its own
typed echo, `waitForServer` too short across a rebake). That tooling is
needed to root-cause THIS item, so it lands here as a committed artifact:

- **`tools/os-drive.mjs`** — boot the OS page once (reusing
  `tests/browser/lib/os-harness.mjs`; rebake-tolerant server wait), then
  expose the driving primitives: `type` (VT-aware, split-needle helper),
  `waitOut`, `vt`, `sample`/`shot`, `wmctl` passthrough, plus an
  under-load toggle (the flake.js generators). Two modes: **REPL** (manual
  poking — "drive commands to see that it works") and **scripted** (a .mjs
  that gets the session handle — what debug loops and future flake
  investigations reuse). Keep it thin: no assertion framework, no runner
  integration; it's a driving layer, not a test tier.
- **Convert the two flaky legs off fixed sleeps**: os-fileman's
  `pause(400/500)` chains and os-doom's fire-and-VT2-away close onto
  marker waits (split-needle echoes, `wmctl list` state), per the new
  selectivity/house-rules section in `tests/browser/README.md`.

## Acceptance

- `node tests/browser/os-sweep.mjs --repeat 5 --filter=os-fileman` 5/5 on
  an idle machine, and 5/5 `--under-load`.
- `node tests/flake.js` fully green (os-doom stable under load ×3).
- Root cause named: either a kernel/tty fix with a regression test, or the
  harness race fixed in the page/test layer with the mechanism documented.
- `tools/os-drive.mjs` committed; the 0167-style launch/close/probe loop
  reproducible as a short script over it (no more bespoke scratch files).
