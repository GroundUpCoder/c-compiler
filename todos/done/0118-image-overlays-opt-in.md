# 0118 — Optional opt-in image overlays: apply a sibling-published overlay@1 manifest in mkimage (flag-gated)

- **Status**: DONE (2026-07-11). Consumer landed: `overlays[]` in `os/image.json`
  (version kept at 65 — the key is inert, base bake byte-identical);
  `--overlay=<id>`/`--overlays=all`/`--require-clean-overlays` in `tools/mkimage.js`
  + `os/boot.js`; `loadOverlays`/`plantOverlays`/`nodeOverlayIo` in `os/os-common.js`
  wired into `bakeSystemImage` (verify-before-bake, then plant + provenance at
  `/usr/share/overlays/<id>.json` + os-release `OVERLAYS=`/`os-release.overlays`).
  Every frozen fatal rule enforced. Verified END TO END against the REAL sibling
  `clang-simplified` artifact: `--overlay=clang-apps` plants 7 files (doom overrides
  the base doom, stl4, sdldemo + assets + .desktop), and the cc2wasm-built console
  demo `/usr/bin/stl4` boots and runs (STL output, exit 0). Tests:
  `tests/kernel/test_overlays.js` (unit-scale bake, all fatal paths, base inertness).
  Follow-up **0120** owns the windowed-DOOM `wmctl shot` browser/e2e smoke leg (not
  driven this session — no Playwright). Acceptance (a)'s literal "byte-identical
  (same seal)" is unmet — the baker stamps wall-clock inode mtimes, so no bake is
  blob-reproducible; 0118 asserts inertness instead, and **0121** owns making bakes
  deterministic. Dev log `logs/2026-07-11/0118-image-overlays.md`.
- **Difficulty**: medium
- **Design**: this file
- **Sibling task**: `clang-simplified` repo `todos/0051-overlay-image-artifacts-publisher.md` (the *producer*). This task is the *consumer*. They share the **frozen `overlay@1` contract** reproduced verbatim below; neither task needs to read the other's repo to be done.

## Background (read first — full context, no prior conversation assumed)

This repo (`c-compiler` / **gucOS**) bakes a read-only system image
(`os/os-system.img`) from a manifest (`os/image.json`) via `tools/mkimage.js`,
which calls `os-common.js`'s `bakeSystemImage(...)`. Manifest file entries today
dispatch two ways:

- `{ "c": "protoshell.c" }` — a single C source compiled at bake time by this
  repo's own compiler (`compiler.js`).
- `{ "project": "vendor/busybox/bin.json" }` — a multi-file build manifest built via
  the `buildProject` hook `mkimage.js` injects into `bakeSystemImage`.

`mkimage.js` also injects a `readBinary(path)` hook — a path for planting **prebuilt
binary bytes** into the image without compiling. `os/boot.js` bakes the same blob
on demand (missing/stale image) from the same `image.json`; the browser
(`os/kernel-worker.js`) fetches the prebaked `os-system.img` + `image.json`.

