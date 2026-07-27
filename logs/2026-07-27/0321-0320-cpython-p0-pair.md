# 0321 + 0320 — the two compiler P0s that blocked a batteries-included CPython

Branch `fix-0321-0320`, two commits off `3d51b684`. Both were found by the
`todos/0313` CPython M0 probe; between them they were the whole of what stopped
a whole-program CPython 3.13.5 build from reaching a clean link.

## 0321 — what the deleted condition was protecting: **nothing**

The guard at the function-re-declaration site read:

```js
if (prevFunc && prevFunc instanceof AST.DFunc &&
    prevFunc.storageClass === Types.StorageClass.STATIC &&
    specs.storageClass !== Types.StorageClass.STATIC &&   // <-- the question
    specs.storageClass !== Types.StorageClass.IMPORT) {
  continue;
}
```

The known prototype deleted the middle condition and CPython linked. That tells
you the condition *rejects valid C*; it does not tell you what it was for. Two
pieces of evidence settle it, and neither is "no tests broke":

**1. The bug predates the condition.** `git log -S` puts the block at
`2a24fe55` (todos/0219). Running the ticket's repro against
`git show 2a24fe55^:compiler.js` — the tree immediately *before* the block
existed — produces the identical failure:

```
Link error: Undefined symbol 'helper' during linking
```

So `!== STATIC` was never a protection. It is 0219's **scope boundary**: that
ticket was about C11 6.2.2p4 linkage *inheritance* (`static int f(void){...}
extern int f(void);` — an `extern` re-declaration must not land in the external
link partition), and its plan says so explicitly: *"extern/no-storage-class
re-declaration of a static DFunc → drop"*. A re-declaration that repeats
`static` needs no linkage inheritance — it already has internal linkage — so it
fell outside the set, kept the pre-existing `varScope.replace` path, and stayed
broken.

**2. There is no distinction to protect.** C11 6.7p4 lets a declaration repeat;
6.2.2p4/p5 make the repeated `static` and the bare `extern` name the *same*
function. Any behaviour difference between those two spellings is a bug by
construction, not a semantic the guard could have been preserving.

So: removed, not narrowed. The surviving `!== IMPORT` condition IS load-bearing
(below), and the adjacent import-prev guard's own `!== STATIC` exclusion — a
`static` declaration *after* an `__import`, which is a real change of intent —
was left alone.

### The mechanism, for the record

`varScope.replace(name, funcDecl)` rebinds the name to the body-less node, and
the per-TU tree-shake marks reachability by **node identity**:

```js
unit.staticFunctions = unit.staticFunctions.filter(f => liveFuncs.has(f));
```

Callers bind the re-declaration, so the definition node is never in `liveFuncs`
and gets filtered out of the unit. The linker then finds a declaration with no
definition. That is why `-a parse` shows a single `DFunc … (def=$0)` with no
body: the definition really is gone, not merely mis-ordered.

### A second shape nobody had filed

The same root cause breaks an ordering the ticket does not mention:

```c
static int h(int);
static int h_user(void) { return h(1); }   /* binds decl #1 */
static int h(int);                          /* rebinds the scope to decl #2 */
static int h(int x) { return x + 8; }       /* def back-pointer lands on #2 */
```

`h_user`'s call holds decl #1, whose `.definition` is still null when the
tree-shake runs, so the definition is dropped exactly as above. Confirmed
failing on `origin/main`, fixed by the same change, and in the conformance
test.

### The load-bearing condition, pinned

`link_static_redecl_import_override` is the pin for `!== IMPORT`. It is
runtime-observable, which is the only kind of pin worth having:

```c
static int pick(void) { return -1; }
__import("c", "getpid") int pick(void);
```

`c.getpid` is host-provided and returns a positive pid, so the program prints
`import` iff the import took the binding and `static-def` iff the guard were
re-widened over IMPORT. The converse ordering (import, then a `static`
declaration, then a static definition) is in the same file, unchanged by 0321.

### The number

