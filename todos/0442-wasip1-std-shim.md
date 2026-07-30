# 0442 — C2: std on wasip1 — the `wasi_snapshot_preview1` shim

- **Status**: open
- **Design**: `todos/RUST.md` §2–§3; the ruling in
  `todos/done/0418-rust-std-decider.md` §"Result" (this ticket's authority).
  🔴 **Read `~/git/meta/gucos/notes/wasi-p1-census.md` before you plan.** It maps all
  **46** `wasi_snapshot_preview1` functions against the `"c"` ABI, measured at
  c-compiler `57ad36fa` (2026-07-30, read-only, no code touched). It sizes the work at
  **~1,250 lines in `host.js`** — **27** trivial rewraps, **8** needing struct/flag
  translation, **5** substantial (`path_open` + preopens, `fd_readdir`, `poll_oneoff`)
  — and confirms **no kernel change is needed**, so the 0418 "bounded shim over
  existing RPCs" premise holds. It also verified the 0418 claim that `FS_WAIT` is
  `poll_oneoff` in a different spelling: opcode `0x0420` at `kernel.js:255`, handler at
  `kernel.js:3864`, and the re-poll-on-any-return contracts match.
- **Provenance**: filed by the `todos/0418` ruling, 2026-07-30. P0 per jku's
  2026-07-30 priority call on the Rust program.

## Goal

Rust programs on gucOS get the **upstream** standard library, on the stable
`wasm32-wasip1` target. `host.js` serves the `wasi_snapshot_preview1` import
namespace beside `"c"` by delegating to the kernel RPCs that already exist.
`std::fs`, `std::io` (stdin/stdout/stderr), `std::env`, `std::time` and the
seeded `HashMap` hasher become real through upstream code. No fork of std, no
rebase, no nightly compiler — those are the terms of the 0418 ruling, and this
ticket must not drift from them.

The `no_std` + `"c"` rung (lanes A1–A4) stays as it is. The two rungs coexist:
a wasip1 std program still reaches spawn, signals, tty, http and the clipboard
through `gucos-sys` and `"c"` — both namespaces in ONE module.

## 🔴 Four gaps the census found in the Plan below — read before you build

Recorded 2026-07-30 by the WASI P1 census (above), measured at `57ad36fa`. The Plan
was written before the census ran; these correct it. **None of them were fixed in the
Plan text — they are corrections to it, and they win.**

1. **`poll_oneoff` has no standalone path, and the Acceptance requires one.** Both
   no-kernel env flavors answer **`-2`** for `__wait` (`host.js:6217`, `host.js:8044`),
   yet this ticket's Acceptance requires standalone `node host.js` runs — and Rust's
   `thread::sleep` goes through `poll_oneoff`. **The shim needs a no-kernel fallback**,
   on the `__select_impl` model. Without it the standalone arm cannot pass.
2. 🔴 **Do NOT copy the existing `__wait` wrapper.** It **silently drops write-fd
   interest** — `host.js:6738` forwards only read fds, while the kernel handler reads
   `req.w` correctly. Copying it yields a `poll_oneoff` that never reports writability
   and never fails loudly. **Call `hooks.waitMulti` directly with BOTH lists.**
3. **"The `createHttp` shape" underspecifies the factory.** `createHttp` is called
   `(ctx, hooks)` and **never sees the filesystem object**, but the whole `fd_*` /
   `path_*` family must delegate to the BlockFS/RemoteFS method surface. So
   `createWasiPreview1` needs the **fs instance** too — its signature is not
   `createHttp`'s.
4. **The `/` preopen fd must be a REAL fd in the gucOS fd table, not a shim-side
   fiction.** The `"c"` namespace shares the process fd space, and two-namespace
   coexistence is an acceptance criterion of this ticket. A private numbering scheme
   inside the shim will collide with `"c"` fds.

⚠️ **Three corrections to the surface map, so they are not re-inherited** (the census
found these while checking its own brief): `createPosix` (`host.js:5502`) serves
**only** `getpid`/`getppid` — `exit`, time and entropy live in `runModule`'s base env
(`__exit` 10911, `__gettimeofday` 11044, the clock latch pair 11063/11079, `__getentropy`
11092) — and **no `times` import exists**; `createHttp` has **four** imports, not five
(there is no `http_body`); and `kernel.js` is at the **repo ROOT**, not under `os/`.

## Plan

1. **The shim.** A `createWasiPreview1(ctx)` factory in `host.js` (the
   `createHttp` shape), merged into the one import object under the key
   `wasi_snapshot_preview1`. First subset: `fd_write`, `fd_read`, `fd_close`,
   `fd_seek`, `fd_fdstat_get`, `fd_prestat_get`, `fd_prestat_dir_name`,
   `fd_readdir`, the `path_*` family (open, filestat, create/remove directory,
   unlink, rename, readlink, symlink), `clock_time_get`, `clock_res_get`,
   `random_get`, `args_get`/`args_sizes_get`, `environ_get`/
   `environ_sizes_get`, `proc_exit`, `sched_yield`, `poll_oneoff`. Preview 1
   functions with no gucOS meaning answer `ENOTSUP`-class errnos loudly —
   no zombie fallbacks.
2. **`poll_oneoff` → `FS_WAIT`.** Map fd read/write subscriptions plus the
   clock subscription onto the unified wait (`kernel.js` `FS_WAIT` 0x0420).
   The caller's re-poll-on-any-return contract matches preview 1's semantics.
3. **The entry contract.** Reconcile wasip1's `_start` convention with the
   gucOS host-played crt0 (`main`/`memory`/`alloca`, `RUST.md` §2). Decide and
   record ONE answer — e.g. keep crate-type `cdylib` exporting `main` and let
   the shim serve `args_get`/`environ_get` from the same argv/envp `host.js`
   already lays out — and write it into `RUST.md` §2 if it amends the contract.
4. **Preopens.** Decide the preopen mapping (a single `/` preopen directory fd
   is the natural shape over MountFS) and record it.
5. **The build rung.** In the sibling `gucos-rust` repository: a wasip1 build
   of a std demo program on **stable** rustc (`rustup target add
   wasm32-wasip1`), linking `gucos-sys` in the same module to prove the
   two-namespace coexistence.
6. **Guardrails.** The base image stays byte-identical (`RUST.md` §3 rule 5 —
   the shim is host.js-side only). A wasip1 module on an embedder whose
   `host.js` predates the shim fails loud with the missing import's name.

## Acceptance

- A std Rust program — `std::fs` read and write, `println!`/`eprintln!`,
  `std::env::args`/`vars`, `std::time::SystemTime` and `Instant`, a `HashMap`
  — runs in gucOS, standalone (`node host.js`) and in-OS, with `$?` asserted.
- The same module imports from BOTH `wasi_snapshot_preview1` and `"c"`, and a
  `gucos-sys` call (e.g. spawn or tty) works beside std I/O.
- `poll_oneoff` with an fd subscription parks via `FS_WAIT` and wakes on
  readiness; a pure-timeout subscription sleeps and returns the clock event.
- The whole path runs on **stable** rustc. No nightly toolchain is installed
  or invoked; the build rung's script refuses `-Zbuild-std`.
- The base image is byte-identical before and after the host.js change (the
  §3 rule 5 guardrail re-run, with its number reported).
- An unserved preview 1 import fails loud, naming module and symbol; no
  silent stub returns fake success.
- `RUST.md` §2/§3 carry any contract amendment this ticket makes (entry
  contract, preopens), in the same commit as the code.
- Tests land in both embedders (kernel suite e2e + a browser leg if the in-OS
  run needs one), and `node tests/run.js --diff` maps the touched paths.

## 🔴 (FA) pass on the Acceptance above — three arms are ALREADY GREEN, read before you build

Measured 2026-07-30 by @master (cont-215) against `main` at `7447d1f4`, by running each
arm against the tree rather than trusting the filed list. **An acceptance arm can be
discharged by the machine's state or by a different ticket between filing and execution,
and it then certifies the wrong lane.** These corrections win over the arms as written.

1. **"No nightly toolchain is installed or invoked" is ALREADY TRUE, and not because of
   this ticket.** `rustup toolchain list` shows only `stable-aarch64-apple-darwin`
   (active, default) and `1.95.0-aarch64-apple-darwin` — both stable, no nightly.
   ⇒ Satisfying that clause proves **nothing** about your work, and it is a fact about a
   **global** toolchain that anything outside this ticket can change. **The only real
   work in that arm is the last clause: `build.sh` must REFUSE `-Zbuild-std`.** It does
   not today — `grep 'build-std' build.sh` in `~/git/gucos-rust` is empty; the string
   appears only in `README.md:19` and `crates/gucos-sys/src/lib.rs:63-65` prose. Add the
   refusal to the script, and report it as the arm you actually closed.
2. **Plan step 5's `rustup target add wasm32-wasip1` is a NO-OP — the target is already
   installed** (`rustup target list --installed` ⇒ `aarch64-apple-darwin`,
   `wasm32-unknown-unknown`, `wasm32-wasip1`). Do not report it as a step you completed.
   What IS new: `build.sh:81` hardcodes `--target wasm32-unknown-unknown` for every
   crate, so the wasip1 rung is genuinely absent and is real work.
3. 🔴 **"An unserved preview 1 import fails loud … no silent stub returns fake success"
   is FREE FROM THE ENGINE, AND IT CONTRADICTS PLAN STEP 1.** `host.js:9749` instantiates
   with a plain `new WebAssembly.Instance(module, importObject)`, so a **missing** import
   throws a `LinkError` naming module and symbol with no code from you at all.
   **But `host.js` contains BOTH disciplines and this arm names only one:**
   - `createNullSpawn` (`host.js:5559`) deliberately makes imports "resolve to ENOSYS so
     any module that links `__spawn` still instantiates (the `createNullSDL` discipline)"
     — i.e. the house style **is** to install a stub so linking succeeds.
   - `createSsCoreEnv` (`host.js:9612`) does the opposite on purpose: unported envs are
     **omitted** so the program "will fail to instantiate with a clear missing-import
     error naming exactly what to add next."
   ⇒ Plan step 1 says preview 1 functions with no gucOS meaning "answer `ENOTSUP`-class
   errnos loudly" — that is a **stub**, which is the `createNullSpawn` discipline and
   **cannot** also LinkError. Both cannot hold for the same symbol. **Resolve it by
   splitting the population explicitly, and record the split:**
   **SERVED-but-meaningless ⇒ present in the import object, returns an `ENOTSUP`-class
   errno. NOT-IN-THE-SHIM ⇒ absent from the import object, so it LinkErrors.**
   Name which preview 1 functions land in which set. A lane that puts everything in the
   first set satisfies Plan step 1 and silently voids this arm; a lane that puts
   everything in the second set voids step 1. **Neither failure announces itself.**

⚠️ **Two more arms need a re-derive at spawn, not a correction:**
- **"The base image is byte-identical before and after"** — `todos/0417` bumps
  `os/image.json` **198 → 199**. Take your "before" measurement on the main you actually
  branch from; do not carry a baseline number from this ticket or from any note.
- **"`node tests/run.js --diff` maps the touched paths"** is under-specified: `--diff`
  is **ignored** in the `--list` form. The runnable invocation is
  **`node tests/run.js --diff --dry-run`** (`tests/run.js:452`, documented at `:13` and
  `:735`). `--list`/`--list-suites` is a different flag that lists suites.

## Result (2026-07-30)

Shipped. A normal Rust bin crate — `fn main()`, upstream std, stable
`rustc`, `wasm32-wasip1` — runs in gucOS standalone and in-OS, with a
`gucos-sys` `"c"` call in the same module.

**The shim.** `BlockFS.prototype.toWasiPreview1(ctx, opts)` in `host.js` —
a prototype method, NOT the planned `createWasiPreview1(ctx)` shape,
because the fd/path family needs the fs instance (census gap 3; the
`toWasmEnv` precedent). `toWasmEnv` registers its instance on `ctx.fs`, so
every bootstrap (BlockFS standalone, RemoteFS in every OS process) gets
the shim with zero bootstrap changes. `runModule` attaches the namespace
only when the module imports it; the Node-fs flavor refuses loudly.

**The served/absent split (the arm-6 contradiction, resolved).**
- REAL (36): `args`/`environ` ×4, clocks ×2, `random_get`, `proc_exit`,
  `fd_read`/`fd_write`/`fd_pread`/`fd_pwrite`/`fd_close`/`fd_seek`/
  `fd_tell`/`fd_sync`/`fd_datasync`/`fd_fdstat_get`/`fd_filestat_get`/
  `fd_filestat_set_size`/`fd_filestat_set_times`/`fd_readdir`/
  `fd_renumber`/`fd_prestat_get`/`fd_prestat_dir_name`, all ten `path_*`,
  `poll_oneoff`.
- Honest no-op success (2): `fd_advise` (advisory by specification),
  `sched_yield` (single-threaded cooperative).
- SERVED, `ENOTSUP` (3): `fd_fdstat_set_flags`, `fd_fdstat_set_rights`,
  `fd_allocate` — runtime fd-state mutations; the loud answer is an errno
  at the call site, not a LinkError after the program already ran.
- ABSENT, LinkError names module+symbol (5): `sock_accept`, `sock_recv`,
  `sock_send`, `sock_shutdown`, `proc_raise` — capability families gucOS
  serves through `"c"` (or not at all); a runtime stub would be a second
  door to a `"c"` capability.

**Entry contract (plan step 3), decided and recorded in `RUST.md` §2:**
the module keeps wasip1's own convention — imports the namespace, exports
`_start` and no `main` ⇒ the host calls `_start()` and skips the
host-played crt0 entirely (no `alloca`/`main` export needed; argv/envp via
`args_get`/`environ_get`; normal return = exit 0; both exit paths route
through the `"c"` `__exit`, so the ordered exit handshake runs). The
`cdylib`-exporting-`main` alternative was rejected: it would make every
Rust std program carry a gucOS-specific harness, against the upstream-std
terms.

**Preopens (plan step 4):** exactly one, `/`, as a REAL fd (census gap 4).
Substrate: `BlockFS.open` grew `O_DIRECTORY` (0x10000) directory fds —
the fs/kernel half of `todos/0400`, recorded there; plain
`O_RDONLY`-on-a-directory deliberately stays `EISDIR` (no C-observable
change; the libc constant is 0400's remaining work).

**poll_oneoff (plan step 2):** kernel path calls `hooks.waitMulti` with
BOTH r and w lists in one FS_WAIT (census gap 2 — the read-only `__wait`
wrapper was not copied; `test_rust_std_e2e.js` carries the regression
guard), re-poll-on-any-return, EINTR surfaces as WASI `EINTR`. No-kernel
fallback (census gap 1): readiness scan over the fd table, stdin-SAB futex
park, `blockingSleepMs` for pure-clock sets — the standalone arm's
`thread::sleep` runs through it.

**The build rung (plan step 5):** `gucos-rust` branch `0442-wasip1-std` —
`crates/std-demo` (the fixture source), the `build.sh` wasip1 rung (no C
runtime objects: wasi-libc owns malloc and gucos-sys's
`#[global_allocator]` delegates to it — still one heap), and gucos-sys's
panic handler behind the default `no-std-runtime` feature (std owns it on
the wasip1 rung; `default-features = false`).

**Arms actually closed vs already green:** "no nightly installed" and
"wasm32-wasip1 installed" were ALREADY TRUE at spawn and are not this
lane's work. The real arm closed: `build.sh` now REFUSES `-Zbuild-std`
(env + args, exit 1 naming the 0418 ruling, before any cargo runs) —
tested with the plain build as positive control.

**Tests:** `tests/kernel/test_rust_std_e2e.js` (registered in the kernel
suite): fixture sha256, two-namespace module shape, shim unit legs
(preopen-is-a-real-fd, O_DIRECTORY substrate, poll_oneoff × {pure-clock,
pipe-fd, kernel-stub-both-lists, EINTR}, served/absent split incl. real
LinkError instantiation), standalone arms (full output, `$?`, exit7,
panic, Node-fs refusal), in-OS shell-spawned arms, sibling freshness +
the `-Zbuild-std` refusal. Fixture:
`tests/kernel/fixtures/std-rust/std-rust.wasm` (sha256-pinned;
gitignore-allowlisted). The gucos-sys feature-gate changed the crate
metadata hash, so the hello/alloc/wc fixtures were refreshed in the same
commit (bytes differ, behavior identical — `test_rust_e2e.js` re-run
green, 58 checks; overlay regenerated, `test_rust_pkgs_e2e.js` green).

**Recorded limits (also in `RUST.md` §2):** wasi-libc's emulated cwd
starts at `/` regardless of the spawn cwd (a preview-1 property, not
ours); the `"c"` errno bridge (`__errno_set`) is absent on this rung
unless a provider is linked; a panic under upstream `panic=abort` ends in
a trap (host reports nonzero + the stderr message), not `__exit(101)`;
`std::net` is unsupported by construction. A kernel predating FS_WAIT
answers `poll_oneoff` with `ENOSYS` loudly (no chunked-poll fallback —
every current kernel has 0178).
