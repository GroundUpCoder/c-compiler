# Misc TODO

## Test categories to add

- **doom** — Doom OPL music module tests. Requires vendoring Doom and Nuked-OPL3 sources.
  Compile+run tests that check for "FAIL" in stdout rather than using expected output files.

- **torture** — GCC torture test subset. Needs its own compile-failure policy (skip, not fail)
  since most tests use GCC extensions the compiler doesn't support. The old repo had a
  separate `run-torture.py` that was never integrated into the main harness.

- **third-party** — External C compliance test suites (c-testsuite, UCB math subset).
  Each has its own runner and discovery logic. Need to decide how to integrate or wrap them.

## Vendor projects to add

- ~~**doom** — DOOM (doomgeneric port) + Nuked-OPL3. Large integration test.~~
- ~~**zlib** / **zlib-compat** — Compression library.~~
- ~~**freetype** — TrueType font rendering.~~
- ~~**gameboy** — Gameboy emulator.~~
- ~~**tinyemu** — RISC-V system emulator (boots Linux to BusyBox shell with interactive stdin). See `vendor/tinyemu/README.md`.~~
- **sqlite** — vendored 3.53.1 amalgamation. Compiles + links, but `sqlite3VdbeExec` blocks codegen. See "SQLite follow-ups" below.

## TinyEMU follow-ups

The headless RISC-V 32-bit build works end-to-end (boots Linux 4.15
to a BusyBox shell, stdin wired). Open items if anyone wants to
push it further:

- **tcc in the guest** — the shipped 4 MB busybox userland has no
  compiler. Two paths to get one, neither pursued:
  - Wire up `fs_wget` HTTP fetching in `host.js` (currently stubbed)
    and point the cfg at `https://vfsync.org/u/os/buildroot-riscv64`,
    Bellard's hosted buildroot-with-tcc 9P tree. Probably an
    afternoon of work; ties operation to vfsync.org.
  - Build (or source) a buildroot ext2 disk image with tcc included
    and swap it in via virtio-blk. Fully offline but ~50–200 MB
    binary that doesn't belong in the repo — would need separate
    hosting.

- **x86 won't work from this source** — TinyEMU's `x86_cpu.c` is a
  96-line stub that exits with "x86 emulator is not supported". The
  real code is a KVM frontend (requires host CPU to be x86) and
  cannot compile to wasm. Bellard's working JSLinux x86 emulator
  (`x86emu-wasm.wasm`, ~600 KB) is a separate 2011 codebase, closed
  source. Adding x86 needs a different emulator entirely — v86
  (open-source JS), Bochs (C++, ~150 KLOC), an old QEMU TCG, or a
  hand-rolled interpreter.

- **Network, framebuffer, 9P** — `host.js` has stubs/no-ops for
  `fs_net_init`, `block_device_init_http`, `fb_refresh`,
  `net_recv_packet`, the SDL paths. Wiring any of them would unlock
  richer demos.

## SQLite follow-ups

SQLite 3.53.1 is vendored under `vendor/sqlite/`. The build clears
parse + link, but codegen fails on 218 "target label not in scope"
diagnostics, all inside `sqlite3VdbeExec` — SQLite's VDBE bytecode
dispatch interpreter. The pattern: shared cleanup labels
(`jump_to_p2`, `check_for_interrupt`, `abort_due_to_error`, etc.) sit
outside a giant `switch` over opcodes, and most case bodies `goto`
into one of those labels. Their author explicitly chose this
unstructured form for performance — see the comment block above
`check_for_interrupt`.

What's needed: `GOTO_NORMALIZER` doesn't unwind enough nested compound
scopes inside switch cases to reach an outside-the-switch label. The
"hoist to LCA of all gotos" approach lands the labels at the function
body where they already are; the real problem is each goto needs to
escape its case-compound (and possibly intervening braces) without
violating switch semantics.

Possible approaches:
- Per-case `goto` rewriting: replace each `goto L` inside a case body
  with `<flag = X>; break;` followed by post-switch dispatch on the
  flag. Mechanical but invasive — would need to track which labels are
  reached by which paths.
- Extend `GOTO_NORMALIZER` to fall through nested compounds when the
  target is at function scope and the path doesn't cross loops/switches
  whose semantics it'd violate. Subtle but contained.
- Replace `sqlite3VdbeExec`'s dispatch with a precompiled jump-table
  form. Heavy surgery; would diverge from upstream.

No path is small. Putting SQLite on hold until we decide whether to
push on goto handling.

## Regression-test gaps

Two bugs found during tinyemu work; one has a regression test, one
doesn't:

- ✅ Buffered-I/O fseek corruption in `r+b` mode — covered by
  `tests/unit/stdlib/fseek_rplus_no_corrupt`.
- ✗ Cross-TU `__export` targets dropped by per-TU tree-shake — fixed
  in `compiler.js` (INLINER seeds `unit.exportDirectives`) but no
  test asserts the export survives, because the unit framework
  diff's stdout and can't inspect wasm exports. Would need either a
  new test category that checks wasm exports, or a JS-side hook the
  test can call to verify presence.
