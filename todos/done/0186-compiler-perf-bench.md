# 0186 — compiler codegen perf bench harness

- **Status**: done (2026-07-15; tests/bench landed + pre-inlining baseline captured — cc 5.70 ms/frame vs clang 1.05 (5.4x), 281051 B / 120084 instrs, sums baselined; log: logs/2026-07-15/compiler-perf-bench-0186.md)
- **Design**: —

## Goal

A committed, runnable, deterministic benchmark of the compiler's GENERATED
code — the before/after regression gate for the upcoming inlining work (and
any future codegen change). Step 0 of the inlining effort: the measured
baseline (2026-07-12, /tmp/sbbench: SameBoy GBC core, compiler.js 5.70
ms/frame vs clang -O2 1.04, 5.66x; binary 281 KB vs 169 KB) currently lives
only in /tmp and memory notes — land it in-repo so every stage has a
trustworthy number to diff against.

## Plan

- `tests/bench/` — standalone `node tests/bench/run.js` (informational,
  opt-in; NOT a run.js gating suite — the ROM is gitignored, so CI/fresh
  checkouts must never depend on it).
- Workload: the headless SameBoy bench (`sameboy_bench.c`, adapted from
  /tmp/sbbench/bench.c) — pure `GB_run_frame` throughput, no SDL, no
  timekeeping, fully deterministic.
- Measure **ms/frame slope-based** (best-of-3 wall times at N=200/600/1000
  frames; slope over the 800-frame span cancels V8 tier-up + startup), plus
  deterministic no-wall-clock proxies: binary size, code-section size,
  static wasm instruction count (fail-loud decoder).
- **Correctness interlock**: parse the framebuffer checksum each run —
  identical across reps (determinism), identical cc vs clang at each N
  (miscompile tripwire), and checked against `baselines.json` (keyed by ROM
  sha256 + frame count) so a miscompile can never masquerade as "faster".
- Optional inputs, graceful skip: no ROM → explicit SKIP + exit 0; no
  `~/git/clang-simplified/cc2wasm` → cc-only run, clang legs noted skipped.
  ROM drop location + flags documented in `tests/bench/README.md`.
- Add a no-suite RULES entry for `tests/bench/` in tests/run.js so bench
  edits don't warn UNMAPPED.

## Acceptance

- `node tests/bench/run.js` with the ROM present prints a one-line result
  (workload, ms/frame cc + clang, ratio, checksum OK, size/instr counts)
  and exits 0; checksum mismatch exits 1.
- Without the ROM: explicit skip message, exit 0 (fresh checkout safe).
- Pre-inlining baseline numbers recorded in a logs/2026-07-15 close-out
  entry and in `tests/bench/baselines.json`.
