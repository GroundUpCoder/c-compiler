# Handoff — start of thread (updated 2026-07-12; 0154 agent-tree waits landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0154 (agent-tree waits) is DONE and committed.** The `sleep N`
synchronization class is now retired from the **win32-app** kernel e2es too —
0083 did the pure-WM ones over the window list; this did the in-app ones over
the win32 agent tree.

- **New primitive: `wmctl wait label|nolabel|text` (`os/wmctl.c`)** — polls the
  per-process win32 agent tree (`AQ_GETTEXT`, the same resolver `wmctl click
  LABEL`/`gettext` use) to a failure deadline (default 15000ms, exit 1 on
  timeout):
  - `wait label LABEL [MS]` / `wait nolabel LABEL [MS]` — a widget with that
    label exists / is gone in ANY win32 app.
  - `wait text LABEL SUBSTR [MS]` — that widget's `WM_GETTEXT` contains SUBSTR.
  - LABEL resolves like `click`: window text ('&' stripped) or `CLASS:n`
    (`EDIT:0`, `LISTBOX:0`, …). Routed before `wmp_connect` (talks to apps, not
    the kernel).
- **All 14 win32-app e2es converted**: ~324 → ~73 `sleep` lines. Real WM windows
  (MessageBox / `#32770` / comdlg32 / wm.c popups) use the 0083 `wait win`/
  `nowin`; in-app control state uses the new `wait label/text`; async file/clip
  outcomes use bounded `[ -s ]`/`clip -o | grep` polls.
- **Key limitation, hit in 3 files independently**: the agent tree resolves
  HWNDs, not menu items — an in-surface `TrackPopupMenu` / menu-BAR dropdown item
  is *clickable* (AQ_CLICK) but not *gettext-able*, so `wait label/text` can't
  observe it. Those open/close settles stay annotated `sleep`s, alongside
  pixel-only render settles (`wmctl shot`), the dialog ` focus ` tree marker,
  WM_TIMER clock ticks, double-click windows, coarse wm.c desktop `.icons`
  ticks, and negative checks. Every kept sleep carries a one-line reason.

Dev log: `logs/2026-07-12/0154-agent-tree-waits.md`. Item:
`todos/done/0154-wmctl-wait-agent-tree.md`.

## Tests / verification

- **Full kernel suite green: 58 passed, 0 failed** (`node tests/kernel/run.js`,
  ~385s, parallel — which is also the 0081 contention / under-load check).
- Every converted file also verified individually (the ones with dropped
  inter-op sleeps run 2–3×). Assertions and `==markers` are byte-for-byte
  unchanged in all 14 (only the boot-script arrays moved).
- `os/wmctl.c` recompiles clean (`node compiler.js -I=os os/wmctl.c -o …`); the
  new `wait` routing is additive.

## Gotchas carried forward (trimmed to the live ones)

- **Image bumped v73→v74** (wmctl.c is a seeded bake input) and the prebaked
  fixture was rebaked. Any edit to a seeded `os/*.c/.h/.rc` or `compiler.js`/
  `host.js`/`vendor/` restales `os/os-system.img`; bump `image.json` `version`
  on a seeded-source edit or a persistent browser OPFS image won't re-fetch.
  (CLAUDE.md still says "v64" in prose — stale; `image.json` version is now 74.)
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

`node todos/queue.js list` for the authoritative order. Head is now **0155**
(the hard-tail kernel/term/emulator sleeps — the last of the 0083 sleep
residue), then **0147** (test flake gate, [light]), **0079/0080**, **0052/0053**,
**0064**. No open P0s. **0147** (flake gate) + **0148** (test-tightness sweep)
can now build on the unified `tests/run.js` entry (0084) plus these event waits.

## Operator-owed (browser, Playwright required)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check).
- **0152** — a `--clang` browser boot confirming the served overlay renders.
- **0153** — run `os-sweep.mjs` to validate the 0146/0083 harness conversions
  (the browser `os-*.mjs` files were already event-based after 0083; 0154 only
  touched the headless kernel e2es, so no new browser debt from this item).

Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` (0055 —
boot REQUIRES worker WebGPU). `node tests/run.js sweep` runs the whole sweep.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0155's recorded decisions (see todos/done/). **0154's
call: agent-tree waits reuse the existing `agent_scan`/`AQ_GETTEXT` machinery
(no new opcode); in-surface menu items are HWND-less so they can't be waited on
— those settles stay annotated `sleep`s by design, not oversight.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0154 agent-tree waits just
landed: `wmctl wait label/text` retired the sleep-sync class from all 14
win32-app kernel e2es, full kernel suite 58/58; head is now 0155 for the last
hard-tail sleeps; no open P0s)."
