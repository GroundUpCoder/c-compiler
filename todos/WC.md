# WC — the wc dialect: memory-less wasm from a forked C compiler

Status: **design settled 2026-07-08 (round 2); queued as `todos/0041` +
`todos/0042`.** Round 2 SUPERSEDES the round-1 "flags on plain C, no
dialect" re-scope: **fork-first is authoritative.** The round-1 design is
not discarded — it is demoted to the *fold-back* plan, to be applied to
`compiler.js` only after wc has proven the language's usefulness and
effectiveness. Decision logs: `logs/2026-07-08/wc-round1-flags.md`
(superseded), `logs/2026-07-08/wc-round2-fork.md` (this design).
Related: `WASM_GC.md`, `EXTERNREF.md`, `OS.md` (dlopen/`.so` story).

## Thesis

A memory-free module's wasm *import section* is a complete, honest manifest
of everything it needs to link, because the compiler emits no implicit
memory, static data, relocations, or shadow stack. Two such modules link by
name-matching imports/exports and passing values/refs — no memory-layout
merging, no GOT, no `__memory_base`/`__table_base`. The heavy Emscripten
"dylink" ABI evaporates *specifically because* the module manages no memory.

wc is the language shaped around that property: C's machinery (preprocessor,
macros, parser, control flow, exceptions) with the memory model replaced —
every local/global a real wasm slot, every aggregate a wasm-GC object,
every string an externref.

## Round 2 decision: fork first (2026-07-08, settled)

- **`wc.js` is a fork (copy) of `compiler.js`.** Sources are `.wc`/`.wh`.
- **The main compiler and the os/ project are not touched** by wc work,
  with exactly one sanctioned exception: `todos/0041` lands `__gcstr` in
  `compiler.js` *before* the fork (independently useful to C; the fork
  then inherits the one genuinely new emission mechanism for free).
- **Why fork, not flags/sugar** (reversing round 1): total isolation — the
  experiment must not get in the way of the main project at all; the
  language is proven in its own artifact first. The fork also lets wc
  *delete* the linear-memory machinery outright instead of gating it,
  which is the honest shape of a language whose semantics don't include it.
- **Fold-back**: only after wc proves out, capabilities migrate to
  `compiler.js` per the round-1 blueprint (envelope gating,
  `--no-linear-memory`, `--shared`, keyword-alias-table sugar). When that
  happens, sync this doc. Until then, round-1 mechanics live in its log.

Don't re-litigate fork-vs-flags without new evidence; both rationales are
recorded in the logs.

## The language (v1 semantics — all decided)

1. **Memory-less by design.** No shadow stack, no data segments, no
   allocator, no `__stack_pointer`/`__heap_base`, no `alloca`. The
   envelope (memory/table sections + exports) is emitted only on demand
   (see "Envelope gating" below).
2. **`struct` ≡ `__struct`, verbatim.** wc's `struct` is the existing GC
   struct with rules inherited unchanged: `struct Foo *` is the ref (the
   value type — `GCStructRefType`), access via `->`, allocation via
   `__new`, reference-semantics assignment, no `&ref->field`, single
   inheritance via `__extends`, `__ref_cast`/`__ref_test`/null rules as-is.
   The heap form in value position stays an error (`struct Foo x` — no).
3. **Arrays are GC arrays.** `T x[]` types as `__array(T)`; no
   array-to-pointer decay; runtime length (`__array_len`), engine bounds
   checks. `T x[N]` as a local declarator sugars to `__array_new(T, N)`.
4. **Unions removed.** No type punning, no `memcpy`-over-aggregates.
5. **Pointers are ints.** For non-GC `T`, the type `T*` parses but *is*
   `int` (i32): pass/store/compare/arithmetic fine, dereference
   (`*p`, `p[i]`, `->`) is a compile error. Keeps adapted `.h` prototypes
   compiling and enables Tier-1 interop (hold a C pointer as an opaque
   token, hand it back, never look inside). Function pointers are ints
   too — see 6.
6. **Function pointers: inherited `call_indirect`** (table indices,
   1-indexed i32s), NOT funcref — consistent with pointers-are-ints, zero
   new codegen. wc change: the table/elem is populated with
   **address-taken functions only** and omitted entirely when no function
   pointers occur (today every function gets a slot — `compiler.js:13643`).
   Typed funcrefs/`call_ref` are deferred to the `.so` callback milestone
   (W5); no `call_ref` support exists today (verified).
