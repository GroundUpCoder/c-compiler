# C Compiler

`compiler.js` is the primary compiler in this repo — a C → WebAssembly compiler in a single file. All other files (host.js, serve.js, tools/, vendor/) are auxiliary.

**North star** (see `todos/OS.md`): a WebAssembly-native, almost-POSIX OS in a
browser tab — every binary a real wasm module from this compiler, with
persistence (BlockFS), a shell, and eventually a compositor/window manager.
"Almost" because `fork()` is deliberately replaced by the owner-brokered
`posix_spawn` model (decision + rationale in `todos/OS.md` — don't re-litigate).

## Portability

`compiler.js` MUST work in both browser and Node.js environments. Never use `process.env`, `process.stderr`, `process.exit`, `process.hrtime`, or any other Node.js-specific API without a `typeof process !== 'undefined'` guard and a browser-compatible fallback. No environment variables — use compiler options and CLI flags instead.

## TODOs & the work queue

Planned work lives in `todos/` (system doc: `todos/README.md`):

- **Work queue**: `todos/NNNN-<slug>.md` — one numbered item per committed
  unit of work (stable IDs, never reused; status header inside; done items
  move to `todos/done/`, so `ls todos/*.md` is the open queue). The
  README's *Next up* list is the authoritative order of attack — keep it
  and item status headers current.
- **Design/topic docs**: `todos/NAME.md` (OS.md, KERNEL.md, SDL3.md, …) —
  long-lived designs and backlogs that queue items reference for detail.

Check both before starting new work; reference items as `todos/NNNN` in
commits and dev logs.

## Dev logs

`logs/YYYY-MM-DD/<topic>.md` is a **committed** engineering journal (folder per
local day, file per topic) capturing the *why* behind non-trivial work —
decisions, trade-offs, gotchas. Add an entry when landing anything
substantial, cross-linking `todos/NNNN` items. In-repo convention doc:
`logs/README.md`.

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
- **Systems**: `tinyemu` (RISC-V 32 emulator, can boot Linux), `busybox`
  (hush as the OS's /bin/sh — NOMMU config over the vfork-on-__spawn
  journaling shim — plus 29 coreutils applets, including vi as /bin/vi,
  as one multicall /bin/coreutils with /bin symlinks; patch table in
  `vendor/busybox/README.md`)
- **Libraries**: `zlib`, `libpng`, `freetype`, `libgit2` (@44c05e5, core only; builds + `git_index_open` smoke test runs — used as a large-codebase stress test, see `vendor/libgit2/README.md`)
- **Frontend infra (JS, not C)**: `xterm` (terminal widget), `codemirror` (editor widget)
- **Project-specific tools**: `disw` (WASM disassembler), `hello` (minimal smoke test)

## Toolchain

- **cmake**: always use the uv-managed install at `~/.local/bin/cmake`
  (`uv tool install cmake`). Do NOT use `/Applications/CMake.app` (shadows
  it on PATH) or any package-manager cmake. Invoke by full path:
  `~/.local/bin/cmake`.

## kernel.js (the process control plane) and its tests

`kernel.js` is the owner-side kernel (design: `todos/KERNEL.md`): process
table, per-process kernel-page SAB, block-RPC transport, spawn/wait/kill
routing. It is per-SYSTEM; `host.js` is per-PROCESS (loaded in every process
worker) — keep that boundary. `KernelClient.spawnHooks()` plugs into
host.js's existing `spawnHooks` seam, so host.js needs no kernel-specific
code. Signal delivery is cooperative: kernel.js posts SIGPEND bits on the
kernel page, host.js claims them at env-import safe points and calls the
wasm `__sig_dispatch` export (so pure-compute loops are uninterruptible by
design — SIGKILL still works). The tty (line discipline, termios, fg-pgroup
signal routing) is a kernel object. With `Kernel({fs})` the kernel also owns
the fd layer — per-process fd tables → shared open file descriptions → ONE
BlockFS instance, with fs syscalls as 0x04xx RPCs served to host.js's
RemoteFS (toWasmEnv reused over it); without opts.fs, processes get private
in-process fs (standalone pages keep that path forever — two transports,
one BlockFS; see KERNEL.md "fd/data-plane amendment"). Pipes are just
another OFD kind (PIPE_CREATE; kernel-side buffers + wait queues; blocking
read/write as deferred RPCs; EOF/EPIPE + SIGPIPE; select readiness). Job
control is cooperative like signals: STOP sets KP_FLAGS bit0 and the
process parks at its next safe point (RPC entry or sigpoll), SIGCONT
clears it; waitpid takes WUNTRACED/WCONTINUED; background brokered tty
readers get SIGTTIN (EIO if ignored/blocked). The kernel can be a native
AF_UNIX peer (`sockServe`) — first user is the WM protocol server on
/run/wm.sock (framed spec in the WMP block, MUST MATCH os/wm_proto.h),
serving /bin/wm (policy: placement, taskbar, minimize) and /bin/wmctl;
`Kernel.service()` spawns parentless auto-reaped service processes (the
wm autostart). The kernel is also the sound server (todos/0017, design in
WM.md "Audio mixing"): per-process source rings register via AUDIO_OPEN
(0x2xxx; SAB rides {type:'audio-sab'} before the RPC — the wm-sabs
handshake), `audioInit()` allocates the one page-owned f32/48k output
ring, `audioPump()` mixes (linear-interp resample, mono fan-out, sum,
clamp — pure deterministic math; the embedder schedules it, 20ms in
kernel-worker). Lifecycle: close/exit/SIGKILL mark streams dying → drain
dry → reclaim (paused/no-output drop at once — never wedge). Tests:
`node tests/kernel/run.js` — `test_kernel.js`/`test_tty.js`/`test_pipes.js`
drive the real SAB protocol against fake workers (deterministic, no
threads); the `*_e2e.js` files compile real C and run it in
`worker_threads`; `bench_fs.js` is the manual brokered-vs-inprocess
benchmark. When changing the kernel-page layout or opcodes, keep KERNEL.md's
layout comment and the tests in sync.

## os/ (the reference OS build)

`os/` is the bootable reference build (design: `todos/OS.md` "Reference
build"; landed via `todos/done/0004`): `os.html` (thin xterm UI bridge) →
`kernel-worker.js` (kernel.js + BlockFS-on-OPFS + compiler.js backing
/bin/cc) → `process-worker.js` per pid. `boot.js` is the headless twin —
same kernel/manifest under Node with the tty on stdio
(`echo 'ls /' | node os/boot.js`). First boot seeds the image from
`image.json`: paths map to **C sources compiled at seed time** by the cc
driver in `os-common.js` (no build step), vendor `project` builds, `bin`
binary blobs (repo-relative game data: doom1.wad, ROMs), raw `text`, and
`link` symlinks; bump `image.json`'s `version` after editing seeded
sources (`protoshell.c`, `cc.c`) or existing images won't re-seed. pid 1
is busybox hush (`/bin/sh`, built at seed time from
`vendor/busybox/bin.json`); `protoshell.c` stays as `/bin/psh`; `/bin/wm`
autostarts as a kernel service (killing it falls back to kernel-chrome;
`wm &` respawns). Windowed vendor apps are seeded in-OS (todos/0015):
`/bin/doom` (WAD at `/root/doom1.wad` — doomgeneric searches cwd only,
hush starts in /root), `/bin/gameboy` (ROMs under `/root/roms` — the ROM
files are gitignored, so their entries are `optional`: missing binary
assets log a skip instead of failing the boot; bare `gameboy` runs a
built-in test ROM), `/bin/snake` (tty game; needs two paced `q`s to quit
— its exit-prompt read loop spins on EOF). `/bin/gpubox` (todos/0016) is
the GPU demo — direct webgpu.h rendering: browser = per-process WebGPU
device + ImageBitmap handoff; headless = the optional Dawn tier (the
`webgpu` devDependency in the root package.json, LAZILY probed by host.js
— never hard-imported, stock Node stays tier 0; present = texture
readback→shm SAB, so `wmctl shot` works identically to CPU apps). GPU
apps must quit via SDL_Quit(), not exit()-in-frame-callback — the runtime
drains pending Dawn work before the EXIT handshake (WM.md spike-S3
caveat). Audio (todos/0017): doom/gameboy sound mixes kernel-side into
one output ring; os.html loads host.js ONLY for `createAudioReceiver`
and resumes the AudioContext on the first user gesture (autoplay
policy); `boot.js` stays silent by design (no `audioInit` — apps
self-pace against SDL_GetAudioStreamQueued, bounded memory). The tty's
`interactiveOut` opt makes fd 1/2
tty-kind (isatty true → hush goes interactive); piped runs stay
byte-clean. Tests: `tests/kernel/test_os_boot.js` +
`test_wm_service_e2e.js` + `test_os_apps_e2e.js` +
`test_gpubox_dawn_e2e.js` (headless, in the kernel suite; the gpubox one
skips without the webgpu pkg) + `test_audio.js`/`test_audio_e2e.js`
(0017); `tests/browser/os-boots.mjs` + `os-wm.mjs`
+ `os-doom.mjs` (now asserts the audio pipeline) + `os-gpubox.mjs`
(real Chromium, manual).

## BlockFS (host.js) and its tests

`host.js` contains **BlockFS** — a POSIX-ish filesystem backed by one byte store
(an OPFS `SyncAccessHandle` in the browser, a `MemoryByteStore` in tests). The
superblock + TLSF allocator + inode table + directories all live in the store.

**Invariant: the store is the single source of truth.** Any metadata that's
persisted in the superblock (inode-table extent/capacity, `nextInodeId`, pool
end, free lists) MUST be read THROUGH the store on each access, never cached on
the JS instance. Caching breaks coherence when **two live BlockFS instances run
over one store** (e.g. an embedder's concurrent headless runner + the workspace
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
