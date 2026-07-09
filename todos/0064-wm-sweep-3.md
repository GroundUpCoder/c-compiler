# 0064 — WM bug sweep, round 3

- **Status**: open
- **Depends**: best after the Win32 wave (0057/0058) lands enough new WM
  surface to be worth sweeping; not blocked by it. **Requires an operator
  present** — the pointer-lock HUMAN check cannot be automated and cannot
  slip a third time.
- **Design**: `todos/WM.md` "The desktop shell" (bug-sweep block — the
  repeatable format established by todos/done/0033; round 2 =
  todos/done/0039)

## Goal

Third dedicated dogfood/verification session over the desktop surface
area, per the 0033 format. Output is repro tests + fixes + an updated
WM.md known-issues list — not a feature.

## Plan

- **MUST (deferred by BOTH prior rounds — do this FIRST, while the
  operator is present)**: pointer-lock UX human check (Playwright can't
  grant the lock): quake lock on click, ESC unlock, click re-lock,
  VT-switch release.
- Drive the full browser suite in real Chromium (serially, incl.
  os-shell.mjs), noting flakes vs the 0033/0039 baselines.
- Free-form storms per the round-2 list, plus NEW surface since:
  user32 windows (0058) if landed — HWND-tree windows under
  drag/scale/maximize/kill storms alongside SDL ones; Cairo/0061
  surfaces if landed; 0062/0063 compositor paths if landed.
- Standing checklist (re-check every WM.md known-issues entry):
  - Dawn + SIGKILL (S3 caveat) — retest on the current webgpu pkg.
  - os-gpubox adapter flake — recharacterize if seen.
  - Anything 0039 re-dated rather than retired.
- Discipline: every finding becomes a MINIMAL repro test FIRST
  (conformance-corpus rule), fixes land as separate commits referencing
  this item; verified-but-unfixed → WM.md known-issues with a repro.

## Acceptance

- **The pointer-lock human check actually performed** and its verdict
  recorded in the dev log — this is the round's non-negotiable.
- Dev-log entry with findings, fixed/deferred split.
- New regression tests committed for everything fixed; WM.md
  known-issues list updated (entries re-dated, retired, or added).
- All suites green at close (unit, blockfs, kernel, browser sweep).
