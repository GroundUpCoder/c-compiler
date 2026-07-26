# os-shell.mjs "Run… place opens the run dialog" — a 33–50% flake, and it was an echo trap

**Scope:** `tests/browser/os-shell.mjs` only. Test-only; no product change, no
image bump. Pre-existing on `origin/main` @749b6bd2.

## The symptom

Under `node tests/browser/os-sweep.mjs --filter=os-shell --repeat 3 --under-load`
on unmodified main:

```
FAIL: pixel (200,780) never became 255,255,255; last 0,128,128
```

— i.e. the Run… dialog's white input box never appeared. Measured baseline: **2
failures in 4 runs** (the requested `--repeat 3 --under-load` scored `FLAKY 2/3
passed`, 33%; a separate single under-load run also failed).

A second manifestation of the same cause showed up one leg earlier: the menu
simply refused to re-open (`pixel (120,510) never became 192,192,192`).

## The cause

`clearRecents()` needled **its own echo**.

The kernel tty line discipline mirrors typed input into `window.__osOut` at TYPE
time (`os/os.html`: every `out` byte lands in `__osOut`; the tty echoes the input
line). The helper built its marker by interpolation:

```js
const tag = `RCLR${++clrN}`;
await page.keyboard.type(`rm -f … && echo ${tag}\r`, …);
await page.waitForFunction((t) => window.__osOut.includes(t), tag, …);
```

`RCLR1` appears verbatim in the typed string, so the wait was satisfied by the
keystrokes — before hush had executed the `rm` at all. This is exactly the trap
the file's own last leg documents ("this leg passed with hush DEAD"), and it
survived the 749b6bd2 echo-trap sweep because a grep for `""` can't see a needle
assembled by template interpolation.

Downstream: `wm.c` rebuilds the Start column from `~/.config/{pinned,recent}` at
every menu open (`sm_rebuild_left` ← `menu_open_root`), stacking pins → recents →
`Settings` → `Run...`, with `All Programs` pinned to the bottom slot. With one
recent still on disk the fixed places sit one row lower, so the test's **fixed
row-1 click landed on `Settings`** and launched `/bin/ctlpanel`. No dialog → the
white-box wait burned 30s → FAIL. And because ctlpanel's window takes focus when
it finally maps, it could also dismiss a Start menu the next leg had just opened
— the second symptom.

Under no load the `rm` won the race almost always; under load it lost ~1 in 3.

## The fix (synchronisation, not timing)

1. **`clearRecents()` waits on the state, not on a proxy.** Split needle
   (`echo RCL""R1`, so only the shell's *output* can satisfy it) **and** gated on
   the postcondition: `test ! -e $R/recent && test ! -e $R/pinned && echo …`. A
   failed `test` prints nothing and the wait fails with a named error plus the
   VT1 tail.

2. **`openMenuOnFixedPlaces()` blocks on the column actually reflecting the
   clear.** New `rowInk(r)` counts solid non-face pixels in a column row's text
   band (4px inset keeps the Win95 grooves — drawn on the pixel *above* a row —
   out of the count). With the store cleared, rows 0/1 carry the two fixed places
   and row 2 (the first slot any survivor would occupy) is blank. The helper
   polls the *drawn panel* — never re-clicks, never re-opens — and on mismatch
   throws with the measured `[ink0, ink1, ink2]` naming the cause, instead of
   letting the click land on Settings and a 30s pixel timeout be diagnosed later.

3. **The first Run… leg stopped being vacuous.** It asserted only "the menu
   dismissed", which is true of clicking *any* row — every one dismisses on its
   way to launching something. It now asserts the dialog's own input box (only
   `Run...` produces it) and waits for the dialog to actually go after Esc, since
   the next leg re-opens the menu and a live dialog owns the focus that dismisses
   it.

## Other proxy-signal legs closed in the same file

- The winbox cleanup ran the same close loop **twice**; the second copy's
  "synchronisation" was
  `waitForFunction(() => !/\twinbox$/m.test(__osOut) || true)` — a predicate true
  on its first poll regardless of the OS — followed by two 800ms naps. `wmctl
  close` only *posts* the close, so the shell echo never meant the windows were
  gone. Now one loop, gated on `wmctl wait nowin winbox` (an absence condition
  that succeeds on absence rather than napping out its clock), and the duplicate
  plus three fixed sleeps are gone.
- The Run… dialog geometry was hand-rolled at two call sites with two different
  offsets, one still on the pre-0132 `28/70` numbers (it happened to land inside
  the box anyway). Derived once now from wm.c's `RUN_W/RUN_H` and the
  `handle_event` placement.
- `waitNotPixel` moved up beside `waitPixel` and grew the 0171 `what` argument.

## Evidence

| | command | result |
|---|---|---|
| BEFORE (unmodified `origin/main`) | `os-sweep.mjs --filter=os-shell --repeat 3 --under-load` | `FLAKY 2/3 passed (flake 33%)` |
| BEFORE (extra single run) | `os-sweep.mjs --filter=os-shell --under-load` | FAIL |
| AFTER | 4 × `--repeat 3 --under-load` | **12/12 green**, `stable … flake 0%` each batch |

One `--repeat 3` batch is ~530s; `--repeat 5` in a single invocation would exceed
the 600s tool ceiling, so the higher count was accumulated as four independent
`--repeat 3` batches (12 runs) rather than one long one. At the observed 33%
baseline, 12 consecutive passes is p ≈ 0.008.

## Rule to keep

A needle that appears in the command you TYPE is not a marker — it is your own
keystrokes coming back. Build markers so the string can only originate from the
shell's output, and prefer gating them on a postcondition (`test ! -e`,
`wmctl wait nowin`) over "the shell said something".
