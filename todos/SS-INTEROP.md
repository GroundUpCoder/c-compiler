# Self-service (.ss) interop — running ss in this runtime, and ss as a loadable library

Status: proposed 2026-07-09. **One slice landed**: `host.js` flavor dispatch +
a ported ss *core* env (commit `6b8e385`) runs simple `.ss` modules under
`node host.js foo.wasm`. Everything past the core env is design, not built.
Not yet a queue item — exploratory until promoted (per `README.md` §1).

The `.ss` ("self service") language is a sister project in a separate repo
(`~/git/self-hosting`: `ss.js` is the compiler, `ss-runtime.js` the Node
runtime). Like this compiler it targets **Wasm GC**, not linear memory, for its
language-level values. This doc is about making the two share one runtime — and,
longer term, letting C programs load ss code as a library.

## Why

The repo north star (`OS.md`) is a wasm-native OS where every binary is a real
wasm module from *this* compiler. ss is a second front end that emits the same
kind of module. If our runtime can host both, then:

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
| Function | funcref / `*fn` (table) | `call_indirect` slot | none if signature matches |

The load-bearing fact is **Wasm GC structural canonicalization**: two structs
with byte-identical shape (fields, mutability, finality, recursive structure)
resolve to the *same* canonical engine type regardless of which module or
compiler emitted them. So a matching `__struct` declaration on the C side and an
ss class are the *same type* to the engine, and refs are mutually assignable
across separately-compiled modules. (Caveat: **nominal** identity is not shared
across separate compilation — see hazards below.)

What is *not* shared: linear memory. Both modules export their own memory
(ss uses it only for `__embed`/`__static` data). Neither dereferences the
other's pointers, so the two linear memories coexist without conflict — the GC
heap is the shared surface, and the engine shares it for free.

## Part 1 — ss running *with* `runModule` (unify, don't dispatch)

### What landed, and why it isn't unification

`runModule` currently compiles the module and, if it imports the `"ss"`
namespace, early-returns to a self-contained `runSsModule` (commit `6b8e385`).
That is a *dispatch*: the two paths share no host services. C's regression tests
still pass precisely because the C path is untouched — but an ss program gets
none of the OS (stdin, BlockFS, spawn, signals, kernel).

### The principle: unify the *services*, not the import *tables*

The import tables must stay distinct — C imports linear-memory functions
(`write(fd, ptr, count)`), ss imports GC/externref functions
(`StandardWriteStream.writeString(handle, jsstr)`). You cannot merge those
symbol sets. But both should call the **same backends**. So restructure
`runModule` into three layers:

1. **Shared preamble** (flavor-agnostic): `ctx`, `writeOut`/`writeErr`, the
   stdin SAB + `requestStdin`, `blockFsFactory`, `spawnHooks`, `pid`/`ppid`,
   signal ctx, `sharedConsoleBuffer`. All the *services*.
2. **Flavor-selected ABI adapter** builds the import object against those
   services. C adapter = today's `"c"` env. ss adapter = the `"ss"` /
   `"suspend.ss"` env, each function *translating* a shared service into ss's
   GC/externref shape.
3. **Shared entry + teardown**: `main(argc, argv, envp)` vs `_start()`, wrapped
   in the same JSPI `promising`, the same `ExitStatus` catch, the same
   `__no_exit_runtime` keepalive, the same atexit / kernel EXIT handshake.

### The per-service bridges

| Service | C path | ss path today | Bridge to build |
|---|---|---|---|
| stdout | `write` reads linear mem | `writeString(jsstr)` | **done** — both funnel to `writeOut` |
| stdin | `read` (suspending) over stdin SAB | `readString` throws "needs fs backend" | wire ss `readString` onto the same stdin SAB / kernel RPC (JSPI — ss already uses `Suspending`) |
| filesystem | fd syscalls over BlockFS | `opfs.*` handle API (externref) | implement `opfs.*` as a shim over BlockFS: each OPFS handle = a JS object wrapping a BlockFS inode; `SyncAccessHandle.read/write` → BlockFS read/write (`BLOCK_FS.md`) |
| process/exit | `posix_spawn`, EXIT handshake, signals | `_start()` returns | ss joins as a **reduced-contract process**: spawnable / waitable / killable, exit funnels through the kernel EXIT handshake — but **no POSIX signal delivery** (ss has no signal/handler model; that is fine) |

