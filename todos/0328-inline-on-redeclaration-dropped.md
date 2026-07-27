# 0328 — `inline` on a prototype or a re-declaration never reaches the definition

- **Status**: open
- **Priority**: P1 (optimization hint lost — no wrong code, no rejected program)
- **Difficulty**: light
- **Design**: —
- **Provenance**: found while fixing `todos/0321` (static re-declaration after a
  definition). Not caused by it — the prototype form fails identically on
  `origin/main`.

## The gap

`DFunc.isInline` is taken from the declaration's OWN specifiers
(`new AST.DFunc(loc, name, type, [], specs.storageClass, specs.isInline, null)`,
both the definition and the declaration path). Function ATTRIBUTES accumulate
across re-declarations and back-propagate onto the definition (todos/0214, the
`_mergeFnAttrs` block), but `inline` does not travel with them. So an `inline`
that appears only on a declaration is silently dropped.

C11 6.7.4p1 makes the specifier a property of the FUNCTION, not of one
declaration of it; gcc and clang both honour `inline` on any declaration.

Measured — one 30-statement static function, three spellings, same program:

| form                                                    | wasm bytes |
|---------------------------------------------------------|-----------:|
| `static int big(int x) {...}` (no `inline`)              | 8345 |
| `static inline int big(int x) {...}`                     | 8749 |
| `static inline int big(int); static int big(int x){...}` | 8345 |
| `static int big(int x){...} static inline int big(int);`  | 8345 |

Rows 3 and 4 should match row 2. The effect is the inliner's size budget:
`fnMeta.inlineHint` (`!!funcDef.isInline`) selects `hintCalleeCap` (256 nodes)
over `calleeCap` (64) in `INLINER`, so the hint is the difference between a
64-node and a 256-node callee being inlined.

## Why it is not a correctness bug

`inlineHint` is only a size-budget bias. The C11 6.7.4p7 external-definition
rule that DOES depend on `inline` is decided in the linker off the DEFINITION
node's `isInline` (`addDecl`), and a definition's own `inline` keyword is never
lost — only a declaration's. Nothing miscompiles; some functions just do not
get inlined that should.

## Plan

Propagate `isInline` the way `fnAttrs` already propagates, at the same three
choke points, so the specifier is a property of the function:

- the definition path: `if (prev.isInline) funcDecl.isInline = true;` alongside
  the existing `_mergeFnAttrs(funcDecl.fnAttrs, prev.fnAttrs)`;
- the declaration path: OR the new declaration's `isInline` onto both the kept
  binding and its `.definition`, in the same block that back-propagates
  attributes (note this must happen BEFORE the redundant-re-declaration drops
  — todos/0321's `continue` and the import `continue` both skip everything
  after);
- block-scope function declarations, if they carry `inline` at all.

## Blast radius — measure it

This CHANGES CODEGEN for any program that spells `inline` on a declaration only
(a common header idiom). Treat it like an optimizer change, not a parser fix:

- `node tests/run.js unit kernel blockfs host` plus the run.py project
  categories — sizes and timings shift, goldens that encode a non-inlined
  call may move.
- Run the SameBoy framebuffer-checksum interlock: the point is that the change
  is a size/perf bias, so the OUTPUT must stay identical even where the bytes
  do not.

## Acceptance

- A conformance test asserting the four spellings above produce the same ANSWER
  (they already do) plus a unit assertion that rows 2-4 agree on
  `fnMeta.inlineHint` (the observable that actually regressed).
- The gap comment in `compiler.js` (the `_mergeFnAttrs` block) is deleted, and
  `todos/LIABILITIES.md` L40 retired in the same commit.
