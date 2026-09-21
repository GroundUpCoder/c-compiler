# 0228 — Hardening: read-only string literals (dedup + writable today — a UB write corrupts cross-literal silently)

- **Status**: in progress (branch `readonly-literals-0228`)
- **Design**: see `## Design` below

## Design

Decided approach (from the Fable decision thread — build this, do not
re-litigate):

1. **Dedup OFF by default.** Each *lexical* string literal now gets its own
   linear-memory storage (`getStringAddress` keys by AST-node identity, not by
   content). A UB write through a `char *` into one literal can no longer
   corrupt every other same-spelling literal — the corruption stays local to
   the one object that was written. wasm linear memory has no page protection,
   so this "keep it local" behavior is the best we can do at runtime without
   per-store instrumentation (the costly tier 0227 rejected).
2. **Opt-in merge flag.** `--dedup-literals` (alias `-fmerge-constants`;
   `--no-dedup-literals`/`-fno-merge-constants` to force off) restores the old
   content-keyed merging for builds that want the data-segment size back. Fully
   wired (CLI + `run-unit.js`), not a stub.
3. **Compile-time diagnostic.** A *provable* direct store through a string
   literal — `"x"[i] = …`, `*"x" = …`, `*("x"+k) = …`, `++"x"[0]`, through
   decays/casts/pointer-arith/all-literal ternaries — is now a hard compile
   error (`assignment to read-only string literal`). Zero runtime cost; nothing
   correct ever hits it. Writes through a *variable* that merely holds a literal
   value stay un-diagnosed (not statically provable) — those are what dedup-off
   localizes.

**Rejected** (do not implement): copy-on-first-use (needs page protection we
lack); diagnostic-only with dedup left on (leaves the cross-corruption in
place).

### Size delta from disabling dedup by default

Representative build — the full Lua 5.5 interpreter (`vendor/lua`, 33 TUs,
~323 KB wasm):

| build | data (string) section | total .wasm |
|-------|-----------------------:|------------:|
| `--dedup-literals` (old behavior) | 15 294 B | 323 202 B |
| **default (dedup off, new)** | **17 945 B** | **325 854 B** |
| **delta** | **+2 651 B (+17.3% of the data segment)** | **+2 652 B (+0.82% of the module)** |

So disabling dedup costs ~17% more *string* bytes (well under 1% of the whole
module). That is small enough to make correctness-by-default the right call, and
large enough that a size-sensitive build has a real reason to reach for the
opt-in `--dedup-literals` flag — which justifies keeping the flag as a wired,
first-class option rather than dropping it.

### Behavior-change note (documented, not a failure)

Disabling dedup shifts the data-segment layout, so **emitted bytes change** for
any module with duplicate string literals. The **SameBoy byte-identity
interlock is rebaselined by design** (see dev log) — this is an expected layout
change, not a regression.

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
