# Handoff — start of thread (updated 2026-07-12; 0141 serve.js --clang overlay landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0141 (serve.js `--clang` overlay on-ramp) is DONE and staged/committed.**
`serve.js` gained a `--clang` flag (generic `--overlay=<id>`/`--overlays=a,b`
too) that folds the sibling `clang-simplified` `clang-apps` image overlay
(todos/0118) into the browser-served system blob **when the sibling artifact is
available** — a browser boot then shows the cc2wasm-built clang apps
(doom-clang, stl4, sdldemo). A missing sibling build is a normal opt-in-not-
satisfied state: it drops to base with a loud line, never errors.

**How it works** (all in `serve.js` + one new `os-common` helper):
- `resolveOverlayPlan()` resolves requested ids against `os/image.json`
  `overlays[]`, checks the referenced `overlay.json` exists (absent → loud
  `--clang requested but … not found — serving base image`, drop, continue
  base), reads producer/commitShort for the "folded in" line.
- Enabled overlays bake to a **sidecar keyed by the overlay set** —
  `os-system.<ids>.img` (gitignored via new `os/os-system.*.img`) — so a
  `--clang` serve and a plain serve never thrash each other's blob.
- `ensureSystemImage(dir, plan)` is now overlay-aware: new
  `os-common.bakedOverlays()` reads the blob's `OVERLAYS=` line (the second
  identity axis next to `bakedVersion`), and the gate rebakes when the desired
  overlay set ≠ baked set OR the sibling `overlay.json` mtime is newer than the
  blob (re-publish → rebake), on top of the version/input-mtime rules.
- The HTTP handler maps `/os/os-system.img` → the sidecar when active, so
  `kernel-worker.js` needs no change.

Dev log `logs/2026-07-12/0141-serve-clang-overlay.md`; item at
`todos/done/0141-serve-clang-overlay-flag.md`. **No image.json version bump** —
the only bake-input touched (`os/os-common.js`) is additive, blob byte-
identical.

## Tests

`tests/serve/test_clang_overlay.js` (registered in `tests/host/run.js`) —
hermetic + fast: a synthetic served tree with NO `tools/mkimage.js` (so the
freshness gate early-returns, no ~90s bake, no sibling dependency) exercises
flag parsing, the fold-in log + sidecar swap, the sibling-absent base fallback
+ loud line, and that a flagless serve neither logs nor swaps. All 6 checks
pass; full `node tests/host/run.js` green. Also manually verified against the
REAL sibling artifact: a `mkimage --overlay=clang-apps` bake folds in
doom-clang/stl4/sdldemo, `serve.js . --clang` serves the sidecar bytes and logs
`overlay clang-apps folded in (clang-simplified@5d95908)`, and touching
`overlay.json` newer forces the `input-stale … baking (+clang-apps)` decision.

## Carried limitation (pre-existing, NOT residue)

A persistent browser OPFS image only re-fetches on a `image.json` version bump
(the in-browser gate can't stat inputs — todos/0040/0082). So toggling `--clang`
on a browser that already holds a same-version OPFS blob won't pick up the
overlay until OPFS is cleared or the version bumps. This is the standing
browser-gate limitation for ANY same-version content change, not overlay-
specific; headless/fresh-OPFS + the todo's acceptance all work. No follow-up
filed (would duplicate the known gap).

## Gotchas carried forward (trimmed to the live ones)

- **Concurrent sessions exist: stage ONLY your own files**, and re-check HEAD
  before committing — it can advance mid-session. Reconcile shared files
  (`queue.json`, `image.json`) against the *current* HEAD.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (verified this time: staged blob has the
  edited "DONE" Status line).
- **Bump `image.json` `version` when you edit a seeded bake input** (`os/*.c/.h/
  .json/.rc`, `compiler.js`, `host.js`, `vendor/`): a persistent browser OPFS
  image only re-fetches on a version bump. Still **v72** (0141 didn't touch
  seeded content). (`.md`/`tests/`/`os-common.js`-additive are NOT bake-content
  inputs.)
- **`--stale-ok` / a pre-baked image runs the STALE binary** — when iterating on
  a seeded `.c`, drop `--stale-ok` or `rm` the image so boot.js re-bakes.
- Overlay bakes are ~90s and DIRTY-provenance (the sibling repo is dirty →
  warns, not fatal unless `--require-clean-overlays`).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. After 0141 the head is
**0146** (medium), then the 0083/0084 pair, **0079/0080**, **0052/0053**,
**0064** (WM browser sweep round 3 — the standing operator debt), and the
0133-0139 notepad-EDIT set. No open P0s.

## Operator-owed (browser)

**Playwright is not installed in this clone.** Two owners:
- **0064** — the standing WM browser-sweep debt (pointer-lock human check + the
  0094–0151 legs incl. the unrun `os-paint.mjs`). Run `node
  tests/browser/os-sweep.mjs` when Playwright is available.
- **0152** (new, filed by the 0141 audit) — a `--clang` **browser** boot that
  confirms the served overlay blob renders the clang apps (`/usr/bin/doom-clang`
  et al) in real Chromium. 0141's acceptance was met by the headless mount check
  (done + passing); 0152 owns the optional browser-render confirmation so it
  isn't lost. NOT folded into 0064 (that item is WM-scoped).

Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` (0055 —
boot REQUIRES worker WebGPU); for 0152 use a fresh OPFS profile so the browser
fetches the `--clang` sidecar rather than a base blob already in OPFS.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; the overlay design (todos/0118); 0013–0151's recorded decisions
(see todos/done/). **0141's call: a sidecar image keyed by the overlay set
(not reusing os-system.img) — so `--clang` and plain serves each keep their own
independently-fresh blob and never rebake on toggle; `bakedOverlays()` is the
guard that a sidecar carries the overlays it claims.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0141 serve.js --clang overlay
just landed; no open P0s, head is 0146). 0064 WM browser sweep still owes the
operator the pointer-lock check + the 0094–0151 browser legs; 0152 owns the
optional --clang browser-render check."
