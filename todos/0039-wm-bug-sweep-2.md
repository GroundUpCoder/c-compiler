# 0039 — WM bug sweep, round 2

- **Status**: open
- **Depends**: best after 0038 lands (re-verify its fix under storm);
  not blocked by it
- **Design**: `todos/WM.md` "The desktop shell" (bug-sweep block — the
  repeatable format established by todos/done/0033)

## Goal

Second dedicated dogfood/verification session over the desktop surface
area, per the 0033 format. Output is repro tests + fixes + an updated
WM.md known-issues list — not a feature.

## Plan

- Drive the full browser suite in real Chromium (serially, incl.
  os-shell.mjs), noting flakes vs the 0033 baselines.
- Free-form storms: open-everything; drag/scale/maximize storms;
  `kill -9` storms (mid-drag, mid-resize, mid-audio); wm kill/respawn;
  VT flips mid-gesture; screen-shrink with maximized + scaled +
  minimized windows in play; NEW since round 1 — Start-menu spawn
  storms, desktop-icon dbl-click races, cycle-chord under load.
- Standing checklist (re-check every WM.md known-issues entry):
  - pointer-lock UX — HUMAN check (Playwright can't grant the lock):
    quake lock on click, ESC unlock, click re-lock, VT-switch release.
    Round 1 did not human-verify; round 2 must.
  - Dawn + SIGKILL (S3 caveat, SHRUNK in round 1) — retest on the
    current webgpu pkg before trusting the shrink.
  - os-gpubox adapter flake — quiet in round 1; recharacterize if seen.
  - taskbar always-on-top — should be FIXED by 0038; verify under storm
    and retire the entry if it holds.
- Discipline: every finding becomes a MINIMAL repro test FIRST
  (conformance-corpus rule), fixes land as separate commits referencing
  this item; verified-but-unfixed → WM.md known-issues with a repro.

## Acceptance

- Dev-log entry with findings, fixed/deferred split.
- New regression tests committed for everything fixed; WM.md
  known-issues list updated (entries re-dated, retired, or added).
- All suites green at close (unit, blockfs, kernel, browser sweep).
