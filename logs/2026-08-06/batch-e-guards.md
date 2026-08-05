# Batch E — #119 DOOM callback-comment verdict, #142 cross-tree guard extension

Base: origin/main @ 196db0b5 (the Batch D merge). Lane: batch-e.
Commits: #119 @ 87920e50, #142 @ 8e707a8b.

## #119 — the DG_SleepMs comment is TRUE for the flavor it names

The prior synthesis pass called the comment "now-stale" without checking which
flavor DOOM runs as. The ticket suspected that skip, and the suspicion was
right — but the sharpest finding is that **flavor is not a build property at
all**:

- `cc2wasmFlags` (named by the ticket as the thing to check) has **zero hits
  in this repo**. Neither `vendor/doom/bin.json` nor `vendor/quake/bin.json`
  carries any flavor axis.
- The same wasm binary runs under whichever SDL backend host.js selects at
  instantiation (`host.js` ~12156-12170): an injected canvas → the
  standalone-browser callback model (`createBrowserSDL`); OS spawnHooks with
  `surfaceCreate` → the process-worker backend (`createSurfaceSDL`); neither →
  headless stubs (`createNullSDL`).

The claim table, per flavor:

| Flavor | SDL_Delay today | Evidence |
|---|---|---|
| standalone-browser callback model (`createBrowserSDL`) | throws, by design | `host.js:9008` unconditional `sdlDelayUnsupported()` — blocking would starve rAF pacing and message-loop input/presents *even where Atomics.wait is legal* (`host.js` ~8999-9007), so this is no longer strictly a "no JSPI" claim |
| gucOS process worker (`createSurfaceSDL`) — **where doom/quake actually run** (gucman packages, spawned as OS processes) | real cooperative sleep | todos/done/0224; `sdlDelay` at `host.js:7672`, wired at 8110/8287; proven by `tests/kernel/test_sdl_delay_e2e.js` |
| headless (`createNullSDL`) | real blocking sleep | `host.js:7100` (`canBlockSync` → `blockingSleepMs`) |

So: **recorded verdict YES, the comment is currently true as scoped** — the
constraint it names is real in the flavor it names. What it lacked was the
scoping itself: a reader would conclude blocking main loops are impossible for
game ports, which post-0224 is false in the flavor doom ships in. The comment
now names both flavors and points at 0224 (`vendor/doom/src/main.c`,
`DG_SleepMs`). Quake needs nothing: `sys_sdl.c:169` is a bare
`void Sys_Sleep (void) {}` with no constraint claim, and its header comment
describes mechanism, not a limitation.

**Is restructuring to a blocking loop worth anything? No.** The callback
structure runs correctly in all three flavors; a blocking loop would break the
standalone-browser flavor and buy nothing in the others (frame pacing there is
the kernel vsync already). No follow-up ticket warranted. No behavioural
change to DOOM or Quake; tests did not move (comment-only), and the gate ran
regardless because #142 shares the lane.

## #142 — every writing entry point now refuses a foreign-cwd launch

### The measured spawn-cwd table (the work the ticket said was the work)

Full survey (mine + a second exhaustive pass) over every spawn of the writers:

- **suite-runner children** run with `cwd: opts.dir` (`tests/lib/suite-runner.js:484`)
  → `tests/kernel` / `tests/browser` — in-tree. `tests/run.js:682` spawns suite
  runners with `cwd: ROOT`. The host suite spawns rows with no cwd → inherits
  the dispatcher's repo-root cwd. `tests/serve/*` are host-suite rows.
- **os/boot.js**: `drive.js` `driveBoot` passes **no cwd** (spawnOpts carries
  only input/timeout/encoding/maxBuffer) → inherits `tests/kernel`. The
  mkdtemp fixture dirs the ticket feared are only ever `--image=` ARGUMENTS,
  never cwds. Direct spawns (test_heavylock_e2e `cwd: ROOT` and
  `ROOT/tests/browser`; test_netsurf_http/test_curl/test_vsync_boot/
  test_os_apps/gcode/jobctl/vi e2es — all no-cwd) inherit the suite cwd.
  `tools/bench2x2/inos-startup.js` sets `cwd: repo` where `repo` is the tree
  whose own boot.js it spawns — same-tree by construction.
- **mkimage**: image-fixture (no cwd → runner cwd), test_image_determinism
  (`cwd: ROOT`), serve.js (no cwd; its harness parent os-harness inherits
  `tests/browser`), kernel gucman/seed/os_boot helpers (no cwd → `tests/kernel`),
  comguc build.mjs (`cwd: CC` — the c-compiler tree; deploys unaffected).
- **mkpkg**: serve-with-clang (`cwd: REPO_ROOT`), mkpkg_clang/rust (`cwd: ROOT`),
  mkpkg_isolation/source_packages/browser mjs legs (no cwd → in-tree runner
  cwds), kernel gucman lib (no cwd → `tests/kernel`), comguc (`cwd: CC`).
