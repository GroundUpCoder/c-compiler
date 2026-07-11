# Handoff — start of thread (updated 2026-07-12; 0155 hard-tail e2e waits landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0155 (hard-tail kernel e2e sleeps) is DONE and committed.** This closes the
0083 sleep-sync sweep: the settles that were neither cleanly window-observable
(0083) nor win32-agent-tree (0154). The `sleep N` guess-wait class is now
retired from the whole kernel e2e estate.

- **Two new `wmctl` wait primitives (`os/wmctl.c`)** for RESIZE/SET_DST ack
  round-trips — the residue class 0083 couldn't express ("same-window geometry
  change", not a window appearing):
  - `wmctl wait dim SID WxH` — buffer `w==W && h==H` (a RESIZE ack landed;
    **position-agnostic**, so a WM-placed window needn't be pinned).
  - `wmctl wait dst SID WxH` — on-screen `dst_w==W && dst_h==H` (a SET_DST /
    scale-to-fit ack landed).
- **Eight e2es swept** — spawn→`wait win`, teardown→`wait nowin/gone`, geometry
  acks→`wait dim/dst`, minimize state→`wait flag/noflag m`, launch deltas→
  `wait atleast winbox $((N+1))`, async fs outcomes→bounded `for … [ -e … ] &&
  break` polls, gpubox frozen poses→`wait seq $SID 1` (first Dawn present
  subsumes the variable adapter/device init). Sleep counts: wm_service 53→38,
  term 22→12, sameboy 5→3, punes 5→3, mgba 2→1, gpubox 5→0, os_apps 3→1,
  cairo 3→2.
- **Kept as annotated timing subjects** (grep `"'sleep "` shows no bare entry):
  multi-frame content renders (pty echo + command output, vi/less alt-screen,
  game/emulator boot-animation-to-shot — a single `wait seq +1` would
  under-wait), coarse wm.c `desk_load` ~1s ticks, in-surface desktop
  selection / inline-rename settles (no window observable), keyboard move/size
  mode-engage (popup is the key grabber, no flag), and the negatives
  (no-spawn / no-op / EEXIST-keeps-both / Esc-untouched). Every kept sleep
  carries a one-line reason.
- **test_os_boot.js audited, unchanged** — its "sleep" hits are the
  pgrep/pkill/usleep *subject under test*, not synchronization.

Dev log: `logs/2026-07-12/0155-term-emu-e2e-waits.md`. Item:
`todos/done/0155-term-emu-e2e-waits.md`.

## Tests / verification

- **Full kernel suite green: 58 passed, 0 failed** (`node tests/kernel/run.js`,
  ~1101s, parallel).
- All eight converted files verified individually too (term, wm_service,
  os_apps, cairo, sameboy, gpubox, punes, mgba — all PASS).
- `os/wmctl.c` recompiles clean; the new `dim`/`dst` conditions key off the
  existing `WMP_LIST` `wmp_rec` (`w/h/dst_w/dst_h`) — additive, default 2-arg
  shape, no `do_wait` change.

## Gotchas carried forward (trimmed to the live ones)

- **Image bumped v74→v75** (wmctl.c is a seeded bake input) and the prebaked
  fixture was rebaked. Any edit to a seeded `os/*.c/.h/.rc` or `compiler.js`/
  `host.js`/`vendor/` restales `os/os-system.img`; bump `image.json` `version`
  on a seeded-source edit or a persistent browser OPFS image won't re-fetch.
  (CLAUDE.md still says "v64" in prose — stale; `image.json` version is now 75.)
- **`queue.js done` stages a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (done this session; verified the staged
  blob carries the DONE Status line).
- **Concurrent sessions exist: stage ONLY your own files**; re-check HEAD before
  committing.
- **Playwright is not installed here.** Kernel/blockfs/unit/host suites run fine;
  the browser `sweep` (0064/0153) needs a separate install. Via `tests/run.js`
  the sweep is `optional` — a can't-launch is a skip.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. Head is now **0147**
(test flake gate, [light]), then **0079/0080**, **0052/0053**, **0064**. No open
P0s. **0147** (flake gate) + **0148** (test-tightness sweep) can build on the
unified `tests/run.js` entry (0084) plus the 0083/0154/0155 event waits — the
whole kernel e2e estate is now sync-sleep-free, so a flake gate has a clean
baseline.

## Operator-owed (browser, Playwright required)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check).
- **0152** — a `--clang` browser boot confirming the served overlay renders.
- **0153** — run `os-sweep.mjs` to validate the 0146/0083 harness conversions
  (0155 only touched headless kernel e2es — no new browser debt; the new
  `wait dim/dst` primitives are available to browser drivers if a future sweep
  conversion wants them).

Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` (0055 —
boot REQUIRES worker WebGPU). `node tests/run.js sweep` runs the whole sweep.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0155's recorded decisions (see todos/done/). **0155's
call: game/emulator/term multi-frame renders and coarse wm.c ticks are genuine
timing subjects — a single `wait seq +1` under-waits (catches the boot/echo
frame, not the asserted content), so a generous annotated sleep is the correct
wait, not oversight. Only static-render frozen poses (gpubox `-f`) use
`wait seq 1`.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0155 hard-tail e2e waits just
landed: `wmctl wait dim/dst` + a sweep of eight term/emulator/misc e2es retired
the last of the 0083 sleep-sync class, full kernel suite 58/58; head is now 0147
flake gate; no open P0s)."
