# ss interop, round 2: fork the compiler, reuse the `c` namespace, skip the PIC

Design review of `todos/SS-INTEROP.md` (proposed this morning, one host.js
slice landed in `6b8e385`). The doc got a substantial revision; this is the
why behind the calls that changed or got made.

## Fork, don't share

Round 1's biggest work item was "port the full ss env from ss-runtime.js and
invert it to accept injected backends" — a cross-repo refactor. Decision:
**abandon ss-runtime.js entirely** as far as this repo is concerned. We
vendor `ss.js` (the compiler) + a subset of the ss stdlib root, both modified
to fit this environment, and host.js becomes the only ss runtime. The
inversion work isn't done, it's *deleted* — there is no second env to port.
Existing ss apps get updated to the reshaped stdlib. Divergence from the
sister repo is accepted and permanent. ss.js falls under the repo
portability rule on arrival (its `SS_PATH` env var and `process.*` uses go;
compiler options instead).

## The `c` namespace is already language-neutral

The observation that reshaped the whole plan: the C env's syscall ABI is
`(i32 fd, i32 ptr, i32 len)` over the *calling instance's* exported memory.
host.js doesn't care who compiled the module. ss has linear memory and
`encodeUTF8` into it — so its stdlib can import `c.open`/`c.read`/
`c.__spawn` verbatim and get the identical backend C gets, zero new
bindings. Round 1's per-service bridge table (an OPFS-shim-over-BlockFS,
etc.) mostly evaporates: the fs "bridge" is now `lib.FS` reshaped to POSIX
and importing the C syscalls directly. System APIs across the board get
C-shaped so both languages share one mental model of the OS.

The exception that proves the rule: reference-shaped host APIs. C's WebGPU
surface is i32 handles + table-index callback trampolines because C *can't*
hold host references natively; ss can (externref + `call_ref`). Wrapping the
handle table from ss would be strictly worse than what ss-native bindings
get for free. So: `c` namespace where the ABI is ptr/len/handle-shaped
(fs, spawn, tty, SDL), ss-native externref bindings where it's
reference-shaped (WebGPU, JS interop) — under the invariant that an ss
binding is a thin translation over the *same backend* the C path runs,
never a second backend. That invariant is what keeps `wmctl shot` etc.
working identically for ss apps.

Also considered and dropped: a `__config` capability manifest with
per-capability env splitting. C's model — instantiate fails loudly naming
the missing import — already composes perfectly with incremental porting,
and with `c`-reuse the bespoke ss surface is too small to need managing.

## Linear memory: verified both sides, and the .so fear dissolves

Facts checked in ss.js and compiler.js:

- **ss has no stack in linear memory.** No stack pointer, no alloca, no
  pointer-to-local — locals are wasm locals, period. Pointers only come
  from `Memory.alloc`/`Buffer`/embeds (page 0 is a null guard, embeds at
  64KiB+, TLSF metadata at compile-time `__heapbase()`, lazy pool init).
- **The two allocators are the same allocator.** compiler.js's embedded
  `__malloc.c` and ss's `Allocator.ss` are the same TLSF with identical
  metadata layout (`fl_bitmap`, `sl_bitmap[27]`, `free_heads[27*16]`,
  `pool_end`, `last_block`). One is clearly a port of the other.

Consequences: emscripten-style dynamic linking is miserable because of
stack/static/heap in *shared* memory — ss structurally has none of that.
Private memories mean ss's fixed-address segments need no relocation ever.
"Pick one malloc" turns out to be an instance question, not an
implementation question (instances are 1:1 with memories), so it only
exists under a hypothetical shared-memory future — deferred, with a noted
lean toward the ss flavor (metadata at a parameterizable base → C adopts it
by swapping `__malloc.c`) if that day comes.

New item from this: a `--no-linear-memory` ss.js mode. Pure-GC modules
already compute to zero memory pages but ss.js unconditionally exports the
section; omitting it + hard-erroring on any memory use makes "pure GC
library" a checkable manifest guarantee for .so's — the pointer-boundary
bug class becomes impossible by construction. Programs can't use it (the
`c` syscalls need buffers); it's a library thing.