- **win32ports/win32rc/mkgit2srclib/mkmpgenhdr**: kernel-suite spawns inherit
  `tests/kernel`; run.py sets `cwd=ROOT_DIR`.
- **mksounds/mkgif/mkwebfixtures/build-libc-ext/os-drive×2**: zero harness
  spawns — hand-run only.

Conclusion: **every harness spawn is same-tree**; the guard fires only on
foreign-cwd hand launches, which is its purpose.

### Design call 1 — os/boot.js is GUARDED (option a)

The ticket sanctioned an exemption if a spawn cwd forced it. None does — the
feared fixture-dir cwd is a fixture-dir *argument*. Guarding boot.js closes
the two real holes: bare `node ~/git/c-compiler/os/boot.js` from a worktree
(re-bakes main's image), and hand-running a single kernel e2e from a foreign
cwd (bypasses the runner guard 0341 relies on). Placement: before the heavy
requires and before the heavy-lock join — refuse before loading a compiler or
taking a machine-wide lock (the 0341 order). Positive control: a full boot
(`echo 'echo BOOTOK' | node os/boot.js` from a kernel-suite-shaped cwd) baked
and booted green under the guard before the gate.

### Design call 2 — the writer list was wrong in both directions

- **`tools/os-drive.js` does not exist** (ticket + tree-guard header both
  named it). The real entry points are `tools/os-drive.mjs` and
  `tools/os-drive-headless.mjs`; both now guarded. Their screenshot writes are
  caller-path-relative, but they drive their OWN tree's serve/boot stack (and
  its bakes), and the `tools/os-drive-scripts/*.mjs` they host write
  cwd-relative REPO paths (`os/media/…`, `logs/…`) — the guard on the entry
  point anchors those too.
- **Four self-tree writers were missing** from the list and are now guarded:
  `build-libc-ext.js` (emits `libc-ext.js` at the repo root), `mkgif.js`
  (vendor/magicpoint/demo.gif), `mkwebfixtures.js` (NetSurf fixtures),
  `mkgit2srclib.js` (regenerates + **deletes** vendor/libgit2 headers in its
  flagless mode; its `--check` spawn inherits `tests/kernel`).
  `tools/libcprobe/probe.js` already carried the guard — prior art.
- **win32rc nuance recorded**: its writes are argument-relative (`-o`), so it
  is not a cross-tree writer per se; the guard catches the wrong-COPY launch
  (a stale tree's rc compiler emitting a committed .res into yours).

### Deliberately NOT guarded, with reasons

- **serve.js** — a writer by *delegation* only: it spawns the served tree's
  OWN mkimage (`path.join(dir, 'tools', 'mkimage.js')` where `dir` is the
  explicit root argument). The write choke is now guarded at mkimage, so a
  foreign-cwd `serve.js` over a stale image refuses loudly before listening.
  Serving another tree read-only via the explicit root argument is a
  legitimate use; guarding serve.js itself would refuse it. Known edge:
  serving tree A from a tree-B cwd with a stale image refuses even though the
  root was explicit — rare, and the printed `CC_ALLOW_FOREIGN_CWD=1` escape
  covers it.
- **net-bridge / net-bridge-ssh / ticket-bridge / idlemeter / peek-repro** —
  servers or stdout-only probes; no self-tree writes.

### Demonstrations (all measured, 2026-08-06)

- All 13 guarded entry points from `/private/tmp`: **exit 4** + the 0341
  refusal banner, each.
- Cross-tree proper (cwd in `~/git/c-compiler`, script in the batch-e
  worktree): exit 4.
- Same-tree and subdir cwd: pass through to normal behaviour (win32rc usage
  exit 2, mkgit2srclib `--check` exit 0).
- `CC_ALLOW_FOREIGN_CWD=1` from a foreign cwd: runs, still printing both
  trees.

### Liabilities

Base (196db0b5): OK — 43 entries. This tree: OK — 42 entries. L45 retired in
the #142 commit, same commit that rewrites its anchor line in
tree-guard.js's header.

## Kickoff corrections (measured vs believed)

1. `cc2wasmFlags` does not exist anywhere in the repo — the #119 investigation
   step it names cannot be performed as written; the flavor axis lives in
   host.js's instantiation-time backend selection instead.
2. `tools/os-drive.js` does not exist — os-drive.mjs / os-drive-headless.mjs.
3. The ticket's boot.js fear ("spawned from per-test fixture dirs") is
   measurably false — fixture dirs are image *arguments*; every spawn cwd is
   in-tree.
4. The ticket's writer list missed four self-tree writers (guarded here) and
   `tests/kernel/test_win32rc.js` does spawn win32rc (the ticket implied only
   committed-artifact regeneration; the spawn is cwd-safe regardless).
