# Handoff — start of thread (updated 2026-07-10; 0072 openwith closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0072 (file associations + pickable default open app) is CLOSED** — dev
log `logs/2026-07-10/0072-openwith-associations.md`, details in
`todos/done/0072-openwith-associations.md`. The load-bearing facts:

- ONE resolver, **`os/openwith.h`** (header-only because image.json `c`
  entries are single-source compiles), shared by wm.c `activate()`,
  fileman and the new **`/bin/open`** CLI (`open FILE`, `open --set KEY
  CMD`). Store: first existing of `~/.config/openwith`, `/etc/openwith`,
  `/usr/share/openwith` (whole-file wins, no merge — the /etc/menu
  precedent); `ow_set` writes the user file with the effective table
  carried forward. Baked seed: gb/gbc → gameboy, `default.gui` →
  notepad, `default.term` → vi.
- **activate() dispatch changed**: stat()-based — anything runnable
  after symlink resolution spawns; everything else (including symlinks
  to non-runnables, previously a silent spawn-fail) opens through its
  association. GUI opens of plain files now land in **notepad**, not
  `term vi` — tests asserting the old viewer were re-baselined
  (test_fileman_e2e, test_wm_service_e2e).
- fileman grew a **"With" button** → the `OpenWith` picker window
  (command EDIT prefilled from the resolver, "Always" checkbox →
  persists). Image version is **v44**.
- Tests after the change: kernel suite **40/40**, browser sweep green
  (see `build/test-browser/summary.json`), plus the new
  `tests/kernel/test_openwith_e2e.js` (15 checks — CLI, desktop, fileman,
  picker, cross-boot persistence).

**Next in queue**: run `node todos/queue.js list` — 0075 sameboy (was
gated on 0072) and 0063 aero lead.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`): quake lock on
click, ESC unlock, click re-lock, VT-switch release.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0072)**: `wmctl click LABEL`/`settext` take the FIRST win32 app
  that accepts the label — sequence agent-driven test legs so ambiguous
  labels (OK, Open, EDIT:n) can't land in another app (notepad's menus
  count). The openwith e2e drives all fileman clicks before notepad
  exists.
- **NEW (0072)**: `strncasecmp`/`strcasecmp` are in `<strings.h>`, not
  `<string.h>`, in this libc.
- **NEW (0072)**: need a Peanut-GB window to stay up in a test? Don't
  feed it garbage (it exits pre-frame); synthesize the minimal valid
  cartridge — the recipe is `minimalRom()` in test_openwith_e2e.js.
- **0070: browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082 gate): land the
  edit, re-run; or run mkimage first. `.md` files and `tests/` are NOT
  bake inputs; `os/*.c/.h/.json` are.
- **New-runner habits**: after an interrupted/failed suite run, look at
  `build/test-*/summary.json` + per-file `.log` before rerunning;
  `--resume` picks up the checkpoint (works for os-sweep too). Don't
  crank `-j` past default on a loaded box until 0083 lands.
- **Sweep is serial by design** (0045 boot lock + contention); os-sweep
  rejects `-j`. Keep it that way.
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('cairodemo' is in both lists now).
- **Editing seeded sources or coreutils.json/bin.json/lib.json**: the
  headless/test/serve paths detect it by mtime (0082). Bump `image.json`
  `version` (now 44) anyway when an interactive browser tab must pick
  the change up (OPFS re-fetch is version-gated only).
- **Cairo/pixman config is hand-written** (`vendor/cairo/config.h` +
  `src/cairo-features.h`; pixman via two -D flags in lib.json). When
  adding cairo features (0080), extend BOTH headers and lib.json, and
  record patches in the README table. Testsuite diff policy: tol 3,
  hard cap 16.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. After `queue.js done`, check `git status` — the internal
  git-mv can stage a pre-edit blob (re-`git add` the done file).
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording — moves if the message changes.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Browser pixel tests: tolerate the icon grid in "empty desktop" asserts;
  desktop teal == compositor teal; derive geometry from `__osScreen`;
  a SECOND page needs a fresh context/browser.
- Concurrent sessions may be active in this repo: check `git status`
  before staging and stage ONLY your own files.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise;
  headers are compiler.js built-ins or project-include-path resolved.
- For the long tail (WRES v2, wmctl click one-arg=label, clipboard file,
  EM_GETHANDLE, argv0, AUDIO_GAIN, TrackPopupMenu coords, 0069 unmapped
  semantics, MAKEINTRESOURCE stack caveat, shebang one-optarg, `ls /`
  goldens incl. proc, 0040 image pairing, MUST-MATCH block list): see
  `todos/done/0048`'s Status, `logs/2026-07-10/0048-closeout.md`, and the
  CLAUDE.md sections — they are the durable copies.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0069's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0061's calls; 0081's calls (ONE shared suite engine, kernel `-j4`, sweep
serial, run-unit.js untouched); 0082's calls (input-freshness by mtime
scan, fixture = `os/os-system.img` itself, `version > manifest` blobs
kept, test_os_boot stays the real-bake test); 0070's call (boot STAYS on
VT1 until `ready`; auto-switch only on a healthy ready; user choice
during boot wins); 0072's calls: openwith store is FIRST-FILE-WINS (no
per-key merge — merge happens at ow_set write time), values are argv
prefixes (the user wraps tty programs in `term …` for GUI use), the
resolver stays header-only, and seeded Desktop ROM launchers stay
scripts.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0075 sameboy, 0063 aero, 0046 strace, 0079 dep-dedup, or 0064
WM sweep round 3 (the pointer-lock human check is owed)."
