# Handoff — start of thread (updated 2026-07-12; 0151 desktop-icon name bug closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0151 (P0 desktop-icon launch bug) is CLOSED and COMMITTED.** Double-clicking a
Desktop icon whose filename was ≥ 32 chars silently failed to launch: `menu_ent`
carried a fixed `char name[32]` (os/wm.c), `load_entries` truncated the name,
`desk_launch` built a path to a file that didn't exist, and `activate()`'s
`stat()` failed with no error. It reads as a "spaces" bug because long names tend
to contain spaces — but a SHORT spaced name launched fine even pre-fix, so
truncation was the whole bug (not spaces).

**Fix**: grew `menu_ent.name` and the mirrored `sm_item.name` from `[32]` to
`ENT_NAME` (256 — a full BlockFS d_name is 255 chars + NUL). One change fixes
BOTH the desktop grid and the Start-menu flyout columns (`menu_ent` feeds both).
Audited every other fixed-size name/path buffer on the launch path — all fit a
255-char name, nothing else needed. Dev log
`logs/2026-07-12/0151-desktop-icon-launch-name-truncation.md`; item at
`todos/done/0151-desktop-icon-launch-name-bug.md`. Image **v72**.

**Tests**: a kernel e2e leg in `tests/kernel/test_wm_service_e2e.js` (dblclicks a
36-char spaced Desktop launcher; a **proven regression witness** — reverting the
struct to `[32]` makes only the long-name check fail, `LN-LONG-DELTA-0`) and a
browser leg in `tests/browser/os-shell.mjs` (operator-owed run, Playwright not
installed here). Verified green: `test_wm_service_e2e.js`, `test_os_boot.js`,
`test_ctxmenu_e2e.js`, `queue.js check`.

## Operator-owed (browser)

The 0151 browser leg (`os-shell.mjs`) is unrun here — **Playwright is not
installed in this clone**. It rolls into the standing **0064** browser debt
(pointer-lock human check + the 0094–0107 legs incl. the unrun `os-paint.mjs`).
Run `node tests/browser/os-sweep.mjs` (or `--filter os-shell`) when Playwright is
available; launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`
(0055 — boot REQUIRES worker WebGPU).

## Gotchas carried forward (trimmed to the live ones)

- **Concurrent sessions exist: stage ONLY your own files**, and re-check HEAD
  before committing — it can advance mid-session. Reconcile shared files
  (`queue.json`, `image.json`) against the *current* HEAD.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (the rename shows `RM`/`R ` until re-added).
- **Bump `image.json` `version` when you edit a seeded bake input** (`os/*.c/.h/
  .json/.rc`, `compiler.js`, `host.js`, `vendor/`): a persistent browser OPFS
  image only re-fetches on a version bump. Now **v72**. (`.md`/`tests/` are NOT
  bake inputs.)
- **`--stale-ok` / a pre-baked image runs the STALE binary** — when iterating on
  a seeded `.c`, drop `--stale-ok` or `rm` the image so boot.js re-bakes.
- Kernel test files are auto-discovered by `tests/kernel/run.js` (glob); confirm
  a new `test_*.js` is picked up.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. After 0151 there are no
open P0s; the P1 head is **0079/0080**, **0052/0053**, the 0083/0084 pair,
**0064** (WM browser sweep round 3 — the standing operator debt), and the
0133-0139 notepad-EDIT set. Heavier P1→P3 tail after.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's settled
layout; 0013–0151's recorded decisions (see todos/done/). **0151's call: the bug
was name-length truncation, not spaces; the fix is the `ENT_NAME` (256) buffer
grow shared by the desktop grid + Start-menu flyout — a full filesystem name
never truncates on the launch path now.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0151 desktop-icon name bug
just landed; no open P0s, P1 head is 0079/0080). 0064 WM browser sweep still owes
the operator the pointer-lock check + the 0094–0151 browser legs."
