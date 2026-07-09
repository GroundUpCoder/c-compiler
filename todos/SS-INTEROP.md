# Self-service (.ss) interop — ss as a first-class OS language, and ss as a loadable library

Status: proposed 2026-07-09, **revised same day after design review** (round 2:
fork-not-share, `c`-namespace reuse, `@c` structs, `__funcref`, table-base-only
PIC, linear-memory findings; round 3: foreign pointers via multi-memory — a
pointer-taking .so *accesses* C's memory as memory 1 without *residing* in it,
so still no memory PIC). **One slice landed**: `host.js` flavor dispatch +
a ported ss *core* env (commit `6b8e385`) runs simple `.ss` modules under
`node host.js foo.wasm`. Everything past the core env is design, not built.
Not yet a queue item — exploratory until promoted (per `README.md` §1).

The `.ss` ("self service") language is a sister project
(`~/git/self-hosting`: `ss.js` is the compiler). Like this compiler it targets
**Wasm GC**, not linear memory, for its language-level values. This doc is
about making ss a first-class language of the OS — every binary writable in
ss instead of C if desired — and, longer term, letting C programs load ss
code as a shared library.

## Why

The repo north star (`OS.md`) is a wasm-native OS where every binary is a real
wasm module from *this* compiler. ss is a second front end that emits the same
kind of module. If our runtime can host both:

- **One runtime, two languages.** `runModule` becomes flavor-agnostic; an ss
  program is just another process in the OS — same console, same BlockFS, same
  spawn/exit — with no second host to maintain.
- **Portable logic, reused not rewritten.** An ss library (parsers, codecs,
  algorithms) becomes callable from C without a rewrite, shipped as a separate
  `.wasm` and loaded on demand.

The surprise that makes this cheap: **ss and our C are both Wasm-GC languages**,
so the gap is far narrower than "linear-memory C vs GC ss" suggests.

## The reframe: two Wasm-GC languages, not two worlds

Our C surface is GC/reference-types capable — `__struct` (`WASM_GC.md`),
`__externref`/`__refextern` (`EXTERNREF.md`), `__cast`/`__ref_cast`/`__ref_eq`,
`call_indirect` through a `WebAssembly.Table`. ss uses the same machinery. The
representations line up:

| Concept | ss | our C | Cross-language cost |
|---|---|---|---|
| String | `newtype str : externref` over `wasm:js-string` | `__externref` holding a JS string (`__jsstr`) | **none — identical externref** |
| Integers / floats | `i32/i64/f32/f64` | same wasm value types | none — passthrough |
| Object | GC `struct` | `__struct Foo *` | **none if shapes match** (see below) |
| Array | GC `array` | `__array(T)` | none if element type matches |
| Opaque host ref | `externref`/`anyref` | `__externref`/`__eqref` | none |
| Function | `&fn` (typed funcref) / `*fn` (table index) | `call_indirect` slot; `__funcref` (planned, below) | none if signature lowering matches |

The load-bearing fact is **Wasm GC structural canonicalization**: two types
with byte-identical shape resolve to the *same* canonical engine type
regardless of which module or compiler emitted them. A matching `__struct` on
the C side and an ss class are the *same type* to the engine; refs are
mutually assignable across separately-compiled modules. (Caveat: **nominal**
identity is not shared across separate compilation — see hazards below.)

What is *not* shared: linear memory. Both modules export their own memory.
Neither dereferences the other's pointers, so the two linear memories coexist
without conflict — the GC heap is the shared surface, and the engine shares it
for free.

## Settled decisions (round 2)

### 1. Fork, don't share: vendor ss.js into this repo; abandon ss-runtime.js

As far as this repo is concerned, **`ss-runtime.js` does not exist**. The only
things brought over are:

1. **`ss.js` (the compiler)**, vendored (suggested home: `ss/ss.js`) and
   modified to fit this environment. The repo **portability rule applies on
   arrival**: no `SS_PATH` env var, no unguarded `process.*` — compiler
   options instead. The `.ss-root`/search-path machinery collapses to the
   vendored root.
2. **A subset of the ss `root/` stdlib** (suggested home: `ss/root/`),
   rewritten against this runtime's bindings (see decision 2). Initially
   feature-poor; grows incrementally as bindings land.

