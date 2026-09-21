# 0222 — notepad menu audit: every item exercised, silent no-ops made loud, regression e2e

- **Status**: done (2026-07-16) — all 24 menu items exercised in the booted
  OS: functional surface PASSES end to end; the three silent no-ops
  (Font.../Page Setup.../Print...) are loud `win32: unsupported` cancels
  now; EDIT WM_SETTEXT caret/view reset to START (real-EDIT contract —
  ctldemo selftest + os-touch pan leg updated off the old behavior); ^Z
  lands a loud EM_UNDO report (0135 stays the real fix); win32rc `\r`
  escape fixed + rc strings LF-normalized (About's "Palamarchukr");
  `tools/win32rc.js` mapped in the RULES table;
  `tests/kernel/test_notepad_menu_e2e.js` (68 checks, registered, stable
  3/3 under load) is the every-item regression sweep. Follow-up filed:
  0223 (ChooseFontW + WM_SETFONT). Image v102; kernel 74/74, sweep 27/27,
  projects 26/26; log: logs/2026-07-16/notepad-menu-audit.md
- **Design**: `todos/WIN32.md` (0211 fail-loud policy; EDIT status thread)

## Goal

User-flagged ("I don't think everything works"): exhaustively exercise every
menu item of the vendored ReactOS notepad in the booted OS, fix what's
broken, make genuinely-unsupported items fail LOUDLY per the 0211 policy,
and leave a committed e2e that clicks EVERY item so the coverage can't
silently rot (0211 was an audit record; the existing notepad e2e covers only
a subset of the menu).

## Plan

- Enumerate the real menu tree from `vendor/notepad/lang/en-US.rc` (24 items
  across File/Edit/Format/View/Help) and map each to its handler + veneer
  support.
- Drive every item agent-side (wmctl click/tree/wait) in a booted image;
  classify PASS / BROKEN / silent no-op.
- Fix the bounded breakages; file design-worthy items as their own todos
  (font dialog → 0223; undo buffer already 0135; wrap layout already 0133).
- Land `tests/kernel/test_notepad_menu_e2e.js` asserting each item's effect
  or its loud refusal.

## Acceptance

- Every menu item either works, is correctly grayed, or reports
  `win32: unsupported …` — zero silent no-ops.
- The menu-sweep e2e is in the kernel suite and green.
- Image version bumped; kernel suite + browser sweep green.
