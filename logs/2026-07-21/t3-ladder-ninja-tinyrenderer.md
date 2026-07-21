# T3 ladder (c-compiler side): ninja-clang + tinyrenderer-clang packages + e2e

Tier 3 of the C++ port ladder (`todos/CPP-LADDER-PROPOSAL.md`; sibling dev
log has the port/toolchain story — this is the packaging/e2e side).

## What landed here

- **`packages/tinyrenderer-clang.json`** — the SDL spinning-head demo. Its
  model assets ride a NEW mkpkg entry type, **`clangFile`**: any absolute
  `/usr` overlay payload (here the 4 head-model files the overlay installs
  at `/usr/share/tinyrenderer/`), pulled through the SAME `loadOverlays`
  sha256 verifier and `--clang` gating as `clangApp` — the Part II
  guardrails hold by construction (a `clangFile` without `--clang` throws;
  base mkpkg never sees the def thanks to `requires`). The Demos menu entry
  is a `tinyrenderer-demo` launcher passing the packaged model path (the
  etl-tests precedent — the binary's built-in default points at the
  overlay's `/usr/share` install, which a gucman install doesn't have).
- **`packages/ninja-clang.json`** — the build tool; bin-only, deliberately
  NO menu entry (a shell tool has no double-clickable surface).
- **`tests/kernel/test_clang_pkgs_e2e.js` 26 → 39 checks**, two new legs:
  - *tinyrenderer*: window appears, self-quits at the 12-frame limit, and
    the in-OS checkpoint series is **byte-exact vs the sibling harness
    golden** — same binary bytes + same model bytes render identically on
    bare host.js and on the kernel's brokered fs (the determinism
    capstone; the sibling-side story of the `-ffp-contract=off` find is in
    its dev log).
  - *ninja* (THE killer leg): a quoted-heredoc `build.ninja` + `hello.c`
    in `/tmp/nb`; `ninja-clang` spawns `/bin/sh -c "cc hello.c -o hello"`
    through the posix_spawn broker (`[1/1] CC hello`, exit 0), the
    product prints and exits 0, and a SECOND `ninja-clang` says
    `ninja: no work to do.` — mtime/stat incremental semantics on the
    brokered fs. "Real builds inside gucOS" is no longer aspirational.
- Base purity re-verified: plain `node tools/mkpkg.js` indexes and pools
  ZERO `-clang` packages.

## Notes for the merger

- No image bump, no deploy — the `*-clang` channel is optional-install
  only; base bytes unaffected (mkpkg/os-common changes are additive:
  `clangFile` parses only under `--clang`).
- The e2e needs the sibling overlay republished at least once after the
  sibling's T3 merge (`node wasm/tools/mk-overlay.mjs`) — `clangApp`/
  `clangFile` freshness keys on `overlay.json`'s mtime.
- Heredoc gotcha recorded in the test: ninja's `$in`/`$out` must reach
  `build.ninja` unexpanded — the script uses `<<'NINJA'` quoted heredocs.
