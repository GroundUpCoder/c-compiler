# alloc-rust.wasm — the committed Rust `alloc` fixture (todos/0414)

`alloc-rust.wasm` is a `#![no_std]` Rust binary that uses `alloc`. Stable
`rustc` built it for the target `wasm32-unknown-unknown` in the sibling
repository (default `~/git/gucos-rust`, crate `crates/alloc-demo`). The
`RUST_ROOT` environment variable in `tests/kernel/test_rust_e2e.js` is the
one point that resolves the sibling path.

The program reaches the host only through the `gucos-sys` crate (the ONE
Rust binding to the `"c"` ABI). Its `#[global_allocator]` delegates to the
linked C libc `malloc` — one heap for Rust and C. The program builds a
`Vec`, a `String`, a `Box` and a `BTreeMap`, sorts, formats and prints,
then interleaves Rust allocations with C `strdup`/`free` on the same heap
and verifies that nothing corrupts. It prints fixed lines that end with
`alloc-demo: OK` and exits 0.

`alloc-rust.wasm.sha256` records the sha256 of the fixture. The sibling
build is byte-deterministic. When the sibling is present,
`test_rust_e2e.js` rebuilds the module and proves the bytes equal this
fixture. To refresh the fixture after a crate change:

```
~/git/gucos-rust/build.sh
cp ~/git/gucos-rust/out/alloc-rust.wasm tests/kernel/fixtures/alloc-rust/
(cd tests/kernel/fixtures/alloc-rust && shasum -a 256 alloc-rust.wasm > alloc-rust.wasm.sha256)
```
