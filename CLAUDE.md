# C Compiler

`compiler.js` is the primary compiler in this repo — a C → WebAssembly compiler in a single file. All other files (host.js, serve.js, tools/, vendor/) are auxiliary.

## Portability

`compiler.js` MUST work in both browser and Node.js environments. Never use `process.env`, `process.stderr`, `process.exit`, `process.hrtime`, or any other Node.js-specific API without a `typeof process !== 'undefined'` guard and a browser-compatible fallback. No environment variables — use compiler options and CLI flags instead.

## TODOs

Planned work and design docs live in the `todos/` folder. Each file covers a distinct feature or topic. Check there before starting new work to see what's already been planned.

## Dev logs

`logs/YYYY-MM-DD/<topic>.md` is a **committed** engineering journal (folder per
local day, file per topic) capturing the *why* behind non-trivial work —
decisions, trade-offs, gotchas. Add an entry when landing anything
substantial. (Machine-wide convention; see `~/git/netguc/skills/logging.md`.)

## Conformance tests (bug regression corpus)

`tests/unit/conformance/` holds one directory per fixed conformance bug:
minimal C repro + clang-verified `expected.stdout` (programs are ILP32-clean),
with `// BUG:` / `// C11:` / `// EXPECT:` header comments. `diag_*` dirs assert
a *required* diagnostic via `expected.compiler.exitcode` (no stderr golden —
the message wording is free to change). **Fix bugs test-first: add the failing
test here, commit it, then fix.** Verified-but-unfixed findings are tracked in
`todos/CONFORMANCE-REMAINING.md`.

Semantics decisions already made (don't re-litigate without cause):
- Enum constants in `(INT_MAX, UINT_MAX]` get type `unsigned int` (gcc
  extension, per the `unsigned_consteval` golden); outside 32 bits errors.
- All constant scalar conversions go through `ConstEval.convert` (C11 6.3.1,
  single implementation — PP, sema, inliner, codegen). Float→int folding
  declines out-of-range so `--trapping-float-conversions` keeps its runtime
  semantics; static-initializer emission saturates explicitly.

`tests/run-unit.js` enforces a per-test timeout (default 30s, `--timeout=MS`,
per-test `timeoutMs` in `config.json`) and replaces the killed worker, so
hang-class miscompiles fail fast instead of stalling the suite.

## Vendored projects

`vendor/` contains real-world C codebases already ported to this compiler — each has its own `bin.json`. **Check this list before proposing a "new" port; many obvious candidates are already done.** As of writing:

- **Games / engines**: `doom` (doomgeneric), `quake` (1996 software renderer), `gameboy` (Peanut-GB emulator), `snake`
- **Interpreters / DBs**: `lua` (5.5), `micropython` (1.28), `sqlite` (3.53)
- **Systems**: `tinyemu` (RISC-V 32 emulator, can boot Linux)
- **Libraries**: `zlib`, `libpng`, `freetype`, `libgit2` (@44c05e5, core only; builds + `git_index_open` smoke test runs — used as a large-codebase stress test, see `vendor/libgit2/README.md`)
- **Frontend infra (JS, not C)**: `xterm` (terminal widget), `codemirror` (editor widget)
- **Project-specific tools**: `disw` (WASM disassembler), `hello` (minimal smoke test)

## Toolchain

- **cmake**: always use the uv-managed install at `~/.local/bin/cmake`
  (`uv tool install cmake`). Do NOT use `/Applications/CMake.app` (shadows
  it on PATH) or any package-manager cmake. Invoke by full path:
  `~/.local/bin/cmake`.

## BlockFS (host.js) and its tests

`host.js` contains **BlockFS** — a POSIX-ish filesystem backed by one byte store
(an OPFS `SyncAccessHandle` in the browser, a `MemoryByteStore` in tests). The
superblock + TLSF allocator + inode table + directories all live in the store.

**Invariant: the store is the single source of truth.** Any metadata that's
persisted in the superblock (inode-table extent/capacity, `nextInodeId`, pool
end, free lists) MUST be read THROUGH the store on each access, never cached on
the JS instance. Caching breaks coherence when **two live BlockFS instances run
over one store** (e.g. the netguc concurrent headless runner + the workspace
owner): a stale cache hands out a used inode id or reads inodes at a relocated
offset → silent cross-file corruption. (This was a real bug — fixed by making
`InodeTable` extent/cap and `_nextInode` read-through.)

**Test suite** (`tests/blockfs/`, run `node tests/blockfs/run.js [--long]`):
- `test_tlsf.js`, `test_blockfs.js`, `test_e2e.js` — example-based unit/e2e.
- `test_posix.js` — POSIX semantics: unlink/rename-while-open lifetime (inodes
  carry an in-memory, per-instance open-refcount; freeing defers to last
  close), same-inode rename no-op, failed-rename rollback, hole zero-fill,
  TLSF v3 huge-size arithmetic, symlink nlink symmetry, pipe-end refcounts
  across dup/dup2/F_DUPFD. Note: the open-refcount is per-instance only —
  cross-instance unlink-while-open still frees early (documented limitation).
- `fsck.js` — an INDEPENDENT consistency checker (shares no code with host.js;
  re-declares the on-disk format with a version guard; reads the store raw). It
  walks the block map, free lists, inodes/extents, and the directory tree and
  cross-checks every invariant (no overlapping/double-claimed extents, no leaked
  used blocks, free-list ↔ physical-free agreement, dirents → live inodes, file
  `nlink` == dirent refcount, reachability). Detection only (no repair).
- `test_fsck.js` — proves fsck catches hand-crafted corruption (and clean images pass).
- `test_fuzz.js` — model-based differential fuzzer: random valid ops against
  BlockFS vs an in-memory reference model; after EVERY op it asserts a fresh
  instance matches the model, runs `fsck`, and (dual mode) checks two live
  instances over one store stay coherent. Deterministic per seed; prints the
  seed+op on failure. This combo catches the multi-instance-coherence class that
  the read-through invariant protects — verified to fail on the pre-fix host.js.

When adding/changing on-disk format or metadata, update `fsck.js`'s constants
(it guards on superblock VERSION) and make sure new persisted state is
read-through, or the fuzzer's dual mode will (correctly) flag it.
