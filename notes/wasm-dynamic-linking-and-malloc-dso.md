# WASM-native shared libraries & the malloc-as-DSO question

**Status:** design finding / code-debt record. No implementation. Captures a
settled *sequencing decision* plus the reasoning, so it is not re-litigated.
**Date:** 2026-07-18.
**Provenance:** one feasibility assessment + two independent adversarial
pressure-tests (fable = `claude-fable-5`, and codex), which converged on the
same verdict with the same code citations. Reviews were read-only against
`HEAD` = `18fc8a6`-era tree.

---

## 1. Context & motivation

gucOS apps are C compiled to WebAssembly, each linked against the win32-style
veneer and run as its own module/instance in its own process worker. Today
there is **no dynamic linking** — every app is fully statically linked, so every
veneer app carries its own copy of the veneer (and libc, allocator, etc.).

Two questions were assessed:

1. **Should gucOS gain dynamically-loadable shared libraries** (a `.so`
   equivalent: a WASM module with position-independent code that a loader can
   place at a runtime-chosen base and `dlopen`/`dlsym`)?
2. **Refinement:** if so, should `malloc` itself be a shared library (DSO),
   rather than baked into a privileged "main"/runtime module — for symmetry and
   to make "exactly one allocator per process" structural?

This note records the answer to (2) and the design constraints for (1). The
**go/no-go for (1) is gated on a measurement** (see §7).

---

## 2. Settled design for dynamic linking (take as given)

Use the **standard core-WASM dynamic-linking ABI**, not a bespoke "insert one
base constant" scheme (a bespoke scheme creates a private format without
eliminating the hard work — external symbols, embedded pointer relocations,
symbol resolution, cycles all remain):

- One gucOS **process owns one** linear memory, one indirect-function table, one
  `__stack_pointer` global, and one allocator; the executable and every loaded
  library are instances **sharing** those.
- `dylink.0` custom section; imported `env.memory` + `env.__indirect_function_table`
  + mutable `env.__stack_pointer`; immutable `__memory_base` (data reloc) and
  `__table_base` (function-pointer reloc); external symbols via mutable
  `GOT.mem` / `GOT.func` globals; `__wasm_apply_data_relocs` for pointers baked
  into static data; `__wasm_call_ctors` after relocations.
- A C **data pointer** is an offset into the shared linear memory; a C
  **function pointer** is an index into the shared table. Internal direct calls
  stay direct WASM `call`s. "PIC" here is really **two** bases with distinct
  semantics: `__memory_base` for data, `__table_base` for function pointers.

The compiler today makes **executable-only assumptions** that must be replaced
for side modules (all cited below in §6).

---

## 3. The malloc-as-DSO refinement & the two-layer model

The proposal was a deliberate **two-layer** allocator:

- **Layer 1 — runtime region primitive ("sbrk-like").** Loader/runtime-owned.
  Hands out page-aligned, process-lifetime (never-freed) ranges by bumping
  `memory.grow`. It is the **sole arbiter of `memory.grow`** and is
  malloc-independent by necessity, because it reserves the static-data region of
  every DSO — including `malloc`'s own. Trivial bump bookkeeping; never calls C
  malloc.
- **Layer 2 — the C heap allocator.** `malloc`/`free`/`realloc`/`calloc` in a
  normal DSO (`libmalloc.so`), a **consumer** of Layer 1: it obtains large
  permanent chunks from Layer 1 and sub-allocates them. Everyone imports the
  allocator from it, so there is structurally one allocator *instance* per
  process.

Claimed benefits: (a) "exactly one allocator" becomes structural; (b)
de-privileges the main module; (c) mirrors real systems (glibc's `malloc` lives
in `libc.so`; `ld.so` has its own private bootstrap allocator because it can't
use libc malloc while loading libc).

---

## 4. Decision

**Implement standard WASM dynamic linking with a *runtime-owned, segmented*
allocator FIRST. Do NOT make `malloc` a DSO in the first implementation.**
Keep the Layer-1 / Layer-2 *conceptual* split, but Layer 2 lives in the
runtime/main module initially.

Once the general loader, relocation model, dependency-graph handling, and the
segmented heap are proven, `malloc` can be moved into a DSO **as a packaging
change** if allocator replaceability or ABI modularity earns its keep. Doing it
at bootstrap time now is *"elegance arriving before the infrastructure that
would make it cheap"* — it adds the hardest possible bootstrap dependency at the
exact moment gucOS is also introducing dynamic linking, for no near-term payoff.

