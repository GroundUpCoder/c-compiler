# 0222 — notepad menu audit: every item exercised, silent no-ops made loud, regression e2e

- **Status**: open
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
