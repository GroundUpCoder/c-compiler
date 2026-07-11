# 0149 — system keyboard scheme (Windows ⁄ macOS keymaps)

- **Status**: open
- **Design**: `todos/KEYMAP.md` (the two keymaps, config format, resolver
  contract, the browser-⌘ passthrough spike). From the 2026-07-12 design
  discussion.

## Goal

One system-wide keyboard scheme with two coherent keymaps, toggled in
settings. **Windows (Ctrl) is the default** — it matches the whole gucOS
Win95/Win7 idiom (user32 EDIT `^C/^X/^V/^A`, fileman accelerators). **macOS
(⌘)** moves the edit verbs to ⌘, which — the point — frees the entire Ctrl row
for emacs line-editing in GUI text fields (delivered by 0150). This item lands
the scheme + the verb remap; 0150 adds the emacs bindings on top.

Note two grounding facts (see KEYMAP.md): the "toolkit" IS Win32 (TOOLKIT.md
superseded), so "respect the OS preference" = user32 EDIT reads the scheme. And
terminal readline (Ctrl+A/E/W/K…) already works in both modes — hush ships
`FEATURE_EDITING=y` — so term only needs the copy/paste **chord** to change.

## Plan

- **`os/keys.h`** — header-only resolver, the `openwith.h`/`sounds.h` precedent:
  first-existing whole-file config `~/.config/keys` / `/etc/keys` /
  `/usr/share/keys`; one line selects the mode; exposes
  `key_action(mods, keysym) → KA_COPY | KA_CUT | KA_PASTE | KA_SELECT_ALL |
  KA_UNDO | KA_REDO | KA_WORD_LEFT | KA_WORD_RIGHT | KA_LINE_START | …`.
- **Consumers of the verbs**:
  - `os/win32/user32.c` EDIT keydown + accelerator layer route the edit verbs
    through `key_action()` instead of hardcoded `^C/^X/^V/^A`.
  - `os/term/term.c` — copy/paste chord only (⌘C/V vs Ctrl+Shift+C/V).
- **ctlpanel Keyboard applet** — Windows/macOS radio, Apply carries the
  effective table forward (the Sounds-applet pattern).
- **The ⌘-passthrough spike (do FIRST, record in KEYMAP.md)**: confirm which ⌘
  chords actually reach a canvas-focused window vs are eaten by Chrome/macOS
  (⌘A/C/X/V/Z expected OK; ⌘W/Q/Tab/N expected eaten). The scheme must not bind
  a swallowed chord.

## Acceptance

- Default boot = Windows mode, byte-identical to today.
- ctlpanel Keyboard → macOS makes ⌘A/C/X/V/Z the edit verbs in EDIT and term
  copy/paste = ⌘C/V; persists across boots.
- Tests: a kernel e2e driving `key_action` both modes + the EDIT/term legs;
  the ⌘-passthrough findings documented in KEYMAP.md.
