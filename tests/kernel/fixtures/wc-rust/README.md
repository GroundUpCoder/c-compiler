# wc-rust.wasm — the committed Rust fixture (todos/0415)

`wc-rust.wasm` is a `#![no_std]` Rust tool. Stable `rustc` built it for
the target `wasm32-unknown-unknown` in the sibling repository (default
`~/git/gucos-rust`, crate `crates/wc-rust`). The `RUST_ROOT` environment
variable in `tests/kernel/test_rust_e2e.js` is the one point that resolves
the sibling path.

The tool counts lines, words and bytes. It replicates the busybox `wc`
applet exactly, as the estate builds that applet (locale and unicode off):
`-l`, `-w`, `-c`, `-m`, `-L`, the multi-file total line, the fallback to
standard input, the `-` operand, and the missing-path error with exit
status 1. The kernel suite compares its output against the busybox applet
on the same inputs, in the same booted OS.

The read loop is the load-bearing part (`todos/0415`). The kernel
reassembles short reads for a REGULAR file only (`RemoteFS.read`,
`todos/0140`). For fd 0 on a pipe a short read really is short, so the
tool's own loop is what makes `cat big | wc-rust` correct. The test file
carries one large-input leg per loop and names which loop each one proves.

`wc-rust.wasm.sha256` records the sha256 of the fixture. The sibling
build is byte-deterministic. When the sibling is present,
`test_rust_e2e.js` rebuilds the module and proves the bytes equal this
fixture. To refresh the fixture after a crate change:

```
~/git/gucos-rust/build.sh
cp ~/git/gucos-rust/out/wc-rust.wasm tests/kernel/fixtures/wc-rust/
(cd tests/kernel/fixtures/wc-rust && shasum -a 256 wc-rust.wasm > wc-rust.wasm.sha256)
```
