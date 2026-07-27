# Making the gate's own record honest — todos/0333 + todos/0339

Two tickets, one file (`tests/run.js`) and one concern: the gate currently lets a
run **claim** more than it **ran**. 0333 is the planner side (a diff that owes a
gate can plan nothing), 0339 the record side (a run that covered half the sweep
leaves an artifact indistinguishable from one that covered all of it).

## 0333 — `tools/` was mostly unmapped

`RULES` mapped exactly five `tools/` paths (`mkpkg`, `clang-unpackaged.json`,
`mkimage`, `os-drive*`, `win32rc`, `win32ports`, `mkmpgenhdr`). A probe touching
one file per unmapped area listed **11 UNMAPPED paths** and planned `(nothing)`:

```
tools/asm86/asm86.js  tools/bench2x2/analyze.js  tools/build-libc-ext.js
tools/cfg/c0.js  tools/disasm/interpreter.js  tools/idlemeter.mjs
tools/mkgif.js  tools/mksounds.js  tools/mkwebfixtures.js
tools/peek-repro.mjs  tools/sample-wasm-filegen/wasmgen.js
→ suites: (none)
```

The hole was never *silent* — `printDiffPlan` prints the yellow unmapped block
and says "add a rule". The defect was that nothing ran, and a reader who takes
`suites: (none)` as "no gate owed" gets no enforcement, only a warning they can
skip. That is exactly how it survived: `tools/bench2x2/` has been in the tree
since `c1b1f47c` and 0332 edited it live.

**Why no blanket `^tools/` rule.** `tools/` is three different kinds of thing at
once, and a single rule would have to pick one:

1. **Generators of committed assets** (`mksounds`, `mkgif`, `mkwebfixtures`,
   `build-libc-ext`). Their outputs are checked in, so an edit here only reaches
   the tree via a re-run — which means the gate that matters is the suite that
   *consumes* the asset, not anything about the generator. Same shape as the
   existing `mkimage`/`win32rc` rules.
2. **Harnesses that ride a test seam** (`idlemeter`, `peek-repro`, `bench2x2`).
   They gate nothing themselves. The useful signal for their editor is "the seam
   under you still holds", which is the `^tools/os-drive → sweep` precedent
   already in the table.
3. **Self-contained side projects** (`asm86`, `cfg`, `disasm`,
   `sample-wasm-filegen`). Own trees, own runners, nothing outside `tools/`
   references them. Their honest answer is `[]`.

So each path states its own answer. The two calls worth defending:

- **`bench2x2 → host`, not `host, kernel`.** Every cell runs `node host.js
  <wasm>` standalone, which the cheap host suite proves. Its in-OS leg
  (`inos-startup.js`) *also* drives `os/boot.js`, so `kernel` is arguably in the
  seam — but taxing a measurement harness with the heavy suite is precisely the
  over-fix the ticket warned against. Declined in a comment, not by omission.
- **`[]` is a rule, not silence.** An explicit `[]` suppresses the UNMAPPED
  warning *because a decision was recorded*; the `tests/bench/`, `tests/run.js`
  and `tests/flake.js` entries already work this way. Deliberately **no**
  catch-all, so a NEW `tools/` path still reports UNMAPPED — that warning is the
  prompt to decide, and a catch-all would silence exactly the case that needs it.

After: all 11 paths match, 0 unmapped, and the bench2x2-only probe plans `host`.

## Aside — L38's anchor comment is false (0318's territory, untouched)

`tests/run.js:176` says "vendor/ has no blanket rule — every OTHER vendored
project reports UNMAPPED on a diff. That gap is todos/0318." There **is** a
blanket rule: `[/^vendor\//, ['projects'], 'a vendored project build']`, present
since the original 0084 commit `f2fd59c5` — i.e. the comment was already wrong
when it was added at `8b945672`, and `todos/0318`'s premise ("has no rule for
`vendor/`") inherits the error. `LIABILITIES.md` L38 anchors on that line.

Not fixed here: it belongs to 0318, and rewriting the anchor line would have
dragged the register into this lane's diff. Flagged to @master instead. Note the
severity is the *inverse* of the usual liability-register hazard — a false gap
comment causes wasted work, where a true one causes missed work.
