# 0090 — System clipboard: cross-app copy/cut/paste

**Item**: `todos/0090-clipboard.md` (now in done/). One shared clipboard for
the whole OS: notepad ↔ notepad, term ↔ GUI apps, shell ↔ everything.

## What landed

- **Kernel-held slot** (`kernel.js`): `this._clipboard = {fmt, bytes}` behind
  two new 0x03xx RPCs. `CLIP_SET` (0x0302) is a RAW request
  `[u32 fmt][u32 last][u32 off][bytes...]` staged per-pcb and committed only
  on `last` — a writer dying mid-set can never tear the slot. `CLIP_GET`
  (0x0303) is JSON `{fmt, off}` → RAW `[i32 total][chunk]`, `total` -1 when
  empty or the stored format differs. Format 1 = UTF-8 text; the tag exists
  so 0092's file lists / CF_BITMAP can ride the same slot later. strace
  decodes both for free (the OP table IS the decode table) plus a dedicated
  RAW-args case for CLIP_SET.
- **The C API is the real SDL3 clipboard** (`compiler.js` SDL.h/__SDL.c):
  `SDL_SetClipboardText`/`SDL_GetClipboardText`/`SDL_HasClipboardText`/
  `SDL_ClearClipboardData` + `SDL_free`, deliberately usable without
  SDL_Init (console-shaped processes clip too). Get sizes with cap 0 then
  reads, retrying if the slot grew between the calls (single-slot,
  last-write-wins; cross-chunk reads are not snapshot-atomic by design).
- **host.js `createClipboard`**: `__clip_set(fmt, ptr, len)` /
  `__clip_get(fmt, ptr, cap)` imports, installed for every process next to
  the spawn imports. Kernel-backed via new `KernelClient.spawnHooks()`
  members (`clipSet`/`clipGet`, chunked at 48K under the 64K kernel page);
  no kernel — standalone pages — or an embedder kernel answering ENOSYS
  degrades to a process-local slot with identical semantics (the
  two-transports-one-fs pattern).
- **user32.c re-based on the slot**: the 0048 `$HOME/.clipboard` file is
  gone; `clip_store`/`clip_load` (the choke points the clipboard API and the
  EDIT control's WM_COPY/CUT/PASTE share) now call the SDL functions.
  Zero behavior change API-side: CF_TEXT/CF_UNICODETEXT stay two views of
  one UTF-8 text, GetClipboardData handles stay clipboard-owned/cached.
  What changed for users: the clipboard now survives the app exiting and is
  shared with non-win32 processes.
- **term selection + chords** (`os/term/term.c`): left-drag selects a
  linear row-major cell range (xterm-style) on the current screen, rendered
  by fg/bg inversion; Ctrl+Shift+C copies (per-row trailing blanks trimmed,
  rows joined with \n), Ctrl+Shift+V pastes to the pty master with \n→CR
  (and CRLF folded) so hush/vi see Enter. Plain ^C stays the SIGINT byte —
  the chord requires BOTH modifiers. Selection clears on click and resize;
  it does NOT track scrolling output (screen coords, like xterm).
- **`/bin/clip`** (os/clip.c, seeded): Windows clip.exe shape plus `-o` —
  `cmd | clip` sets the slot, `clip -o` prints it (exit 1 when empty).
  It's both a real shell utility and the probe every test reads the slot
  through. Image version **v50 → v51**.

## Decisions

- **Kernel slot, not the 0048 file**: the file was cross-process already but
  format-blind, HOME-scoped, fs-write-per-copy, and invisible to non-win32
  code paths. The control plane owning it gives the format tag (0092), true
  system-wide identity, and RPC-level strace visibility.
- **The public C surface is SDL3's clipboard API, not a bespoke one** —
  SDL3.md's missing-feature table drives that; any future SDL port gets
  copy/paste for free. The win32 veneer consumes the same functions.
- **Term chords are Ctrl+Shift+C/V** (the modern terminal convention);
  copy-on-select and middle-click paste deliberately not built.
- **Host-browser clipboard (navigator.clipboard) stays unwired** — async +
  permission prompt needs the callback model; recorded in SDL3.md.

## Gotchas hit

- **Browser keyboard pacing**: Playwright `keyboard.type` at zero delay +
  `press('Control+a')` flooded the per-frame win32 pump — characters
  dropped and the Control keydown separated from its letter (the EDIT got a
  literal 'a'). The os-shell leg types with `{delay: 60}` and runs chords as
  explicit down/gap/press/gap/up sequences. Headless `wmctl key SID 0 97 64`
  (keysym+mod on one record) never had the problem.
- **Cascade covers the click target**: notepad2 spawns at +28,+24 over
  notepad1, so "click notepad1 to refocus" must aim at its LEFT edge strip
  or the click lands in notepad2's client area.
- **`wmctl gettext EDIT:0` is tree-order-global across processes** (the
  0089 gotcha, again): with two notepads the browser paste assertion is a
  black-glyph histogram over notepad2's client area; EDIT:0 addresses
  notepad1 (first process) for the cut assertion.

## Tests

- `tests/kernel/test_clipboard_e2e.js` (new, in run.js): clip round-trip /
  overwrite / clear / empty-rc, ~170KB chunking, notepad copy→exit→paste
  across processes, Cut semantics, shell→GUI paste, term drag-copy /
  paste / plain-^C SIGINT regression. All 15 checks pass.
- `test_notepad_e2e.js` / `test_calc_e2e.js` migrated from
  `cat /root/.clipboard` / `printf ... > /root/.clipboard` to `clip -o` /
  `printf ... | clip` — both pass unchanged otherwise.
- `tests/browser/os-shell.mjs` grew the 0090 leg (notepad→notepad over the
  real VT2 keyboard: Ctrl+A/C/V/X, cross-checked via clip on VT1) — PASS.
- Full unit suite 707/707; kernel suite + browser sweep green (see
  `build/test-kernel/summary.json` / `build/test-browser/`).