There is a **sibling repo** `~/git/clang-simplified` — a buildless clang→wasm
toolchain (`cc2wasm`) that can compile real **C++/STL/SDL** programs (things this
repo's `compiler.js` cannot) to `.wasm` that runs on our `host.js`. It has already
built the flagship **DOOM** to a spawnable `.wasm` headlessly.

**The goal of this two-repo effort:** let the gucOS image *optionally* include real
C/C++ apps that only `cc2wasm` can build, **cross-compiled ahead of time** in the
sibling repo and shipped here as **prebuilt** binaries + a manifest. This repo does
**not** run `cc2wasm`, does not build anything from the sibling, and gains only a
thin, well-contained consumer.

**Design decisions already locked with the user (do not relitigate):**

1. **Prebuilt artifacts, not build-on-demand.** This repo's bake must NEVER trigger
   the sibling's 30–40-min compiler build. It only reads the sibling's published
   JSON, verifies hashes, and plants bytes.
2. **Opt-in, flag-gated, never silent.** Overlays are **off by default**; the base
   bake with no overlay flag must stay **byte-identical to today**. An overlay is
   applied only when its flag is passed. If a flag requests an overlay that can't be
   found or fails verification, the bake **fails loudly** — no quiet degradation.
   (The user explicitly dislikes build scripts that silently look for a thing and
   degrade; requiring an explicit flag forces the dev to acknowledge it.)
3. **Reproducibility is mandatory.** The overlay carries **version + commit + dirty**
   provenance; this repo records it into the baked image so the image is
   self-describing.
4. The **sibling owns the decision of what to include** — the `overlay.json` *is*
   that decision. This repo never enumerates the sibling's projects; it applies a
   manifest.

This task = the **consumer**: declare available overlays in `image.json`, add the
opt-in flag + apply/verify/plant/record logic in `mkimage.js` / `os-common.js`.

## Goal

Add flag-gated, verifying, provenance-recording overlay support to the image bake so
that `node tools/mkimage.js --overlay=clang-apps` folds a sibling-published
`overlay@1` manifest's prebuilt files into the image, while a plain
`node tools/mkimage.js` remains byte-identical to today.

## The `overlay@1` contract — FROZEN (identical in the sibling task)

This is the **only** cross-repo interface. If it must change, both tasks change
together and the version bumps to `overlay@2`. A sample artifact this repo must
consume:

```jsonc
{
  "schema": "overlay@1",          // refuse any other major
  "id": "clang-apps",             // MUST equal the image.json overlay id it's applied under

  "provenance": {                 // REQUIRED — the reproducibility spine
    "producer": "clang-simplified",
    "toolchain": "cc2wasm",
    "builtAtUtc": "2026-07-11T20:15:00Z",
    "artifactRoot": ".",          // dir holding the `bin` payloads, RELATIVE to this file

    "repo":     { "commit": "<full-sha>", "commitShort": "<short>", "dirty": false, "branch": "main" },
    "compiler": { "elf": "out-wasm/llvm", "builtFromCommit": "<full-sha|unknown>", "dirty": false },
    "libc":     { "vendoredFromRepo": "c-compiler", "vendoredFromCommit": "<full-sha|unknown>" }
  },

  "dirs": [                       // dirs to ensure before planting; under /usr (or a base-declared mount)
    "/usr/share/menu/Games",
    "/usr/share/doom"
  ],

  "files": {                      // absolute OS path -> entry; exactly one of `bin` | `text`
    "/usr/bin/doom": {
      "bin": "doom/doom.wasm",    // path under artifactRoot; plant verbatim
      "mode": "0755",             // octal string; default 0755 under /usr/bin, else 0644
      "sha256": "<hex>",          // REQUIRED for every `bin`; VERIFY before planting
      "size": 1245184,            // REQUIRED for every `bin`
      "build": { "project": "doom", "cc2wasmFlags": ["--sdl","-Isrc","-INuked-OPL3"], "sourcePin": { "repo": "doomgeneric", "commit": "<hex|unknown>" } }
    },
    "/usr/share/doom/DOOM1.WAD": {
      "bin": "doom/DOOM1.WAD", "mode": "0644", "sha256": "<hex>", "size": 4196020, "asset": true
    },
    "/usr/share/menu/Games/doom.desktop": {
      "text": "[Desktop Entry]\nName=DOOM\nExec=/usr/bin/doom\nCategories=Games;\n", "mode": "0644"
    }
  }
}
```

**Frozen rules this repo (the consumer) MUST enforce:**

- `schema` must be exactly `"overlay@1"` → else fatal. `id` must equal the
  `image.json` overlay entry's `id` it's applied under → else fatal.
- Each file entry has exactly one of `bin` | `text` → else fatal.
- Every `bin`: resolve under `provenance.artifactRoot` (relative to `overlay.json`),
  read bytes, **recompute sha256 + size and compare** → mismatch is fatal.
- `mode` is an octal string; default `0755` under `/usr/bin`, else `0644`.
- File paths absolute, under `/usr` (or a base-declared mount); each file's parent
  is a base dir or listed in the overlay's `dirs` → else fatal.
- A target path already present in the base image is **fatal unless the entry sets
  `"override": true`**. Two enabled overlays targeting the same path → fatal.
- `provenance.repo` required. If `repo.dirty` (or `compiler.dirty`) is true → **warn
  loudly** by default; a `--require-clean-overlays` flag promotes it to fatal.

## Plan

1. **Declare overlays in `os/image.json`** — a new top-level `overlays` array
   (sibling to `system`), each entry optional and default-off:
   ```jsonc
   "overlays": [
     {
       "id": "clang-apps",
       "description": "C/C++ apps cross-compiled by the sibling clang-simplified (cc2wasm) toolchain",
       "manifest": "../clang-simplified/out-image/overlay.json",  // relative to repo ROOT; absolute also allowed
       "enableFlag": "clang-apps",
       "default": false
     }
   ]
   ```
   External overlays MUST be `default: false`. (Bump `image.json` `version` when you
   add the `overlays` key.)

2. **Flags in `tools/mkimage.js`** — parse `--overlay=<id>` (repeatable),
   `--overlays=all`, and `--require-clean-overlays`. Collect the requested id set and
   pass it into the bake (see step 3). Unknown id (not declared in `overlays[]`) →
   usage error (exit 2). Keep the existing `--out=`/`--manifest=`/`--quiet` intact.
   Update `os/boot.js` to accept the same flags **optionally** (so a headless
   on-demand bake can opt in too); default remains no overlays.

3. **Apply logic in `os/os-common.js`** — implement an `applyOverlays(...)` step and
   call it from within (or right after) `bakeSystemImage`, driven by a new option in
   the opts object, e.g. `opts.overlays = [{ id, manifestPath, artifactRootAbs }]`
   resolved by the caller from `image.json` `overlays[]` ∩ requested ids. Putting it
   in `os-common.js` (not only `mkimage.js`) means both `mkimage.js` and `boot.js`
   share one implementation. For each enabled overlay:
   - Resolve `manifest` path relative to repo ROOT. **Missing while requested →
     fatal** with an actionable message ("overlay 'clang-apps' requested but
     `<path>` not found — build it in the sibling: `node wasm/tools/mk-overlay.mjs`").
   - Parse; enforce every frozen rule above (schema/id/one-of/hash/paths/conflicts).
   - `mkdir -p` the `dirs`; plant each `bin` via the existing `readBinary`-style seed
     path (read verified bytes → write into the BlockFS at the target with `mode`);
     write each `text` inline.
   - Record provenance into the image (step 4).
   - Return a summary for the caller to log.

4. **Bake provenance into the image (self-describing image).**
   - Plant the overlay's full provenance verbatim at `/usr/share/overlays/<id>.json`.
   - Extend the image identity: alongside the existing `/usr/share/os-release`
     manifest-version, record the applied overlays as
     `overlays=[{id, commitShort, dirty}]` (a new os-release line/field, or a
     companion `/usr/share/os-release.overlays`). This lets a browser boot and CI
     distinguish a base image from a `+clang-apps` one, and makes the sealed image's
     identity reflect the overlay. (`os-common.js` `bakedVersion` / the seal check
     stays authoritative for the base; overlays are additive identity.)

5. **Logging (loud, per the design).** On apply, log e.g.
   `[mkimage] overlay clang-apps: 9 files, 12.4 MiB, clang-simplified@4708ae6 (clean)`.
   On a dirty overlay: `[mkimage] WARNING overlay clang-apps built from a DIRTY tree
   — not reproducible`. On no overlay flag: no new output (base bake unchanged).

6. **Tests** — add to the existing `tools/queue.test.js` neighborhood / bake tests:
   (a) base bake with no flag is byte-identical to the pre-change baseline (seal +
   version unchanged); (b) a fixture `overlay@1` manifest + a tiny prebuilt payload
   applies, plants files, and records provenance; (c) each fatal path is exercised —
   unknown id, missing-manifest-while-requested, sha256 mismatch, base-path conflict
   without `override`. Keep the seal-verify (`tests/blockfs/fsck_v4.js`) green.

## Acceptance

- `node tools/mkimage.js` (no overlay flag) bakes an image **byte-identical** to the
  current output (same seal + version) — overlays are truly inert by default.
- `node tools/mkimage.js --overlay=clang-apps`, pointed at a valid sibling
  `out-image/overlay.json` (real or fixture), plants its files, verifies every
  `sha256`, records provenance at `/usr/share/overlays/clang-apps.json`, notes the
  overlay in the image identity, and logs a loud one-line summary.
- All four fatal paths fail loudly with actionable messages: unknown id;
  requested-but-missing manifest; sha256/size mismatch; base-path conflict without
  `override`. A dirty overlay warns (and is fatal under `--require-clean-overlays`).
- End-to-end (with the sibling task landed): a `--overlay=clang-apps` image boots and
  **DOOM launches** from `/usr/bin/doom`; the base image still boots unchanged.
- Seal verification stays green; the bake tests above pass.

## Coordination

- **Sibling:** `clang-simplified` `todos/0051-overlay-image-artifacts-publisher.md`
  (producer — emits `out-image/overlay.json` + hashed binaries + provenance). Both
  queued **P0 / next-up** by user request specifically so they're worked as focused
  units, not raced against other parallel edits.
- **Order independence:** safe to land in either order. This consumer's support is
  inert until its flag is passed, so it can land first with no behaviour change; the
  producer emits a standalone artifact. Develop/test against the **frozen `overlay@1`
  sample above** (or a checked-in fixture) — do not block on the sibling repo being
  present.
- If a real need forces a schema change, bump to `overlay@2` and update **both**
  tasks together.

## Non-goals / guardrails

- Do **not** invoke `cc2wasm` or build anything from the sibling here — prebuilt only.
- Do **not** make overlay application depend on mere directory existence — it must be
  flag-gated (the whole point).
- No change to base-image behaviour when no overlay flag is passed.
- No in-OS/in-browser compilation (that's the sibling's separate 0030 epic).
