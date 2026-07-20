# os-wm.mjs sysmenu-Move leg flake — root cause + marker fix (todos/0199)

Branch `fix-0199-wm-flake`. A P0 gate-reliability item: the browser leg
`keyboard Move relocated C (+40,+16)` in `tests/browser/os-wm.mjs` flaked
2/5 under load on 2026-07-15. Product binaries hashed byte-identical to a
passing HEAD, so it's a TEST-sync bug, not a miscompile.

## What the flake actually was

Two distinct instant-sample-vs-composite races. Only one was in the leg the
item names; the other I found while verifying under load.

### 1. The move-proof (already fixed by 0238, before I got here)

The item's described failure — `waitPixel(CX+240, CY+116, GREEN, 30000)`
burning its clock and reading `[192,192,192]` — is the move-proof racing the
move composite. `git log -S` shows commit **579f277 (todos/0238,
2026-07-17)** already converted that instant sample into the marker wait
`waitPixel(CX+5, CY+5, ORANGE, 30000)` ("C's old corner vacated to B's
orange"), and its own message calls it "pre-existing 33% flake" — i.e. the
same 2/5 this item reports. 0238 was filed two days AFTER 0199 and fixed it
independently without closing it.

### 2. The SYSMENU-UP presence check (the 0199/0171 ask)

The item hypothesised the arrows race the sysmenu popup's focus/grab
acquisition — `wmctl list | grep ctxmenu` proves the popup EXISTS, not that
it holds kernel focus, so early arrows could land on winbox C.

I traced it and the focus race does NOT actually manifest: the kernel routes
keys to the focused surface's owner (`_wmEventTo(this._focusSid, …)`,
kernel.js:4730), and **create-focus** (`_wmSetFocus(sid)` at SURFACE_CREATE,
kernel.js:3901) sets focus on the popup synchronously — in the SAME RPC that
adds it to `_surfaces`. So the moment `wmctl list` can see the ctxmenu, it is
already focused. Instrumented dumps confirmed it: the ctxmenu was `f-b---T`
(f = focused) in every pre-arrows snapshot across dozens of under-load runs.

Still, presence ≠ marker (the 0171 rule). Strengthened both SYSMENU checks
to assert the focus flag:

    wmctl wait win ctxmenu 8000 && wmctl list |
      awk '$NF=="ctxmenu" && $(NF-1)~/^f/ {print "SYSMENU-FOCUS" "ED"}'

`wmctl wait win` is the deadline-bounded presence-wait primitive (robust to
the create delay, loud on timeout); the awk then asserts the `f` flag
(FLAGS is the second-to-last whitespace field). Now a create-focus
regression fails LOUD instead of silently racing the arrows.

Needle discipline: the awk prints `"SYSMENU-FOCUS" "ED"` (POSIX juxtaposition
concat → `SYSMENU-FOCUSED`) so the typed-command echo never contains the
literal needle — the same self-satisfaction trap the file's `SYSMENU-U''P`
split guarded, which I initially fell into with a `DIAG-END` needle while
instrumenting.

### Bonus: early-boot `desktop teal before any window` (line 52)

Reproduced 1/10 under `--under-load=12` — but the failing check was NOT the
sysmenu leg (that passed every run). It was line 52's
`near(await sample(SW-20, SH-60), TEAL)`: a bare instant sample with no
composite barrier ahead of it. `waitScreen()` settles canvas GEOMETRY, not
the desktop-layer teal PAINT, so under load the condition sample read a
pre-composite frame and failed while the diagnostic re-sample already read
`[0,128,128]` (teal) — the tell. Converted to `waitPixel(SW-20, SH-60, TEAL)`.
Every later instant-sample in the file is protected by a preceding
`waitPixel` barrier on the same frame (once one pixel of a settled composite
is confirmed, the rest are coherent); line 52 was the lone unguarded one,
because it runs before the first `waitPixel`.

## Tripwire

Added `os-wm` to the `tests/flake.js` browser leg (`os-doom,os-term,
os-compositor,os-wm`) — twice-flaky (0238 + 0199) earns a permanent slot.

## Verification

- `node tests/flake.js --filter=os-wm` → green.
- 42 runs under `--under-load=12..14` post-fix, 0 failures (batches
  12/14/16). Pre-fix, the teal flake surfaced 1/10 in the same config.
- Product code untouched — only `tests/browser/os-wm.mjs` and
  `tests/flake.js`.

## Lesson

"Presence in `wmctl list`" and "an instant `sample()`" are the two silent
symptoms this estate keeps regrowing. When an item hypothesises a race,
verify WHICH property is actually missing before writing the marker — here
the focus property was never actually absent (create-focus is synchronous);
the real residual was a composite-timing sample two dozen lines earlier. The
marker still belongs (loud-fail on regression), but the honest root cause was
elsewhere.
