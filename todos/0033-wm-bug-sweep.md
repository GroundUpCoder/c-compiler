# 0033 — WM bug sweep, round 1

- **Status**: open
- **Depends**: best after 0028/0029 land (new features are where the
  bugs will be); not blocked by them
- **Design**: `todos/WM.md` "The desktop shell" (bug-sweep block —
  the repeatable format; later rounds allocate new numbers)

## Goal

One dedicated dogfood/verification session over the whole desktop
surface area. Output is not a feature: it's repro tests + fixes + an
updated known-issue list.

## Plan

- Drive the full browser suite in real Chromium (`tests/browser/*.mjs` —
  all manual tier), noting anything flaky vs 2026-07-08 baselines.
- Free-form storms: open-everything sessions; drag/scale/maximize
  storms; `kill -9` storms (incl. mid-drag, mid-resize, mid-audio);
  wm kill/respawn; VT flips mid-gesture; screen-shrink with maximized +
  scaled + minimized windows in play.
- Standing checklist (from the 2026-07-08 sweep of dev logs):
  - pointer-lock UX — the one thing Playwright cannot exercise
    (Chromium denies CDP-gesture lock): human-verify quake lock/unlock/
    re-lock, ESC, VT-switch release.
  - os-gpubox adapter flake (environmental — recharacterize, don't fix).
  - Dawn + SIGKILL process abort (S3 caveat — retest on current webgpu
    pkg; maybe the accepted risk shrank).
  - snake's double-`q` exit quirk (EOF-spinning prompt loop).
- Discipline: every finding becomes a MINIMAL repro test FIRST
  (kernel/browser suite as appropriate — conformance-corpus rule),
  fixes land as separate commits referencing this item.

## Acceptance

- Dev-log entry (`logs/`) with findings, fixed/deferred split.
- New regression tests committed for everything fixed; anything
  verified-but-unfixed lands on the WM.md known-issue list with a repro.
