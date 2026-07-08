# WC — memory-free wasm modules from C (and, later, the wc dialect)

Status: **design / not yet queued.** Round 1 re-scoped 2026-07-08: **no
dialect** — two compiler flags on plain C + the existing `__`-extensions.
The wc dialect survives as a later, pure-sugar milestone (see "The dialect,
demoted to sugar" below). Original 2026-07-07 findings preserved; decision
log in `logs/2026-07-08/wc-round1-flags.md`.
Related: `WASM_GC.md`, `EXTERNREF.md`, `OS.md` (dlopen/`.so` story).

## Thesis

A memory-free module's wasm *import section* is a complete, honest manifest
of everything it needs to link, because the compiler emits no implicit
memory, static data, relocations, or shadow stack for it. Two such modules
(or one and a full-C module) link by name-matching wasm imports/exports and
passing values/refs — no memory-layout merging, no GOT, no
`__memory_base`/`__table_base`. The heavy Emscripten "dylink" ABI
evaporates, *specifically because* the module manages no memory.

Originally this was framed as a dialect ("wc"). The 2026-07-08 re-scope
recognizes the substance was never the dialect — it is three
dialect-independent capabilities:

1. **Envelope gating** — stop emitting memory/table scaffolding nothing used.
2. **Memory-freedom enforcement** — a flag that makes demanding linear
   memory a compile error, checked at the point of demand.
3. **GC string literals** — string constants as externrefs, not data
   segments.

Plain C + `__struct`/`__array`/`__externref` can express every memory-free
program today; the dialect is ergonomics and can come later, purely as
sugar over a proven core.

## Round 1: two flags, no dialect (decided 2026-07-08)

- **`--no-linear-memory`** — enforcement flag. Compiling a TU that *demands*
  linear memory (or a function table — see choke points below) is an error,
  reported at the first demanding construct's source location.
- **`--shared`** — `.so` output mode: no `main` required, `__export`
  directives (already implemented — parsed :12468, emitted :17449) are the
  module interface. **Forces `--no-linear-memory`, and additionally forbids
  table demand, for now**: until the M2 imported-memory tier exists a `.so`
  must be memory-free, and a module-local funcptr table index crossing a
  module boundary is meaningless to the other side — funcptrs-in-`.so` wait
  for M3. Driver shape: `cc -shared foo.c -o foo.so` (morally: `-shared`
  implies `-fPIC`).

Only flag-validated TUs become `.so` files — the driver enforces this, not
the language. `--no-linear-memory` alone (without `--shared`) permits a
module-private table: self-contained `call_indirect` is sound when no index
escapes, and enforcing escape is not statically possible anyway.

## The envelope, and gating it

**"Envelope"** = the module-level scaffolding emitted *unconditionally
around* the compiled functions, as opposed to per-construct code inside
bodies (already demand-driven). Inventory (all verified 2026-07-08):

| piece | where | gated today? |
|---|---|---|
| `__stack_pointer` + `__heap_base` globals | `compiler.js:17397-17398` | never |
| `addMemory` + `memory`/`__indirect_function_table`/`__heap_base` exports | `:17747-17780` | never |
| table section 4 — sized `totalFuncs + 1` (every function gets a slot) | `:13643-13646` | never |
| memory section 5 | `:13648-13657` | never |
| `alloca` helper + export | `:17430` | never |
| data segments | `:17758` | `staticData.length > 0` |
| shadow-stack prologue/epilogue | `:15207`/`:15247` | `frameSize > 0` |
| tag section | `:13660` | `tags.length > 0` |

Gating = `cg.usedMemory` / `cg.usedTable` flags; emit the top block only
when the corresponding flag is set (the tag section is the in-tree
precedent). Note table gating touches **elem population** too, not just the
section header — today every function occupies a slot regardless of
address-taken-ness.

Gating is **unconditional** (not behind the flags): every pure-compute
module slims, so this is removing a baked-in assumption, not adding
wc-specific complexity. The care item: hosts that assume a `memory`/table
export (host.js instantiation, tooling) must tolerate their absence.

## Enforcement: at the point of demand, not the syntax (decided 2026-07-08)

**No AST/syntax reject pass.** Syntax is too surface-level — many paths
reach the same bad tree, and syntax rules also *over*-reject: holding a C
pointer as an opaque scalar token (`int f(char *p) { return g(p); }`)
demands no memory and is exactly the Tier-1 interop pattern we want.

Instead, **the gating flags are the validator.** They flip at the choke
points where the demanding *bytes* are emitted, so the checked property is
a property of the artifact, not the tree — there is no second way to reach
a memory-using module that bypasses them, by construction:

`usedMemory` flips in:
- `body.mop(...)` — the single funnel for every load/store instruction
  (all of `emitLoad`/`emitStore` route through it, `:15881`+)
- `body.memoryCopy()` / `body.memoryFill()` (`:13234-13235`)
- `__memory_size` / `__memory_grow` / `__heap_base` intrinsic codegen
- staticData allocation (`getStringAddress` `:14556`; global data placement)
- `frameSize > 0` at function emit (`:15207`) — itself demand-driven:
  address-taken locals, by-value aggregates, VLA, `alloca`, `va_arg`

`usedTable` flips in:
- `call_indirect` emission
- function-address materialization (funcptr → table index)

Each flag records its **first blame loc**. Under `--no-linear-memory` the
first flip is an immediate error at that loc (fail fast, precise
diagnostic); the `emit()`-time gate doubles as a backstop assertion. If
neither flag flipped, the module provably carries no memory/table — nothing
is left to validate after the fact.

Consequences accepted deliberately:
- Flagged TUs live outside libc — `printf` and friends demand memory
  everywhere. These are leaf modules: scalars, GC structs, externref
  strings, `__import`ed capabilities.
- A bare `"..."` (staticData) under the flag fails with a blame loc at the
  literal; the fix is `GCSTR("...")`. Honest diagnostic, right nudge.

## GC string literals (decided 2026-07-08)

- New expression node **`GCStringLiteral`**, typed **`__refextern`**
  (non-nullable — the js-string spec types imported constants
  `(ref extern)`, and a constant is never null); decays to `__externref`
  like other refs.
- Surface spelling: **`__gcstr("...")`** keyword builtin (pattern-matching
  `__new`/`__array_len`), with **`GCSTR(s)`** as the friendly macro.
  Argument must be a string literal; adjacent-literal concatenation works
  (parser already concatenates, `:10142`). **No `@"..."`** — it would break
  the parses-as-C principle and choke C analyzers/IDEs.
- Lowering: js-string **`importedStringConstants`, module `"#"`**. Each
  distinct literal is one imported immutable externref global whose import
  *name is the string content* — dedup is by construction; codegen is a
  `global.get`.
- **No engine cliff.** Where the engine builtin is absent (or in our own
  loaders), the polyfill is one line:
  `imports["#"] = new Proxy({}, { get: (_, name) => name })`.
  Engine support merely upgrades the constants to validator-known
  immutables. `boot.js`/host.js keep working everywhere.
- Emitter net-new: **imported globals** (import kind 0x03) + the
  index-space shift — defined-global indices offset by the imported count,
  the same dance function imports already do (`:13630`). Classic off-by-N
  bug class; wants a targeted test.

## Codegen coupling — how hard is the memory-free mode? (verified 2026-07-07)

Linear memory is **demand-driven, not deeply threaded.** Per-construct
usage is already gated (see envelope table above); only the envelope is
unconditional, and it is centralized. Gating it is a localized,
~day-of-careful-work-with-tests change — a mode, not a second backend. The
GC/externref codegen paths needed already exist and work.

Empirical baseline: a pure-GC program today still emits `memory`,
`__heap_base`, `__indirect_function_table`, `alloca`, and a data section
(193 bytes for `int main(){return add(2,3);}` + one `__struct`). Gating
removes all of it.

## Minimal rec groups — already done (verified 2026-07-07)

Cross-module GC type identity relies on structural canonicalization of
**minimal rec groups**. The type emitter already does exactly this: an
iterative Tarjan SCC pass (`compiler.js:13528`) puts each type in its own
singleton rec group unless it is part of a genuine mutually-recursive
cycle, in which case the minimal SCC becomes the group (comment at
`:13494-13504`). Cross-*module* identity rides the same guarantee that
already fixes cross-*TU* identity. Remaining care: field mutability /
finality / rec-group shape must match exactly across modules — both sides
compiling the same header ensures it.

## Interop model — two tiers

**Tier 1 — values, refs, handles. Zero shared memory.** Exchange scalars,
GC refs, and externrefs by wasm import/export. A memory-free module holds a
**C pointer as an opaque scalar it never dereferences**, so it works as
clean orchestration over C libraries:

```c
int db = c_sqlite3_open("foo.db");   // C returns a heap offset; held as a token
c_sqlite3_exec(db, "SELECT ...");    // handed back — never dereferenced
```

Needs *nothing new in the compiler* — honest import/export already works.
This is the round-1 sweet spot. (Note the enforcement design deliberately
permits this: demand-point checking accepts opaque pointer-holding; only an
actual dereference flips `usedMemory`.)

**Tier 2 — shared linear memory.** To actually read a `char*` C handed
over, the module must **import C's `memory`** and use explicit builtins,
with a shared allocator (`__import("env","malloc")` — C owns the heap). A
flag-validated module contributes no static data and takes no addresses of
statics, so it needs **zero relocations** — far lighter than Emscripten
dylink.

## Function pointers across modules (M3)

The one dylink primitive that can't be fully avoided — but it is naturally
deferred (round-1 `.so`s forbid table demand entirely). When it lands:

- **C-boundary callbacks**: a shared table, append-at-`dlopen`, index
  handed back — C's `call_indirect` needs a slot.
- **GC-world callables**: prefer **typed funcrefs / `call_ref`**
  (net-new codegen — no support today, verified). Funcref values need no
  table and no indices, so no module-local compile-time slots exist to
  collide — which is exactly what keeps the "zero relocations" promise
  airtight. The shared table then shrinks to the C ABI boundary only.

## The dialect, demoted to sugar (2026-07-08)

When wc/.wh arrive, the mechanism is a **per-file keyword-alias table in
`postProcess`** (`:990-997` — the existing IDENT→KEYWORD pass; tokens carry
their source file), **not PP macros**:

- `struct`→`X_STRUCT_GC`, `str`→`X_EXTERNREF`, `array`→`X_ARRAY_GC`,
  `new`→`X_NEW` — all already parse in C-compatible shapes
  (`__array(int)`, `__new(...)`), so the sugar is literally a spelling
  remap, ~30 lines, consulted only for tokens whose file ends `.wc`/`.wh`.
- Why not macros: PP defines are TU-global once defined, `#undef`-able, and
  hazardous under mixed includes. The alias table is scoped exactly "for
  the duration of those files," can't leak, and needs no push/pop
  machinery.
- Bonus: it plausibly makes `.wh` **directly includable from `.c`** —
  tokens lexed from the `.wh` remap, the includer's don't — which would
  kill the `.wh`→`.h` projection pass from the original design. To verify
  then: PP macro expansion preserves definition-site file locs on body
  tokens (giving definition-site dialect semantics for macros defined in
  `.wh`).
- Verified fun fact: keyword resolution runs **after** the PP in this
  compiler (`postProcess`, `:982-997` — correct C phase order), so
  `#define struct __struct` in plain C works **today**. Sugar is
  user-opt-in with zero compiler changes in the meantime.

Original dialect principles kept for that milestone: parses as C;
isomorphic core (`int add(int,int)` byte-identical in both); `int` is i32;
no parser-managed linear memory; `.wh` canonical for cross-module ABI.

## Staging (revised 2026-07-08)

- **R1** — envelope gating (+ host tolerance for absent memory/table
  exports) + demand-point enforcement with blame locs + `--no-linear-memory`
  + `--shared` driver mode + `__gcstr`/`GCStringLiteral`/imported-globals
  emitter/`"#"` wiring in the loaders. Plain C only. Days, not weeks.
- **M1** — separate compilation; host instantiates two modules and
  cross-wires imports↔exports by name. First real cross-module GC-identity
  test. No compiler changes.
- **M2** — memory-import codegen + shared malloc → Tier 2; relaxes the
  `--shared` ⇒ `--no-linear-memory` coupling.
- **M3** — real `dlopen`/`dlsym` loader + shared table and/or `call_ref` →
  the full `.so` vision, function-pointer callbacks included.
- **M4** — the wc dialect as sugar (keyword-alias table, `.wc`/`.wh`,
  possibly direct `.wh`-from-`.c` include).

## Open questions

- Exact flag spellings (`--no-linear-memory` vs `-mno-linear-memory`;
  `--shared` vs `-shared`).
- `__gcstr` name bikeshed (`__str`? `__jsstr`?). `GCSTR()` macro home
  (a tiny `<gc.h>`?).
- Whether unconditional envelope gating needs a compat escape hatch for
  embedders that assume a `memory` export exists.
- `str` `+`-as-concat sugar — deferred with the dialect (M4).
