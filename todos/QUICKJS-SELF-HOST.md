# QuickJS Self-Host Bootstrap — local-reuse codegen bug

**Status (2026-05-17):** Self-host loop is **open** with `--no-reuse-locals`
as a workaround. The full pipeline:

```bash
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs.wasm --std -e \
  "std.evalScript(std.loadFile('compiler.js')); console.log('PASS');"
# → PASS — compiler.js loads + runs inside QuickJS-on-our-wasm
```

The remaining task is to **fix the underlying local-reuse codegen bug**
so we don't need the `--no-reuse-locals` flag.

## The bug

Our compiler's wasm-local slot allocator gives **the same slot** to two
distinct C variables in different scopes when their live ranges shouldn't
permit it. Concretely, in QuickJS's `js_parse_postfix_expr`
(`vendor/quickjs/quickjs.c` line 25513):

```c
} else if (s->token.val == '(' && accept_lparen) {
    int opcode, arg_count, drop_count;     // outer block — `opcode` allocated here
    ...
    switch(opcode = get_prev_opcode(fd)) {
    ...
    case OP_scope_get_var: {
        JSAtom name;
        int scope;                          // INNER block scope
        name = get_u32(...);
        scope = get_u16(...);               // ← after this, opcode == scope (!!)
        if (name == JS_ATOM_eval && ...) {
            opcode = OP_eval;
        }
        ...
    }
    break;
    ...
    }
    // ... later code reads opcode, expects it to be unchanged ...
}
```

**Probe data** (`PROBES:` line at stack-underflow time, after instrumenting
the various assignment sites):

```
classify=593 cl_eq=0 in_if=0 gpo50=0
eval_emit=9 eval_opc=50 pre_emit=1898 pre50=9 after_sw1=1543 after_sw1_50=9

case_scope_get_var:
  before_name=0/593 after_name=0/593 after_scope=9/593 (opcode==50 count / total)
  scope == opcode after assignment: 593 / 593   ← they alias 100% of the time
  scope == 50 after read: 9                     ← in 9 cases, the read value is 50
```

So:
- For all 593 invocations of `case OP_scope_get_var`, the locals `scope`
  and `opcode` share the same storage.
- 9 of those reads return value 50 (OP_eval), so opcode is silently
  changed to 50.
- The outer code then dispatches based on `opcode==OP_eval` and emits
  `OP_eval` bytecode instead of `OP_call`. The 5-byte `OP_eval` op
  mis-frames subsequent bytecode → verifier hits a stack underflow at
  a downstream `OP_call_method`.

**Address-of test confirms**: adding `(unsigned)(uintptr_t)&opcode`
forces opcode onto the memory frame instead of a wasm-local. With the
address taken, the bug **disappears** — clean evidence that the issue
is wasm-local slot allocation.

## Where to look in the compiler

- **`allocLocal`** (`compiler.js:13480`) — pops from `freeLocalsByType`
  for reuse. Reuse is gated on `noReuseLocals` flag (which when set,
  fixes the bug, confirming this is the area).
- **`pushLocalScope` / `popLocalScope`** (`compiler.js:13503-13513`) —
  free locals back to the pool on scope exit.
- **`hoistDeclarations`** (`compiler.js:5954`) — flattens all DVars to
  function entry, with name-uniquification. After hoisting, the block
  structure that originally separated `opcode` and `scope` may be lost,
  causing the allocator to think they're independent.
- **`SDecl` case in `emitStmt`** (`compiler.js:14252-14274`) — where
  DVars trigger `allocLocal`. After hoisting, SDecls are replaced with
  SExpr-only statements, so the DVars' allocs happen via some other
  path (probably the per-function-entry decls list passed to
  `synthesizeWrapper` at `compiler.js:6703`).

The most likely culprit: hoistDeclarations flattens the lexical scoping,
and the function-entry allocation walks the flattened list without
respecting original block live-ranges. Then any time the original outer
variable's value needs to persist across a hoisted inner allocation,
the slot is reused incorrectly.

## Minimal repro — not yet captured

I tried a small switch/inner-scope test that didn't trigger the bug.
The repro needs:
- A function with many block-scope variables
- Variables with the same wasm-type (int)
- An outer variable whose value must persist past inner block exit
- Sufficient complexity to exercise the regalloc edge case

Probably needs to look more like the real js_parse_postfix_expr (deep
nesting, recursion, many branches). Worth synthesizing a real repro
before fixing.

## What's been ruled out

- **Macro / preprocessor issues** — none.
- **Switch codegen bug** — `case OP_eval` matches correctly given
  `opcode == 50`. Standalone switch test passes.
- **The `OP_eval` classification check itself** — the if-body at
  `quickjs.c:25892` never executes (probe in_if=0). The bug is upstream:
  `opcode` already equals 50 before that check.
- **A QuickJS bug** — native clang build of identical sources runs
  compiler.js fine.

## Reproduction recipe

```bash
# Build our QuickJS without the workaround:
( cd vendor/quickjs &&
  python3 -c "import json; b=json.load(open('bin.json')); \
              b['compilerArgs'] = [a for a in b['compilerArgs'] if a!='--no-reuse-locals']; \
              json.dump(b, open('bin.json','w'), indent=2)" )
node compiler.js -o /tmp/qjs-buggy.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs-buggy.wasm --std -e \
  "std.evalScript(std.loadFile('compiler.js'))"
# → InternalError: stack underflow (op=36, pc=2052)
```

Re-add `--no-reuse-locals` and it passes.

## Once fixed

Drop `--no-reuse-locals` from `vendor/quickjs/bin.json`. Verify the
full self-host:

```bash
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs.wasm --std -e '
  std.evalScript(std.loadFile("compiler.js"));
  const wasm_bytes = globalThis.CompilerJS.compile("int main(){return 42;}");
  std.open("/tmp/out.wasm","wb").write(wasm_bytes,0,wasm_bytes.length);
'
node host.js /tmp/out.wasm
# → exit code 42
```

That's the bootstrap.
