# #12 — GNU-extension gap triage (SameBoy port): re-measure + rulings

Lane #12, triage only. Ticket #12 ("0087 — Compiler triage: GNU-extension gaps
surfaced by the SameBoy port", P3/light) lists seven gaps written down
2026-07-12. The compiler moved since, so every claim was re-measured at the
current tip before ruling. **No compiler code lands here; no tickets are filed
here** — @master files from this table.

- Tree measured: `~/worktree/c-compiler/12-gnu-triage` @ `92f0745d` (= main).
- Method: every probe compiled through the real cc driver
  (`COMMON.createCcDriver(CompilerJS, kfs)` over a `BLOCK_FS.MemoryByteStore`
  — the sanctioned harness shape from `tests/host/test_gcode_orientation.js`),
  runtime probes executed via host.js `runModule`. Scratch script, not
  committed.
- Positive controls: a syntax-error file fails compile (exit 1, parse error
  named), and `return 42` runs to exit 42 — the harness detects both failure
  modes, so a green probe is a measurement, not a null.

## Why the ticket body is stale (the interesting part)

Gap 1 was **fixed and annotated fixed on 2026-07-22** — commit `bfe4edc5`
("0087 item-1: annotate offsetof-ICE fixed + lock array-bound case with
conformance test") updated the old file-based `todos/0087-gnu-ext-gaps-triage.md`
and added `tests/unit/core/offsetof_array_bound`. But the ticket DB body was
migrated from a **2026-07-12 snapshot** of that file, and the 07-22 annotation
never reached the DB. The retired-file → ticket-DB migration is a one-shot
copy; anything annotated in the file after its snapshot silently reverted to
"open" in the ticket. That is the mechanism behind this whole re-measure
mandate, demonstrated live.

## Per-gap measurements and rulings

### Gap 1 — `offsetof` as an integer constant expression → **C. ALREADY RESOLVED**

Probe (the exact ticket claim — an offsetof-difference array bound):

```c
#include <stddef.h>
#include <stdint.h>
struct A { int x; char y[13]; int z; };
static uint8_t buf[offsetof(struct A, z) - offsetof(struct A, y)];
int main(void) { return sizeof(buf) == 16 ? 0 : 1; }
```

- File-scope bound: compile exit **0**, run exit **0** (folded to 16).
- Local-scope bound (the SameBoy gb.c rtc shape, the claimed VLA rejection):
  compile exit **0**, run exit **0**.
- `case offsetof(struct A, z):` label: compile exit **0**, run exit **0**.
- Control: literal-16 bound compiles identically (the probe distinguishes
  nothing being measured from a pass).

`((size_t)&((T*)0)->m)` (the macro at `compiler.js:25356`) const-folds in all
three ICE contexts. Fixed before 2026-07-22, locked by conformance test
`tests/unit/core/offsetof_array_bound` (commit `bfe4edc5`). Shape is honest: a
real fold under the standard macro, plus a regression lock.

**Residual (optional, for @master):** `vendor/sameboy/README.md:76` still
claims "offsetof doesn't fold to an integer constant expression **yet**" —
that claim is now **false**, and the gb.c rtc patch (checked 128-byte buffer)
is revertible port tax. A light vendor-cleanup ticket is defensible but not a
compiler item.

### Gap 2 — GNU statement expressions `({ … })` → **A. PROMOTE**

```c
int main(void) { int a = ({ int t = 3; t + 4; }); return a == 7 ? 0 : 1; }
```

Compile exit **1**: `error: Unexpected token in expression: PUNCT '{'`. Still
absent.

Second consumers (the ticket's own promotion trigger — it has fired):
- SameBoy: **3 patch rows** (`defs.h` MIN/MAX → plain ternaries, `defs.h`
  `GB_inline_const` → compound literal, `display.c` one unrolled site).
- busybox: `xargs.c` `ISSPACE` statement expression → ALWAYS_INLINE helper,
  same rewrite as libbb.h's ctype trio (`vendor/busybox/README.md:142`).

Proposed ticket: **"Compiler: GNU statement expressions `({ … })`"** —
parser + sema + codegen for the full GNU semantics (value = last expression
statement, block-scoped declarations, usable in any expression context).
PRINCIPLES: this is the *real implementation* option — a subset under the GNU
syntax is forbidden; if scoped, the boundary must be declared, not discovered.
- Difficulty: **medium**. Priority: **2** (feature-gap; every consumer has a
  documented workaround, no shipped contract violated).
- `epic:gamedev` (argued): the port-tax on the game-port corpus is measured —
  the MIN/MAX rewrites are "audited side-effect-free" hand-patches whose audit
  rots silently as upstream moves, and MIN/MAX-style statement-expr macros are
  pervasive in exactly the Linux-adjacent C game ports arrive in. Honest
  caveat: no in-OS dev-loop consumer is named.

### Gap 3 — Elvis operator `x ?: y` → **A. PROMOTE**

```c
static int calls = 0;
static int f(void) { calls++; return 5; }
int main(void) { int y = f() ?: 9; /* + single-eval + 0?:7 checks */ }
```

Compile exit **1**: `error: Unexpected token in expression: PUNCT ':'`. Still
absent.

Second consumers: **12 measured vendored sites across 3 ports** — SameBoy 5
(`apu.c`/`display.c`/`sgb.c`), busybox `vi.c` 6, busybox `time.c` 1 (each
README row carries the "operands side-effect-free" audit caveat).

Proposed ticket: **"Compiler: GNU elvis operator `x ?: y`"** — a small parser
production over the existing conditional; the one semantic that matters is
*first operand evaluated once* (which is exactly why the vendored
`x ? x : y` rewrites need their side-effect audits). Full GNU semantics are
small and well-specified, so the honest shape is cheap.
- Difficulty: **light**. Priority: **2** (feature-gap).
- `epic:gamedev` (argued): same port-tax argument as gap 2, with the most
  measured sites of any gap in the list. Same honest caveat: no in-OS
  dev-loop consumer named.

### Gap 4 — PP directives inside macro arguments → **A. PROMOTE (weakest — defer is defensible)**

Minimal probe (`#ifdef/#else/#endif` inside `ID(...)`): compile exit **1**,
`error: Unexpected token in expression: PUNCT '#'`. The SameBoy `GB_SECTION`
shape (directive-gated struct members in a variadic macro arg) also fails
(exit 1). Still absent, both shapes.

Second consumers: SameBoy `gb.h` (4 `#ifndef` blocks removed) and busybox
`touch.c` — `vendor/busybox/README.md:158` records that `LONG_OPTS=y` is
"REQUIRED, not cosmetic" *precisely because* the `LONG_OPTS=n` config expands
`#if` directives inside `getopt32long` macro arguments. The trigger has
technically fired, but the busybox hit was absorbed by a config choice, not a
source patch.

Proposed ticket: **"Preprocessor: process directives during macro argument
collection (gcc/clang-compatible)"** — C11 6.10.3p11 makes this UB, so there
is no standard contract to violate; the target contract is gcc/clang's
documented behavior. Needs the PP to execute conditionals encountered while
collecting arguments.
- Difficulty: **medium** (PP argument-collection surgery). Priority: **3** —
  honest note: this is the weakest payoff-to-cost of the promoted set (two
  consumers, both cheaply absorbed); @master rejecting this into a
  wait-for-a-third-consumer note would also be defensible.
- `epic:gamedev` (argued, weakly): save-state struct sectioning of the
  GB_SECTION kind is a game-emulator idiom; otherwise generic port tax.

### Gap 5 — `__attribute__((constructor))` → **A. PROMOTE** (ticket claim stale; current shape already honest)

```c
__attribute__((constructor)) static void init(void) { inited = 1; }
```

Compile exit **1** — but **not** the ticket's claimed "hard parse error":
`error: __attribute__((constructor)) is not supported`. The compiler now has a
deliberate attribute machine (`compiler.js:~10510-10545`): known harmless
attrs accepted (`unused` probe compiles and runs green), semantics-changing
attrs (`constructor`/`destructor`/`alias`/`ifunc`/`weak`/`vector_size`/…) get
a **named loud refusal**, unknown attrs error. That is exactly PRINCIPLES'
honest-absence shape — the current state is correct, just not the feature.

Consumers: **three ports** — SameBoy (`apu.c`/`random.c` → lazy init), mGBA
(`common.h` `CONSTRUCTOR(FN)` dropped — with a **live, measured cosmetic
defect**: every `mLOG_DEFINE_CATEGORY` registrar is skipped, so all mGBA log
categories collapse to id 0, `vendor/mgba/README.md:75`), NetSurf libnsfb
(`NSFB_SURFACE_DEF` registration → explicit lazy call).

Proposed ticket: **"Compiler: `__attribute__((constructor))`/`(destructor)` as
a pre-main init pass"** — in this static-link single-module world, collect
ctor functions (with gcc priority-argument ordering), emit calls before
`main`; dtors at exit. If dtors or priorities are descoped, the boundary must
be **declared** (docs + the named refusal stays for the descoped part), per
the scoped-but-honest rule.
- Difficulty: **medium**. Priority: **3** (feature-gap; every consumer's
  workaround was cheap, and the refusal is already loud — nobody trips this
  silently).
- `epic:gamedev` (argued): three consumers are game/emulator ports, and mGBA
  carries a live in-OS defect (broken log categories) traceable to this gap.

### Gap 6 — `vasprintf`/`asprintf` in libc → **B. REJECT / defer**

```c
int n = asprintf(&s, "x=%d", 42);   /* and a va_list vasprintf twin */
```

Both compile exit **1**: `Undeclared identifier 'asprintf'` /
`'vasprintf'`. Still absent — and the absence is honest (loud at compile).
Measured against the shipped libc, not vendor code.

Second-consumer test **fails**: across the whole vendored corpus, only
SameBoy ever paid this tax (`gb.c` vasprintf → fixed 512-byte vsnprintf,
`vendor/sameboy/README.md:75`). busybox (`platform.h`), NetSurf (`talloc.c`)
and tcc (`tcclib.h`) all *bundle their own* implementations upstream — they
are portability-hardened codebases that never touch our libc gap.

**Named promotion trigger:** the next port whose upstream calls
`asprintf`/`vasprintf` **without** carrying its own fallback (i.e., a
GNU-assuming codebase, not a portability-hardened one) — at which point the
fix is **light**: real POSIX/GNU semantics (measure with `vsnprintf(NULL, 0)`,
allocate exact, no truncation) under the standard names. A fixed-buffer
lookalike under these names would violate PRINCIPLES and must not be what gets
promoted later.

### Gap 7 — `__builtin_bswap16/32/64` as real builtins → **C→A. Closed in effect, dishonest in shape — PROMOTE the defect**

The names exist and compute correct values (bswap16/32/64 all verified by
runtime probe, exit 0), and they are even usable as ICEs
(`static char buf[__builtin_bswap32(0x04000000u)]` folds — exit 0). But they
are **preprocessor macros in the builtin prelude** (`compiler.js:35027-35029`,
landed with the mGBA port, commit `7e5fa46c`/todos-0112), and the macro form
**double-evaluates**, measured:

```c
int main(void) { unsigned i = 0; unsigned r = __builtin_bswap32(i++); (void)r; return (int)i; }
```

Run exit **4** — `i++` executed **four times** (a real builtin gives 1; the
value of `r` is likewise garbage relative to intent). Classification:
**contract-violation** — the governing contract is GCC's documented builtin
(a *function-semantics* builtin: argument evaluated once); the prelude
presents these names as those builtins ("Byte-swap builtins (GCC/Clang)",
comment at `compiler.js:35024`) with no declared divergence, so Amendment A
(declared benign degradation) cannot apply: undeclared, and wrong computation
is load-bearing. This is PRINCIPLES' "never approximately implement a
standard name", live.

Blast radius, measured honestly: **latent, no live victim found.** Nine
in-tree files name `__builtin_bswap*`, but micropython gates on
`__has_builtin` — which this compiler **does not define at all** (probed:
`defined(__has_builtin)` is false), so guarded consumers fall through to
their own fallbacks; mGBA's unconditional uses sit in a big-endian branch
unreached on wasm; SameBoy patched its own static inlines before the macros
existed. The hazard is armed for the next port that passes a side-effecting
argument unguarded — a silent-wrong-code class.

Proposed ticket: **"Compiler: `__builtin_bswap16/32/64` as real builtins —
the prelude macro form double-evaluates its argument"** — implement as true
compiler builtins (single evaluation; wasm has no bswap opcode, so codegen as
the shift/mask sequence), **preserve ICE-foldability** (constant args must
still fold — the macro form folds today, so a naive lower-to-libcall would
*regress* a measured working capability), and **delete the prelude macros in
the same change** (the two-sided-edit rule). Worth noting in the ticket:
`__has_builtin` being undefined is a separate, adjacent absence the
implementer will trip over.
- Difficulty: **light**. Priority: by the letter of the policy, a contract
  violation in a shipped feature files at **0**; measured harm today is nil
  (no live consumer miscompiles), which is @master's to weigh — the weight
  sort puts a light ticket at the head of its tier either way. Not inflated,
  not buried: the classification is contract-violation; the blast radius is
  latent.
- `epic:gamedev` (argued): toolchain correctness for exactly the code shape
  game ports use (emulators byte-swap constantly); a silent wrong-code hazard
  in the compiler every in-OS game developer compiles against is on the epic
  path regardless of which port trips it first.

## Port-tax quantification

`vendor/sameboy/README.md` carries **11 patch rows**; **9 trace to these seven
gaps** (G2×3, G1, G3, G4, G5, G6, G7 — the other two are `<alloca.h>` and the
printer.c VLA, neither in this ticket). One row (G1's) is now revertible; one
row's stated reason (row 76's "yet") is now false. The README's other claims
were spot-checked against the probes and hold.

## Bookkeeping flags for @master

- Ticket #12 `design` field carries a stale `pkgdev:os-proper` tag — PKGDEV
  was tabled 2026-08-13; `epic:gamedev` is the live half.
- The ticket body predates the `bfe4edc5` gap-1 fix annotation (see "Why the
  ticket body is stale" above) — worth noting in the close-out.
- Epic honesty, carried as instructed: **no in-OS dev-loop consumer is named
  for any of these gaps.** The promotes lean on the port-tax argument; the
  gap-6 reject and the gap-4 "defer is defensible" note lean on its absence.

## Suite plan for this diff

`node tests/run.js --diff main --dry-run`: this diff is `logs/**.md` only →
**no suites selected** (the IGNORE set). Output recorded in the lane report to
@master. No suite was run (heavy lock held by another lane's gate, per
kickoff).
