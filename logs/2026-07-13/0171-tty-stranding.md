# 0171 — the VT1-typed flake class: canonical edit-buffer stranding

The one-line story: `Tty.setattr` stranded the canonical edit buffer
(`_line`) across a cooked→raw switch, so any typed line that STRADDLED a
shell's between-reads cooked window and its line editor's raw-mode entry
lost its head — the surviving tail executed alone (`echo X` arrives as
`cho X`), and a tail with an unbalanced quote locked hush into PS2
continuation forever: echo alive (hush's lineedit happily consuming
continuation lines), reader "dead" (nothing ever executes), no prompt, no
error. That is byte-for-byte the wedge 0167's investigation captured.

## How the window opens

busybox hush interactive reads lines via lineedit (`read_line_input`):
raw termios (ICANON/ECHO off, self-echo) per line, restored cooked when
the line returns. While hush EXECUTES a command the tty is cooked — bytes
typed then go into the kernel's canonical `_line` edit buffer (kernel
echo). When hush finishes and lineedit re-enters raw mode mid-typing,
pre-fix `setattr` left `_line` bytes stranded: invisible to the raw
reader, and prepended to some unrelated FUTURE canonical line if cooked
mode ever returned with them still there.

Under CPU contention command execution stretches into the next typed
line — which is why the class only fired under load (os-fileman ~33%,
os-doom 12–37% under the flake gate) and almost never idle: idle, each
command finishes inside the test's inter-line pause; loaded, the raw
switch lands mid-line.

Linux (n_tty) flushes the canonical buffer to the read queue when ICANON
is cleared — partial input becomes readable immediately. We now do the
same (kernel.js `Tty.setattr`): on an ICANON on→off transition the edit
buffer `_push`es to the reader path (both transports — ring and
brokered). `TCSAFLUSH` also now clears the BROKERED cooked queue
(`_cooked`), which the pre-fix flush missed entirely (it only reset the
ring words + `_line`).

## Evidence trail

- Headless repro (no browser in the path): paced char-by-char typing into
  `boot.js --tty-out` racing `usleep 30000 &` reaps under full-core load.
  The extended `--dump-state` probe (now prints tty `fgPgid`, `_cooked`/
  `_line` contents, `lflag`) captured `_line` holding 29 bytes of a typed
  probe line WHILE `lflag` was lineedit-raw — the stranding, live.
  Product bug confirmed; the page→xterm input path exonerated.
- Regression tests (test-first, both failing pre-fix):
  `test_tty.js` "canonical->raw flushes the edit buffer" (ring) +
  `test_pty.js` brokered twin and the brokered-TCSAFLUSH leg.
- The scripted-stdin headless flow never reproduced (8/8 under load) —
  piped scripts pre-queue whole lines, so no line ever straddles the
  switch; only paced typing (browser xterm or paced pipe writes) hits it.

## The harness side (converted the same day, same item)

os-fileman.mjs dropped its `pause(400/500)` chains for `wmctl wait …`
guards + split-needle echo markers (`shLine`); os-doom.mjs's two `wmctl
close` flows wait for a `CLOSE-S""ENT-n` echo BEFORE switching to VT2
(a lost line is now distinguishable from a stuck app). Ordering rule
that shaped the conversion: sid/coord injections ride the per-app input
ring FIFO and need no pacing; click-by-LABEL / settext do agent-tree
lookups at dispatch time and must wait for the popup/dialog to be
populated (`wmctl wait label`). The one fixed sleep left in os-fileman
is the annotated 0091 EV_SCREEN quiesce (a genuine no-marker window).

## Tooling landed (0171 scope)

`tools/os-drive.mjs` — boot the OS page once, then drive it: REPL mode
(live __osOut mirror, `:vt/:type/:key/:sample/:shot/:load` commands) and
scripted mode (default-export `async (drive, args)`), with `sh`/`run`
(split-needle marker round-trip), `wmctl` passthrough, under-load
generators (the flake-gate pattern), headed mode, and the rebake-tolerant
server wait baked in. `tools/os-drive-scripts/doom-close-probe.mjs` is
the 0167-style launch→close→probe loop as a committed script over it.

## Second product bug the conversion surfaced: popup items were invisible to waits

Converting os-fileman's pauses onto `wmctl wait label Copy` failed 5/5 —
and exposed that **AQ_GETTEXT (the query behind `wmctl wait label`/`text`)
only walked HWNDs**: menu items were AQ_CLICK targets and `tree` dump rows,
but never resolvable by GETTEXT. Consequence hiding in plain sight: every
`wmctl wait label <popup item>` in the kernel e2es (fileman ops, calc) was
silently running out its FULL timeout and the script just moved on — a
fixed sleep in disguise (the 0083 class, wearing event-wait clothes) — and
every `wait nolabel <popup item>` passed instantly without checking
anything. user32.c's AQ_GETTEXT now falls back to the OPEN menu's items
(TrackPopupMenu or a dropped bar submenu, `g_menu.open` gated). OPEN only,
deliberately: a CLOSED bar's items must stay unresolvable, or notepad/
paint's `wait label Save` (a dialog button) would match File>Save via the
tab-cut ("Save\tCtrl+S") forever and break those flows. Validation:
test_fileman_ops_e2e dropped from 117s to 27s — that delta WAS the dead
waits — and the converted browser leg goes green. user32.c is a seeded
lib, so image.json bumped to v85.

## Gotchas re-learned

- Editing ANY bake input (even boot.js's debug dump) DURING an mkimage
  bake leaves the fresh blob input-stale (mtime = bake start) — the next
  boot re-bakes in-process and a 240s prompt timeout reads as a wedge.
  Bake AFTER the last edit, then run.
- `boot.js` under piped stdio needs `--tty-out` for an interactive hush
  (prompt, job notices, lineedit) — without it there is no `~ #` to wait
  for and no lineedit raw/cooked cycling to race.
