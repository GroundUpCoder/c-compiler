# 0150 — emacs line-editing bindings in GUI text fields (macOS mode)

- **Status**: done (shipped with 0149 — system keyboard scheme, image v124;
  was: mass-deferred 2026-07-12)
- **Design**: `todos/KEYMAP.md`. Depends on 0149 (the scheme + `os/keys.h`
  resolver). This is the *payoff* piece of the keyboard-scheme work.

## Goal

In **macOS mode**, ⌘ owns the edit verbs, which frees the entire Ctrl row for
emacs line-editing in GUI text controls — exactly how Cocoa's NSTextField
behaves. Today user32's EDIT has Home/End nav but **no emacs bindings**
(`os/win32/user32.c:669` just turns Ctrl+letter into a raw control char). Add
the emacs subset, gated on the scheme so Windows mode is unaffected (Ctrl there
is the verb modifier and must stay so).

Terminal already has these (hush readline) — this item is GUI-only.

## Plan

- Extend `os/keys.h` (0149) with the motion/edit actions: `KA_LINE_START`
  (^A), `KA_LINE_END` (^E), `KA_CHAR_FWD` (^F), `KA_CHAR_BACK` (^B),
  `KA_DELETE_FWD` (^D), `KA_WORD_DELETE_BACK` (^W), `KA_KILL_LINE` (^K),
  `KA_KILL_TO_START` (^U), `KA_NEXT/PREV_LINE` (^N/^P) — populated only in the
  macOS table.
- Implement them in user32.c EDIT keydown over the existing `EditState`
  caret/selection machinery (`edit_line_start`/`edit_line_end` already exist at
  `:3117`/`:3342`). Start motion + delete-word/kill-line; a kill-ring (^K/^Y
  yank) is a follow-up, not v1.
- Multiline vs single-line: ^N/^P only meaningful in multiline EDIT (notepad);
  no-op in single-line.

## Acceptance

- macOS mode: ^A/^E/^F/^B/^D/^W in a notepad EDIT move/delete like a terminal;
  ⌘ still does the verbs.
- Windows mode: byte-identical to today (no emacs bindings, Ctrl = verbs).
- Kernel e2e drives the bindings in both modes over a real EDIT control.
