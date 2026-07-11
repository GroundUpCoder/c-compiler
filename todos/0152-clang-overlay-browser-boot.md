# 0152 — Browser boot verification of serve.js --clang (clang-apps overlay renders)

- **Status**: open
- **Design**: this file; builds on todos/done/0141 (the serve `--clang` on-ramp)

## Background

todos/0141 landed `serve.js --clang`: it folds the sibling `clang-simplified`
`clang-apps` image overlay into the served system blob (sidecar
`os/os-system.<ids>.img`, mapped onto the `/os/os-system.img` fetch). 0141's
acceptance offered "a browser boot **OR** a headless mount check" — the headless
mount check was done and passed (the baked blob carries `/usr/bin/doom-clang` +
`/usr/share/menu/Games/doom-clang`, `os-release.overlays` lists `clang-apps`),
and the serve-path is regression-tested hermetically
(`tests/serve/test_clang_overlay.js`). What was NOT done — **Playwright is not
installed in the 0141 clone** — is an actual **browser** boot confirming the
served overlay blob renders the clang apps in a real Chromium. This item owns
that optional-but-valuable verification so it is not lost.

## Why separate from 0064

0064 is the WM/desktop bug-sweep session (its scope: drive the WM browser
suite). A `--clang` overlay boot is a serve-path/overlay concern, not a WM one —
tracking it here keeps 0064's scope honest.

## Plan

- With the sibling `../clang-simplified/out-image/overlay.json` present, run
  `node serve.js . <port> --clang` and boot `os/os.html` in real Chromium
  (`--enable-unsafe-webgpu --enable-features=Vulkan` — boot REQUIRES worker
  WebGPU, 0055). NB the persistent-OPFS gate only re-fetches on an `image.json`
  version bump (0040/0082), so use a FRESH OPFS profile (or clear storage) so
  the browser actually fetches the `--clang` sidecar rather than reusing a
  base-v72 blob already in OPFS.
- Confirm `/usr/bin/doom-clang` exists in the booted FS and launches (Start
  menu ▸ Games ▸ doom-clang, or `doom-clang` at the shell), and the other
  overlay apps (stl4, sdldemo) are present.
- Optionally add a browser leg (an `os-*.mjs`) if it can be made non-flaky and
  the sibling artifact can be assumed present in the operator's env; otherwise
  keep it a documented manual operator check (the artifact is optional, so a
  hard-required CI leg would be wrong).

## Acceptance

- A real-Chromium `--clang` boot shows the clang-built apps (doom-clang at
  minimum) launchable from the seeded menu/`/usr/bin`; note any flake vs the
  base boot in WM.md / a dev log.
- If a browser leg is added, it degrades gracefully (skips, not fails) when the
  sibling overlay artifact is absent.

## Non-goals

- No changes to the 0141 serve-path mechanism (done + tested); this is
  verification only.
- Do not build/trigger the sibling toolchain — consume the published artifact.
