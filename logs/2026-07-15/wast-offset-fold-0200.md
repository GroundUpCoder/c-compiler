# WAST Stage 3a — the load/store offset-fold peephole (todos/0200)

The first real optimization through the 0197/0198 substrate: fold the
`i32.const k; i32.add` address-displacement pair into the load/store
memarg `offset=` immediate. Grep-verified before design: codegen emits
EVERY memory op with `offset 0` and materializes all address arithmetic
explicitly — the immediate was entirely unused. `foldMemOffsets` in the
WAST module, registered in `runPasses(wmod)`; every rewritten function is
re-validated (the 0198 rule; funcLabel isn't persisted on the funcDef, so
re-validation passes null — all structural checks except the
foreign-func-label one still run).

## The store shape — why the spec'd triple wasn't enough

The obvious pattern is three adjacent nodes
`[WConst i32 k, WAop i32.add, WMop off=0]`. That is sound for LOADS: a
load pops exactly its address, so an immediately-preceding add IS the
address producer. It is a MISCOMPILE for stores: a store pops
[value, addr] with the value on top, so the node before a store produced
the VALUE — `*p = x + 4` ends `local.get x; i32.const 4; i32.add;
i32.store`, and folding that triple would store `x` at `p+4` instead of
`x+4` at `p`. The store form therefore matches one node further back —
`[WConst k, WAop add, V, WMop store off=0]` — and only when V is a single
pure single-push producer (WConst / WLocalGet / WGlobalGet). Complex value
sequences (calls, loads, nested arithmetic) are skipped; locating the
address producer under them needs stack-effect analysis, out of scope for
an adjacency peephole. `tests/ast/test_wast_passes.js` pins the
miscompile case (`store-value-is-the-add`) forever.

## Safety rules (all pinned in test_wast_passes.js)

- k normalized as `Number(v) | 0` — exactly what serialize() emits — and
  must be `>= 0`. This kills both spellings of a negative displacement
  (`-8` and its wrapped-u32 form `4294967288`): a negative displacement
  relies on i32.add's mod-2^32 wrap, which the non-wrapping 33-bit memarg
  effective address would turn into a trap. For k >= 0 the fold assumes
  base+k doesn't wrap — only wrapped/UB pointer arithmetic could break
  that (no object spans the top of the 4GB space); the assumption every
  production wasm compiler makes.
- Only i32 ADD (addresses are i32), only `offset == 0` mops, align/opcode
  preserved untouched.
- Exact-class matching makes every barrier automatic: WRaw (opaque stack
  effect), control/label nodes, and WSrcLoc markers all fail the match.
  Nothing moves — two nodes are deleted and an immediate rewritten — so
  label identities survive by construction.
- Greedy at the fold site: only a k == 0 fold leaves the offset foldable
  again, so `+0` chains collapse in one pass and a SECOND run of the pass
  is a guaranteed no-op (idempotence asserted per-case in the test).

Telemetry: `wmod.passStats.offsetFolds`, mirrored to
`WAST.lastPassStats` (WAST is now in compiler.js's export surface).

## The gate (all foreground, this machine)

- **SameBoy framebuffer-checksum interlock (the primary oracle): PASS.**
  All three sums (N=200/600/1000: 70866000 / bd26bb7b / 42d967fd)
  identical before vs after and vs `baselines.json`, and the cc and clang
  legs agree at every N. The code changed everywhere; the pixels didn't.
- unit 715 + 8 xfail; ast 2/2 (incl. the new test_wast_passes.js, 20
  cases); run.py categories 274/274 (tcc differential notable: tcc built
  by the folded compiler still emits byte-identical i386 objects);
  blockfs + host ok; micropython-upstream 513 passed / 3 failed — the
  SAME 3 float tests fail with the stashed clean compiler (verified this
  run, filtered re-runs on clean HEAD), pre-existing/environmental.
- kernel 73/73 (449s; full OS boots — every OS binary offset-folded).
- browser sweep 25/25 first try (the 0199 os-wm flake didn't trigger).
- `tools/mkimage.js`: v94 bakes, seals, verifies (version bumped 93→94 —
  compiler.js changes every baked binary; the in-browser OPFS gate can't
  stat inputs).

## disw / sourcemap goldens — NOT regenerated, and why that's right

The plan sanctioned regenerating them; it turned out none change. The
only compiler-built disw golden (`tests/disw/compiler`) compiles
`int add(int,int)` + main — locals only, zero memory ops; the other six
disw cases are synthetic wasm_builder modules; the sourcemap golden
asserts line mappings, not byte offsets. All 8 pass untouched. The
mandated spot-check ran against a real binary instead: disassembled a
struct/array workload before/after (disw-native `-d`, offsets stripped),
and every hunk in the diff is exactly `i32.const k; i32.add` deleted with
`offset=k` appearing on the adjacent load/store — including the store
form (the value `local.get` stays put) and correctly-skipped stores whose
value is a load. i32.add count dropped by exactly the fold count.

## The measured result

SameBoy bench binary: **3931 folds** (= Δinstrs/2 exactly), 121728 →
113866 instructions (−6.5%), 283815 → 271376 B wasm (−4.4%), code
section 237310 → 224871 B (−5.2%). The smoke workload folded 272 sites
(libc included).

**Wall-clock is FLAT.** cc leg, 6 samples each side: before mean
5.554 ms/frame (5.540–5.575), after mean 5.599 ms/frame (5.577–5.646) —
nominally +0.8%, at the harness noise floor; the unchanged clang control
moved 1.080 → 1.082 (+0.2%) across the same runs. Reading: V8's
optimizing tiers already fold const+add into addressing, so cycles don't
move; the win is module size, decode/compile surface, and the cleaner
node sequences later passes see. Flagged per the stage plan: further
WAST stages should NOT be justified on this bench's ms/frame until one
demonstrably moves it — the inliner (the known 5.4x gap driver, see
todos/0186) remains the real perf candidate.

## Deliberately NOT here

No inliner, no other peepholes, no accumulate-into-nonzero-offset
(re-folding into an already-folded mop), no stack-effect analysis to
reach stores with complex values. Stage 3a is the cheapest certain win
only.
