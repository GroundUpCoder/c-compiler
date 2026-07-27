# 0329 — an over-arity call is blamed on an "unprototyped function" when the prototype came from a re-declaration

- **Status**: open
- **Priority**: P3 (diagnostic wording only — the program is still rejected)
- **Difficulty**: light
- **Design**: —
- **Provenance**: filed by the master while grading `todos/0321`. The cont-98
  handoff carried this as a **C11 6.2.7p4 composite-type gap** ("the compiler
  never forms the composite type across a dropped re-declaration"). **That
  framing did not survive verification** — see "What was claimed" below. This
  ticket is the residue that did.

## The gap

Given an unprototyped declaration followed by a prototyped re-declaration and a
definition, an over-arity call is diagnosed — but the message names the function
as *unprototyped*, which it is not:

```c
static int f();
static int f(int x);          /* f IS prototyped from here on */
static int f(int x) { return x; }
int main(void) { return f(1,2,3); }
```

```
error: call to unprototyped function 'f' with 3 argument(s), but the definition takes 1
```

The call is caught by the **definition-arity** check, which describes the callee
as unprototyped, rather than by the **composite-type** path that produced the
precise message. The accurate message exists in the compiler already — the same
program with the first declaration removed reports:

```
error: too many arguments to function call (expected 1, got 3)
```

Post-`0321` this affects the `static`/`static` spelling too. At merge-base
`3d51b684` that spelling took the precise route; on `38d6d940` it takes the
definition route like the others. **0321 made the two spellings consistent and
made this one message less precise — it did not introduce a missed check.**

## What was claimed, and what the evidence actually shows

The carried claim was that the composite type is never formed, leaving a missing
diagnostic. Measured at `38d6d940`, with a positive control each time:

| program | result |
|---|---|
| `extern int f(); extern int f(int x); f(1,2,3)` (no definition) | **diagnosed precisely** — composite type *is* formed |
| `extern int f(int x); f(1,2,3)` (control) | diagnosed precisely |
| `static int f(); static int f(int x); <def>; f(1,2,3)` | diagnosed, imprecise wording |
| `static int f(); extern int f(int x); <def>; f(1,2,3)` | diagnosed, imprecise wording |

And the codegen question, which the handoff explicitly left unclaimed, is now
answered **negative**. Parameter-type conversion across the composite type is
applied correctly:

```c
static int f();
static int f(double x);
static int f(double x) { return (int)(x * 10); }
int main(void) { printf("%d\n", f(1)); }   /* prints 10, as does the no-first-decl control */
```

So: **no missing diagnostic, no wrong codegen.** What remains is the wording.

## Plan

Where the definition-arity check fires, prefer the prototyped re-declaration's
parameter list when one exists, and only say "unprototyped" when no declaration
in the chain carried a prototype. Alternatively, keep the check but pick the
message off whether a prototype was ever seen.

## Acceptance

- A conformance test asserting the four spellings above all produce the
  **precise** message when a prototyped declaration exists anywhere in the
  chain, and the "unprototyped" wording only when none does.
- No behavioural change: every one of these programs is rejected before and
  after.

## Not to be confused with

- `todos/0323` — cross-TU declared-type **mismatches**. Different problem.
- `todos/0328` — `inline` lost on a re-declaration. Same family (information
  carried only on a dropped re-declaration), different information.
