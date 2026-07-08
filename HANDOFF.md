# Handoff — start of thread (updated 2026-07-08, after 0026 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

This thread landed **0026 — mount points / split system+user volumes**
(dev log `logs/2026-07-08/mount-points.md`): host.js gained **MountFS**
(longest-prefix routing over N BlockFS volumes, own fd/dir-handle
namespaces, EXDEV/EBUSY edges, full-namespace symlink resolution via the
volume-side `_mountOwns` escape hook — foreign targets THROW
`__mountEscape`, MountFS's dispatch loop rewrites + retries). Both
embedders mount `/` system + `/root` user volumes
(`os-system.v4.img`/`os-user.v4.img` in OPFS; `os-system.img` +
`os-user.img` headless, `--image=` names the system one); zero kernel.js
changes. Upgrades now reseed the system volume while `/root` survives —
`boot.js --fresh-system` demonstrates it; the pre-split `os.v4.img` /
`os/os.img` are orphaned by design. **image.json is v21.** The user
volume mounts with `noDevNodes` (no `~/dev` clutter).

All green at hand-off: unit 697✓ (3 pre-existing skips), blockfs suite✓
(incl. new `test_mounts.js` — walk mechanics + both-volume fsck), kernel
suite✓ (incl. new `test_mounts.js` semantics + the test_os_boot reseed/
--fresh-system acceptance legs), browser sweep os-boots✓ os-wm✓ os-scale✓
os-doom✓ os-gpubox✓ os-quake✓ os-term✓ os-vt✓ os-screen✓ — run serially.

## The queue (todos/README.md is authoritative)

The desktop-shell round 0028–0033 (designed in `WM.md` "The desktop
shell") is next up: 0028 start menu, 0029 desktop icons, 0030 title-bar
min/max boxes, 0031 taskbar polish, 0032 window cycling, 0033 WM bug
sweep. After that: the WebGPU app port (WEBGPU.md) and the
0026-unlocked `tools/mkimage.js` baked system image. (`0006`
threads+atomics stays deferred indefinitely.)

## Gotchas carried forward

- 0026's: every BlockFS path op must walk ALL components via `_walkPath`
  BEFORE mutating (an escape aborts the op — that ordering is what makes
  throw-and-retry safe); volumes share inode numbers (both roots ino 1,
  no st_dev) — don't compare inos across volumes; MountFS is
  kernel-embedder-side only (RemoteFS/standalone paths untouched).
- 0025's: unfocused window emits EV_FOCUS before EV_TITLE_ACTIVATE;
  double-click detection needs `opts.t` timestamps in tests (dt >= 0
  guard, mixed clock origins never match); wm.c work area is
  `scr_w x (scr_h - BAR_H - TITLE_H)` at `(0, TITLE_H)` with TITLE_H=28
  (wm.c's, not the kernel's 24).
- 0023's browser-test rules: derive geometry from `__osScreen`/live
  canvas rect, VT2 settle before pixel work, wm placement is async,
  keep the sweep serial.
- The IDE's clangd flags os/*.c and vendor SDL sources (SDL.h not
  found etc.) — noise; those headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v21 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP incl. ACTIVATE/
  EV_TITLE_ACTIVATE; 80-byte record) ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js (SH_*/IR_*) ↔
  host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event
  values in compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js
  (AU_*) ↔ host.js; SDL audio format words ↔ <SDL3/SDL_audio.h>;
  SI_* tty header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-scale/
  os-doom/os-gpubox/os-quake/os-term/os-vt/os-screen (serially!) after
  touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0027's decisions, 0026's (throw-and-retry escape over
  VFS namei; EXDEV on cross-volume rename/link; mount-point dirs
  materialized in the outer volume; user volume skips /dev).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: the desktop-shell round (0028 start menu first), the WebGPU
app port, or something else."
