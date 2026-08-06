# #554 — malloc(0)/calloc(0,…) return unique non-NULL pointers; realloc(p,0) keeps the block

Lane: `lane-554`. Base: `bbc81fa3` (origin/main). Reverses a deliberate design
decision per jku's 2026-08-06 ruling: gucOS's libc returned NULL for
`malloc(0)` by design (so errno-checking callers could tell zero-size from
OOM); every mainstream libc — glibc, musl, BSD, Darwin, MSVC — returns a
unique non-NULL freeable pointer, and the vendored port corpus is written
against that contract. NetSurf's Wikipedia ABRT (empty `display:flex` →
`calloc(0,60)` → NULL read as OOM → half-laid-out tree → UNKNOWN_WIDTH assert
at layout.c:4481) was the trigger; the fix is the libc, not a NetSurf patch.

## What changed

- **`malloc`** (compiler.js): the `if (size == 0) return NULL` early return is
  gone; zero falls through the normal TLSF path. `adjust_request()` clamps to
  MIN_BLOCK_SIZE, so the pointer comes from the pool — which is load-bearing:
  `free()` bounds-checks against `[pool_start, pool_end)` and **traps** on a
  miss, so any fixed-sentinel implementation of malloc(0) would kill the
  process on its first `free()`. Falling through is what makes "freeable"
  true.