7. **String literals are imported externref constants.** Every `"..."`
   lowers as a js-string `importedStringConstants` global: module **`"#"`**,
   import name = string content (dedup by construction), typed
   `__refextern` (non-nullable; decays to `__externref`), codegen is a
   `global.get`. `str` is a prelude typedef of `__externref` for v1
   (promote to a nominal type only if mixing bugs bite). String ops ride
   the `wasm:js-string` builtins already bound in the stdlib
   (`compiler.js:22009+`) and already enabled in host.js
   (`builtins: ['js-string']`, host.js:8210). No engine cliff: where the
   builtin/compile-option is absent, the polyfill is
   `imports["#"] = new Proxy({}, {get: (_, name) => name})`.
   `importedStringConstants` verified working in Node v25.8.2 by direct
   probe. Because imported globals are wasm constant expressions, string
   literals may initialize globals.
8. **Variadics dropped** (the arg-block ABI is stripped). In their place,
   a **`format("...", args...)` builtin**: format string must be a
   literal, parsed and type-checked against the args at compile time,
   lowered to a `wasm:js-string` `concat` chain. Integer specifiers
   (`%d`/`%u`/`%x`/`%c`/`%s`) need no host help — itoa is pure prelude
   code (digit loop into a mutable i16 `__array(short)` +
   `fromCharCodeArray`). Floats use one host util (`__wc_dtoa`) because
   `wasm:js-string` has no number→string conversion.
9. **Exceptions kept; setjmp/longjmp stripped.** `__try`/`__catch
   tag(bindings)`/`__throw tag(args)` is a first-class dialect feature
   (`DExceptionTag`, `compiler.js:3545`) independent of the setjmp
   lowering. Wasm tags carry typed values — scalars and refs (a thrown
   `str` works natively). The only impossible payload class
   (aggregate-by-value) doesn't exist in wc.
10. **Globals & static locals.** Scalars → wasm globals (a static local is
    a function-scoped global; supported, free). Ref-typed globals/statics:
    init restricted to null or a string literal (constant-expression
    imported global); anything else initializes in `main`. No synthesized
    start function for the foreseeable future — less complicated than C.
11. **Compound literals** (in v1): `(T[]){...}` → `__array_of`;
    `(struct Foo){...}` → `struct.new` when fully positional, else
    `struct.new_default` + per-field `struct.set` (both opcodes wired).
12. **`sizeof`**: error on GC types, kept for scalars (userland `__wasm`
    memory code wants `sizeof(int)`).
13. **Userland linear memory escape hatch.** `__wasm(type, (args...),
    op 0xNN, ...)` inline wasm (`compiler.js:10706`) and
    `__memory_size`/`__memory_grow` are inherited. Addresses are ints;
    the compiler does zero memory bookkeeping. Prelude code can define
    load/store helpers out of `__wasm` if a program wants raw bytes.

## Runtime ABI (the `__wc_*` veneer) — deliberately tiny

Entry point is **`int main(void)`**; args/env are *pulled* by the program,
never pushed by the host (the host never has to construct GC values —
externrefs are all it produces). All wc-specific imports are prefixed
`__wc_*` (module `"c"`, alongside the existing C import table). v1 set:

| import | signature | note |
|---|---|---|
| `__wc_argc` | `() -> int` | |
| `__wc_arg` | `(int i) -> str` | |
| `__wc_getenv` | `(str) -> str` | null if unset |
| `__wc_read` | `(int fd, int max) -> str` | null at EOF |
| `__wc_write` | `(int fd, str) -> int` | |
| `__wc_exit` | `(int) -> void` | |
| `__wc_dtoa` | `(double) -> str` | `format` `%f`; JS `String(x)` |

Binary-safe I/O (byte/i16 arrays) is post-v1.

**Loader is fully agnostic — no provenance detection anywhere.** The host
always supplies the superset import object (C table + `__wc_*` + the `"#"`
namespace/compile option); instantiation binds only what a module declares,
and existing C binaries declare none of it. Call convention dispatches on
the module's own signature: `main.length === 3` → the existing
argv-in-linear-memory path; `0` → just call it. host.js already contains
both call paths. One loader, C and wc alike, in node hosts and in os/.

## The fork worklist (what wc.js strips / redirects / adds)

**Strip**: shadow-stack + `AllocClass.MEMORY` machinery (address-taken
promotion becomes a diagnostic), static-data layout + data segments,
variadic arg-block ABI (`va_*` gone), setjmp/longjmp lowering, unions,
`alloca`, the C stdlib (replaced by a small `.wh` prelude), always-on
envelope emission.

**Redirect**: `struct` → the GC-struct path; array declarators →
`__array`; string literals → `"#"` imports; non-GC pointer types → int;
compound literals → `__new`/`__array_of`; driver accepts `.wc`/`.wh`.