Consequences: the original plan's biggest chunk — "port the full ss env and
invert it to accept injected backends" — is **deleted**, not done. host.js is
the only ss runtime. Existing ss apps get updated to the reshaped stdlib;
divergence from the sister repo is accepted and permanent.

`/bin/ssc` in the OS follows the `/bin/cc` pattern: ss.js is dependency-free
single-file JS, so it loads in kernel-worker beside compiler.js and backs an
ss compile RPC.

### 2. System APIs are POSIX/C-shaped; reuse the `c` import namespace where it fits

The key observation: **the `c` env namespace is already language-neutral.**
Its syscall ABI is `(i32 fd, i32 ptr, i32 len)` over the *calling instance's*
exported `memory` — host.js neither knows nor cares which compiler produced
the module. ss has linear memory, `Memory.alloc`, and `encodeUTF8` into its
own memory, so its stdlib can import the C syscalls **verbatim**:

```
import("c", "open") fn c_open(path iptr, flags i32, mode i32) i32
import("c", "read") fn c_read(fd i32, buf iptr, count i32) i32
```

and get the identical backend C gets — BlockFS/RemoteFS, brokered kernel
RPCs, pipes, select, spawn — with **zero new host bindings**. Blocking reads
are sync-over-SAB, so ss's `suspend`/JSPI machinery isn't needed on this
path. `lib.FS` and friends are reshaped to the POSIX/C conceptual model and
wrap the raw imports in GC-ergonomic ss (str paths encoded into own memory,
results copied out to GC values); the bindings stay as thin as possible so
both languages share one mental model of the OS.

**Where the host API is reference-shaped, ss gets native bindings instead.**
C's WebGPU surface is i32 handles into a host-side table with table-index
callback trampolines (`__wgpu_call_*_cb`) — wrapping *that* from ss would be
perverse when ss can hold the `GPUDevice`/`GPUTexture` as an externref
directly and take callbacks as funcrefs via `call_ref`. Same for JS interop.
The invariant that keeps this honest:

> **An ss binding is a thin translation layer over the *same backend* the C
> path runs** (same surface/present/readback/compositor/audio machinery) —
> never a second backend, and never nontrivial overhead. If an ss binding
> needs new host state, that state belongs in the shared backend where the C
> path can see it too.

(That invariant is also what keeps `wmctl shot` and the kernel-side surface
lifecycle working identically for ss GPU apps.)

So the `ss` import namespace shrinks to what is genuinely ss-specific:
`str.*`, `Native.*`, JSBufferView, and the reference-shaped native bindings.
Everything syscall-shaped comes from `c`.

### 3. No capability manifest

Considered and rejected: a `__config`-driven capability manifest / per-
capability env splitting. C works fine without one — instantiation fails
loudly naming exactly the missing import, which composes with incremental
porting (each new ss program tells you precisely which binding to add next).
With the `c`-namespace reuse above, the bespoke ss surface is small enough
that a manifest would manage almost nothing. Flavor detection stays
"imports `ss`".

### 4. Compile options unify → ss joins the module cache

ss modules are excluded from the 0037 spawn module cache today only because
their compile options differ (`importedStringConstants: '#'`). Per `0041`
that option is independently useful to C; once the options unify,
`kernel._moduleFor` caches ss binaries exactly like C ones. (Until then,
every ss spawn recompiles from bytes.)

### 5. ss loads into C, never C into ss (unchanged from round 1)

