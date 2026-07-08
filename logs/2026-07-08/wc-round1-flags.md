# WC round 1 re-scoped — flags on plain C, no dialect (todos/WC.md)

Yesterday's WC.md designed a `.wc`/`.wh` dialect as the vehicle for
memory-free wasm modules. Today's assessment session inverted that: the
dialect is demoted to a late, pure-sugar milestone, and round 1 ships as
**two flags on plain C**. WC.md is rewritten accordingly; this log captures
the reasoning and the code facts that drove it.

## The decomposition that changed the plan

Working through "could this just be h/c handling + a strip list + some
always-on macros?" exposed that the substance of wc was never the dialect.
It is three dialect-independent capabilities:

1. **Envelope gating** — stop emitting the module-level scaffolding nothing
   used (memory, table, sp/heap globals, their exports, `alloca`).
2. **Memory-freedom enforcement** — make demanding linear memory a compile
   error, so only validated TUs become `.so`s.
3. **GC string literals** — string constants as externrefs, not data
   segments (the one construct that is *reinterpretation*, not stripping —
   macros can't reach literals).

Plain C + `__struct`/`__array`/`__externref` already expresses every
memory-free program. So round 1 = `--no-linear-memory` (enforcement) +
`--shared` (`.so` mode; forces no-linear-memory AND no-table for now — a
module-local funcptr index is meaningless across a module boundary, and
"honest manifest, zero relocations" is the whole promise). The dialect
becomes M4 sugar over a proven core — addable any time, deletable any time,
load-bearing never.

## Enforcement at the point of demand, not the syntax

The key design decision. A syntax/AST reject pass is wrong on both axes:

- **Under-rejects**: many paths reach the same bad tree; a syntax list is a
  whack-a-mole allowlist.
- **Over-rejects**: `int f(char *p) { return g(p); }` — holding a C pointer
  as an opaque scalar token — demands no memory and is exactly the Tier-1
  interop pattern the design wants.

Instead the envelope-gating flags **are** the validator: `usedMemory` /
`usedTable` flip at the emitter choke points where the demanding *bytes*
are written, each recording its first blame loc. Under the flag, first flip
= error at that loc; the emit()-time gate is the backstop. The property
checked is a property of the artifact, so there is no second way to a bad
module by construction. Verified the choke points are few and total:
`body.mop()` is the single funnel for every load/store (compiler.js:15881+),
plus `memoryCopy`/`memoryFill` (:13234), the `__memory_size`/`__memory_grow`/
`__heap_base` intrinsics, staticData allocation (`getStringAddress` :14556),
and `frameSize > 0` (:15207); table demand is `call_indirect` + funcptr
materialization. Bonus finding: the table is sized `totalFuncs + 1`
(:13643) — every function gets a slot today, so table gating must touch
elem population, not just the section header.

Gating itself is unconditional — pure-compute plain-C modules slim too, so
this removes a baked-in assumption rather than adding dialect complexity.
Care item: host.js and tooling must tolerate absent memory/table exports.

## String constants: importedStringConstants "#"

- New `GCStringLiteral` expr node, typed `__refextern` (non-nullable — the
  js-string spec types imported constants `(ref extern)`; never null).
- Spelling `__gcstr("...")` keyword builtin + `GCSTR(s)` macro. Rejected
  `@"..."` — breaks parses-as-C, chokes IDE analyzers.
- Module `"#"`; import name = string content, so dedup is by construction.
- **No engine cliff**: `imports["#"] = new Proxy({}, {get: (_, n) => n})`
  is a complete polyfill; the engine builtin only upgrades constants to
  validator-known immutables. boot.js/host.js unaffected everywhere.
- Emitter net-new: imported globals (kind 0x03) + the defined-global
  index-space shift — the off-by-N class, wants a targeted test.

## Code facts verified today (they de-risked the estimate)

- WC.md's 2026-07-07 "verified" line refs all still hold (:17397, :17747,
  :15207, :13641-13657; tags already gated :13660 — the in-tree precedent).
- `__export name = func;` already exists end-to-end (:12468 parse, :17449
  emit) — the `.so` export story is done.
- Keyword resolution runs **after** the PP (`postProcess` :982-997, correct
  C phase order) — so `#define struct __struct` works in plain C *today*;
  dialect sugar is user-opt-in with zero compiler changes meanwhile. When
  the real dialect lands, the mechanism is a per-file keyword-alias table
  in postProcess (tokens carry source file), not PP macros — can't leak,
  can't `#undef`, and plausibly lets `.c` include `.wh` directly, killing
  the projection pass from the original design.
- No `call_ref`/`ref.func` support exists — funcptrs across modules stay
  M3 (shared table at the C boundary; typed funcrefs preferred GC-side to
  keep zero-relocations airtight).

Estimate for R1: days, not weeks — gating (~a day, verified seams), the
`__gcstr` path, blame-loc plumbing, `-shared` driver mode, host tolerance.
