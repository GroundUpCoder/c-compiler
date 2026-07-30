# hello-rust.wasm — the committed Rust fixture (todos/0413)

`hello-rust.wasm` is a `#![no_std]` Rust binary. Stable `rustc` built it for
the target `wasm32-unknown-unknown` in the sibling repository (default
`~/git/gucos-rust`, crate `crates/hello-gucos`). The `RUST_ROOT` environment
variable in `tests/kernel/test_rust_e2e.js` is the one point that resolves
the sibling path.

The module satisfies the gucOS ABI contract (`todos/RUST.md` §2): it imports
only from the module `"c"`, and it exports `main`, `memory` and `alloca`.
It prints `hello from rust on gucOS` and exits 0. With `panic` as the first
argument, it panics on purpose, and the panic handler reports the panic on
stderr and ends the process through `__exit` with status 101. Since
todos/0414 the crate reaches the host only through `gucos-sys`, and its
`alloca` export is backed by the linked C libc `malloc` (the 0413 static
arena is deleted).

`hello-rust.wasm.sha256` records the sha256 of the fixture. The sibling
build is byte-deterministic. When the sibling is present,
`test_rust_e2e.js` rebuilds the module and proves the bytes equal this
fixture. To refresh the fixture after a crate change:

```
~/git/gucos-rust/build.sh
cp ~/git/gucos-rust/out/hello-rust.wasm tests/kernel/fixtures/hello-rust/
(cd tests/kernel/fixtures/hello-rust && shasum -a 256 hello-rust.wasm > hello-rust.wasm.sha256)
```