We support **ss-as-a-loadable-library (C is the caller)** and deliberately do
**not** support the reverse. As a callee, ss can present a surface that is
entirely GC/externref/primitive — nothing leaks into linear memory, so no
sharing, no PIC. As a callee, a C library's *useful* surface is inherently
linear-memory-bound (`char*`, `struct*`, `malloc`'d anything); for ss to call
it would force shared linear memory, the C allocator, and the emscripten
MAIN/SIDE dance. The asymmetry is permanent and intentional (same spirit as
posix_spawn-not-fork in `OS.md`). Don't re-litigate without new evidence.

## Linear memory: the two models, and why the .so story stays cheap

Verified facts (ss.js / compiler.js):

| | C (compiler.js) | ss (ss.js) |
|---|---|---|
| Stack | first `stackPages` of memory, SP-managed | **none** — locals are wasm locals only; no pointer-to-local, no alloca |
| Static data | active segments | page 0 unused (null guard); embeds at 65536+ |
| Heap | `__heap_base` global; TLSF (`__malloc.c`) | allocator metadata at compile-time `__heapbase()` (= embed end, else 65536); lazy-init TLSF pool after |
| Allocator | TLSF, metadata in C statics | **the same TLSF** — identical structure (`fl_bitmap`, `sl_bitmap[27]`, `free_heads[27*16]`, `pool_end`, `last_block`) |

Consequences:

- **ss has no stack pointer to relocate and no cross-module static data.**
  Its fixed-address active segments and baked `__heapbase()` are position-
  dependent only *within its own private memory*, which no other module
  addresses. The miserable parts of emscripten-style dynamic linking are all
  stack/static/heap-in-shared-memory problems; ss structurally doesn't have
  them. No `__memory_base`, ever. The load-bearing distinction is **access
  vs residence**: a .so may *access* the caller's memory (multi-memory,
  below) — what forces memory PIC is ss's own statics/heap *residing* at a
  load-assigned address in someone else's memory, and nothing in this design
  ever requires that.
- **Shared malloc: the question mostly dissolves.** The two allocators are
  already the same algorithm; "picking one" is an *instance* choice, and
  allocator instances are 1:1 with memories. While memories stay private
  (the settled design), two instances of one TLSF is the correct end state.
  The question only becomes real under a hypothetical shared-single-memory
  future; if that day comes, lean ss-flavored — its metadata sits at a
  parameterizable base address, so C adopting it is a `__malloc.c` swap with
  an agreed base, whereas the reverse means linking C static data into ss's
  layout. **Deferred; revisit only with a shared-memory use case in hand.**
- **`--no-linear-memory` mode (ss.js): cheap and worth it, for libraries.**
  A pure-GC ss module can already need zero memory pages, but ss.js always
  exports the memory section. Add a mode that omits it and makes any
  `Memory`/`Buffer`/embed use a compile error. This turns "pure GC library"
  into a *checkable guarantee* (manifest bit) — the entire pointer-boundary
  bug class becomes impossible by construction, and the dlopen loader skips
  all memory wiring. Note the scope: OS *programs* can't use it (the
  `c`-namespace syscalls need buffers in own memory); it's a default-on
  aspiration for `.so` libraries only.

## C-compat data: `StructDef`/`Struct`, then `@c struct`

Staged plan for ss reading/writing C-layout data in linear memory (needed
immediately for things like `struct stat` buffers passed to `c` syscalls):

1. **Dynamic reflection**: `StructDef` (layout: field names/types/offsets) +
   `Struct` (an `iptr` + its `StructDef`) with `fromPointer`/`toPointer` and
   interpreted field get/set. Slow, flexible, no compiler change.
2. **`@c struct Foo { ... }` syntax**: compiles to a newtype over `iptr` with
   monomorphized accessors — direct `Memory.loadI32(ptr + off)` codegen,
   zero-cost, reads like a real C struct.

Two rules that keep this sound:

- **Layout is generated from (or golden-tested against) compiler.js's actual
  layout rules** — alignment, padding, ILP32 — never hand-maintained twice.
  A small tool that feeds struct decls to compiler.js and emits/asserts the
  ss `@c` defs kills a whole class of silent corruption. Bitfields excluded.
- **The memory-space rule**: ss `Memory.load*` hits ss's *own* memory 0.
  In a standalone ss process that's exactly right (buffers it allocated and
  passed to `c` syscalls). But in the .so case a `Foo*` from the C caller
  points into *C's* memory — plain accessors would silently read the wrong
  memory. The fix is that **the memory space is part of the pointer type**
  (see "Foreign pointers via multi-memory" below): a foreign-pointer kind
  whose accessors emit memidx-1 loads/stores against the imported caller
  memory. `@c struct` accessors are parameterized by space — same layout
  code monomorphized per memidx: own memory in a standalone process,
  memory 1 for C-provided pointers in a .so. Untyped mixing of the two
  spaces is a compile error, not a runtime surprise.

