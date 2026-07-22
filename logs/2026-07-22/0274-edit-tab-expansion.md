# 0274 — EDIT control expands `\t` to tab stops (was rendering `?`)

**What broke.** Opening `posix-on-wasm.mgp` in notepad showed a leading `?` on
every tab-indented bullet line. Root cause was a two-part gap (both real):
`edit_proc` in `os/win32/user32.c` never expanded tabs — its measure / draw /
caret / hit-test path treated `\t` as an ordinary byte — so the raw `\t`
reached gdi32, whose `if (cp < 32) cp = '?'` control-char rule (term relies on
it) drew it as `?`.

**Fix — all in the SHARED EDIT control** so every consumer (notepad, fileman
boxes, ctldemo) benefits with zero consumer-side code:

- `edit_x_of` rewritten to expand tabs: non-tab runs measured by the font, each
  `\t` jumps to the next stop via `edit_next_tab`. This one function already
  fed caret x, selection-band x, hit-test, and caret-follow scroll, so those
  all became tab-correct for free.
- `edit_draw_run` (new) draws a byte range as tab-separated runs, each placed
  at its tab-expanded offset — so the raw `\t` never reaches gdi32. Used for
  both the main line paint and the selection-highlight repaint.
- `edit_content_w` (hscroll extent) now measures via `edit_x_of` (tab-aware).
- Default stop = 8 avg-char columns (32 dialog units), the real-Win32 default.
  `EM_SETTABSTOPS` wired as the cheap override (dialog-unit stops in `tabs[]`,
  freed on `WM_DESTROY`); no `EM_GETTABSTOPS` — it isn't a real Win32 message.
- **gdi32.c:353 left untouched** — the `?`-for-control-char rule is term's and
  stays as the last resort; the fix expands the tab *before* the glyph layer.

**Why not touch gdi32 or notepad.** The tabs are genuine and notepad delegates
all layout to EDIT; the gap was the EDIT veneer, not the deck or gdi32.

**Tests.**
- `ctldemo selftest` (kernel `test_user32_e2e.js`) gained tab column-mapping
  asserts: with `"a\tb"`, a near-gap click lands before the tab (col 1) and a
  far-gap click after it (col 2) — under the old bug both landed at/after the
  last byte. Plus an `EM_SETTABSTOPS` narrowing check.
- New `tests/browser/os-edittab.mjs`: types `X<TAB>Y` into ctldemo's shared
  multiline EDIT and pixel-asserts a wide (≥40px) *blank* gap between the two
  glyphs — proving BOTH the tab advance AND that no `?` is drawn in the gap.
  Also opens the real deck in notepad (headline repro). Auto-discovered by
  os-sweep; `^os/` already maps to kernel+sweep so no RULES edit.

**Gate.** kernel 101/1 (the 1 = `test_clang_pkgs_e2e`, the known `-j4
dist/packages` race — green isolated); browser sweep 36/0; os-edittab flake
0% (3/3 under load). Visual look-confirm: the deck's tab-indented lines render
as uniformly aligned whitespace, no `?`. Image bumped v139 → v140 (user32.c is
baked into the seeded win32 apps).