This is the end-state the malloc-as-DSO instinct points at (and it *is* the
native design); the correction is **sequencing**, not direction.

---

## 5. Why (the pressure-test findings — fable & codex agreed)

### 5.1 The layout collision is real AND unavoidable — not caused by malloc-as-DSO

WASM has **one** linear memory that grows monotonically only at the top via
`memory.grow`; no sparse virtual space, no mmap-from-the-top. Statically the
layout is stack (low) → static data → heap growing up. But DSOs are `dlopen`'d
at **runtime**, potentially *after* the heap has grown. A late DSO's permanent
static region can only be reserved at/above the current memory top — landing
**above** a heap that was growing upward:

```
[exe+libmalloc static][heap arena H1 ...][page slack][late-DSO static D][heap arena H2]
```

The heap is now `{H1, H2}`, not one interval `[.., B)`. Treating it as one pool
would let coalescing walk across `D`'s bytes and corrupt them.

**Therefore late `dlopen` forces a segmented, multi-arena allocator.** The
current allocator is strictly single-pool contiguous TLSF and **breaks**:
- one `pool_start`/`pool_end`/`last_block` (`compiler.js:27447`);
- physical neighbor computed as `block + block_size(block)` (`compiler.js:27471`);
- coalescing tests only against the single `pool_end` (`compiler.js:27590`);
- growth appends a block at the old `pool_end` and calls `memory.grow` directly
  (`compiler.js:27659`);
- `free` accepts anything in `[pool_start, pool_end)` before reading its header
  (`compiler.js:27743`).

Corrected Layer 2 needs: a process-wide arena registry `{base, end, first/last
block}`; global TLSF size-class free-lists spanning arenas but **coalescing
strictly arena-local**; `free`/`realloc` must find & validate the owning arena
(sorted range array / page radix map); `realloc` in-place only within an arena,
else alloc/copy/free; diagnostics report aggregate extents, not `pool_end -
pool_start` (`compiler.js:27818`).

**Crucially: any allocator sharing an append-only memory with arbitrary late
`dlopen` must become segmented — whether it's a DSO or baked into the runtime.**
So this hard work is identical either way. A pre-reserved DSO "corridor" can
postpone segmentation but imposes a fixed budget and still fails once exhausted
— an optimization, not the general mechanism.

### 5.2 The "structural one-allocator guarantee" is REFUTED as stated

Packaging `malloc` as a DSO does **not** by itself prevent a second allocator:
an executable or another DSO can define its own strong `malloc`, statically
embed a copy under hidden names, use `--wrap`, or export a conflicting strong
symbol; symbol preemption / `RTLD_LOCAL`-style scopes can bind differently. The
invariant requires explicit **link/load symbol policy** regardless of where
`malloc` lives: reserve the allocation ABI symbols to one designated provider,
reject duplicate strong definitions, bind all public allocation references
non-preemptibly to that provider, don't statically extract allocator objects
into other modules. Structural single instantiation **plus** that policy gives
the invariant; DSO packaging alone does not.

### 5.3 Per-process replication weakens the memory-saving motive for `malloc`

Each process gets its own worker (`os/process-worker.js`), and `runModule`
creates a fresh instance inside it (`os/process-worker.js:55`); a
`WebAssembly.Module` may be compiled once and cloned across workers, but
**instances are not shared**. So every process has its own memory, table,
allocator globals/free-lists, and its own `libmalloc` instance + arena metadata
— required for isolation, but it means DSO-ifying `malloc` saves ~nothing in
allocator state (a statically-linked exe already contains only one allocator
copy). The real code-sharing win is the **veneer** (shared across apps *within*
a process via module caching), not the allocator.

### 5.4 Two concrete bootstrap hazards

- **`libmalloc` is NOT dependency-free as written.** The current malloc source
  `#include`s `<stdio.h>` and calls `puts` on corruption paths
  (`compiler.js:27419`, `:27539`, `:27749`). That is literally the unsatisfiable
  bootstrap cycle `libmalloc → stdio → malloc`. Error paths must **trap** or use
  a leaf host/runtime import — never libc — for `malloc` to be a leaf DSO.
- **`memory.grow` invalidates JS typed-array views** (the host already knows
  this at `host.js:9208`). Once a loader grows memory behind the allocator's
  back, **every** host import must re-acquire its view from `memory.buffer`
  after *any* region acquisition; no cached `DataView` may survive a grow.

