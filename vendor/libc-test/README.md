# libc-test (vendored)

musl's libc conformance test suite — the `functional/` tests plus their
`common/` harness, from https://repo.or.cz/libc-test.git (MIT, see
COPYRIGHT). Each test is self-checking: `t_error()` prints a diagnostic
to stdout and sets `t_status`; `main` returns it, so **exit 0 + empty
output = pass**. No goldens needed.

Run via:

    python3 tests/run.py --types=libc

The runner compiles each `src/functional/*.c` together with
`src/common/print.c` (+ `rand.c`) using compiler.js, executes it under
host.js, and expects a clean exit. Tests for features this target
doesn't have (threads, dlopen, fork/exec, sockets, SysV IPC, ...) are
skipped with reasons in `LIBC_TEST_SKIP` in tests/run.py.

`src/math/` and `src/regression/` are not vendored yet — math is a
large data-table suite worth adding separately; regression is mostly
musl-internal bug repros.
