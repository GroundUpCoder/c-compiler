# 0120 — Overlay windowed-app smoke leg: drive an --overlay=clang-apps DOOM via wmctl shot (browser + e2e)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/done/0118-image-overlays-opt-in.md` (the overlay consumer)

## Background

0118 landed the opt-in image-overlay consumer: `node tools/mkimage.js
--overlay=clang-apps` folds the sibling `clang-simplified` `overlay@1` manifest's
prebuilt binaries into the system blob (verify/plant/provenance, all fatal rules).
That session verified end-to-end against the **real** sibling artifact by booting a
`--overlay=clang-apps` image and running the cc2wasm-built **console** C++ demo
`/usr/bin/stl4` (STL map/set/std::function output, exit 0). It did NOT drive the
**windowed** DOOM (`/usr/bin/doom`, the cc2wasm build that `override: true`-replaces
the base compiler.js doom) through the WM — no Playwright in that env, and headless
windowed-app driving via `wmctl shot` wasn't wired for an overlaid image.

## Goal

A repeatable smoke leg proving an overlaid windowed app really renders: bake (or
reuse) a `--overlay=clang-apps` image, boot it, launch `/usr/bin/doom`, and assert a
real frame via `wmctl shot` (the `tests/kernel/test_os_apps_e2e.js` / `os-doom.mjs`
pattern) — plus that the overlay's cc2wasm doom (size ≠ the base doom) is the one
that ran.

## Plan

- Add a kernel-suite e2e (or extend `test_os_apps_e2e.js`) that bakes a throwaway
  overlay image (`--overlay=clang-apps`, gated on the sibling `out-image/overlay.json`
  existing — SKIP loudly if absent, like the webgpu-pkg gate) and drives doom via
  `wmctl shot`, asserting non-blank frame pixels.
- Optionally a `tests/browser/os-overlay.mjs` leg for the real compositor.
- Guard cost: the overlay bake is ~60s and the sibling artifact is dirty-tree by
  nature — the leg should tolerate a dirty overlay (warn, not fail).

## Acceptance

- With the sibling artifact present, the leg boots a `--overlay=clang-apps` image and
  captures a real DOOM frame from the overlaid `/usr/bin/doom`; without it, it SKIPs.
- The base (no-overlay) apps e2e is unchanged.