- **The stale comment went with it.** The old comment ("every genuine
  allocation failure (as opposed to malloc(0)) reports ENOMEM — callers like
  hsearch's table resize rely on it") documented the contract being reversed,
  and its hsearch claim was already untrue (below).
- **`calloc`** is fixed transitively (delegates to `malloc(count*size)`; its
  overflow guard `size != 0 && count > 0x40000000/size` passes zero through;
  `memory_fill(p, 0, 0)` is a wasm no-op).
- **`realloc(p, 0)`** now keeps the block and returns `p` — see the decision
  below.

## The realloc(p,0) decision (mine to make, per the kickoff)

The zero-size corner is where implementations genuinely disagree: glibc and
MSVC free the block and return NULL; musl, BSD (jemalloc), and Darwin return
a valid non-NULL pointer; C17 made it implementation-defined and C23 made it
undefined — precisely because the glibc shape is unanswerable for a portable
caller (`q = realloc(p, 0); if (!q)` cannot distinguish "freed, success" from
"OOM, p still live", which is a use-after-free or a leak depending on the
guess).

I chose the musl/BSD/Darwin side: **`realloc(p, 0)` keeps the block and
returns `p`**. Implementation: the zero special case is simply deleted —
`new_size = 0` satisfies `new_size <= old_payload`, the existing
shrink-in-place path, so it returns `p` unchanged. Arguments:

1. **Uniform failure signal.** This ticket's entire point is NULL ⟺ failure.
   Keeping a NULL return on the realloc zero path would preserve exactly the
   ambiguity being removed from malloc/calloc.
2. **Majority of the named ecosystems** (3 of 5: musl, BSD, Darwin) — and the
   vendored corpus skews POSIX/BSD-shaped, not MSVC-shaped.
3. **The dangerous caller shape is `p = realloc(p, n)` with zero-capable
   `n`** (shrink-to-fit). Under free-and-NULL that's a double-free time bomb;
   under keep-the-block it's simply correct.
4. `realloc(NULL, 0)` == `malloc(0)` == non-NULL — every mainstream libc
   agrees on that one, including glibc.

Deliberately NOT matched: glibc's free-and-NULL. Code written strictly
against glibc that calls `realloc(p, 0)` *as a free* will now leak one
minimal block per call instead. That trade is accepted: a bounded leak in a
rare idiom beats a spurious-OOM/double-free class, and C23 declares the idiom
dead anyway.

## Invalidated committed assertions (declared, per the kickoff rule)

Two tests pinned the old contract; both re-cut with **more** coverage, both
goldens unchanged (PASS lines only):

- `tests/unit/stdlib/malloc_stress/malloc_stress.c` asserted
  `malloc(0) == NULL`. Now: two `malloc(0)` are distinct non-NULL, 8-aligned,
  a zero-size block regrows via `realloc(z, 24)` and frees; plus
  `calloc(0,60)` / `calloc(60,0)` distinct non-NULL (the exact NetSurf
  empty-flexbox shape).
- `tests/unit/stdlib/malloc_realloc_inplace/malloc_realloc_inplace.c`
  asserted `realloc(NULL,0) == NULL` and `realloc(q,0) == NULL`. Now:
  `realloc(NULL,0)` non-NULL, `realloc(q,0) == q` (keep-pointer), the kept
  block regrows, both free clean.

A conformance-dir test was considered and rejected: conformance goldens are
clang-verified, and clang's host libc (glibc or Darwin) *disagrees with
itself* across platforms on `realloc(p,0)` — the stdlib corpus is the right
home for a contract we chose deliberately.

## The audit ("make the rest of the system respect it")

- **hsearch (`ext/src/hsearch.c`) — audited by name, cleared.** The ticket's
  claim that NULL-for-malloc(0) "was chosen FOR hsearch" is not supported by
  the code: `resize()` allocates `calloc(newsize, …)` where
  `for (newsize = MINSIZE=8; newsize < nel; newsize *= 2)` makes newsize ≥ 8
  structurally; `hcreate_r` allocates `calloc(1, …)`; and the file never
  reads `errno` at all (grep returns nothing). Zero-size requests are
  unreachable and the NULL-means-failure checks keep working unchanged.
- **libc internals (compiler.js) — cleared.** Every internal allocation site
  was enumerated; zero-capable candidates each carry their own guard:
  `mmap` rejects `length == 0` with EINVAL before its `calloc(1, length)`;
  `fmemopen` already does `calloc(1, size ? size : 1)`; SDL veneer's
  `SDL_malloc` already does `malloc(size ? size : 1)` (both workarounds are
  now redundant but harmless — left untouched, the SDL veneer additionally
  under the byte-identity rules). strdup/memstream/wcs-transcode/environ
  sites are all structurally ≥ 1 byte.
- **os/ (176 alloc call sites) — swept, cleared.** The only zero-aware
  pattern found is the defensive `malloc(n ? n : 1)` family in the win32
  veneer (user32/kernel32/advapi32/comdlg32/comctl32/listview, 9 sites) —
  written to defend against the old contract, redundant-but-correct under
  the new one, left untouched. No site *exploits* NULL-on-zero.
- **host.js `TLSFAllocator`/`TLSF64Allocator` — out of scope, deliberately.**
  `tests/blockfs/test_tlsf.js` pins `alloc.malloc(0) === 0` — that is the
  BlockFS *disk-extent* allocator, a separate implementation in a separate
  namespace whose `0` is an internal in-band signal; no C program can reach
  it, and its only callers pass clamped non-zero sizes (`_growExtent` does
  `Math.max(neededSize, 256)`). The C contract does not govern it.
- **`old/tests/…` duplicates** of the pinned tests exist but no runner
  references `old/` (and the 26-suite gate proves it empirically — a run of
  the old copy would now fail).

## NetSurf acceptance (vanilla, both directions)

NetSurf untouched: `git status --porcelain -- vendor/netsurf` empty and
`git diff --stat origin/main -- vendor/netsurf` empty (the ticket's original
"no patches/netsurf.diff change" check is vacuous — that file does not
exist; NetSurf is vendored as tracked files).

Built vanilla `nsmonkey.wasm` in this worktree (`smoke.mjs` — SMOKE PASS),
NOT in `netsurf-crash` (which carries the dropped #553 layout_flex guard —
building there is a guaranteed fake green). Fixtures copied read-only from
the investigator's scratch. Four legs on the fixed libc + two positive
controls on a stock-libc build (same vanilla sources, pristine main
compiler.js):

| build | empty-flex-min.html (7-line repro) | wiki-fixture (captured en.wikipedia.org) |
|---|---|---|
| fixed, JS on | exit 0, no assert | exit 0, no assert |
| fixed, JS off | exit 0, no assert | exit 0, no assert |
| stock (control) | **exit 134, assert layout.c:4481** | **exit 134, assert layout.c:4481** |

The control proves the fixtures still have teeth and that the libc flip —
not environment drift — is what cleared them. Live-https through vanilla
monkey is impossible by construction (standalone host.js has no httpOpen
hook; the https graft was netsurf-crash scratch); the wiki fixture is the
captured live page, per the ticket's own acceptance wording.

## Gate

`node tests/run.js all` (26 suites), started after the last code commit —
verdict recorded in the follow-up log entry / ticket comment with the
run-level `summary.json` evidence. `node todos/liabilities.js check`:
OK — 38 entries, rc=0 (matches the pristine-main control).
