# 0269 — Nondeterministic wasm output: one function-table slot drifts run-to-run

- **Status**: open — diagnosed 2026-07-20 (COULD-NOT-REPRODUCE; ASLR/stack
  hypothesis REFUTED). No fix landed; awaiting a reclassify/gate-hardening thread.
- **Design**: Root-cause diagnostic in
  `logs/2026-07-20/wasm-nondeterminism-rootcause.md`; repro harness in
  `build/nondeterminism-0269/`.

  **Finding (2026-07-20).** The reported run-to-run drift does NOT reproduce:
  0 outliers across **185 fresh/repeat builds** (110 fresh-process @ HEAD, 50
  fresh-process @ the original 7d04f1d, 25 in-process). P(0 | true rate 1-in-7)
  ≈ (6/7)^185 ≈ 3e-13, so the "1-in-7" was not a per-process random rate.

  **Stack-size / ASLR hypothesis: REFUTED**, three ways:
  1. A `--stack-size` sweep 66→4000 KB (60× range) yields the SAME sha at every
     value; a stack-ceiling-dependent branch would flip somewhere in it.
  2. The deepest recursion (recursive-descent parser) overflows only below
     ~64 KB, vs V8's ~984 KB default budget — a ~920 KB margin. ASLR jitters the
     stack base by ≪1 KB, far too little to flip it.
  3. When the limit IS hit (ss≤62) the compiler THROWS "Maximum call stack size
     exceeded" and the build FAILS (os-common.js:224) — it never silently emits a
     valid, one-slot-smaller module. No "caught-overflow → different slot count"
     path exists.

  **Allocation site.** Table slot = wasm funcIdx+1 (compiler.js:20183/20197),
  assigned by iterating `units`→`definedFunctions`/`staticFunctions` (plain
  arrays). The surviving-function set is fixed by `optimizeLinked` (:6354) and
  `gcSectionsPass` (:9323) — both deterministic. The WAST shake (:15480)
  preserves slot numbers with holes (:15550-15567), so it cannot cause the
  "all higher fps −1" symptom. There is NO run-to-run-varying allocation site
  under identical inputs; buildProject is a pure function of its inputs.

  **Best explanation for the 2026-07-19 outlier.** "First build differs, six
  converge" is not the ASLR scatter signature. The phaseB session was live-editing
  compiler.js AND adding/removing headers (langinfo.h bisect). A one-time
  uncontrolled input on the first capture (a header present/absent → one function
  compiled-or-not → every subsequent fp −1, table one slot smaller) matches the
  exact symptom and, unlike genuine nondeterminism, is consistent with 0/185
  reproduction.

  **Recommended (later thread, NOT done here).** (1) Harden the GATE: build in a
  pristine `git worktree` and hash ≥20 fresh processes (the harness does this) to
  remove the live-edited-first-build confound. (2) Optional insurance: make the
  AST-level shake slot-preserving like the WAST shake. (3) Reclassify 0269 to
  could-not-reproduce.

## Goal

Identical inputs must produce byte-identical wasm. Found during the Unicode
Phase B SameBoy byte-identity gate (2026-07-19, logs/2026-07-19/
gucos-unicode-phaseB.md): building `vendor/sameboy/bin.json` via
`os-common.js buildProject` with the SAME compiler.js (main @ 7d04f1d,
untouched) produced TWO different 662546-byte outputs across 7 runs —
one outlier (`f3022c70…`), six agreeing (`04eccc9e…`).

The delta is exactly ONE function-table slot: the outlier's table is one
slot SMALLER (table limits 2523 vs 2524), a low slot (< fp 91) is absent,
and every baked function pointer above it shifts by 1 (elem offsets, ~289
data-segment fp constants — SameBoy's dispatch tables — and 15 code-side
`i32.const` fps). Code/function/type/import sections are otherwise
byte-identical, so this is slot ALLOCATION drift, not a codegen diff.

## Plan

- Find the table-slot allocation site whose order/count can vary run-to-run
  with identical inputs. Prime suspect classes: a recursion-depth fallback
  (V8 stack budget varies per-process with ASLR — a caught
  "Maximum call stack size" changing a path), or an iteration over a
  structure whose order isn't insertion-stable.
- Make slot assignment a pure function of the input program.
- Repro harness: loop `buildProject(sameboy)` N times in fresh processes,
  compare SHA-256s (the outlier appeared 1-in-7 on 2026-07-19).

## Acceptance

- N (≥ 50) fresh-process SameBoy builds produce one SHA.
- The A/B byte-identity gate (compiler.js-touch mandate) is trustworthy
  without needing a same-process rebuild baseline.