### 5.5 Bootstrap ordering is feasible only with a JS-resident loader

All pre-`malloc` loader state — parsed `dylink.0` metadata, dependency graph,
symbol tables, GOT globals, region/table bookkeeping, module bytes — stays
**JS-side** (`Map`s, `WebAssembly.Global`s, typed-array writes for relocations).
It does not need a C heap. This ceases to hold if the loader itself is written
in C/WASM and uses ordinary collections/strings before `libmalloc` is up — that
would reintroduce a genuine private bootstrap allocator. Keep the loader in JS.

Constructor order is **not** simply "malloc first, then all": it is Layer-1
runtime → relocate `libmalloc` → `libmalloc` ctor → relocate the full remaining
dependency closure → ctors in dependency-topological order (with proper
strongly-connected-component handling for cycles: instantiate + bind GOT +
relocate all SCC members, then run their ctors in a deterministic recorded
order) → executable ctors → `main`. Destructors run in reverse completed-ctor
order. Initial `dlclose` should be **non-reclaiming** (logical unload / refcount
only) because live heap objects, function pointers, and GOT refs can outlive a
DSO and Layer-1 regions are process-lifetime.

---

## 6. Unavoidable work (independent of allocator placement)

These are required by dynamic linking itself, and are where the real cost lives:

- **Segmented multi-arena allocator** replacing the single-pool TLSF (§5.1).
- **Layer 1 as the sole `memory.grow` arbiter** with an arena-provider API
  (request permanent aligned chunk; amortized/geometric growth; overflow +
  max-memory checks; disjoint reservation records; no adjacency promise). Malloc
  never calls `memory.grow` itself.
- **Compiler: emit side-module form** — import rather than define memory
  (`compiler.js:20334`), import rather than define the table + its identity
  element segment (`compiler.js:15838`), import `__stack_pointer` (currently a
  module-defined global, `compiler.js:19960`), base static addresses on
  `__memory_base` (currently absolute offsets after the stack,
  `compiler.js:16822`/`:16837`), base function-pointer constants + element
  segments on `__table_base` (currently `functionIndex + 1`, `compiler.js:19976`),
  add memory/table to the import section (currently funcs+globals only,
  `compiler.js:15813`), emit `dylink.0`, `GOT.mem`/`GOT.func` and
  `__wasm_apply_data_relocs`, move externally-visible C globals into linear
  memory, and give tree-shaking a dynamic-linking mode.
- **Host: use a process context, not `instance.exports`.** Host services close
  over the single instance's `memory`/`__indirect_function_table`
  (`host.js:10510`, `:10516`); with multiple instances they must close over
  shared process resources. Ctors are currently a single global call after env
  construction (`host.js:10836`, `:10866`) — insufficient for per-DSO
  relocation + ctor state.
- **Link/load symbol policy** enforcing exactly one public allocator provider
  (§5.2).
- Refresh every host memory view after growth (§5.4).

---

## 7. Go/no-go gate for dynamic linking at all

Dynamic linking is justified **only if large common code is materially
duplicated across apps** — the natural proving workload and measurement is the
**win32 veneer**: measure per-app `.wasm` size, total download/cache footprint,
and process memory with the veneer statically linked vs. shared as a DSO. If the
duplication is material, proceed (veneer-as-DSO is the first real library to
migrate); if apps are small and tree-shaking already trims the overlap, static
linking wins and this stays on the shelf. **Measure before building.**

---

## 8. TL;DR

- Dynamic linking: use the standard `dylink.0` + GOT ABI; one process owns one
  memory/table/stack/allocator. Gate the whole effort on the veneer-duplication
  measurement (§7).
- `malloc`-as-DSO is the correct *destination* (it's the native design) but the
  wrong *first step*. Ship a **runtime-owned segmented** allocator first; DSO-ify
  `malloc` later as a packaging change.
- The genuinely hard core is the **segmented multi-arena allocator + Layer-1
  `memory.grow` arbiter**, forced by one append-only linear memory + late
  `dlopen` — and it is unavoidable regardless of where `malloc` lives.
- Two claims for malloc-as-DSO don't hold up: the one-allocator guarantee needs
  symbol policy either way, and per-process isolation means it saves ~no
  allocator memory. Its real remaining value is symmetry + replaceability, worth
  cashing in only once the infrastructure makes it cheap.