## `__funcref` in the C compiler

Assessment (verified against compiler.js): **small — it rides everything
`__externref` built.**

Already in place: ref types as `TypeInfo` subclasses with the full
restriction machinery (no address-of, no linear-memory storage, no
arithmetic), ref locals/params/returns/`__struct` fields, Tarjan-SCC rec-
group type emission, and wasm func types already emitted as first-class
types for `call_indirect`. **Free by accident**: `ref.func` requires its
target be "declared" in an elem segment — and this compiler already puts
every function in the indirect table's active elem segment, so every
function is ref.func-legal with no new element machinery.

Genuinely new: a `FuncRefType` carrying its C function type, the
`__funcref(int(T*, int))` declarator parse (reuses the function-pointer
declarator parser), two opcodes (`ref.func` 0xD2, `call_ref` 0x14), and the
conversions (function designator → funcref; call-through-funcref beside the
existing `callIndirect` path).

Gotchas, none fatal:

1. **No funcrefs in linear memory** — same rule as `__externref`. C code
   wanting to stash callbacks in structs must use `__struct` GC structs.
   The diagnostic machinery already exists.
2. **Signature lowering is the cross-language ABI.** The wasm functype must
   come from the same lowering as calls — including the quirks (struct-by-
   value returns → hidden i32 pointer param; varargs → `(i32)→()`). Those
   quirks don't exist in ss, so the FFI seam admits only primitives + GC
   refs + externref (bindgen rejects the rest). Then canonicalization makes
   a C `__funcref(int(__externref))` and an ss `&fn(externref)(i32)` the
   *same engine type* — direct `call_ref` across compilers, no thunk.
3. `call_ref` ships with the GC proposal in every engine we already require.

## `*fn` in a .so: table-base-only PIC

Precision matters here: **`&fn` needs no PIC at all** (`ref.func` — an
engine-level reference; no table, no base), and `^fn` closures ride
`call_ref` likewise. That is *why* the .so story is cheap.

It is **`*fn`** (i32 table indices baked as `i32.const`) that is position-
dependent. To let `*fn` survive in a .so sharing the caller's table, the
relocation needed is table-base-only, and it is small in ss.js (behind a
`--shared` flag):

1. Import the table instead of defining it (the loader sizes/grows it).
2. Import an immutable i32 global `__table_base` (the `--import-globals`
   plumbing already exists).
3. Two emission sites change: the active elem segment offset `i32.const 1`
   → `global.get $__table_base` (a legal constexpr for imported immutable
   globals), and `IR.FuncPtr` materialization → `global.get $__table_base;
   i32.const slot; i32.add`.

No `__memory_base`, no data relocation, no GOT. The payoff that justifies
it: if the ss .so populates slots in **C's `__indirect_function_table`**, an
ss function becomes an *ordinary C function pointer* — plain `call_indirect`
with a canonicalized matching type. Existing C callback APIs (`qsort`, SDL
callbacks, anything taking a function pointer) accept ss functions with zero
changes and zero thunks. Both seams end up available: `*fn`→shared-table for
legacy C APIs, `&fn`/`__funcref` for the typed one.

## Part 1 — ss running under `runModule` (unify, don't dispatch)

### What landed, and why it isn't unification

`runModule` compiles the module and, if it imports the `"ss"` namespace,
early-returns to a self-contained `runSsModule` (commit `6b8e385`). That is a
*dispatch*: the two paths share no host services. An ss program gets none of
the OS (stdin, BlockFS, spawn, signals, kernel).

### The principle: unify the *services*, not the import *tables*

Restructure `runModule` into three layers:

1. **Shared preamble** (flavor-agnostic): `ctx`, `writeOut`/`writeErr`, the
   stdin SAB + `requestStdin`, `blockFsFactory`, `spawnHooks`, `pid`/`ppid`,
   signal ctx, `sharedConsoleBuffer`. All the *services*.
2. **Flavor-selected ABI adapter** builds the import object against those
   services. C adapter = today's `"c"` env. ss adapter = **mostly the same
   `"c"` env** (decision 2) plus the small `"ss"` namespace.
