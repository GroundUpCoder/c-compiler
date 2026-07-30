# std-rust.wasm — the committed wasip1 std fixture (todos/0442)

`std-rust.wasm` is a NORMAL Rust bin crate (`fn main()`, upstream `std`,
no attributes). Stable `rustc` built it for the tier-2 target
`wasm32-wasip1` in the sibling repository (default `~/git/gucos-rust`,
crate `crates/std-demo`). The `RUST_ROOT` environment variable in
`tests/kernel/test_rust_std_e2e.js` is the one point that resolves the
sibling path.

The module is the two-namespace acceptance shape of the `todos/0418`
ruling: `std::fs`, `std::io`, `std::env`, `std::time`, `thread::sleep`
and `HashMap` import from `wasi_snapshot_preview1` (served by the
`toWasiPreview1` shim in `host.js`), and one `gucos-sys` call (`getpid`)
imports from `"c"` — both namespaces in ONE module. The entry is wasip1's
`_start` (wasi-libc crt1); the host detects it and skips the host-played
crt0 (`RUST.md` §2, the wasip1 entry).

`std-rust.wasm.sha256` records the sha256 of the fixture. The sibling
build is byte-deterministic (`codegen-units = 1`). When the sibling is
present, `test_rust_std_e2e.js` rebuilds the module and proves the bytes
equal this fixture. To refresh the fixture after a crate change:

```
~/git/gucos-rust/build.sh
cp ~/git/gucos-rust/out/std-rust.wasm tests/kernel/fixtures/std-rust/
(cd tests/kernel/fixtures/std-rust && shasum -a 256 std-rust.wasm > std-rust.wasm.sha256)
```

Then commit the fixture and the sha256 file together with the crate
change in the sibling.
