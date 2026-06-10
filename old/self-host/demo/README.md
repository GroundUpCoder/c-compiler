# Self-host demo

This directory shows our compiler **compiling C source while running
inside our own QuickJS-on-wasm build**.

## What happens

1. Our native compiler builds QuickJS to wasm:
   `node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json`
2. We launch that wasm, ask QuickJS to load `compiler.js` as a script,
   and then drive the compile pipeline through `globalThis.CompilerJS`.
3. The compile output goes back through `std.open(..., "wb").write(...)`
   to a file on disk.

So a small wrapper script — `selfhost.js` — reads `hello.c`, runs it
through the full lex → parse → link → codegen pipeline (no native
process help), and writes the resulting wasm. Then we run that wasm.

## Running it

```bash
# Build QuickJS first
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json

# Run the self-host demo
node host.js /tmp/qjs.wasm --std demos/self-host/selfhost.js
# → "[selfhost] wrote /tmp/selfhost-demo/hello-rebuilt.wasm"

# Run the wasm it built
node host.js /tmp/selfhost-demo/hello-rebuilt.wasm
# → "Hello from a wasm built INSIDE wasm!"
# → exit code 42
```

## Determinism check

The wasm output from self-host is **bit-identical** to a native build
of the same C source:

```bash
node compiler.js -o /tmp/hello-native.wasm demos/self-host/hello.c
cmp /tmp/selfhost-demo/hello-rebuilt.wasm /tmp/hello-native.wasm
# → (no output: files are identical)
```

That's the strongest signal that our compiler "is" our compiler:
running it in two different JS hosts (native Node vs. QuickJS-in-wasm)
produces the exact same wasm bytes for the same input.

## Caveats / next steps

- The `selfhost.js` wrapper needs to polyfill `TextEncoder` /
  `TextDecoder` because stock QuickJS doesn't ship them.
- Today this requires `--no-reuse-locals` in
  `vendor/quickjs/bin.json` — there's a wasm-local slot reuse bug
  documented in [todos/QUICKJS-SELF-HOST.md](../../todos/QUICKJS-SELF-HOST.md).
  Once that's fixed the workaround can come out.
- The demo compiles small programs. Compiling QuickJS itself
  (~64 KLOC of C) through this loop would be the full bootstrap; not
  attempted here but the pipeline is the same.
