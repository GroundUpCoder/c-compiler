# 0199 — os-wm.mjs 'keyboard Move relocated C' leg flakes under load

- **Status**: fixed on branch `fix-0199-wm-flake` (awaiting review + merge)
- **Design**: tests/browser/os-wm.mjs (the 0102 sysmenu keyboard-Move leg), CLAUDE.md "Test-sync discipline"

## Resolution (2026-07-20)

Two things, one of which was already fixed:

1. **The described move-proof symptom was already cured by todos/0238**
   (commit 579f277, 2026-07-17 — filed AFTER this item): the
   `waitPixel(CX+240, CY+116, GREEN)` *instant sample racing the move
   composite* became the `waitPixel(CX+5, CY+5, ORANGE)` marker wait. That
   is the exact "33% flake" 0238's message names.

2. **The `wmctl list | grep ctxmenu` presence check → a FOCUS marker**
   (the 0199/0171 ask). The hypothesised focus race does not actually
   manifest — create-focus (kernel.js `_wmSetFocus` at SURFACE_CREATE, line
   ~3901) sets kernel focus on the popup synchronously, in the same RPC that
   lists it, so presence already implies the `f` flag (empirically: the
   ctxmenu was `f-b---T` in every pre-arrows snapshot across dozens of
   runs). The check now ASSERTS focus anyway — `wmctl wait win ctxmenu &&
   wmctl list | awk '$NF=="ctxmenu" && $(NF-1)~/^f/'` — so a create-focus
   regression fails LOUD instead of racing the arrows onto winbox C.

**Bonus flake found + fixed under load** (same instant-sample class): the
early-boot `desktop teal before any window` check (line 52) did a bare
`near(sample(...), TEAL)` with NO composite barrier — `waitScreen()` settles
canvas GEOMETRY, not the desktop-layer teal paint. Reproduced 1/10 under
`--under-load=12` (the condition sample read a pre-composite frame while the
diagnostic re-sample already read teal). Converted to a `waitPixel(TEAL)`
marker.

os-wm added to the `tests/flake.js` browser tripwire set (twice-flaky now).

**Verification**: `node tests/flake.js --filter=os-wm` green; 42 runs under
`--under-load=12..14` post-fix, 0 failures (the teal flake reproduced 1/10
pre-fix in the same config). No product code touched — tests only.

## Goal

The os-wm.mjs leg `keyboard Move relocated C (+40,+16)` intermittently
fails (observed 2/5 runs on 2026-07-15 during the 0198 gate, on a tree
whose emitted binaries hashed byte-identical to a passing HEAD — so the
product bytes are excluded as the cause). Failure shape: the
`waitPixel(CX + 240, CY + 116, GREEN, 30000)` after the Move commit burns
its full 30s and reports `[192,192,192]` (gray) — the window never moved,
or the sysmenu never entered move mode.

Root-cause and fix the SYNC, not the symptom (no timeout inflation, no
quiet retry): find the unsynchronized step between the SYSMENU-UP echo
(sysmenu confirmed present via wmctl on VT1) and the ArrowDown/Enter
sequence on VT2. Prime suspect: the keypresses race the sysmenu root's
FOCUS/grab acquisition — presence in `wmctl list` doesn't prove the menu
root already holds kernel focus, so early arrows may land on winbox C or
fall dead, leaving the menu on the wrong row when Enter fires.

## Plan

- Reproduce with `node tests/browser/os-sweep.mjs --repeat 5 --filter=os-wm`
  and `--under-load` (the 0147 flake gate) to get a rate.
- Instrument: on failure, dump `wmctl list`/`wmctl tree` — is the ctxmenu
  still up? Did C keep focus? Which row was selected?
- Fix the wait (e.g. wait for the menu root to hold focus — a focus-flag
  probe or a wm-side marker — before typing), per the 0171 discipline:
  wait on a marker, never on presence alone.
- Add the file to the flake-gate tripwire set if the class warrants it.

## Acceptance

`node tests/flake.js --filter=os-wm` (or the sweep `--repeat 5
--under-load`) reports 0% flake on the leg; the fix is a real sync marker,
not a longer timeout.
