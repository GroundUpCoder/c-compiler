# todos/0186 — compiler codegen perf bench harness (tests/bench/)

Step 0 of the inlining effort: the measured generated-code baseline lived
only in /tmp/sbbench (2026-07-12) — a codegen change had no committed
before/after gate. Landed it as `tests/bench/` (adapted from that harness,
not reinvented): a standalone, opt-in `node tests/bench/run.js` that builds
the headless SameBoy GBC core with compiler.js (and clang via the external
`cc2wasm` when present), times N=200/600/1000 frames best-of-3, and reports
the **slope** ms/frame over the 800-frame span so V8 tier-up and process
startup cancel.

## Pre-inlining baseline (main @ this commit — the reference for every stage)

```
BENCH sameboy(SuperMarioDeluxe.gbc) | cc 5.697 ms/frame | clang 1.049 ms/frame | 5.43x | sum OK | 281051 B wasm, 120084 instrs (code 234546 B)
```

- compiler.js: **5.70 ms/frame** (5.697/5.704/5.706 across three full runs
  today — tight; matches the 2026-07-12 /tmp measurement of 5.705)
- clang -O2 via cc2wasm: **1.04–1.07 ms/frame** (noisier at ~1s totals);
  ratio **~5.4–5.7x**
- cc build statics (fully deterministic, no wall clock): 281051 B wasm,
  234546 B code section, **120084 instructions**
- Framebuffer checksums (SuperMarioDeluxe.gbc, committed in
  `tests/bench/baselines.json` keyed by ROM sha256):
  N=200 `70866000`, N=600 `bd26bb7b`, N=1000 `42d967fd` — identical
  between compiler.js and clang builds at every N.

## Design decisions

- **Correctness interlock is the point**: a bench that doesn't check output
  is worse than none for inlining work. Three independent tripwires, any of
  which exits 1: reps disagree (nondeterminism), cc != clang at any N
  (differential miscompile check), or divergence from the committed
  baseline sums (catches a miscompile even with no clang checkout around).
  Verified the FAIL path by corrupting a baseline sum (exit 1, names
  MISCOMPILE, one-liner says `sum FAIL`).
- **Optional inputs skip, never fail**: the ROM is gitignored/copyrighted
  (drop into `vendor/gameboy/roms/` or `--rom=PATH`; never committed) — no
  ROM prints an explicit SKIP and exits 0 (verified by hiding the roms
  dir), so fresh checkouts and CI are untouched. No `cc2wasm` → cc-only.
- **Opt-in, not a run.js category**: `tests/bench/` gets a no-suite RULES
  entry in tests/run.js (edits don't warn UNMAPPED, nothing gates on a
  gitignored input). Run it manually around codegen changes; the BENCH
  line is built for pasting into close-out logs.
- **Static instr count** decodes the cc wasm with a fail-loud MVP(+sign-ext
  +0xFC) decoder — unknown opcode drops the proxy loudly rather than
  miscounting. Clang's module isn't decoded (different feature surface);
  its size shows in the build log only.
- Second workload (doom/quake timedemo) deliberately deferred — SameBoy is
  the priority signal; the harness structure takes another `*_bench.c`
  workload without redesign.

Blame ranking for the 5.4x (expression-only inliner, no offset folding /
CSE / peephole) is unchanged from the 2026-07-12 investigation; the
inlining stages come next as their own queue items.
