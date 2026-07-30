# 0442 — std on wasip1: the `wasi_snapshot_preview1` shim

The `todos/0418` ruling authorized ONE second import namespace. This lane
built it. A normal Rust bin crate (`fn main()`, upstream std, stable
rustc, `wasm32-wasip1`) now runs in gucOS — standalone over `--block-fs`
and in-OS from the shell — with a `gucos-sys` `"c"` call in the same
module. Ticket: `todos/0442` (the full Result lives there). Sibling:
`gucos-rust` branch `0442-wasip1-std`.

## The decisions worth remembering

- **The shim is a prototype method, not a factory.** The plan said
  "`createWasiPreview1(ctx)`, the `createHttp` shape". The census showed
  that shape cannot build the fd/path family: `createHttp` never sees the
  fs object. So the shim is `BlockFS.prototype.toWasiPreview1(ctx, opts)`
  — the `toWasmEnv` precedent — and `toWasmEnv` registers its instance on
  `ctx.fs` (one line), which gives EVERY bootstrap (BlockFS standalone,
  RemoteFS in each OS process, browser process-worker) the shim with zero
  bootstrap changes.
- **The entry contract keeps wasip1's own convention.** `_start` + no
  `main` ⇒ the host calls `_start()` and skips the host-played crt0. The
  alternative (cdylib exporting `main`) would make every Rust std program
  carry a gucOS-specific harness — against the upstream-std terms of the
  ruling. Recorded in `RUST.md` §2.
- **The served/absent split** (the arm-6 contradiction): 36 real + 2
  honest no-ops (`fd_advise`, `sched_yield`) + 3 served-`ENOTSUP`
  (`fd_fdstat_set_flags`/`set_rights`, `fd_allocate` — runtime fd-state
  mutations want an errno, not a LinkError after the program ran) + 5
  absent (`sock_*` ×4, `proc_raise` — capability families gucOS serves
  through `"c"`; a stub would be a second door). The e2e pins both
  halves, including a REAL one-import module that must LinkError.
- **The preopen forced the `todos/0400` substrate.** The `/` preopen must
  be a REAL fd, but no gucOS fd could refer to a directory. `BlockFS.open`
  grew `O_DIRECTORY` (0x10000) — dir-kind fd entries, `read(2)` = EISDIR —
  and the flag rides MountFS + the kernel `FS_OPEN` + RemoteFS unchanged.
  Plain `O_RDONLY`-on-a-directory deliberately still answers `EISDIR`: the
  libc has no `O_DIRECTORY` constant, so nothing C-observable moved. 0400
  keeps the libc surface (constant, dirfd/fdopendir, `__at_ok` recovery,
  fchdir); its ticket and the `compiler.js` `__at_ok` comment now say so.
- **poll_oneoff did NOT copy the `__wait` wrapper.** The census caught
  that wrapper silently dropping write-fd interest. The shim calls
  `hooks.waitMulti` with BOTH lists in one FS_WAIT; the e2e's stub-hooks
  leg is the regression guard (asserts `req.w` arrives). The no-kernel
  fallback is the `__select_impl` model — the standalone `thread::sleep`
  arm runs through it.

## Gotchas hit

- **A dependency's `[features]` section changes every downstream
  artifact's bytes.** Feature-gating gucos-sys's panic handler (std owns
  the lang item on the wasip1 rung) changed the crate metadata hash, so
  hello/alloc/wc fixtures all shifted. Refreshed all four fixtures + the
  overlay in one motion; `test_rust_e2e` (58 checks) and
  `test_rust_pkgs_e2e` re-run green. Byte-determinism itself held (two
  consecutive builds agree).
- **wasi-libc's preopen probe walks fds 3.. and stops at the first
  EBADF.** The shim opens the preopen before wasm runs, so it takes the
  lowest free fd. A spawner seeding extra fds ≥ 3 would stop the probe
  early — recorded as a contract line in `RUST.md` §2 rather than
  hidden.
- **Upstream `panic=abort` traps; it does not `__exit(101)`.** The gucOS
  no_std rung's 101 convention does not carry over: a std panic prints to
  stderr then hits `unreachable`. The tests pin nonzero + the message,
  not 101.
- **WASI p1 has no cwd.** wasi-libc emulates one starting at `/`,
  whatever cwd the spawn set. Upstream semantics — recorded, not patched
  (no-fork-no-rebase terms).
