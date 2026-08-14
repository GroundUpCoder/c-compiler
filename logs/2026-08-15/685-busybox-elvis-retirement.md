# #685 — busybox: all 7 `x ?: y` vendored patch sites retired

The measured payoff of #681 (`8999f38d`, elvis operator, first operand
evaluated exactly once) on the busybox side; SameBoy's 5 sites were #684.

## Measurement first

- **Feature probe** through the real cc driver (`createCcDriver` over a
  `MemoryByteStore`, the `test_gcode_orientation.js` harness shape) at base
  `952bdf2d`, with a positive control (plain ternary compiles) and a negative
  control (broken syntax fails) so a dead harness could not read as a
  confirmed absence. All green: bare `x ?: y`, the `getenv("TIME") ? :
  dflt` pointer/function-call shape, and the vi.c arithmetic shapes.
- **Site census**: grep found exactly the ticket's 7 — `vi.c` ×6 (791, 1193,
  1937, 3621, 3924, 4472) + `time.c` ×1 — marked `WASM PORT PATCH: GNU ?:`.
- **Upstream oracle**: busybox 1.37.0 tarball (the README's pinned version).
  The vi.c line numbers matched the vendored copy exactly, which made the
  restoration trivially checkable: after the edit, all 7 lines diff
  byte-identical to upstream.

## Outcome: 7 of 7 retired, no residual patch

Unlike #684 (where one row had to stand on a re-measured reason), every
busybox site restores to pure upstream text and builds: both
`coreutils.json` (carries vi + time) and `bin.json` (hush) compile exit 0
with the patches gone.

Two nuances worth recording:

- `time.c` was never the `x ? x : y` rewrite — because its operand is
  `getenv("TIME")`, a function call, the value-duplicating rewrite would
  have called it twice, so the patch spelled the fallback out as an `if`.
  Restoring true `?:` is strictly safer than either form: single evaluation
  is now the compiler's guarantee, not an audit obligation on the operand.
- Upstream spells the operator two ways — `? :` (with space) in time.c,
  `?:` in vi.c. Both parse; the restoration keeps each file's own spelling
  for byte-fidelity.

`time.c` keeps #619's two unrelated patches (wait3/wait4 fallback, xvfork
journaling form); `vi.c` keeps its sigsetjmp if-form. The README rows now
list only those, and a RETIRED note below the table cites `8999f38d`.

No `image.json` bump: behavior-identical restoration of vendored source,
the #684/#623 no-bump precedent (Node-side bake gates are mtime-fresh; a
persistent browser image has nothing user-visible to gain).
