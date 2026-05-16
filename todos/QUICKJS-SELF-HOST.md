# QuickJS Self-Host Bootstrap — open codegen bug

**Status (2026-05-17):** QuickJS compiles + runs JS on our wasm. Recursion,
classes, regex, JSON — everything works for direct eval. The one remaining
hurdle to "compiler.js compiles itself through our QuickJS" is a single
**codegen bug in our compiler** that miscompiles part of QuickJS's bytecode
emitter for large/complex JS functions.

## Reproduction

```bash
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs.wasm --std -e \
  "try { std.evalScript(std.loadFile('compiler.js')); console.log('PASS'); }
   catch (e) { console.log('FAIL:', e.message); }"
# → FAIL: stack underflow (op=36, pc=2052)
```

Native clang build of the **exact same patched sources** runs compiler.js
successfully:

```bash
cd vendor/quickjs && clang -O2 -D_GNU_SOURCE -DEMSCRIPTEN \
  -DCONFIG_VERSION='"2025-09-13"' -Wno-everything *.c -lm -o /tmp/qjs-native
/tmp/qjs-native --std -e \
  "try { std.evalScript(std.loadFile('compiler.js')); console.log('PASS'); }
   catch (e) { console.log('FAIL:', e.message); }"
# → PASS
```

So **the QuickJS source is fine; our compiler miscompiles it.** Native
QuickJS is built with the same patches in `vendor/quickjs/` (alloca.h
includes, USE_WORKER disabled).

## The smoking gun

After enabling `#define DUMP_BYTECODE (3)` in quickjs.c and diffing the
pass-2 bytecode dump from both builds of the inner `visit` function inside
compiler.js's `buildSegments`:

| Op | Native | Ours |
|---|---:|---:|
| `call`        | 80 | 77 |
| `call_method` | 45 | 46 |
| `eval`        | 0  | 2  |

**Our build emits `OP_eval` (op 50) instead of `OP_call` for two specific
source lines:**

```js
// compiler.js:6291
const target = topBreakTarget();
// our bytecode: eval 0,27   (should be: call 0)

// compiler.js:6292
close(Term.goto(target));
// our bytecode: eval 1,27   (should be: call_method 1)
```

`OP_eval` has different stack effects from `OP_call`, so the verifier
(`compute_stack_size`) later detects a stack-tracking mismatch when it
scans the bytecode and rejects the function. The reported "op=36" is
`call_method` further down the bytecode — it's where things finally
collapse, not where the bug is.

## Where to dig

The emitter logic that chooses between OP_call / OP_call_method / OP_eval
lives in `js_parse_postfix_expr` (quickjs.c:25513). The relevant section:

- **Line 25820:** `switch(opcode = get_prev_opcode(fd))` — looks at what
  opcode was just emitted for the callee, dispatches.
- **Line 25874:** `case OP_scope_get_var:` — reads the atom name; sets
  `opcode = OP_eval` (line 25889) iff `name == JS_ATOM_eval &&
  call_type == FUNC_CALL_NORMAL && !has_optional_chain`.
- **Line 26069 (label `emit_func_call:`):** `switch(opcode)` — emits the
  actual call op. `case OP_eval:` emits OP_eval.

When I added a probe at line 25880 (the eq check), it **never fired for
`topBreakTarget` / `close`** — name was never `JS_ATOM_eval`. So line
25889 never sets `opcode = OP_eval`.

**So where does opcode come from?** Most likely from the first switch's
expression itself: `opcode = get_prev_opcode(fd)`. If `get_prev_opcode`
returns OP_eval directly (because the previous emitted byte is 50, the
OP_eval value), the first switch falls through (no matching case for
OP_eval), opcode retains the value 50, and the second switch's
`case OP_eval:` fires.

The chain: once OP_eval is emitted once spuriously, the next function
call sees it as `prev_opcode`, and the chain repeats. So we need to find
**the first OP_eval emission** — the first time `get_prev_opcode` or
some other path produces 50 incorrectly.

## What's been ruled out

- **Macro-handling** — our preprocessor accepts redef silently, identical
  to gcc/clang behavior. Not the cause.
- **Reserved-word property names** — renaming `Term.return`/`Term.throw`
  to `Term.ret`/`Term.thr` in compiler.js still triggers the bug with
  identical pc.
- **Function size threshold** — the bug only fires for `visit`. Removing
  either the SReturn or SThrow branch makes visit pass; removing both,
  passes. Suggests an emitter-state-dependent issue, not a per-construct
  one.
- **Compiler.js parser fixes** — already landed (enum tag namespace fix,
  zero-length-array flag). Those got us past parse; the codegen bug is
  separate.

## Probe sites attempted

- `compute_stack_size` at line 34516 (stack-underflow site) — useful for
  function name + pc (gave us `func=visit op=36 pc=2052`).
- `js_parse_postfix_expr` line 25880 — confirmed the eval-name branch
  never fires.
- `emit_func_call:` label (line 26065) — initial probe showed huge garbage
  values; a cleaner re-probe showed sensible values but the `fprintf`
  output got tangled with other JS-execution output. Need a smaller
  side-channel.

## Suggested next probe

Instrument **both** clang-built and our-built QuickJS with the **same**
minimal fprintf at `emit_func_call:`:

```c
fprintf(stderr, "FUNC_CALL opcode=%d prev_byte=%d bc_size=%d\n",
        opcode,
        fd->last_opcode_pos >= 0 ? fd->byte_code.buf[fd->last_opcode_pos] : -1,
        (int)fd->byte_code.size);
```

Diff the outputs, find the first line that disagrees. That tells us
which exact function call diverges, then we can look at the
**immediately preceding bytecode emission** and ask why our build
produced a different opcode there.

## Once the divergent C construct is found

Reduce to a minimal C test case (a hundred lines, no QuickJS
dependencies), add to `tests/unit/...`, fix the codegen, watch the
whole compiler.js-on-QuickJS-on-our-compiler pipeline come alive.

Self-host through a JS engine is one bug away.

## Useful files

- `vendor/quickjs/bin.json` — build config with our patches + `--allow-zero-length-arrays`
- `/tmp/qjs.wasm` — our build (build via `node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json`)
- `/tmp/qjs-native` — reference clang build (build via the `clang -O2 ...` invocation above)
- `/tmp/qjs-bisect/` — bisect artifacts from when we narrowed the trigger to `visit`
