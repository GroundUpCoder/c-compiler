# 0118 — Optional opt-in image overlays (the consumer)

**What**: gucOS can now *optionally* fold a sibling-published, prebuilt
`overlay@1` manifest's files into the read-only system image at bake time —
real C/C++/SDL apps that this repo's `compiler.js` can't build, cross-compiled
ahead of time by `~/git/clang-simplified` (cc2wasm). This repo is only the
consumer: it never runs cc2wasm, never builds from the sibling — it reads the
published JSON, **verifies hashes**, plants bytes, and records provenance.

## Shape

- `os/image.json` grew a top-level `overlays[]` (sibling to `system`): one entry
  `clang-apps` pointing at `../clang-simplified/out-image/overlay.json` (repo-root
  relative), `default: false`. **Version stayed 65** — the key is inert on a base
  bake, so no re-fetch gate trip. (The plan's parenthetical said "bump when adding
  the key", but acceptance (a) demands the base bake stay identical, and adding an
  unread key changes zero baked bytes; the two conflict and inertness wins.)
- Flags in `tools/mkimage.js` **and** `os/boot.js`: `--overlay=<id>` (repeatable),
  `--overlays=all`, `--require-clean-overlays`. Unknown id → **exit 2 before any
  bake** (the explicit-opt-in point). boot.js forces a system re-bake when any
  overlay is requested (the prebaked fixture / reused blob are base-only).
- `os/os-common.js` is the single implementation shared by both tools:
  - `loadOverlays(specs, oio, requireClean, log)` — runs at the **top** of
    `bakeSystemImage`, BEFORE the ~minute seed, so a bad flag fails fast. Reads +
    parses each manifest, enforces schema `overlay@1` / id match / provenance.repo
    required / exactly-one-of `bin|text` / octal mode / **recompute sha256 + size
    and compare** for every `bin`. Dirty provenance → loud WARN (or fatal under
    `requireClean`).
  - `plantOverlays(mfs, loaded, log)` — after the seed: mkdir `dirs`, enforce
    parent-is-a-base-dir-or-listed, base-path-conflict-without-`override` (fatal),
    cross-overlay same-path (fatal), write bytes at mode, plant provenance at
    `/usr/share/overlays/<id>.json`. Returns a summary the baker stamps into the
    image identity: os-release `OVERLAYS=<ids>` + a `/usr/share/os-release.overlays`
    companion (`[{id, commitShort, dirty}]`).
  - `nodeOverlayIo(fs, path, crypto)` — the Node fs/path/crypto injection so
    os-common stays environment-neutral (the browser never applies overlays; it
    fetches a prebaked blob).

## Verified end-to-end against the REAL sibling

The sibling task `clang-simplified/0051` had already published
`out-image/overlay.json` (7 files, `repo.dirty: true`). `node tools/mkimage.js
--overlay=clang-apps` planted all 7 (doom **overrides** the base compiler.js doom —
439064 B cc2wasm build; plus stl4, sdldemo, DOOM1.WAD, three .desktop entries),
warned loudly about the dirty tree, and sealed. Booting that image and running the
cc2wasm-built **console** C++ demo `/usr/bin/stl4` printed correct STL map/set/
`std::function` output and exited 0 — a real prebuilt sibling binary running on our
`host.js`. The windowed DOOM (`wmctl shot`) was NOT driven this session (no
Playwright) → follow-up **0120**.

## Gotchas / decisions

- **The bake is NOT byte-deterministic**: BlockFS stamps inode mtimes from the
  wall clock, so two identical base bakes differ in ~24 bytes (8-byte-spaced inode
  time fields) → the seal hash differs too. So acceptance (a)'s "byte-identical to
  current output" was never literally true run-to-run, even pre-change. The real,
  testable invariant is **inertness**: `test_overlays.js` asserts the base
  os-release is the exact canonical 3-line string and that no overlay dir/file/
  companion exists; `test_os_boot.js` (the full base bake) stays green.
- **`--quiet` silences the dirty WARNING** (it rides the same `log` channel). The
  durable record survives in `os-release.overlays` (`dirty:true`), and overlay
  bakes are explicit `--overlay=` invocations, so this is an accepted trade — not
  worth threading a separate always-on stderr channel through the neutral
  os-common.
- **`loadOverlays` is pre-bake, `plantOverlays` is post-seed**: content/hash
  failures cost seconds; placement/conflict failures (which need the seeded base
  tree) cost the full bake. An early transient failure I hit was the sibling repo
  mid-rebuild (dirty) — a hash mismatch is *correctly* fatal.

## Tests

- `tests/kernel/test_overlays.js` (registered in `tests/kernel/run.js`): unit-scale
  bake over a tiny synthetic manifest (one trivial compile, ~0.1s) exercising a
  valid overlay (plant + provenance + identity + mode defaults), base-bake
  inertness, `override: true`, and **every** fatal rule (bad schema, id mismatch,
  missing manifest, sha256/size mismatch, bin+text, out-of-/usr, base conflict,
  parent-not-a-dir, cross-overlay conflict, requireClean-on-dirty) + dirty-warns.
- `test_os_boot.js` PASS (base bake path unchanged).
