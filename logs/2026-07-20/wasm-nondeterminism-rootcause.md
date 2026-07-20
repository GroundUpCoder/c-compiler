# 0269 — WASM build nondeterminism: root-cause diagnostic

**Thread:** single-writer diagnostic (branch `wasm-nondeterminism-0269`, worktree).
**Scope:** ROOT-CAUSE ONLY — no compiler.js / codegen edits. Notes + harness only.
**Date:** 2026-07-20. **Base:** main @ ab9f9be; original report @ 7d04f1d.

## TL;DR

- **Stack-size / ASLR hypothesis: REFUTED**, on three independent grounds (numbers below).
- **The reported run-to-run drift does not reproduce**: 0 outliers across **185 builds**
  (110 fresh-process @ HEAD, 50 fresh-process @ 7d04f1d — the exact original commit,
  25 in-process repeats). P(0 outliers | true rate 1-in-7) ≈ (6/7)^185 ≈ **3e-13**.
- buildProject is a **pure function** of its inputs: every stage that could drop a
  function (and thus shift function-table slots) is deterministic by construction,
  verified by code audit + the 185-build corpus.
- The 2026-07-19 outlier is **most consistent with an uncontrolled INPUT difference
  on the first build**, not per-process compiler nondeterminism (see "What actually
  happened" — the phaseB session was live-editing compiler.js AND adding/removing
  headers, e.g. `langinfo.h`; a header-presence flip changes which functions compile
  and shifts every baked fp by one, matching the symptom exactly).

## Harness (committed under `build/nondeterminism-0269/`)

- `build-once.js`      — build vendor/sameboy/bin.json with HEAD compiler.js+os-common.js, print sha256+len.
- `build-once-orig.js` — same, but compiler.js+os-common.js pinned at 7d04f1d (`orig/`, extracted via `git show`; vendor/ is unchanged since).
- `run-harness.sh N [node-args]` / `run-orig.sh` — loop N FRESH node processes, tally distinct SHAs.
- `inproc-repeat.js N` — build N times in ONE process (mimics a bake, which builds many projects per process).

All outputs land inside the worktree; nothing is written to a shared absolute path
(the concurrent sibling mGBA build is untouched).

## Data

### Fresh-process determinism (the core test)
| corpus | builds | distinct SHAs |
|---|---|---|
| HEAD (ab9f9be) fresh procs | 50 + 60 = 110 | **1** (`1c477ed7…`, 664893 B) |
| 7d04f1d (original commit) fresh procs | 50 | **1** (`c845ac88…`, 664872 B) |
| HEAD in-process repeat | 25 | **1** |

The original report was "1-in-7, outlier = the FIRST build." A per-process ASLR
flip at 1-in-7 would give P(0 in 185) ≈ 3e-13. So the 1-in-7 was **not** a
per-process random rate.

(Length differs from the todo's 662546 B because vendor's dep closure/compiler.js
have moved since the log was written — immaterial to a determinism check.)

### --stack-size sweep (the hypothesis test), @7d04f1d
Sweeping V8 JS-stack budget (KB): 300,400,…,984(default),…,4000 →
**identical SHA `c845ac88…` at every value**. A stack-ceiling-dependent branch would
have flipped somewhere across this 13× range. Low-end:

| --stack-size (KB) | result |
|---|---|
| 40 | crash during module load |
| 60, 62 | **"Maximum call stack size exceeded"** → build **FAILS** (caught at os-common.js:224) |
| 66 … 4000 | OK, identical SHA |

The deepest recursion in the whole compile is the **recursive-descent parser**; it
overflows only below ~64 KB. Node/V8's default JS-stack budget is ~984 KB, so the
parser runs with a **~920 KB margin**. ASLR randomizes the stack base by at most a
few pages (≪1 KB, at most a few KB) — orders of magnitude too small to flip a
920 KB margin. And when the limit *is* hit, the compiler **throws** — it never
silently emits a valid, one-slot-smaller module. So the "caught-overflow flips a
slot" mechanism does not exist in this pipeline.

## Where table slots come from (allocation-site localization)

- Function-table slot = wasm funcIdx + 1: `funcDefToTableIdx.set(fdef, funcIdx+1)`
  (compiler.js:20183 imports, :20197 definitions). funcIdx is assigned by iterating
  `units` then `[...unit.definedFunctions, ...unit.staticFunctions]` — plain arrays,
  fully insertion-ordered. Slot order is therefore a pure function of the surviving
  function set and its source order.
- The surviving set is fixed by two deterministic passes:
  - `optimizeLinked` / `foldStmt` inliner (compiler.js:6354+): post-order DFS over
    `referencedFunctions` (a `TreeBag`, recursive but deterministic iterator);
    inline decision is `effSize(sub, budget) > budget` — a pure size compare.
  - `gcSectionsPass` (compiler.js:9323+): worklist over a `Set` + array queue seeded
    from `main`/`alloca`/exports in array order. Deterministic.
- The **WAST-stage tree-shake** (compiler.js:15480+) deliberately **preserves slot
  numbers, leaving holes** (`tableLayout = {size: oldTotal+1, segments}`, :15550-15567)
  precisely so baked fp constants never shift. So a deletion *there* cannot produce
  the reported "all higher fps −1" symptom. Only an **AST-level** elimination (before
  funcIdx assignment) shifts fps — and those passes are deterministic.

**Conclusion: there is no run-to-run-varying allocation site under identical inputs.**

## What actually happened on 2026-07-19 (best explanation)

The phaseB log records: first pristine build = `f3022c70…`; six subsequent
(incl. "pristine in-place", "pristine from /tmp", the full edit, and three bisect
variants "define-only / comment-only / minus langinfo.h") = `04eccc9e…`. Signature:
**first differs, all rest converge** — not the scatter ASLR produces. The session was
actively editing compiler.js and adding/removing headers. A one-time uncontrolled
input on that first capture (a header present/absent → one function compiled-or-not
→ every subsequent fp shifts by one, table one slot smaller) reproduces the exact
symptom, and unlike genuine nondeterminism it is consistent with 0 reproduction in
185 clean builds.

## Recommended fix (for a later thread — NOT done here)

1. **Harden the byte-identity GATE, not the compiler.** Build in a pristine
   `git worktree` and hash across ≥20 fresh processes (the harness here does exactly
   this). That removes the "first build over a live-edited tree" confound that
   produced this false P0. Keep `build/nondeterminism-0269/` as the regression
   tripwire.
2. **Optional determinism insurance (design change, out of scope here):** teach the
   AST-level inliner/tree-shake to preserve funcIdx/slot numbering the way the WAST
   shake already does (hole-preserving). Then even a legitimate compiler.js change
   that flips one function's liveness would NOT shift every baked fp — the gate stays
   quiet for semantically-neutral inliner improvements. This is defense-in-depth; it
   is not fixing a confirmed live bug.
3. **Reclassify 0269:** from "confirmed P0 nondeterminism" to "could-not-reproduce;
   most likely an uncontrolled-input artifact of a live-edited first build." The
   deploy gate is not being silently weakened by a codegen race — buildProject is
   deterministic across 185 builds and a 50× stack-size sweep.
