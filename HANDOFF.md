# Handoff — start of thread (updated 2026-07-08, after 0020 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**The OS has its own terminal.** This thread landed **0020** — kernel pty
pairs + `/bin/term`, the wasm terminal (design/status: KERNEL.md status
paragraph + WM.md "The terminal"; dev log
`logs/2026-07-08/wasm-terminal-ptys.md`). Shape:

- **Ptys**: `PTY_CREATE` (0x0106) → master OFD (`ptm`) + slave OFD whose
  tty **is a full kernel `Tty`** (line discipline/termios/ISIG reused
  verbatim); slave→master is one pipe-shaped buffer (echo + OPOST/ONLCR
  slave writes, whole-or-block so expansions never split); termios/pgrp
  RPCs are **fd-aware** (`_ttyForFd`; the host `__tty_*` env passes the
  real fd now); `TIOCSWINSZ` (0x0105) → SIGWINCH; spawn attaches
  `pcb.tty` from the child's post-actions fd 0 (winsize SAB + signals
  follow; first attach claims fgPgid); master close → SIGHUP + slave
  EOF/EIO; last slave ref → master EOF. libc: `<pty.h>` openpty,
  TIOCSWINSZ in `<sys/ioctl.h>`; RemoteFS `openpty`/`setWinsize`.
- **`/bin/term`** (`os/term/`, bin.json project over vendored freetype;
  font seeded at `/etc/fonts/mono.ttf`): 80x24 @ 8x18 cells = 640x432,
  escape parser scoped to hush lineedit + busybox vi (alt screen, DECSTBM,
  SGR 256→16, DSR/DA replies, OSC title), SDL keys → pty bytes (SDL3
  modifier-applied keysyms), WINDOW_RESIZED → grid realloc + TIOCSWINSZ
  reflow, child-exit/master-EOF/close-box all end the session cleanly.
  `term cmd args...` runs that instead of /bin/sh. **image.json is v15**.
- `SDL_WINDOW_RESIZABLE` now exists in `<SDL3>` (real SDL3 value 0x20);
  term + winbox declare it. Currently accepted-and-ignored by
  createSurfaceSDL — **0021 will gate resize offers on it** (the constant
  + declarations are pre-staged; 0021 shouldn't need to touch term/winbox).

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓ (now 24 files: + test_pty.js 62 checks, test_pty_e2e.js,
test_term_e2e.js — the 0020 acceptance incl. vi-in-term + resize-reflow
pixel assertions), browser os-boots✓ + os-wm✓ + os-doom✓ + os-quake✓ +
os-gpubox✓ + **os-term✓ (new)**.

## The queue (todos/README.md is authoritative)

1. `0021` honor SDL_WINDOW_RESIZABLE — fixed-res apps (doom/quake) corrupt
   on drag-resize; the flag + app declarations are already in place, the
   kernel/WM gating is the work (item file exists)
2. `0022` VT switching tty ↔ desktop (item file exists)
3. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **Pty slave writes report PRE-OPOST byte counts** and are whole-or-block
  (a partial landing could split a `\r\n` expansion). PTY_OUT_CAP (256K)
  must stay > 2× the RemoteFS write chunk (60000) or a whole-write could
  never fit — don't shrink either independently.
- **`_ttyWaiters` is gone**: tty read waiters are per-Tty (`tty.waiters`)
  and the waiter record carries its tty. Any new tty-read defer must use
  the per-instance queue.
- **Master close → SIGHUP** happens in `_ofdUnref`; a test that closes the
  master while asserting on the fg process must set a SIGHUP disposition
  first or the process dies (default action).
- busybox vi's lone ESC needs pacing air on both sides (read_key resolves
  it by timeout) — inject ESC as its own key event with sleeps around it
  (test_term_e2e does).
- The vi/os-boots timing guards from 0018 still apply: wait for `/~ #/` in
  `__osOut` before typing in browser tests; os-gpubox stays
  environmentally flaky (headless WebGPU adapter availability).
- The IDE's clangd flags os/*.c and os/term/term.c (SDL.h not found etc.)
  — noise; those headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v15 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP) ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js (SH_*/IR_*) ↔ host.js
  (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event values in
  compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js (AU_*) ↔
  host.js; SDL audio format words ↔ <SDL3/SDL_audio.h>; SI_* tty header
  kernel.js ↔ host.js (ptys reuse it per-pair).
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox/os-quake/os-term after touching os/, kernel.js, host.js
  SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0019's decisions, 0020's decisions (slave-is-a-Tty,
  fd-aware termios with attached-tty fallback, whole-or-block OPOST
  writes, EIO-not-EPIPE for slave writes, SIGHUP at master close, spawn
  fd-0 tty attachment).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0021 (SDL_WINDOW_RESIZABLE), 0022 (VT switching), a lingering
item, or something else."