**Keep unchanged**: preprocessor + macros, lexer, parser shape, sema,
`ConstEval`, inliner, goto normalizer + irreducible lowering, exceptions,
`__wasm`, the whole GC/externref codegen, the wasm emitter (incl. minimal
rec groups), name/sourcemap sections.

**Add** (short list): `format()` lowering; the `__wc_*` prelude
declarations; address-taken-only elem population; demand-gated envelope;
diagnostics with blame locs for the removed constructs (see below).

## Enforcement: at the point of demand (inherited from round 1)

The round-1 insight carries over verbatim into wc.js: don't reject syntax,
flip flags at the emitter choke points where demanding *bytes* are
written, each recording its first blame loc. In wc most linear paths are
deleted outright, but the pattern still governs what remains:

- `body.mop(...)` is the single funnel for every load/store
  (`compiler.js:15881+`), plus `memoryCopy`/`memoryFill` (`:13234`),
  `__memory_size`/`__memory_grow` — in wc these flip `usedMemory`, which
  *gates the memory section in* (userland `__wasm` demand) rather than
  erroring.
- staticData allocation (`getStringAddress` `:14556`) and `frameSize > 0`
  (`:15207`) must be unreachable in wc; assert with blame locs.
- `call_indirect` + funcptr materialization flip `usedTable` → gates
  table/elem in, populated address-taken-only.

## Envelope inventory (verified 2026-07-08, line refs valid at fork time)

| piece | where | wc disposition |
|---|---|---|
| `__stack_pointer` + `__heap_base` globals | `compiler.js:17397-17398` | stripped |
| `addMemory` + `memory`/table/`__heap_base` exports | `:17747-17780` | demand-gated |
| table section — sized `totalFuncs + 1` | `:13643-13646` | address-taken only, else omitted |
| memory section | `:13648-13657` | demand-gated (`__wasm` users) |
| `alloca` helper + export | `:17430` | stripped |
| data segments | `:17758` | stripped (literals are `"#"` imports) |
| shadow-stack prologue/epilogue | `:15207`/`:15247` | stripped |
| tag section | `:13660` | kept (already demand-gated — the precedent) |

## `.so` / dynamic linking (wc-only; C programs are never `.so`s)

- **Type identity is already solved**: the type emitter's iterative Tarjan
  SCC pass (`compiler.js:13528`) emits **minimal rec groups**, and wasm-GC
  canonicalization is structural — two independently compiled wc modules
  sharing a `.wh` get identical `struct` identity from the engine, no
  registry. Care: field mutability/finality/rec-group shape must match —
  both sides compiling the same header ensures it.
- `__export` already exists end-to-end (`:12468` parse, `:17449` emit) —
  the export-surface story is done.
- v1 `.so` interface: named function imports/exports, scalars + GC refs +
  externrefs crossing. **No function pointers across module boundaries**
  (a module-local table index is meaningless to the other side) until W5.

## Staging

- **W1 = `todos/0041`** — `__gcstr("...")` in the MAIN compiler (the one
  sanctioned pre-fork touch): `GCStringLiteral` typed `__refextern`,
  `"#"` importedStringConstants, imported globals (kind 0x03) + the
  defined-global index-space shift (off-by-N class — wants a targeted
  test), `GCSTR()` macro, host.js compileOptions token + `"#"` proxy
  polyfill in loaders, tests. Independently useful to C.
- **W2 = `todos/0042`** — the fork: copy `compiler.js` → `wc.js`, apply
  the strip/redirect worklist, v1 language per this doc, first tests, a
  size baseline (hello-world section dump — no memory/table/data).
- **W3** — prelude + `format()` + the `__wc_*` veneer + loader arity
  dispatch: wc binaries run under the node host and in os/.
- **W4** — separate compilation + `.so`: `-shared`-style driver mode in
  wc.js, host cross-wires two modules by name, first cross-module
  GC-identity test.
- **W5** — `dlopen`-in-wc + the cross-module callback decision (typed
  funcrefs vs shared table at the boundary).
- **Fold-back (unscheduled)** — after wc proves out: the round-1
  flags/gating design applied to `compiler.js`; sync this doc then.

## Open questions (small, deferrable)

- `str` nominal type vs typedef (start typedef; revisit on evidence).
- Binary-safe I/O shape (byte arrays vs i16 arrays) — post-v1.
- W5 callback mechanism (funcref preferred GC-side to keep
  zero-relocations airtight; shared table only at a C ABI boundary).
- `format()` specifier set beyond `%d %u %x %c %s %f` (`%g`? width/pad?).
