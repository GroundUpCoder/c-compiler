# 0104 — user32 dialog keyboard (Tab order, mnemonics, default button)

`todos/0104`. The 0058 descope ("no Tab-order navigation (IsDialogMessage)")
came due: dialogs were mouse/agent-only — Tab did nothing, Enter didn't
press the default, `&` mnemonics were stripped for agent matching but never
matched against Alt+letter, and the modal `DialogBoxParamW` loop didn't even
call IsDialogMessageW (only Esc worked, and only when an app pumped it
itself). This makes dialogs keyboard-native.

## What landed

**`IsDialogMessageW` is now the real dialog manager** (`os/win32/user32.c`):
- **Tab / Shift+Tab** → `GetNextDlgTabItem` walks the dialog's controls in
  creation (Z) order, depth-first, picking WS_TABSTOP + visible + enabled,
  wrapping. Focus is set with `SetFocus`.
- **Alt+mnemonic** → `dlg_find_mnemonic` matches the `&`-marked letter/digit
  of a control label (via the new `mnemonic_char`, consistent with
  `strip_amp`'s "drop every `&`, keep the next char" rule). A BUTTON presses
  (BM_CLICK); a STATIC hands focus to the *next* tabstop — the Win32 label
  rule (`dlg_do_mnemonic`).
- **Enter** → the DEFPUSHBUTTON (`dlg_default_id`, which reads the
  BS_DEFPUSHBUTTON style — one source of truth), OR a focused pushbutton, OR
  a newline when the focused multiline edit claims the key.
- **Esc** → IDCANCEL if that control exists, else IDOK (the MB_OK case), else
  the legacy WM_CLOSE.
- **Arrows** → within a WS_GROUP radio run (`GetNextDlgGroupItem`), moving
  focus and auto-checking.

Routing is generic because every standard control now answers
**`WM_GETDLGCODE`** (BUTTON: DEF/UNDEF-pushbutton/radio/button/static; EDIT:
WANTCHARS|HASSETSEL|WANTARROWS, +WANTALLKEYS only for VK_RETURN when
multiline so Tab still navigates; STATIC: STATIC; LISTBOX: WANTARROWS), so
app custom controls participate too. Wired into **both** modal loops —
DialogBoxParamW (template) and MessageBox (#32770, whose buttons now carry
WS_TABSTOP and the first is BS_DEFPUSHBUTTON with initial focus). DefDlgProc
gained DM_GETDEFID/DM_SETDEFID/WM_NEXTDLGCTL.

**Rendering followed the mechanism:** `draw_label_mn` underlines the
mnemonic glyph in pushbutton/checkbox/groupbox/left-static labels; the
default button gets the classic 1px black outline (COLOR_WINDOWFRAME) inset
one pixel. LISTBOX picked up PageUp/PageDown (VK_PRIOR/VK_NEXT) while I was
in its WM_KEYDOWN switch — same keyboard-parity class.

**The acceptance surface:** `os/win32/ctldemo.rc` → `ctldemo.res` (a WRES
sidecar via `tools/win32rc.js`, seeded `/usr/bin/ctldemo.res` in image.json)
adds an "Options" template dialog with mnemonic'd `&Name`/`&Verbose`/
`&OK`/`&Cancel`. ctldemo grew an Options button + `OptProc` DLGPROC that
reports the keyboard-produced state.

## Gotchas hit

- **Duplicate `case WM_GETDLGCODE`**: edit_proc already had a stub returning
  `4` (DLGC_WANTALLKEYS) — "always wants all keys", which is *why* the old
  IsDialogMessageW let Enter fall through to edits. Removed it; the richer
  version replaces it (single-line edits no longer claim Enter → it reaches
  the default button).
- **Headless mnemonic driving**: `wmctl key SID SC SYM MOD` carries the SDL
  keymod as the 5th arg (the 0077 held-modifier path); **MOD 256 = LALT**.
  So Alt+V is `wmctl key 0 <sc> 118 256`. The mod rides both the synthesized
  down and up, so `GetKeyState(VK_MENU)` reads set when the letter arrives.
- **The disabled owner keeps a stale `focus` mark**: when a modal opens, the
  owner top-level's `top->focus` still points at whatever had focus (the
  Options button), so the agent tree shows TWO ` focus` lines. The test
  picks focus **by control id inside the `#32770` subtree**, not by grepping
  ` focus` globally.
- ctldemo is **ANSI**; the DLGPROC uses `GetWindowText`/`IsDlgButtonChecked`
  (not the `GetDlgItemText`→W macro) to avoid charset confusion, and calls
  `DialogBoxParamW` directly (the template is charset-neutral).

## Verified

`node tests/kernel/run.js` → **53 passed, 0 failed** over a fresh v64 bake.
`test_user32_e2e.js` grew a **session B**: opens the Options dialog and
drives Tab→Verbose→OK, Shift+Tab reverse, Alt+N (static mnemonic → edit),
type "hi" + Alt+V toggle + Enter default → `opt-ok name='hi' verbose=1`
options=1, then Esc and Alt+C both → IDCANCEL; plus a MessageBox leg
(Tab→Cancel, Enter presses it → IDCANCEL; Enter on default → IDOK). winmine
e2e stays green (its custom-board dialog gained Tab/Enter free).

**Browser tier NOT run this session** (no Playwright in this env):
`tests/browser/os-user32.mjs` grew a 0104 leg (real page keyboard: open
Options, type into the edit, Alt+V, Enter → the shell `opt-ok` marker;
reopen, Esc). The operator should run `node tests/browser/os-sweep.mjs
--filter=os-user32` to eyeball it — same standing as prior browser legs.

Image bumped **v63 → v64** (seeded `user32.c`/`ctldemo.c`/`ctldemo.res`
changed).
