# Handoff — start of thread (updated 2026-07-12; 0083 event-based waits landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0083 (event-based waits) is DONE and committed.** The `sleep N`
guess-wait synchronization class is retired everywhere it was observable.

- **New primitive: `wmctl wait` (`os/wmctl.c`).** Polls `WMP_LIST` on the
  open WM connection every 30ms until a condition holds, with a
  failure-deadline timeout (default 15000ms; **exit 1 on timeout** — the ms is
  a deadline, not a sync sleep). Conditions: `win`/`nowin TITLE`,
  `count`/`atleast TITLE N`, `gone SID`, `flag`/`noflag SID CH`, `seq SID N`
  (frame_seq ≥ N). TITLE = the exact TITLE column of `wmctl list` (quote
  spaced titles); shell vars work (`wmctl wait flag $SID m`). Factored the
  shared FLAGS builder into `rec_flags()` — `list` output is byte-identical.
- **Converted (pure-WM kernel e2es)**: `test_wm_service_e2e.js` (53 sleeps →
  waits, 136 ok / 0 fail), `test_snap_e2e.js`, `test_saver_e2e.js`,
  `test_cursor_e2e.js`. Sleeps that are genuine **timing subjects** (negative
  "nothing happened" checks, geometry round-trips on an existing window,
  coarse desk/`.icons` re-read ticks, in-surface render settles) stayed as
  `sleep`s with a justifying comment.
- **Converted (browser)**: `os-shell.mjs` (3 real conversions to
  `waitPixel`/`waitNotPixel`); the rest of the `os-*.mjs` sync sites were
  already event-based post-0146 or are annotated timing subjects.

## Tests / verification

- **Full kernel suite: 58 passed, 0 failed** (`node tests/kernel/run.js`,
  ~385s — the `os-system.img` rebake dominates `test_os_boot.js`). The
  `wmctl.c` change is regression-free across every test that runs `wmctl`.
- **Browser: static-verified only** (`node --check` on all edited `os-*.mjs`;
  no bare sync `waitForTimeout` left un-annotated). **The sweep was NOT run —
  Playwright is not installed in this clone.** Runtime confirmation is
  operator-owed (see 0153/0064 below).

Dev log: `logs/2026-07-12/0083-event-based-waits.md`. Item at
`todos/done/0083-test-sleep-waits.md`.

## Follow-ups filed

- **0154** (P1) — agent-tree waits: add `wmctl wait label/text` over the
  win32 agent tree (`wmctl tree`/`gettext`, todos/0058), then convert the
  **win32-app e2e cluster** (fileman_ops/recycle/ctxmenu/user32/notepad/calc/
  winmine/ctlpanel/clipboard/openwith/paint/gdi32 — ~295 sleeps waiting on
  in-app control state the WM window list can't see).
- **0155** (P1) — `test_term_e2e.js` tty-render waits (`wait seq` off a
  captured baseline) + audit the emulator/misc timing-subject sleeps
  (sameboy/punes/mgba/gpubox/os_apps/cairo/os_boot) so the "no bare sync
  sleep" invariant is clean and greppable.

Slotted right after 0084 in `queue.json`.

## Gotchas carried forward (trimmed to the live ones)

- **`wmctl.c`/`os/*.c` are seeded bake inputs.** This session bumped
  `image.json` `version` 72 → **73** and rebaked `os/os-system.img` (gitignored)
  so warm e2e boots stay ~1-2s; a cold in-worker bake is ~90s. Any edit to a
  seeded `os/*.c/.h/.rc` or `compiler.js`/`host.js`/`vendor/` restales the
  fixture — the suite runner (`tests/lib/image-fixture.js`) rebakes once up
  front. **Bump `version` on any seeded-source edit** or a persistent browser
  OPFS image won't re-fetch.
- **`queue.js done` stages a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (hit this session: the git-mv staged the
  "Status: open" blob; re-adding staged the "DONE" one).
- **Concurrent sessions exist: stage ONLY your own files**, and re-check HEAD
  before committing.
- **Playwright is not installed here.** The kernel suite and `node --check`
  run fine; `node tests/browser/*` needs a separate install (browsers cached
  under `~/Library/Caches/ms-playwright`).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. Head is **0084**
(unified test entry point with diff-aware selection), then **0154/0155** (the
0083 residue), **0147**, **0079/0080**, **0052/0053**, **0064**. No open P0s.

## Operator-owed (browser, Playwright required)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check +
  the 0094–0151 legs).
- **0152** — a `--clang` browser boot confirming the served overlay renders.
- **0153** — run `os-sweep.mjs` to validate the 0146 harness conversion (and
  now the 0083 os-shell `waitPixel` conversions ride along).

Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` (0055 —
boot REQUIRES worker WebGPU). `node tests/browser/os-sweep.mjs` runs the whole
sweep serially.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0155's recorded decisions (see todos/done/). **0083's
call: `wmctl wait` polls the WM window list (30ms, failure-deadline timeout) —
in-app control state (win32 agent tree) is a SEPARATE primitive owned by 0154;
timing-subject sleeps that prove a negative or settle a render stay as
annotated `sleep`s by design.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0083 event-based waits just
landed; `wmctl wait` retired the sleep-sync class in the pure-WM kernel e2es +
browser; win32-app cluster is owned by 0154, term/emulators by 0155; no open
P0s, head is 0084)."
