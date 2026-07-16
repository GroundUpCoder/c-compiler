# 0228 — Hardening: read-only string literals (dedup + writable today — a UB write corrupts cross-literal silently)

- **Status**: open
- **Design**: —

## Goal

String literals are deduplicated AND writable (bug-hunt G23's side note,
assessed and DEFERRED in todos/0227): a UB write through a `char *` into one
literal silently corrupts every other use of the same spelling — no trap, no
diagnostic, just wrong strings later. clang/gcc put literals in `.rodata`
and the write faults.

Deliberately NOT shipped with 0227: wasm linear memory has no page
protection, so "read-only" needs either per-store bounds instrumentation
(costly, touches the codegen hot path) or a debug-mode-only check — and
turning writes that currently "work" into traps is a real behavior change
for existing UB-but-working code in the corpus. Needs its own design pass.

## Plan

- Survey options: (a) a `--check-literal-writes` instrumentation tier
  (stores bounds-check against the literal segment range, debug builds
  only); (b) canary/guard placement + integrity check in test harnesses;
  (c) keep the extension but stop deduplicating so UB writes at least stay
  local. Cost the hot-path impact of (a) before choosing.
- Whatever ships must keep default builds byte-identical (SameBoy
  interlock).

## Acceptance

- A UB write into a literal is caught loudly under the chosen tier (or the
  decision to keep current behavior is recorded with rationale here).
- Default-build output unchanged; no measurable slowdown in the default tier.
