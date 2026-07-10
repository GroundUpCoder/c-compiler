# 0060 — win32: OSS GDI program ports + compile-test harness

- **Status**: done (2026-07-10) — corpus vendored (winmine/notepad/calc @
  ReactOS 1a706d7), harness `tools/win32ports.js` + committed report
  `os/win32/PORTS.md` (175 distinct symbols, the 0059+ backlog), `--check`
  wired into the kernel suite. Dev log
  `logs/2026-07-10/win32-port-corpus.md`.
- **Design**: `todos/WIN32.md` (references + "Corpus status"); this item
  (the target list)

## Landing notes (deviations from the sketch below)

- **sol is C++** (ReactOS solitaire = CardLib .cpp) — excluded; the raw-C
  scope note anticipated this. metapad/PuTTY not vendored yet: grow the
  corpus when the current demand log shrinks (each new app is a bin.json +
  ports.json entry away).
- **"launches + drivable" acceptance holds for the targets that link**
  (gdidemo/ctldemo controls — their e2e tests drive them via `wmctl
  click`); the vendored trio deliberately STOPS at the link stage — the
  missing-symbol report IS the deliverable, and 0059 implements to it.
  None of the trio is seeded into the OS image yet.
- **The Petzold ladder was not re-vendored**: 0057/0058 already consumed
  it as the bring-up order (gdidemo/ctldemo are the Petzold-style rungs,
  and they double as the harness's zero-missing control targets).
- The A/W split landed here as header architecture: implemented = ANSI
  generic names (veneer sources `#undef UNICODE`), W declared + generic→W
  maps under UNICODE, WCHAR = 2-byte UTF-16 (`u"…"`, TEXT() pastes the
  prefix), `_tcs*` as real 16-bit-CRT symbols (tchar.h documents why not
  wcslen). Control apps' wasm stayed byte-identical — no image bump.

## Goal

Vendor real **raw-C Win32/GDI** OSS programs and a harness that compiles /
runs them on the platform, logging which win32 symbols each needs. The
missing-symbol log is the authoritative backlog for 0057–0059 — we
implement to *real demand, not speculation*. (C only: the MFC/Qt/wx/.NET
majority is out of scope.)

## The corpus (what's out there, and its scale)

- **ReactOS** `base/applications` + `rosapps` — dozens of pure-C
  Win32/GDI apps (1–20 KLOC each) under a permissive-ish license, *built
  to run on a Win32 reimplementation*. The canonical corpus and primary
  source (and its own user32/gdi32 is a blueprint to read).
- **Petzold *Programming Windows*** samples — a graded C corpus (hello →
  GDI → controls → dialogs → comctl32) that sets the **bring-up order**
  for 0057/0058.
- **Standalone C/Win32**: `metapad` (small notepad replacement), **PuTTY**
  (raw-Win32 GDI terminal — the prestige milestone), `muPDF`/`gVim`
  (large, later).
- Scale note: the high-quality raw-C set is *dozens*; the long tail is
  *hundreds* with quality falling off. The C++ ecosystem (Notepad++,
  Sumatra, 7-Zip, Far, WinSCP) is unreachable.

## First wave (ported in this order)

1. **Petzold ladder** — the bring-up gate; drives 0057/0058 feature order.
2. **winmine** (ReactOS Minesweeper) — small, C, GDI bitmaps + dialog; the
   identity port (replaces the hand-written `0048` minesweeper).
3. **sol** (ReactOS Solitaire) — card bitmaps + drag.
4. **notepad** (ReactOS) — `EDIT` control + menus + comdlg32 (open/save/
   font); the real notepad (retires the MVU-editor question entirely).
5. **calc** (ReactOS) — dense control/dialog exercise.
6. **metapad** — first non-ReactOS real-world port.
7. **PuTTY** — the milestone: when it runs, the subset is genuinely real.

## Acceptance

- The harness compiles + launches each first-wave target; each is drivable
  headless via `wmctl click`/injection for one scripted interaction; a
  report lists per-app missing symbols (the 0057–0059 backlog).
