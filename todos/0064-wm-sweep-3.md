# 0064 — WM bug sweep, round 3

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WM.md` "The desktop shell" (bug-sweep block — the
  repeatable format established by todos/done/0033; round 2 =
  todos/done/0039)

## Goal

Third dedicated dogfood/verification session over the desktop surface
area, per the 0033 format. Output is repro tests + fixes + an updated
WM.md known-issues list — not a feature.

Best after the Win32 wave (0057/0058) lands enough new WM surface to be
worth sweeping — not blocked by it. **Requires an operator present** —
the pointer-lock HUMAN check cannot be automated and cannot slip a
third time.

## Plan

- **MUST (deferred by BOTH prior rounds — do this FIRST, while the
  operator is present)**: pointer-lock UX human check (Playwright can't
  grant the lock): quake lock on click, ESC unlock, click re-lock,
  VT-switch release.
- Drive the full browser suite in real Chromium (serially, incl.
  os-shell.mjs), noting flakes vs the 0033/0039 baselines. **The 0101
  taskbar-polish browser leg (os-shell.mjs: strip-menu render + outside-
  click/Esc dismiss, clock-hover datepop, Show Desktop reveal/restore) was
  authored but NOT run in its landing session (no playwright there) — run
  and eyeball it here. Likewise the **0151 long/spaced Desktop-icon launch
  leg** (os-shell.mjs: two spaced launchers dblclicked, winCount +1 each)
  authored without playwright — run it in this sweep.**
- Free-form storms per the round-2 list, plus NEW surface since:
  user32 windows (0058) if landed — HWND-tree windows under
  drag/scale/maximize/kill storms alongside SDL ones; Cairo/0061
  surfaces if landed; 0062/0063 compositor paths if landed.
- **Aero eyeball (0063 landed — needs the operator, like pointer
  lock)**: the pixel asserts cover mechanics only. Judge shadows /
  rounded corners / Aero Peek / the 200ms minimize fly / glass
  AESTHETICALLY at 60fps in real Chromium, and glass perf with many
  chromed windows (the blur chain reruns per glass window per frame —
  no fps counter exists yet, so this is a feel check).
- **Sound listen (0094 landed — operator again)**: the event clips are
  SYNTHESIZED (`tools/mksounds.js` — startup chime, error chord, ding,
  exclamation chimes) and every automated assert is ring-math; nobody
  has HEARD them. Boot with speakers on: chime once at desktop, error
  MessageBox chord, applet Test ding — judge levels/pleasantness,
  retune the generator if grating (re-run + commit the wavs).
- **Snap feel (0095 landed — operator)**: os-snap.mjs proves the
  mechanics; judge the GESTURE at 60fps — preview appear/replace
  latency while dragging along edges and corners, the 8px zone size
  with a real mouse (too twitchy? too grabby near the taskbar?),
  drag-off release feel (the size restores at RELEASE, not mid-drag —
  the recorded simplification; decide whether it reads as broken or
  fine), Win+arrow ladder on a snapped vs floating window.
- **Saver eyeball (0096 landed — operator)**: os-saver.mjs proves raise/
  dismiss/animation mechanically; judge the SAVERS at 60fps in real
  Chromium — starfield density/speed (128 stars, 0.008/frame — too
  sparse? too fast?), marquee zoom/scroll rate/legibility at desktop
  sizes, whether the black cut-in and dismissal feel instant; and the
  ctlpanel Screen Saver applet reads sanely (radio labels, Preview).
  Retune the wm.c constants if it feels off — they're all in one place
  (saver_zoom, the 4px scroll, SAVER_STARS, the z step).
- Standing checklist (re-check every WM.md known-issues entry):
  - Dawn + SIGKILL (S3 caveat) — retest on the current webgpu pkg.
  - os-gpubox adapter flake — recharacterize if seen.
  - Anything 0039 re-dated rather than retired.
  - os-quake's desktop-restore assert still hardcodes a 5% icon
    allowance (`nonTeal < n * 0.05` over [16,40,328,232]) — the same
    class that broke os-doom's 2% at 0048 close-out (todos/done/0074:
    icon-grid growth). It has margin today; repair to os-doom's
    pre-launch-baseline pattern when it trips or when /root/Desktop
    gains entries in that band.
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
