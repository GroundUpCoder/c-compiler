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

## 🔴 CLOSED DECISION — Ctrl carries NO edit verbs in the macOS scheme. Do not re-open.

**Status: decided by jku, three times, by email, 2026-07-29. This is a decision
record, not a discussion. Do not re-litigate it in a design pass.**

The macOS scheme is a **swap, not an alias**. ⌘ takes the edit verbs. **Ctrl is
RESERVED** for the readline rows and for future emacs-style bindings, the same
as real macOS. That reservation is the *point* of macOS mode, not an incidental
consequence of it — see "The idea" below, which explains why a freed Ctrl row is
the capability the mode exists to deliver.

**Rejected, on the record:** dual-binding Ctrl+V / Ctrl+C / Ctrl+X in the macos
table of `os/keys.h` so that the Win95 chords keep working alongside ⌘. jku
rejected this proposal three times. In his words: *"the whole point of Mac mode
is to free the ctrl combos for readline and other niceties like real Mac does.
Dual binding kills that."*

**Do not propose it again.** The argument *for* dual-binding is always the same
one — Win95 muscle memory, a low apparent cost, "it only adds, it does not
remove." That argument is **known and rejected**, not a new insight. It is wrong
because the cost is not visible in the macos table: adding Ctrl+V there silently
spends a chord that the readline rows and 0150's emacs bindings need. Anyone who
re-derives it has found the rejected argument, not a gap.

**The tests are policy, not description.** These assertions in
`tests/kernel/test_keymap_e2e.js` encode this decision:

- `macos: ^C is freed (paste delivers the sentinel, not the selection)`
- `macos: Ctrl chords do NOT fire the accels (exactly the two ⌘ copies)`

**If either goes red, the policy has been broken. The test is not stale.** Fix
the code. Do not flip the assertion.

**Why this is written here.** Until 2026-07-29 this decision existed only in the
coordination repo, and nowhere in this one. A design pass that read `KEYMAP.md`,
`META-ARROW-KEYBIND.md` and `KEYBINDING-OVERRIDE-SYSTEM.md` correctly found the
"swap not alias" *design* and found nothing recording that reversing it had
already been refused — so it re-weighed the trade-off and recommended the
reversal, confidently. A design that is documented without its settled decisions
reads as open for re-litigation. That is what this section closes.

## As built — deviations from the original table (5 decisions, all shipped)

1. **Cmd+arrows are line/doc nav in the macOS scheme** (⌘←/→ =
   KA_LINE_START/END, ⌘↑/↓ = KA_DOC_START/END) — restoring the original
   table's rows. This REVERSES the original 0149/0150 "As built" decision that
   ⌘+arrow stays Aero Snap: the kernel snap grab was scheme-blind and had to
   cede ⌘+arrow, so line/doc nav shipped only on ^A/^E (readline) + Home/End.
   The keybinding-override grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md)
   made the grab scheme-aware, so **META-ARROW-KEYBIND.md** relocated macOS
   tiling to **Ctrl+Alt+arrow** (Rectangle-style) and RELEASED GUI+arrow to the
   focused app, where `os/keys.h`'s macos rows resolve it. The **windows scheme
   is unchanged** — Win+arrow is still Aero Snap. `os/keys.h`
   (KA_LINE_START/END, KA_DOC_START/END rows + the KS_ACTIONS snap defaults) is
   the authoritative binding. Host auto-detect (META-ARROW decision 4) defaults
   the scheme to macos on a Mac host (`os-common.js seedHostKeyScheme`, seeded
   into the admin `/etc/keys`); the per-user ~/.config/keys override always wins.
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
