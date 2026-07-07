# Handoff — start of thread (updated 2026-07-07, after 0015 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**DOOM runs windowed in the OS.** This thread landed **0015** (WM.md unit
7 — the WM design's own acceptance test): `doom &` from hush opens the
DOOM Shareware title screen on the desktop, gameboy boots Pokémon Blue
from a seeded ROM, snake plays in the tty — all **zero source changes**.
The one real piece of machinery: image.json's new **`bin` entry type**
(repo-relative binary blobs seeded verbatim: doom1.wad ~4MB, ROMs) with an
`io.readBinary` hook in both boot paths; the app binaries themselves build
at seed time via the existing `project` path. image.json is **v11**; fresh
seed went 4.0s → 5.0s. Dev log: `logs/2026-07-07/windowed-vendor-apps.md`.

Decisions made in 0015 (don't re-litigate): WAD lives at `/root/doom1.wad`
because doomgeneric's `d_iwad.c` searches cwd only and hush starts in
/root — no search-path patch; DOOM's 1280x800 window overflowing the
screen is the app's choice, kernel clips (0019 resize is the eventual
answer); audio stays gracefully silent until 0017.

All green at hand-off: unit 697✓ (3 pre-existing skips), kernel 19 files✓
(new: test_os_apps_e2e — 13 checks incl. histogram-verified `wmctl shot`
frames), blockfs✓, host✓, browser os-boots.mjs✓ + os-wm.mjs✓ +
os-doom.mjs✓ (new: composited doom frame, Escape reaches the app, attract
demo animates, wmctl close quits, gameboy lifecycle).

## The queue (todos/README.md is authoritative)

1. **`0016` SDL+WebGPU demo app + Dawn tier-1 suite** — first real
   `gpu`-transport consumer; a real-world WebGPU port follows (unnumbered)
2. `0017` audio mixing (kernel sound server; doom + gameboy are waiting
   consumers, both already NULL-check the failed stream open)
3. `0018` quake — relative-mouse/pointer-lock flag + pak0.pak seeding
   (seeding is trivial now via `bin` entries)
4. `0019` client resize (SURFACE_CONFIGURE)
5. `0020` wasm terminal + ptys

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **snake needs TWO paced `q`s to quit** — one ends the game, one
  dismisses "Press q to exit", and its exit read loop SPINS on EOF while
  `poll_key()` slurps all queued bytes in one read. Piped snake sessions
  hang unless input lands in separate reads (test_os_apps_e2e feeds stdin
  on timers). Looks exactly like an OS hang; it isn't.
- `cat file.ppm` through byte-clean piped boot.js stdout is the way to get
  binary files OUT of the image for verification (bump spawnSync
  `maxBuffer` for multi-MB frames).
- image.json `bin` entries are REPO-relative (like `project`); `c`/`text`
  stay os/-relative.
- **The gameboy ROMs are gitignored** (copyrighted, local-only — unlike
  the committed shareware doom1.wad). Their entries are
  `"optional": true`: a missing asset logs SKIPPED and boot continues
  (post-landing fix — the first cut 404-bricked boots on other
  checkouts). Bare `gameboy` boots a built-in test ROM; both acceptance
  tests adapt to ROM presence.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v11 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- WM protocol MUST-MATCH blocks live in THREE places: kernel.js (WMP) ↔
  os/wm_proto.h ↔ tests/kernel/test_wm_policy.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom after
  touching os/, kernel.js, host.js SDL/fd paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0014's decisions (wmctl on the same socket protocol,
  borderless surfaces skip click-to-focus, trusted peers skip the pipe
  cap), 0015's decisions above.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0016 (WebGPU demo app), a lingering item, or something else."