Whole-program CPython, same 233 sources, same flags, **only this condition
differing** (`/tmp/cpy-m0/link.sh` with `CCJS` swapped; two files —
`Modules/expat/xmlparse.c`, `Python/dynload_shlib.c` — excluded because they
hit todos/0323, which is out of this lane's scope):

| compiler | link errors | `Undefined symbol '*_impl'` | undefined total |
|---|---:|---:|---:|
| 0320 fix only, 0321 guard restored | 273 | 211 | 271 |
| both fixes | **61** | **0** | **0** |

The 61 that remain are a different class — `conflicting types for
'PyArg_ParseTupleAndKeywords'`, `char **` vs `const char **` — and are not this
ticket's.

A base measurement against plain `origin/main` is not possible: it dies in the
preprocessor (0320) long before the linker runs. The two P0s had to be fixed
together to get a number at all.

## 0320 — the spread audit: 12 sites, not 8, and why the guard is a lint

`dst.push(...src)` passes every element as a separate argument, so it dies once
`src` crosses V8's argument limit. The ticket's 8 preprocessor sites re-derive
at 1591/1657/1658/1695/1716/1754/1836/2113 against `3d51b684` — and they are
what one probe happened to trip over, not an audit.

### Found

Every call-argument spread in `compiler.js`, by grep for `push(...`,
`unshift(...`, `Math.max/min(...`, `String.fromCharCode(...`, `.apply(`, and the
general `<callee>(...expr` shape:

| site | array | verdict |
|---|---|---|
| PP `expanded.push(...replacement)` (×2), `vaRaw`/`vaArgs`, `out.push(...)` (×3), `expanded.push(...expand(combined))` — 8 total | macro replacement lists / expanded token streams | **changed** — unbounded in the input |
| `switchBodyStmts.push(...seg.stmts)` / `...termToStmts(seg.term)` | statements of one irreducible-CFG segment | **changed** — a machine-generated switch body is input-sized |
| `result.push(...expandProjectJson(dep))`, `args.push(...expandProjectJson(arg))` | a project's expanded source/dep list | **changed** — no construction bounds a `bin.json`'s source count |

### Left alone, with the bound stated

- `[...arr]`, `[a, ...arr, b]`, `new Set([...arr])`, `[...names].join(",")` —
  **array-literal** spread, not a call. Verified empirically: a 400,000-element
  array-literal spread succeeds where the same array in a `push` throws. No
  argument list is built, so there is no limit to cross.
- `[].concat(...[big, big])` — spreads **two** arguments (the arrays), not their
  elements. Bounded at 2 by construction.
- `Loc.join(...locs)` at `compiler.js:206` — a rest **parameter** in a method
  signature. It declares a signature, it does not pass an argument list; no
  call site spreads an array into it (checked).
- `Math.max/min(...arr)`, `String.fromCharCode(...arr)`, `fn.apply(null, arr)` —
  these DO hit the limit (confirmed: both throw at 400k) and `compiler.js` has
  zero instances of any of them. Nothing to change; the lint now keeps it that
  way.

### The helper is a hybrid, deliberately

A plain per-element loop is **3-4x slower** than the spread at n≤256 (measured:
109ms vs 330ms for 2M iterations at n=32; 708ms vs 2800ms at n=256), and these
are preprocessor hot paths. So:

```js
const SPREAD_CHUNK = 4096;
function pushAll(dst, src) {
  const n = src.length;
  if (n <= SPREAD_CHUNK) { if (n > 0) dst.push(...src); return dst; }
  for (let o = 0; o < n; o += SPREAD_CHUNK) dst.push(...src.slice(o, o + SPREAD_CHUNK));
  return dst;
}
```

Small inputs keep the single fast spread; the per-call argument count is bounded
by 4096 no matter how long the input is. Perf-neutral against the old code at
every size measured.

**Placement was a real trap.** The first version landed just above the
`// Preprocessor` banner — which is *inside* the `Lexer` IIFE (lines 9-2623).
The 8 preprocessor sites worked; the switch-lowering pair and the two
project-json sites are in other scopes and became latent `ReferenceError`s
firing only on an irreducible switch or a `--project` build. The new host test
caught it on its first run. The helper is now at file scope, and all three
formerly-latent paths were exercised deliberately afterwards
(`run-unit.js --filter=irreducible`, `--filter=goto`, `vendor/snake/bin.json`,
`vendor/libpng/bin.json` — the last one goes through the `deps` site).

### Why the guard is not a fixture

The ticket already warned that a token-count fixture XPASSes under
`tests/run-unit.js`'s worker stack. Measuring it settles *why*, and rules out
"just pick a bigger N":

```
$ node                      -e 'const b=Array(400000).fill(0); [].push(...b)'
Maximum call stack size exceeded
$ node --stack-size=200000  -e 'const b=Array(400000).fill(0); [].push(...b)'
(survives)
```

The limit is the available stack, with no hard cap in sight — so *every* N is a
flake waiting for a bigger stack. `tests/host/test_pp_spread_bounds.js` is
therefore limit-independent:

1. a **source lint**: no call-argument spread survives in `compiler.js` outside
   the helper's own two bounded ones. Verified red by reverting one site
   (`compiler.js:1864: expanded.push(...expandedResult)` reported by line and
   text), and it also asserts `pushAll` is actually *wired* at ≥12 sites so the
   lint cannot pass vacuously by deletion;
2. the **helper's contract**: over a 500k input, max arguments per `push` call
   ≤ `SPREAD_CHUNK` (measured 4096 over 123 calls), the append is byte-exact,
   a small input still takes exactly ONE call, and an empty input takes none;
3. an e2e smoke — a 400k-token macro through a **fresh main-thread**
   `node compiler.js -a lex`. Positive-only: it can never fail spuriously, and
   on a bigger stack it merely stops being informative. Which is why (1) and (2)
   are the guards.

## Filed, not just noticed — todos/0328

`inline` is taken from a declaration's OWN specifiers, so unlike function
attributes (which accumulate and back-propagate, todos/0214) an `inline` spelled
only on a prototype or a re-declaration is silently dropped and the WAST inliner
never sees `hintCalleeCap` (256 nodes) instead of `calleeCap` (64). Measured on
one 30-statement static function:

| form | wasm bytes |
|---|---:|
| no `inline` | 8345 |
| `inline` on the definition | 8749 |
| `inline` on a prototype only | 8345 |
| `inline` on a post-definition re-declaration only | 8345 |

Rows 3-4 should equal row 2. It is pre-existing (row 3 fails on `origin/main`
too) and it is a size-budget bias, not a correctness bug — the C11 6.7.4p7
external-definition rule reads the *definition* node, whose own `inline` is
never lost. Deliberately NOT folded into a P0 fix: propagating it changes
codegen for a common header idiom and wants the SameBoy interlock plus the
project categories. Filed P1 with the blast-radius plan in the ticket, a gap
comment at the `_mergeFnAttrs` block, and register entry **L40**.

## Two probe-harness artifacts, chased down so nobody files them as bugs

Reaching the linker at all needed two files excluded from `link-srcs.txt`. Both
look like front-end defects and neither is one — they are flag bugs in
`/tmp/cpy-m0/link.sh`, and they are pre-existing (byte-identical in the earlier
probe's own `link.err`, produced by `compiler-patched.js`):

- **`Modules/expat/xmlparse.c:284: error: Expected ';'`** — `link.sh` passes
  `-DPREFIX='"/usr/local"'` for CPython's `getpath.c`, and expat writes
  `typedef struct prefix { ... } PREFIX;`. The macro rewrites the typedef name
  to a string literal. **clang emits the same error on the same input**
  (`expected ';' after struct`). A real CPython build compiles expat to a
  separate object without CPython's `-DPREFIX`; a whole-program driver has to
  keep them apart the same way.
- **`Python/dynload_shlib.c:41: error: Expected '}'`** — `link.sh` never defines
  `SOABI` (its sibling `minlink.sh` does), so `"." SOABI ".so"` leaves a bare
  identifier inside an initializer list. Missing `-D`, nothing more.

## Not settled

Nothing outstanding on either ticket. The 61 remaining CPython link errors are
all `conflicting types` on `char **` vs `const char **` — that is
**todos/0323**, already open and explicitly out of this lane's scope. So after
0321 + 0320 (plus the two `link.sh` flag fixes above), 0323 is the *only* thing
between this build and a clean whole-program CPython link.
