# 0146 — extract shared test harnesses (browser + kernel-e2e boot driver)

- **Status**: open
- **Design**: this file. Surfaced by the 2026-07-12 test-infra audit
  (`logs/2026-07-12/queue-hardening-and-keymap.md`). Prerequisite that makes
  0083's browser-leg conversion tractable — 0083 is soft-`after` this.

## Goal

The *core* runner is good (`tests/lib/suite-runner.js`, `image-fixture.js` —
sound parallelism, checkpointed resume, shared prebake). The debt is in the
**per-test layer**: there is no shared per-test helper, so boilerplate is
copy-pasted across ~15 browser files and ~37 kernel e2e files. Extract it so
the 0083 event-wait conversion has ONE place to land.

## Plan

- **`tests/browser/lib/os-harness.mjs`**: Chromium launch (the
  `--enable-unsafe-webgpu --enable-features=Vulkan` incantation), serve.js
  spawn, `waitForServer()` (currently duplicated verbatim in os-boots.mjs:32,
  doom-renders.mjs:31, quake-renders.mjs:37, safari-renders.mjs:43), VT switch
  (`__osVtSwitch`), `__osScreen` geometry, and a `waitFor(page, cond,
  {timeout})` poll util (0083's "extract the ad-hoc poll" — but there is no
  shared lib to extract INTO yet; this creates it). Convert the os-*.mjs files
  to import it; behaviour must be byte-identical (goldens unchanged).
- **`tests/kernel/lib/drive.js`**: a `driveBoot(script, opts)` that does the
  `mkdtemp` + `--image=` pair + spawn `os/boot.js --quiet` + `.join('\n')`
  script piping + marker-grep that every e2e reimplements inline. This is the
  single seam the future `wmctl wait` (0083) integrates into.
- Keep the runners independently invocable; this is a per-test-layer refactor,
  no runner change.

## Acceptance

- One browser harness + one kernel boot-driver module, imported by the
  converted files; the duplicated `waitForServer`/launch/mkdtemp blocks are
  gone.
- Full kernel + browser suites green, goldens unchanged (pure refactor).
- 0083 can add `wmctl wait` in the driver and the browser `waitFor` in the
  harness, once each, instead of per-file.
