# 0114 — Rebrand the OS as gucOS (groundupcoder OS)

- **Status**: open
- **Design**: `todos/OS.md` (north star — the thing being named);
  `todos/DISK-IMAGE.md` (os-release / image-version mechanics).

## Goal

The OS grown in `os/` has shipped under the placeholder name **wasm-os**.
Name it properly: **gucOS** (groundupcoder OS), everywhere a user or
agent sees a name. The compiler/repo keeps its own identity — this brands
the OS product, not `compiler.js`.

Sequenced after 0096 (the in-flight screensaver work touches `os/wm.c`,
`ctlpanel.c`, `image.json` — land that first so the sweep doesn't collide).

## Plan

Inventory (from `grep -rn wasm-os`, excluding historical logs/done items):

- **Boot-facing strings**: `os/os.html` — `<title>`, the boot-locked guard
  ("wasm-os is already running in another tab"), the no-WebGPU guard text.
- **os-release**: `os/os-common.js` bakes `NAME=wasm-os` into
  `/usr/share/os-release` → `NAME=gucOS` (consider adding
  `PRETTY_NAME="gucOS (groundupcoder OS)"`; `VERSION_ID` and the blob
  version gate are untouched by a NAME change, but the **image.json
  `version` must bump** so persistent browser OPFS images re-bake).
- **/proc/version**: `kernel.js` renders
  `Linux version 6.6.0-wasm (root@localhost) (cc wasm-os)` — rebrand only
  the builder token (`cc gucos`). The `Linux version …` prefix is
  deliberate compat surface (busybox procps parses Linux formats — 0043);
  uname sysname stays as-is for the same reason.
- **In-OS text**: `os/protoshell.c` banner; `os/win32/ctlpanel.c` System
  applet (comment + any rendered NAME line comes from os-release anyway).
- **Boot lock**: `os/kernel-worker.js` `BOOT_LOCK = 'wasm-os:' + images`.
  Renaming it means a pre-rebrand tab and a post-rebrand tab would not
  contend — acceptable one-time skew (same-build tabs still exclude), note
  it in the dev log.
- **Docs**: `README.md` §"The OS (os/)", `todos/OS.md`, `todos/DISK-IMAGE.md`
  os-release mention. Historical material (`logs/`, `todos/done/`) is NOT
  rewritten — logs are a journal, the old name there is the record.
- **Tests**: `tests/kernel/test_ctlpanel_e2e.js` asserts `NAME=wasm-os`;
  sweep the suites for other literals after the rename.

## Acceptance

- `grep -rn wasm-os` over the tree hits only `logs/`, `todos/done/`, and
  this item's inventory — no live code, manifest, or open doc.
- Browser boot shows the gucOS title; `cat /usr/share/os-release` in-OS
  shows `NAME=gucOS`; `cat /proc/version` keeps its `Linux version` prefix.
- `node tests/kernel/run.js` and `node tests/browser/os-sweep.mjs` pass
  (image version bumped, ctlpanel e2e updated).