3. **Shared entry + teardown**: `main(argc, argv, envp)` vs `_start()`,
   wrapped in the same JSPI `promising`, the same `ExitStatus` catch, the
   same `__no_exit_runtime` keepalive, the same atexit / kernel EXIT
   handshake.

### The per-service bridges (revised)

| Service | C path | Bridge for ss |
|---|---|---|
| stdout/stderr | `write` reads linear mem | **done** — both funnel to `writeOut` |
| stdin | `read` (sync-over-SAB) | ss stdlib imports `c.read` directly — no bridge |
| filesystem | fd syscalls over BlockFS | ss `lib.FS` reshaped POSIX; imports `c.open/read/write/...` directly — no bridge |
| process/exit | `posix_spawn`, EXIT handshake | `_start()` return funnels through the kernel EXIT handshake; ss imports `c.__spawn`/`__spawn_wait`/`__spawn_kill` |
| signals | cooperative delivery at env-import returns | STOP/CONT/SIGKILL work with **zero ss changes** (host-side, at import boundaries); user-defined ss handlers are a later, separate feature |
| argv/env/cwd | procSpec | replace the Node-only `System.getenv`/`cwd` imports with procSpec-fed ones (current ones violate the portability rule in the browser) |
| SDL / audio | `__sdl_*` (ptr-shaped) | reuse `c` namespace — ABI fits |
| WebGPU / JS interop | i32 handle table | ss-native externref bindings over the same backend (decision 2) |

## Part 2 — ss compiled to a library C `dlopen`s

An ss module has **no linear-memory data to relocate**: its values are GC
structs/arrays/externref, and the GC heap is engine-managed and shared across
all instances in one engine. "Loading" an ss library is *instantiate another
wasm module and wire its imports* — no shared linear memory, no
`__memory_base`, no GOT. Instance lifetime is GC'd: `dlclose` just drops the
handle.

### The FFI ABI

- `i32/i64/f32/f64` → passthrough.
- **strings** → same externref js-string, zero marshaling.
- **ss arrays / classes** → GC refs; a matching `__struct`/`__array` on the C
  side is the same engine type (structural canonicalization).
- **functions** → `&fn` / `__funcref` at the typed seam; shared-table `*fn`
  slots for legacy C function-pointer APIs (table-base PIC above).
- **pointers** → **directional**: C addresses flow *in*, typed on the ss
  side as foreign pointers into the imported caller memory (multi-memory,
  below); ss's own-memory addresses never flow *out* (bindgen rejects
  `iptr`/own-space `*T` in export signatures — C cannot address ss's
  memory). A C-space address ss received or derived may flow back out.
  Opaque-handle fallback (i32 into a host-side ref table) only where a
  shape is deliberately hidden.

### Foreign pointers via multi-memory

A pointer-free surface would cripple the classic use case —
`ss_parse(buf, len)` with `buf` in C's memory. The mechanism that serves it
without memory PIC: under `--shared`, the ss .so **imports the caller's
memory as memory 1** while its own statics/allocator stay at their baked
addresses in private memory 0. Multi-memory makes the memory index an
immediate on every load/store, so "which memory" is a compile-time property
of the pointer's *type* — zero runtime dispatch, zero overhead.

- **Growth is transparent**: wasm loads always see the memory's current
  size (the JS stale-TypedArray-view hazard does not exist at the wasm
  level), so C growing its memory needs no coordination.
- **Allocating in C's space**: when ss must return a buffer C owns, it
  calls the caller's exported `malloc`/`free` through the FFI. ss's own
  TLSF never touches memory 1; each allocator stays 1:1 with its memory.
- **Engine support**: multi-memory is standardized and shipped everywhere
  we already require GC + JSPI (which are stricter).
- **Tiering**: a pure-GC library imports no memory at all
  (`--no-linear-memory` still applies); a pointer-taking library adds the
  memory-1 import. No tier ever has ss *residing* in C's memory — the only
  tier that would cost `__memory_base` PIC, and it stays rejected.

ss.js cost: a foreign-pointer kind in the type system (space as part of the
pointer type), memidx selection in load/store emission, the memory import
under `--shared`. Contained, but it is the largest single piece of the
`--shared` mode — bigger than the table-base change.

### The missing toolchain piece: manifest + bindgen

