# 0274 — EDIT control: expand '\t' to tab stops (tabs render as '?' in notepad)

- **Status**: done (surfaced 2026-07-21 while opening a .mgp deck in notepad)
- **Design**: `todos/WIN32.md` (EDIT status). Umbrella **0133**
  (edit-control-completeness) — a 5th plain-EDIT gap alongside 0134–0137.
- **Difficulty**: medium

## Goal

A literal TAB (`0x09`) in text displayed by the user32 multiline EDIT control
renders as a **`?`**, not as whitespace advancing to the next tab stop. Repro:
open `vendor/magicpoint/decks/talks/posix-on-wasm.mgp` in notepad — every
bullet line is indented with a real tab (MagicPoint's `%tab 1`/`%tab 2`
tab-level convention; verified: lines 26/86 begin with `\t`), and each shows a
leading `?`.

Root cause is a two-part gap, both real:

1. **`edit_proc` (`os/win32/user32.c`) never expands tabs.** Its draw / caret /
   hit-test path treats `\t` as an ordinary character; there is no tab-stop
   logic (no `DT_EXPANDTABS`-equivalent, no `EM_SETTABSTOPS`). Real Win32 EDIT
   expands tabs to tab stops (default = every 8 dialog-unit-derived columns,
   or the stops set via `EM_SETTABSTOPS`).
2. **`gdi32.c:353` maps every control char to `?`:**
   `if (cp < 32) cp = '?'; /* control chars, term's rule */`. So once a raw
   `\t` reaches the glyph layer it is drawn as `?`. That rule is fine as a
   *last resort* — the fix is to expand the tab in the EDIT control BEFORE it
   ever reaches gdi32, not to change the `?` rule (term relies on it).

**Is notepad broken?** Yes — this is an EDIT-control veneer gap, not a problem
with the deck (the tabs are genuine) and not a gdi32 bug. Notepad delegates all
text layout to the EDIT control; once EDIT expands tabs, notepad shows the deck
correctly with no notepad-side code.

## Plan

- Add tab-stop expansion to `edit_proc`'s line measurement, drawing, caret x↔
  column mapping, and mouse hit-testing so a `\t` advances to the next tab stop
  (default 8-column-equiv; wire `EM_SETTABSTOPS`/`EM_GETTABSTOPS` if cheap, but
  the default-stop behaviour is the must-have). Keep selection/click accuracy
  correct across tabs.
- Confirm the fix is in the shared EDIT control so every consumer benefits
  (notepad, fileman boxes, ctldemo). Coordinate with 0136/0137 (scroll/wrap)
  since tab width feeds line-width / horizontal metrics.
- Leave `gdi32.c:353` as-is (term's control-char rule stays).

## Acceptance

- Open the posix-on-wasm deck (or any tab-indented file) in notepad: leading
  tabs render as aligned whitespace to the tab stops, no `?`.
- Caret arrow-keys and mouse clicks land on the correct column across tabbed
  lines; selection spanning tabs highlights correctly.
- A focused EDIT e2e: insert text with `\t`, assert the drawn caret advance /
  column mapping matches the tab stop (not one glyph), and no `?` glyph is
  emitted for `\t`.
- No regression in existing notepad / EDIT legs; term's `?`-for-control-char
  behaviour unchanged.
