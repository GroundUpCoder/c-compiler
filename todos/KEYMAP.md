# KEYMAP — the system keyboard scheme

Design doc for the Windows ⁄ macOS keyboard schemes. Queue items:
`todos/0149` (the scheme + verb remap) and `todos/0150` (emacs bindings in GUI
text fields). Decided 2026-07-12 (log:
`logs/2026-07-12/queue-hardening-and-keymap.md`); **built 2026-07-18** on
branch `shortcuts-0149` (log `logs/2026-07-18/keymap-scheme-0149.md`) — the
"As built" section below is normative for the shipped behavior. The
⌘-passthrough spike (below) is still a placeholder awaiting the human
real-macOS-Chrome run; nothing was bound on its say-so — the table already
excludes every chord the spike is expected to find eaten.

## As built — deviations from the original table (5 decisions, all shipped)

1. **Cmd+arrows stay Aero Snap**, unchanged, kernel-side (`kernel.js:4623`
   intercepts GUI+arrow before any app sees it). The macOS keymap therefore
   has **no ⌘←/→/↑/↓ bindings at all** — line/doc nav is ^A/^E (readline) and
   the native Home/End VKs in both schemes. This supersedes the original
   table's "Line start/end: ⌘← / →, and ^A / ^E" and "Doc start/end: ⌘↑ / ↓"
   rows below — read KA_LINE_START/END and KA_DOC_START/END in `os/keys.h`
   as the authoritative binding, not the table.
2. **Redo (⌘⇧Z / Ctrl+Y) is not implemented** — `os/keys.h` binds KA_UNDO only,
   consistent with EDIT having no undo buffer yet (`todos/0135`); the
   original table's Redo cell is aspirational, not shipped.
3. The accelerator swap (`TranslateAcceleratorW`, `os/win32/user32.c`) is
   **global at the one choke point** — FCONTROL means GUI under the macos
   scheme, Ctrl under windows, no per-app exceptions.
4. Readline rows are **GUI-EDIT-only, default ON, macos-scheme-only** (the
   `readline off` key is the escape hatch); they are structurally absent from
   the windows table, not merely unbound.
5. Config is **cached with a 1 Hz revalidate** (`os/keys.h` `ks_cached`, the
   `wm.c saver_poll` precedent) — no new notify/broadcast mechanism; a
   Control Panel Apply reaches running apps within ~1s.
6. term's Cmd+C-types-'c' bug is fixed as a consequence of (3)+(4): GUI is
   never a text modifier in either `user32.c TranslateMessage` or
   `term.c handle_key` — an unbound ⌘ chord drops instead of typing.

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
