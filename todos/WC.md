# WC — a clean, memory-free C dialect for trivial wasm linking

Status: **design / not yet queued.** Findings captured here to work on later.
Related: `WASM_GC.md`, `EXTERNREF.md`, `OS.md` (dlopen/`.so` story).

## Thesis

`wc` is a strict, cleaner dialect of the C this compiler already accepts. It
looks like C, parses as C, and shares this compiler's frontend and backend —
but its semantics are the existing WASM-GC / externref subset with linear
memory removed from the language surface.

The payoff is **trivial semantic linking**. A wc module's wasm *import section*
is a complete, honest manifest of everything it needs to link, because the
parser never emits implicit memory, static data, relocations, or a shadow
stack. Two wc modules (or a wc and a C module) link by name-matching wasm
imports/exports and passing values/refs — no memory-layout merging, no GOT, no
`__memory_base`/`__table_base`. The heavy Emscripten "dylink" ABI evaporates,
*specifically because* wc manages no memory.

## Core principles

1. **Parses as C.** wc source is a syntactic subset of C. The lexer, the whole
   preprocessor (`#include`, `#define`, forward decls), and the C parser are
   reused verbatim. The "simpler parse" is not a simpler parser — it is the
   same parser fed a smaller grammar, plus a wc sema pass that *reinterprets*
   and *rejects*.
2. **Isomorphic core.** Where C and wc agree, the source is byte-identical.
   `int add(int x, int y) { return x + y; }` compiles as-is in both `.c` and
   `.wc`. We diverge only where it genuinely makes sense.
3. **`int` is i32.** No `i32`/`i64` spellings in the surface language — `int`
   is already always i32 in this dialect, `long` is i64, etc. Stay C-looking.
4. **No parser-managed linear memory.** No `*`, no `&`, no pointer types, no
   pointer arithmetic, no arrays-in-memory, no VLA, no `va_arg`. Structs are
   GC, strings are externref. Any linear-memory access is explicit, through
   builtins on an explicitly declared (or imported) memory — never a `*`.