The ss compiler emits, per exported function, its GC/externref/primitive
signature plus descriptors for exposed struct/array types (a custom section).
A **bindgen** tool reads that and emits a C header — matching `__struct`
declarations + import decls. Bindgen is the *only* source of C-side
declarations (hand-written headers drift → canonicalization mismatch →
`call_indirect`/`call_ref` traps), and load-time checks the manifest hash.

### Loader models

- **Load-time binding** (first): the C program declares imports; at
  instantiate, the runtime instantiates the named ss library and installs
  funcref-table slots / binding thunks.
- **True `dlopen`**: fetch bytes from BlockFS, instantiate + wire the ss env,
  return a handle; `dlsym` → a funcref / table index.
- **Per-instance statics**: a native `.so` has one copy of its globals per
  process; here each *instantiation* has its own memory and globals. Loader
  policy: `dlopen` of the same library returns the cached per-process
  instance, matching native `.so` intuition.

### Boundary hazards

- **Nominal identity does not survive separate compilation** — keep the
  public interface structural/primitive/handle-based. Worth making the ss
  compiler *enforce*: exporting a nominal-class-typed signature is an error
  (or explicit opt-in).
- **Exceptions**: exception tags match by *instance identity*, so C can never
  catch a specific ss tag it didn't import. Define one blessed boundary tag
  (`code i32, msg str`) + an error-return convention in bindgen-generated
  wrappers, *before the first library ships*. Boundary thunks `catch_all` and
  translate; an unhandled foreign exception traps.
- **JSPI transparency**: if an ss library function suspends, the entire C
  call chain must be entered via `promising` with no plain-JS frames
  interposed. Bindgen marks suspending exports.
- **Library-mode `_start`**: globals-init-and-return (already the behavior);
  make it explicit in the manifest, guarantee idempotence, and disallow
  suspending global initializers in library mode so `dlopen` can init
  synchronously.

## Sequencing

1. **Vendor ss.js + minimal `ss/root/`** into this repo; strip env-var /
   Node-isms per the portability rule. Smoke: compile + run hello under
   `node host.js`.
2. **Unify `runModule`** (shared preamble → flavor adapter → shared
   entry/teardown); procSpec-fed argv/env/cwd; kernel EXIT handshake; unify
   compile options → module cache.
3. **Reshape the stdlib onto the `c` namespace**: lib.FS (POSIX shape),
   stdin, spawn. `StructDef` reflection for C-layout buffers (`struct stat`).
4. **`/bin/ssc`** backed kernel-side like `/bin/cc`.
5. **`@c struct`** syntax + layout golden-tests against compiler.js.
6. **`__funcref`** in the C compiler.
7. **Manifest + bindgen**; load-time binding via shared funcref table
   (+ `--shared` in ss.js: table-base rebasing and the memory-1 import /
   foreign-pointer type); then true `dlopen` from BlockFS.
8. Reference-shaped ss-native bindings (WebGPU, JS interop) as demand
   arises; `--no-linear-memory` mode alongside the .so work.

Biggest risks to pin down early: a *spec'd* GC/string/error ABI so two
independently-evolving compilers stay shape-compatible (bindgen as the single
source of truth), plus the nominal-identity and JSPI-transparency
constraints. Nothing here needs memory PIC — which is exactly why the
ss-as-loadable-library direction is the one to bet on.

## Cross-references

- `OS.md` — north star; the posix_spawn-not-fork decision this doc's
  asymmetry mirrors.
- `WASM_GC.md`, `EXTERNREF.md` — the `__struct` / `__externref` surface that
  makes the shared GC/string ABI possible; both note funcref as the natural
  next step.
- `0041-gcstr-string-constants.md` — `importedStringConstants "#"` in the
  main compiler; the option unification that lets ss join the module cache.
- `KERNEL.md`, `BLOCK_FS.md` — the process control plane and filesystem the
  ss stdlib binds onto (via the `c` namespace).
- `logs/2026-07-09/ss-interop.md` — the round-2 design review that settled
  the decisions above.
- Sister repo: `~/git/self-hosting` — `ss.js` (the compiler to vendor),
  `docs/NOMINAL.md` (nominal vs structural identity). `ss-runtime.js` is
  deliberately **not** used by this repo.
