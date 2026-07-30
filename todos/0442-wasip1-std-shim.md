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
