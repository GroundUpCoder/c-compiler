# KEYMAP — the system keyboard scheme

Design doc for the Windows ⁄ macOS keyboard schemes. Queue items:
`todos/0149` (the scheme + verb remap) and `todos/0150` (emacs bindings in GUI
text fields). Decided 2026-07-12 (log:
`logs/2026-07-12/queue-hardening-and-keymap.md`).

## The idea

gucOS is deliberately Win95/Win7, so **Ctrl-style is the default and the native
idiom** — user32 EDIT (`^C/^X/^V/^A`), fileman accelerators, the clipboard all
use Ctrl. The scheme adds an opt-in **macOS mode** that moves the edit *verbs*
to ⌘.

The reason macOS mode is worth having is not aesthetics — it's that in Windows
mode Ctrl is overloaded (it owns select-all/copy/etc.), so a GUI text field
*cannot also* offer emacs line-editing on Ctrl; the chords collide. In macOS
mode ⌘ takes the verbs and **frees the entire Ctrl row** for emacs bindings
(^A/^E/^F/^B/^D/^W/^K…), exactly like Cocoa's NSTextField. So macOS mode is
strictly *more* editing power in GUI controls, not just different keys.

## Two facts that scope the work

1. **The "toolkit" is Win32.** `TOOLKIT.md` was superseded 2026-07-09 — the UI
   toolkit is user32/gdi32. So "the toolkit respects the OS preference"
   concretely means **user32's EDIT control reads the scheme**. One place, not
   a separate toolkit.
2. **Terminal readline already works.** busybox hush ships
   `CONFIG_FEATURE_EDITING=y` (emacs mode), so Ctrl+A/E/W/K/U already edit the
   shell line *in both modes today* — the shell provides them, not the OS. The
   ONLY thing term changes per mode is the copy/paste **chord**. The real new
   capability (0150) is emacs bindings in **GUI** text fields, which don't
   exist today.

## The two keymaps

| Verb | Windows (default) | macOS |
|---|---|---|
| Select all / Copy / Cut / Paste | Ctrl+A / C / X / V | ⌘A / C / X / V |
| Undo / Redo | Ctrl+Z / Ctrl+Y | ⌘Z / ⌘⇧Z |
| Word left / right (GUI) | Ctrl+← / → | ⌥← / → |
| Line start / end (GUI) | Home / End | ⌘← / →, and ^A / ^E |
| Doc start / end (GUI) | Ctrl+Home / End | ⌘↑ / ↓ |
| **Terminal** copy / paste | Ctrl+**Shift**+C / V | ⌘C / V |
| **Emacs line-editing in GUI** (^A ^E ^F ^B ^D ^W ^K ^U ^N ^P) | — (Ctrl = verbs) | ✓ (0150) |

## Architecture

`os/keys.h` — header-only resolver, following the `openwith.h` / `sounds.h`
precedent: first-existing whole-file config
(`~/.config/keys` → `/etc/keys` → `/usr/share/keys`; one line picks the mode),
exposing `key_action(mods, keysym) → KA_*`. Consumers:

- **user32.c** — EDIT keydown + the accelerator layer route the edit verbs
  through `key_action()` instead of hardcoded chords; 0150 adds the emacs KA_*
  actions over the existing `EditState` caret machinery.
- **term.c** — copy/paste chord selection only.
- **ctlpanel** — a Keyboard applet with a Windows/macOS radio, Apply carries
  the effective table forward (Sounds-applet pattern).
- **wm.c** — no global clipboard chords today; keep it that way (the WM only
  owns window chords — Ctrl+Alt+Tab cycle, Win+arrow snap — which are a
  separate axis, unchanged by the scheme).

## The ⌘-passthrough spike (do FIRST)

On the macOS host, ⌘ is the GUI/Meta keysym and already reaches the WM (Win+arrow
Aero Snap uses it). But Chrome/macOS swallow some ⌘ combos before the page sees
them. Before binding anything, confirm empirically which reach a canvas-focused
window:

- **Expected to pass through** (safe to bind): ⌘A, ⌘C, ⌘X, ⌘V, ⌘Z.
- **Expected eaten** (must NOT bind): ⌘W, ⌘Q, ⌘T, ⌘N, ⌘Tab, ⌘Space.

Record the actual findings here — the scheme must never bind a swallowed chord.

## Out of scope / separate axes

- Menu mnemonics (Alt+F) and dialog default buttons — a different concern;
  unchanged.
- A kill-ring (^K/^Y yank) in GUI EDIT — a follow-up to 0150, not v1.
