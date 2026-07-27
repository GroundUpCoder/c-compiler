# 0321 — A static function re-declared AFTER its definition becomes an undefined symbol

- **Status**: open
- **Priority**: P0 (valid program rejected)
- **Difficulty**: light
- **Design**: —
- **Provenance**: found by the `todos/0313` CPython M0 probe. It accounted for
  **168 of 173** remaining link errors on a whole-program CPython build, because
  it is exactly the shape CPython's Argument Clinic emits.

## The bug

```c
#include <stdio.h>

static int helper(int x)   /* DEFINITION first */
{
    return x + 1;
}

static int helper(int x);  /* re-DECLARATION after the definition — legal C11 */

int main(void)
{
    printf("%d\n", helper(41));
    return 0;
}
```

```
ours : Got 1 link errors.
       Link error: Undefined symbol 'helper' during linking
         at redecl.c:8
clang: OK (prints 42)
```

The re-declaration **replaces** the definition in scope, so the definition is
dropped from the AST entirely (`-a parse` shows a single `DFunc … (def=$0)`
with no body).

### Why this matters far beyond a toy

CPython's Argument Clinic generates `clinic/<file>.c.h` containing forward
declarations of the `_impl` functions, and the convention is to `#include` that
header **near the bottom** of the `.c` file — after the definitions. So every
clinic-generated `_impl` in `_io`, `_elementtree`, `_sre`, `_queue`,
`posixmodule`, `selectmodule`, `timemodule` … is declared after it is defined.

## Root cause

`compiler.js:13368` already carries the todos/0219 fix for
`static int f(void) {...} extern int f(void);` — but it is gated on the
re-declaration being **non**-static:

```js
if (prevFunc && prevFunc instanceof AST.DFunc &&
    prevFunc.storageClass === Types.StorageClass.STATIC &&
    specs.storageClass !== Types.StorageClass.STATIC &&   // <-- excludes the common case
    specs.storageClass !== Types.StorageClass.IMPORT) {
  continue;
}
```

Argument Clinic emits `static PyObject *name(...);`, i.e. a **static**
re-declaration, so the guard is skipped and control reaches
`this.varScope.replace(name, funcDecl)`.

## Plan

Drop the `specs.storageClass !== STATIC` condition, so a redundant re-declaration
of an already-static function is dropped whether or not it repeats `static`.
Verified during the probe: this one-condition change makes the repro print `42`
and clears all 168 clinic link errors.

Keep the `!== IMPORT` condition (an explicit import re-declaration is meaningful).
Check that decl-then-def (`static int f(void); static int f(void) {...}`) still
works — it takes a different path and was unaffected in the probe.

## Acceptance

- The repro above is a conformance test and passes.
- Regression guards for all four orderings: def→decl, decl→def, def→extern-decl
  (the todos/0219 case, must not regress), decl→decl→def.
- A whole-program build of CPython 3.13.5 core reports zero
  `Undefined symbol '*_impl'` link errors.