## `@c struct`, and the foreign-memory trap

Staged: dynamic `StructDef`/`Struct` reflection first (no compiler change),
then `@c struct Foo` compiling to a newtype-over-iptr with monomorphized
accessors (zero-cost). Two rules recorded: layout is generated from or
golden-tested against compiler.js (never hand-maintained twice; no
bitfields), and **pointers do not cross the .so boundary** — ss `Memory`
intrinsics hit ss's *own* memory 0, so a C-side `Foo*` dereferenced by `@c`
accessors in a .so would silently read the wrong memory. Bindgen enforces
the rule; multi-memory (import the host's memory as memory 1) is the noted
escape hatch if ever genuinely needed.

## `__funcref` in the C compiler: smaller than it looks

Verified: the externref/GC-struct work already built the type-class +
restriction machinery (no address-of, no linear-memory storage), rec-group
emission, and wasm func types (for `call_indirect`). And `ref.func`
validity is free by accident — every function is already in the indirect
table's active elem segment, which satisfies the "declared" requirement.
Net-new: a `FuncRefType`, the `__funcref(sig)` declarator parse, two
opcodes (`ref.func`, `call_ref`), conversions. Days, not weeks. The real
design content is the seam ABI: the FFI admits only primitives + GC refs +
externref (no struct-by-value/varargs lowering quirks), so canonicalization
makes C `__funcref` and ss `&fn` the same engine type — direct cross-
compiler `call_ref`, no thunk.

## PIC precision: only `*fn` needs it, and only table-base

`&fn` is `ref.func` (engine reference — no table, no base) and `^fn` rides
`call_ref`; neither needs any PIC. Only `*fn` (baked `i32.const` table
indices) is position-dependent. Making it .so-safe is table-base-only:
import the table, import an immutable `__table_base` global, and rebase two
emission sites (elem offset, `IR.FuncPtr`). ~50 lines behind `--shared`.
The payoff that justifies bothering: ss .so functions installed in C's
`__indirect_function_table` become *ordinary C function pointers* — qsort,
SDL callbacks, any C callback API accepts ss functions with zero changes.

## What didn't change

ss-loads-into-C-never-the-reverse stands (round 1's call, same spirit as
posix_spawn-not-fork). The manifest+bindgen toolchain, the single blessed
boundary exception tag, and the JSPI-transparency constraint all stand —
with bindgen promoted to the *only* source of C-side declarations, since
hand-written headers drifting out of shape-sync produce canonicalization
mismatches that trap at call time.

## Round 3 addendum: foreign pointers via multi-memory

The round-2 rule "pointers never cross the .so boundary" got challenged the
same day, correctly: it kills the classic use case — `ss_parse(buf, len)`
with `buf` in C's memory. The resolution is a distinction worth naming:
**access vs residence**. What forces memory PIC is *residence* — ss's own
statics/heap living at a load-assigned address inside C's memory (the
emscripten MAIN/SIDE model). Merely *accessing* C's memory needs only
multi-memory: under `--shared` the ss .so imports the caller's memory as
memory 1, dereferences C pointers with memidx-1 loads/stores, and keeps its
own statics at their baked addresses in private memory 0. Still no
`__memory_base`, ever.

The design fallout: the memory space becomes part of the pointer type (a
foreign-pointer kind; `@c struct` accessors monomorphize per space), the
bindgen rule turns directional (C addresses flow in as foreign pointers;
ss's own addresses never flow out), ss allocates in C's space only via the
caller's exported malloc/free, and memory growth is a non-issue (wasm loads
always see current size — the stale-view hazard is JS-only). Multi-memory
is shipped everywhere we already require GC + JSPI. This is now the largest
single piece of `--shared` — bigger than the table-base change — and was
promoted in the doc from escape-hatch footnote to the pointer story proper.
Also recorded: per-instance statics (each instantiation = own globals), so
dlopen returns the cached per-process instance to match native .so
intuition.

Still exploratory — not yet promoted to queue items. Sequencing in the doc:
vendor first, unify runModule second, POSIX stdlib third; the .so milestone
rides on all of it.
