# 0082 — Prebaked system-image fixture for the boot.js e2e family

- **Status**: open
- **Design**: this file (spawned from `todos/done/0081`'s measurements)

## Goal

0081 measured the kernel suite: 16 boot.js e2e files >30s account for
**97% of the suite's 1354s serial cost**, and essentially all of that is
each file re-baking an IDENTICAL system blob (compiling every seeded
source + vendor binary via compiler.js) into its private `--image=` tmp
pair. The browser sweep already dodges this — kernel-worker fetches a
prebaked `os/os-system.img` when present, which is why the full 15-file
sweep runs in ~70s — but headless boot.js has no prebake path.

Give boot.js (or the e2e tests) a bake-once fixture: first user of a
given manifest version bakes into a shared cache location; later users
COPY the blob (file copy ≪ bake) into their private image pair, keeping
test isolation intact (the root volume stays per-test).

## Plan

- Likely shape: boot.js, when `--image=` is missing/stale, checks a
  fixture blob (e.g. `build/test-kernel/fixture-system.img` or the
  existing `os/os-system.img`) before baking, and copies it if fresh.
- **Freshness must gate on INPUTS, not just `image.json` version**: a
  same-version blob baked before an uncommitted compiler.js / os/*.c /
  coreutils.json edit is stale — silently reusing it would make e2e
  runs test yesterday's binaries. Compare blob mtime against the bake
  inputs (compiler.js, host.js, os/, image.json, referenced vendor
  bins), or hash the manifest closure; when in doubt, re-bake.
- The same freshness check should guard the BROWSER prebake path: today
  a same-version-stale `os/os-system.img` is silently fetched by
  kernel-worker (0081 noted this; the sweep this session happened to
  have a fresh bake). Cheapest fix: os-sweep.mjs re-runs mkimage (or
  deletes a stale blob) before the sweep.
- Tests that deliberately exercise the bake path itself (test_os_boot's
  fresh/fresh-system legs) must keep really baking — opt-out flag.

## Acceptance

- Kernel suite wall-clock drops substantially again (0081 got 20min →
  6.5min via `-j4`; the 16 heavy files each carry ~40-60s of avoidable
  bake, so ~2x more is on the table).
- A stale-input fixture is never silently reused (prove it: touch
  compiler.js, rerun, observe re-bake) — in both the boot.js and the
  browser-sweep prebake paths.
- test_os_boot's bake-path legs still bake for real.
