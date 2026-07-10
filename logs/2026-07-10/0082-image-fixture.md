# 0082 — prebaked system-image fixture + the input-freshness gate

0081 measured it: 16 boot.js e2e files re-baking an IDENTICAL system blob
carried 97% of the kernel suite's serial cost. 0082 makes materialization a
file copy and — the other half of the item — makes *staleness* mean the
right thing everywhere on the Node side.

## What landed

- **`newestBakeInput()` (os-common.js)** — the input-freshness scan: newest
  mtime across everything that can change the blob's bytes — compiler.js,
  host.js, the os/ tree, and the manifest system section's closure (each
  `project` bin.json expanded through its `deps`, whole project directories
  walked; each `bin` blob statted). ~2,500 files, 6–25ms. Excluded because
  they can't change blob bytes: `*.img`, `*.md`, dotfiles, and os/'s
  runtime-only files (os.html, boot.js, the workers, compositor.js) — so
  0070-style os.html iteration won't force pointless re-bakes. Directory
  granularity deliberately over-invalidates: "when in doubt, re-bake" is
  the cheap direction.
- **boot.js**: the version gate became version + input freshness. A blob
  *newer* than the manifest is still kept unconditionally (upgrade = swap
  the blob — the input gate must never clobber a swapped-in upgrade); a
  blob at exactly the manifest version whose mtime is older than any bake
  input re-materializes. Materialization prefers **installing** a prebaked
  fixture (default `os/os-system.img`, `--fixture=PATH` overrides) —
  superblock-last copy, kernel-worker's crash discipline — when the fixture
  is itself version-current and input-fresh. `--no-fixture` forces a real
  bake (the bake-path tests), `--fresh-system` implies it (its one purpose
  is a real re-bake), `--stale-ok` skips the input check (dev escape
  hatch). Boot log mode is now `installed`/`baked`/`reused`.
- **mtime discipline**: bakers stamp the blob's mtime with the bake *start*
  time (an input edited mid-bake may or may not be reflected — it must
  read newer than the blob); installs carry the fixture's mtime along.
  mkimage now bakes to `<out>.tmp-<pid>` and publishes with an atomic
  rename, so a concurrent fixture copy or browser fetch never sees a
  half-bake (and concurrent mkimages are last-writer-wins instead of
  corrupting).
- **serve.js** — the browser-path half. Its 0040 version gate now also
  checks input freshness before listening, because kernel-worker *cannot*
  (no way to stat repo files from a worker): a version-current but
  input-stale `os/os-system.img` was previously fetched silently by every
  fresh browser boot. One gate at serve time covers the sweep and manual
  browser use alike.
- **`tests/lib/image-fixture.js`** + pre-steps: `ensurePrebakedImage()`
  re-bakes the repo fixture once, visibly, when missing/version-stale/
  input-stale. tests/kernel/run.js calls it only when the (filtered) run
  contains rows tagged `IMG` (the 15 fixture consumers — test_os_boot is
  deliberately untagged: it IS the bake-path test and passes
  `--no-fixture`); os-sweep.mjs calls it unconditionally so the one bake
  lands before Chromium instead of inside the first test's timing.
- **test_os_boot.js** grew the 0082 legs (run last — they age mtimes):
  fixture install (no bake, OS compiles), clean reuse, input-stale private
  blob re-materializes, `--stale-ok` overrides, input-stale fixture is
  bypassed with a real bake. Staleness is simulated with `utimes` aging —
  same comparison as touching compiler.js, without mutating repo files
  under a possibly-parallel suite. The literal "touch compiler.js" case
  was proven by hand (both stale log lines + real bake; mtime restored).

## Measured

- Boot of a fresh `--image=` pair: **~0.16s** (install + user seed) vs the
  ~40–60s private bake it replaces. test_ctlpanel_e2e standalone: 13.7s.
- Full kernel suite at `-j4`: **165s, 40/40** (0081's baseline: 393s —
  the 16 heavy files each carried an avoidable ~40-60s bake;
  test_os_boot, which really bakes by design, is now the long pole).
- blockfs suite: 15/15 (unaffected, sanity).
- Browser sweep: 15/15 in 74s after a `[fixture] fresh (v43)` pre-step
  check.

## Gotchas / decided

- The input gate keys the *reuse* path only at `version == manifest`;
  `version > manifest` is reused untouched, or the upgrade contract dies.
- A persistent browser OPFS image still only re-fetches on a *version*
  bump — the in-browser gate can't stat inputs. So the "bump image.json
  version after editing seeded sources" rule STAYS for interactive
  browser work; the headless/test/serve paths now self-heal without it.
- test_os_boot runs its aging legs last: they leave the first image pair
  input-stale on purpose, so nothing may boot it afterwards.
- boot.js's default run (`node os/boot.js`, no `--image=`) has
  imagePath == fixture path; the fixture branch self-skips and it bakes
  in place — the fixture refresh IS the default dev loop.
