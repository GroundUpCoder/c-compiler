# Keymap scheme (todos/0149 + 0150, image v124)

Built on branch `shortcuts-0149` in an isolated worktree
(`~/worktree/c-compiler/shortcuts-0149`) alongside the concurrent FS_WATCH
kernel-lane work on main — deliberately kept off the main tree per standing
instruction. Design was decided read-only in an earlier session (thread
019f72f2-2296, `todos/KEYMAP.md`); this landed it to all 5 previously-open
decisions, unmodified:

1. Cmd+arrows stay Aero Snap (kernel-only, untouched) — the macOS table has
   no ⌘-arrow rows at all; line/doc nav is ^A/^E (readline) and the native
   Home/End VKs.
2. The accelerator swap is global at ONE choke (`TranslateAcceleratorW`,
   `os/win32/user32.c`) — FCONTROL means GUI under macos, Ctrl under windows,
   zero per-app exceptions.
3. Readline rows are GUI-EDIT-only, default ON, macos-scheme-only —
   structurally absent from the windows table (not just unbound), `readline
   off` is the escape hatch.
4. Config is cached with a 1 Hz revalidate (`ks_cached` in `os/keys.h`, the
   `wm.c saver_poll` precedent) — no new notify mechanism; a Control Panel
   Apply reaches running apps within ~1s.
5. term's Cmd+C-types-'c' bug folded into this item: GUI is never a text
   modifier in either `user32.c TranslateMessage` or `term.c handle_key`, so
   an unbound ⌘ chord drops instead of typing its letter.

## What landed

- **`os/keys.h`** (new, header-only, the `openwith.h`/`saver.h` precedent):
  one `KeyBinding` table {scheme, ctx mask, mods, key, action} keyed by
  KS_WINDOWS/KS_MACOS, `key_action(ctx, mods, key) → KA_*` as the single
  dispatch every consumer calls. Config store `keys` (`~/.config/keys` >
  `/etc/keys` > baked `/usr/share/keys`; cfgstore.h CS3 overlay), keys
  `scheme windows|macos` and `readline on|off` (default windows/on — the
  baked default is byte-identical to pre-0149 behavior). `ks_cached()` reads
  `time(2)` (second-coarse) and re-loads the store at most once/sec.
- **`os/win32/user32.c`**: `TranslateAcceleratorW`'s FCONTROL match reads
  `ks_scheme()` (macos → `g_mod & 0x0C00`, i.e. GUI; else the existing
  `GetKeyState(VK_CONTROL)`) — covers fileman's runtime accel table and every
  `.rc`-compiled one with zero per-app work. `TranslateMessage` gained a GUI
  guard (`g_mod & 0x0C00 → FALSE`) so a ⌘ chord never synthesizes WM_CHAR.
  EDIT's WM_CHAR clipboard/select-all special-cases (^C/^X/^V/^A) are GONE —
  WM_KEYDOWN now resolves every chord through `key_action(KCTX_EDIT, …)` into
  one `edit_do_action()` dispatcher (movement, word-nav, the readline
  kill/line actions, and the verbs as thin `SendMessage` forwards). LISTBOX's
  Ctrl+A select-all is the same table lookup (`KCTX_LIST`). New helpers:
  `edit_word_left/right` (whitespace-delimited, shared by Ctrl/⌥-arrow nav
  AND the ^W kill — one rule, not two), `kk_from_vk` (VK → the keys.h
  canonical vocabulary).
- **`os/term/term.c`**: the copy/paste chord resolves through
  `key_action(KCTX_TERM, …)` (Ctrl+Shift+C/V under windows, ⌘C/V under
  macos); an SDL_KMOD_GUI chord that misses the table now `return`s instead
  of falling into the plain-byte-write path — the actual bug fix.