### The real cost: the env's provenance

The full ss env lives in `ss-runtime.js` in the *other* repo, and it is written
to build its *own* backends (its own OPFS shim, its own `@kmamal` SDL). To run
under `runModule` it must be (a) ported/vendored into `host.js` — commit
`6b8e385` did only the core slice (str/Native/Math/Time/JSBufferView + stdio) —
and (b) **inverted to accept injected backends** instead of constructing them,
so the OPFS env takes a BlockFS handle, stdio takes the shared console sink, etc.
That inversion is the bulk of the work (and a refactor on the ss side too, if we
share code rather than fork it).

### Two smaller notes

- **Detection** should move from "imports `ss`" to reading the **`__config`
  "ss" custom section** every ss module already carries — it is the natural
  flavor + capability manifest (it can say `runner=sdl`, so `runModule` wires
  only the envs a module needs).
- **Compile options** become per-flavor: ss needs
  `importedStringConstants: '#'` alongside `builtins: ['js-string']`
  (cf. `0041` — the same `"#"` mechanism is independently useful to C).

## Part 2 — ss compiled to a library C `dlopen`s

### Why this direction dodges the PIC nightmare

Emscripten-style dynamic linking hurts because a C side-module's code and data
must live in the main module's **linear memory** — hence position-independent
code, `__memory_base` / `__table_base`, GOT relocations applied at load. An ss
module has **no linear-memory data to relocate**: its values are GC
structs/arrays/externref, and the GC heap is engine-managed and shared across
all instances in one engine. A ref minted in the ss instance is valid in the C
instance with no relocation. "Loading" an ss library is therefore just
*instantiate another wasm module and wire its imports* — no shared linear
memory, no `__memory_base`, no GOT.

### The FFI ABI is unusually thin

Given the representation table above:

- `i32/i64/f32/f64` → pass through, nothing to do.
- **strings** → same externref js-string, **zero marshaling**.
- **ss arrays / classes** → GC refs; with a matching `__struct` / `__array`
  declaration on the C side (structural canonicalization), C holds and passes
  them as first-class GC refs, not opaque blobs.
- **opaque-handle fallback** (an `i32` index into a host-side ref table) is
  needed only where we deliberately hide a shape — a `FILE*`-style handle.
  Optional, not mandatory.

### Calling mechanism — zero per-call host involvement is achievable

Both compilers use `call_indirect` through a `WebAssembly.Table`. Clean design:
at load, install the ss library's exported functions into a shared funcref
table; `dlsym("foo")` hands C a table index; C calls it via `call_indirect` with
the matching type — a direct wasm→wasm call, **no JS thunk on the hot path**.
Host thunks are needed only for signature adaptation, error translation, or
where a value must actually be marshaled.

### The missing toolchain piece: manifest + bindgen

For C to call ss you need a machine-readable **export manifest**: the ss compiler
emits, per exported function, its GC/externref/primitive signature plus
descriptors for any struct/array types it exposes (a new custom section, or an
extension of `__config`). A **bindgen** tool reads that and emits a C header —
matching `__struct` declarations + `extern` import decls. The "dynamic" part is
just that the `.wasm` bytes are loaded/instantiated at runtime (from BlockFS)
rather than statically merged: separate shippable ss libraries, one shared copy,
no PIC.

### Loader models

- **Load-time binding** (simplest): the C program declares imports `ss_foo`;
  at instantiate, the runtime instantiates the named ss library and installs
  binding thunks / funcref-table slots. Functionally a shared library.