5. **Sugar is macros over `__`-extensions both dialects already parse.**
   `struct`→`__struct`, `str`→`__externref`, `ARRAY(int)`→`__array(int)`,
   `NEW(Point)`→`__new`, `LEN(xs)`→`__array_len`. `[]` and `.` survive — but on
   GC refs only (`array.get` / `struct.get`), never pointer deref. `ARRAY(int)`
   not `array<int>` (the latter isn't C-parseable — template-ambiguity).

## Dialect selection

By **file extension**, not a flag:

- `.c` / `.h` — C (full force).
- `.wc` — wc translation unit.
- `.wh` — wc header.

The root file's extension picks the dialect; `#include` stays textual.
Internally this is still an `options.dialect` mode, just auto-set from the
extension.

## Headers & the single source of truth

- **`.wh` is canonical and clean.** It is the single source of truth for any
  type/ABI that crosses a module boundary. Because GC type identity is
  structural (see below), both sides compiling the same header is what
  guarantees matching layouts.
- **`.wh` → `.h` projection is one-way and nearly free.** Lower the wc sugar to
  the shared `__`-extension forms (`struct`→`__struct`, `str`→`__externref`,
  `ARRAY(int)`→`__array(int)`, `NEW`→`__new`). Can be a macro prelude or a tiny
  rewrite pass. C then `#include`s the projected `.h` and gets structurally
  identical GC types. The `struct`→`__struct` rewrite the projection performs is
  the same mapping wc uses internally as a dialect rule.
- **wc never includes C `.h`.** The clean world does not absorb C constructs. To
  call into C, wc *declares* the imports it needs in wc/wh vocabulary
  (`__import("c","malloc")` etc.). Rejecting `.h`-into-wc keeps the import
  manifest honest and the language clean; the cost (hand-written or projected
  interop headers) is accepted deliberately.

## Codegen coupling — how hard is the memory-free mode? (verified)

Linear memory is **demand-driven, not deeply threaded.** Two separable pieces:

1. **Per-construct usage is gated.** The shadow-stack prologue/epilogue is
   behind `if (this.frameSize > 0)` (`compiler.js:15207`, `:15247`).
   `frameSize` is non-zero only for address-taken locals, by-value aggregate
   params/returns, VLAs, or `alloca`. String literals only populate
   `cg.staticData`; data segments only emit `if (cg.staticData.length > 0)`
   (`:17758`). A function over GC structs + externref strings + scalar locals
   has `frameSize === 0` and emits **zero** stack-pointer traffic. wc simply
   never feeds the codegen the constructs that use memory — no need to rip
   memory out of the expression codegen.
2. **Scaffolding is unconditional but centralized.** Three spots force every
   module to carry a memory even when unused:
   - `:17397-17398` — always adds `__stack_pointer` + `__heap_base` globals.
   - `:17747-17780` — always `addMemory`, exports `memory` /
     `__indirect_function_table` / `__heap_base`.
   - in `emit()`, the memory (section 5) and table (section 4) are written
     unconditionally, unlike tags which are gated `if (this.tags.length > 0)`.

**"The mode" therefore is:** gate that scaffolding on whether anything actually
used it (a `cg.usedMemory` / `cg.usedTable` flag flipped the first time
`addDataSegment` / `frameSize>0` / an indirect call fires), and make the two
`emit()` sections conditional like the tag section already is. Localized,
~day-of-careful-work-with-tests change — a mode, not a second backend. The
GC/externref codegen paths wc needs already exist and work.

Empirical baseline: a pure-GC program today still emits `memory`, `__heap_base`,
`__indirect_function_table`, `alloca`, and a data section (193 bytes for
`int main(){return add(2,3);}` + one `__struct`). Gating removes those for pure
wc.

## Minimal rec groups — already done (verified)

Cross-module GC type identity relies on structural canonicalization of
**minimal rec groups**. The type emitter already does exactly this: an iterative
Tarjan SCC pass (`compiler.js:13528`) puts each type in its own singleton rec
group unless it is part of a genuine mutually-recursive cycle, in which case the
minimal SCC becomes the group (comment at `:13494-13504`). This already fixes
cross-*TU* recursive type identity; cross-*module* identity rides the same
guarantee. Risk here is lower than first feared — the discipline exists and is
load-bearing. Remaining care: field mutability / finality / rec-group shape must
match exactly across modules, which the shared `.wh` contract ensures.

## Interop model — two tiers

**Tier 1 — values, refs, handles. Zero shared memory.** Exchange scalars, GC
refs, and externrefs by wasm import/export. wc can hold a **C pointer as an
opaque `int` it never dereferences** (wc has no `*`), so wc is clean
orchestration over C libraries:

```c
int db = c_sqlite3_open("foo.db");   // C returns a heap offset; wc holds it as a token
c_sqlite3_exec(db, "SELECT ...");    // hand it back — wc never looks inside
```

Needs *nothing new in the compiler* — just honest import/export (already works).
This is the milestone-1 sweet spot: wc as a scripting/glue layer over existing C
(sqlite, zlib, …) plus native externref string handling.

**Tier 2 — shared linear memory.** For wc to actually read a `char*` C handed
it, wc must **import C's `memory`** and use explicit builtins
(`load_i8(mem, p+i)`), with a shared allocator (`__import("env","malloc")` — C
owns the heap). wc contributes no static data and takes no addresses of statics,
so it needs **zero relocations** — far lighter than Emscripten dylink.

## Net-new work (not present today)

- **Memory-*import* codegen.** No `addMemoryImport` / `__import_memory` exists;
  every module defines its own memory (`:17747`). Importing `env.memory` is a
  new codegen capability — the crux of Tier 2.
- **Multi-module / dlopen loader in the host.** The host instantiates exactly
  one module (`host.js:7739`, `:9315`); `dlopen`/`dlsym` don't exist (dlfcn is
  stubbed). Real dynamic linking = a wasm loader that reads a `.so` (wasm bytes)
  from BlockFS and instantiates it with imports satisfied (`js-string`,
  `env.memory` = C's memory, `env.malloc`, a shared table).
- **Shared table for function pointers.** `dlsym` returning a callable = a table
  index. C→wc callbacks need wc's exported funcs appended to a shared table with
  indices handed back. The one dylink primitive you can't avoid for that
  direction.
- **The wc dialect itself.** Sema reinterpret/reject pass + the envelope gating
  above.

## Staging

- **M0** — wc + C in *one* invocation → one module, one type section. GC
  identity free. Proves the dialect (sema + envelope gating). Start by defining
  the shared `__`-vocabulary / sugar-macro prelude.
- **M1** — separate compilation; host instantiates two modules and cross-wires
  imports↔exports by name. Tier-1 only. First real cross-module GC-identity
  test. No compiler changes beyond clean imports.
- **M2** — memory-import codegen + shared malloc → Tier-2 (wc reads/writes C's
  heap).
- **M3** — real `dlopen`/`dlsym` loader + shared table → the full `.so` vision,
  function-pointer callbacks included.

## Open questions

- Projection mechanism: macro prelude vs. dedicated `.wh`→`.h` pass. (Macro
  prelude is cheapest; may not cover everything.)
- `import`/`export` as contextual keywords vs. reusing `__import(...)` attribute
  (the latter needs no grammar divergence).
- Which memory builtins to expose, and their exact spellings
  (`load_i32(mem,addr)` / `store_i32(mem,addr,v)` / `memory(pages)`).
- Whether `str` gets `+` as concat sugar (js-string.concat) or stays a builtin
  call only.