- **`os/wm.c`**: added `mod_gui` tracking (SDLK_LGUI/RGUI edges, alongside the
  existing ctrl/shift tracking; the veneer's `windows.h` doesn't define
  SDLK_LGUI/RGUI yet — defined locally, `#ifndef`-guarded, scancode-derived).
  Desktop select-all resolves through `key_action(KCTX_LIST, …)`; the inline
  rename editor now drops Ctrl/GUI chords instead of inserting them as text
  (same class of fix as term's).
- **`os/win32/ctlpanel.c`**: a Keyboard applet (Windows/macOS radios + an
  "Emacs editing" checkbox for `readline`) over `ks_get`/`ks_set`, following
  the Sounds-applet auto-toggle-then-revert-on-failure discipline exactly.
- **`os/image.json`**: seeded `/usr/share/keys` (scheme windows, readline on
  — the byte-identical-boot default); version bumped 122 → 124 (123 was
  claimed by FS_WATCH on main between this branch's fork point and now — see
  Hermeticity below).

## Tests

`tests/kernel/test_keymap_e2e.js` (new, registered in `tests/kernel/run.js`),
19 checks across 5 boot sessions:
- windows scheme (baked default): ^A/^C/^V round-trip the kernel clip slot
  in a real notepad EDIT, Ctrl+Right word-nav, an unbound ⌘C drops (doesn't
  type 'c').
- macos scheme (`/etc/keys` admin layer): ⌘A/⌘C/⌘V are the verbs; a plain
  ^C is proven inert via a sentinel-slot trick (select, set a sentinel on
  the clipboard, ^C, ⌘V — the paste must deliver the sentinel, not the
  selection, or ^C would have overwritten it); the readline rows ^E/^A/^K
  edit a live EDIT; ⌥Right word-nav; `readline off` disarms the rows
  live (polled, no restart); a live `/etc/keys` scheme flip reaches a
  RUNNING notepad within the 1 Hz revalidate (polled to idempotence).
- accelerators: fileman's runtime FCONTROL table fires Copy/Paste on ⌘C/⌘V
  under macos and provably does NOT fire on Ctrl+C/Ctrl+V in the same
  session (a swap, not an alias — asserted via exact file-copy count).
- term: ⌘V executes a pasted shell line under macos; ⌘C with a stray typed
  command afterward proves no letter leaked; a live flip back to windows
  re-arms Ctrl+Shift+V (a genuine 2s settle here, annotated — an early
  chord under a stale cached scheme would corrupt the pty line, so this
  could not be an injection-retry poll like the others).
- ctlpanel: the Keyboard applet's radios + checkbox delta-write
  `~/.config/keys`, verified by `cat`.

Gate: image v124 sealed, **kernel 87/87** (test_keymap_e2e new), **browser
sweep 28/28**, flake gate green (`test_keymap_e2e` 3/3 stable under load ×10
via the kernel suite runner directly, plus the standard tripwire set —
wm_service/term/os_apps + os-doom/os-term/os-compositor — 3/3 stable);
**compiler.js UNTOUCHED**. `todos/0149` and `todos/0150` closed
(`node todos/queue.js done`).

## Hermeticity finding

The build itself is hermetic: `tools/mkimage.js` writes only
`os/os-system.img` inside the worktree (no shared absolute deploy path), so
baking here never collided with the concurrent kernel-lane build on the main
tree. The browser sweep needed a manual `node_modules` symlink into the
worktree (`playwright` resolves through a symlink into a sibling
`c-compiler-copy` checkout, not a real dependency — every worktree needs this
wired by hand; documented as a known gotcha).

The **source tree** is a different story: `origin/main` advanced past this
branch's fork point (bcac37e) with FS_WATCH (`b5f0fa1`, todos/0264, image
v123) *while this branch was in flight*, and FS_WATCH touches
`os/win32/user32.c`, `os/image.json`, and `tests/kernel/run.js` — the exact
three files this item also modifies (`RegisterFdWake`/watch-fd wiring in
user32.c; the image version bump; new e2e registrations in run.js). This
branch was NOT rebased onto the new origin/main (out of scope for this
close-out; the coordinator sequences merges) — the eventual merge/rebase will
need manual conflict resolution in those three files, and the image version
numbers will need reconciling (this branch bumped 122→124 without knowledge
of FS_WATCH's 122→123). Flagging for the coordinator rather than resolving
unilaterally.

## Design note

`todos/KEYMAP.md` gained an "As built" section recording the deviations from
the original (pre-decision) table — most notably that macOS mode has no
⌘-arrow bindings at all (decision 1) and Redo is not implemented (no EDIT
undo buffer yet, todos/0135). The ⌘-passthrough spike table in that doc
remains an unfilled placeholder — it's a real-macOS-Chrome human task, not
blocked on or blocking anything here; the shipped table already excludes
every chord the spike is expected to find eaten (⌘N/W/Q/T/Tab/Space were
never bound).