- **True `dlopen`**: `dlopen("libfoo.ss.wasm")` fetches bytes from BlockFS,
  instantiates + wires the ss env, returns a handle; `dlsym` → a funcref /
  table index. Wasm cannot JIT new call trampolines at runtime, so
  dlsym-returns-callable relies on manifest-generated per-signature glue or
  `call_ref`/`call_indirect` with statically-known types.

### Boundary hazards to design around

- **Nominal type identity does not survive separate compilation** — nominal
  classes need a shared rec group, which two independently-compiled modules do
  not have. `instanceof` across the boundary will not work. Keep the public
  interface **structural / primitive / handle-based**.
- **Exceptions**: ss throws `exnref`; C has its own model. Boundary thunks must
  catch ss exceptions and translate to error codes / errno; an unhandled
  foreign exception traps. The ABI needs an error-return convention at the seam.
- **JSPI transparency**: if an ss library function suspends (async OPFS,
  `await`), the *entire* C call chain must be entered via `promising` and every
  intervening thunk must be suspend-transparent — do not interpose a plain JS
  frame that cannot resume. Both runtimes already use JSPI, so it is consistent,
  but it constrains how thunks are written.

## Settled decision: ss loads into C, never C into ss

We support **ss-as-a-loadable-library (C is the caller)** and deliberately do
**not** support the reverse (a C `.so` loaded by ss). This is not about which
language is "more GC" — it is about the interface surface:

- As a **callee**, ss can present a surface that is *entirely*
  GC/externref/primitive — nothing leaks into linear memory, so no sharing, no
  PIC.
- As a **callee**, a C library's *useful* surface is inherently
  linear-memory-bound (`char*`, `struct*`, anything `malloc`'d). For ss to call
  `c_foo(char *buf)` it would have to place bytes into **C's** linear memory
  using C's allocator and pass a pointer — forcing shared/managed linear memory,
  the C allocator, and PIC/GOT relocation (the emscripten MAIN/SIDE dance).

The asymmetry is permanent and intentional (same spirit as the
posix_spawn-not-fork call in `OS.md`). Don't re-litigate without new evidence.

## Sequencing

1. **Part 1 is the substrate for Part 2** — you must be able to instantiate +
   wire an ss module *inside a C process context* before you can dynamically
   load an ss library into a running C program.
2. Port the **full** ss env into `host.js` and **invert it to accept injected
   backends** (biggest single chunk).
3. **Unify `runModule`**: shared preamble → flavor adapter → shared
   entry/teardown; bridge fs (`opfs.*` → BlockFS) and stdin.
4. Define the **ss export manifest** (custom section) + **bindgen**
   (`.ss` lib → C header).
5. **Load-time binding** via a shared funcref table; then optional true
   `dlopen` from BlockFS.

Biggest risks to pin down early: a *spec'd* GC/string/error ABI so two
independently-evolving compilers stay shape-compatible, plus the
nominal-identity and JSPI-transparency constraints. Nothing here needs PIC —
which is exactly why the ss-as-loadable-library direction is the one to bet on.

## Cross-references

- `OS.md` — north star; the posix_spawn-not-fork decision this doc's
  asymmetry mirrors.
- `WASM_GC.md`, `EXTERNREF.md` — the `__struct` / `__externref` surface that
  makes the shared GC/string ABI possible.
- `0041-gcstr-string-constants.md` — `importedStringConstants "#"` in the main
  compiler; the same option ss modules require.
- `KERNEL.md`, `BLOCK_FS.md` — the process control plane and filesystem the ss
  adapter bridges onto.
- Sister repo: `~/git/self-hosting` — `ss.js` (compiler), `ss-runtime.js`
  (`createEnv` / `createCoreEnv` — the env being ported), `docs/NOMINAL.md`
  (nominal vs structural identity).
