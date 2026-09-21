# 0341 — a worktree lane can silently write into the main tree; nothing guards it

- **Status**: done
- **Reported by**: the router CHECK lane (cont-106/107), filed by @master cont-108
- **Evidence**: first-hand, reproduced by construction with a positive control;
  the dated artifact is the stray `logs/2026-07-25/*.png` writes into
  `~/git/c-compiler` from a lane that was working in `~/worktree/c-compiler/fix-0316`

## The mechanism — it is NOT "a lane forgot to `cd`"

`tests/browser/os-hires.mjs:43-44` — the writer of the exact two stray files:

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.resolve(__dirname, '../../logs/2026-07-25');
```

`OUT_DIR` is resolved from **the script file's own location**, never from
`process.cwd()`. So a script always writes into the repo that *contains it*.

> **The tree you write to is decided by WHICH PHYSICAL COPY of the script you
> execute. `cd` into your worktree is NOT the control and cannot protect you.**

A lane with perfect `cd` discipline that invokes `node ~/git/c-compiler/tests/...`
— or any wrapper, doc snippet, or kickoff line carrying a main-tree absolute path
— writes to **main**, silently, from any cwd.

### Positive control (so "no difference found" cannot be a broken probe)

The instrument replicates lines 43-44 verbatim against each physical copy and
**exits 3 if it finds fewer than 2 copies**:

```
script copy: ~/git/c-compiler/tests/browser/os-hires.mjs
  -> OUT_DIR: /Users/jku/git/c-compiler/logs/2026-07-25        <- exactly where the strays landed
script copy: ~/worktree/c-compiler/fix-0316/tests/browser/os-hires.mjs
  -> OUT_DIR: /Users/jku/worktree/c-compiler/fix-0316/logs/2026-07-25
cwd during the probe = /private/tmp   <- NEITHER repo, and both still resolved
```

That last line is the control: the resolution is provably **cwd-independent**.
Reproduced with no sweep run and no heavy lock taken. Instrument is committed in
the **meta** repo at `tools/wtprobe.mjs` (not this repo).

## One cause or several: ONE, and it is systemic

| count | fact |
|---|---|
| 74 | files under `tests/` + `tools/` using `import.meta.url` |
| 127 | sites resolving `path.resolve(__dirname, '../..')` — "the repo root is wherever I live" |
| **2** | uses of `process.cwd()` in the **entire** `tests/` + `tools/` source |

The suite is almost perfectly cwd-**independent** by design. This is not 127 bugs;
it is one convention applied consistently, and **in isolation the convention is
correct** — a script writing next to itself is what you want. **The defect is the
missing guard, not the resolution.** Do not "fix" the 127 sites.

## Candidates adjudicated (not assumed)

- **(1) hardcoded absolute path — REFUTED for this incident.** `grep -rn
  "git/c-compiler" --include='*.js' --include='*.sh' --include='*.mjs'` over the
  repo returns **zero**. ⚠️ The `tools/ccjs-build.sh` / `python-clang` hardcoded
  path is a **real but DIFFERENT instance and was NOT verified** by this
  investigation — do not let this ticket imply it was.
- **(3) the lane never `cd`-ed in — the TRIGGER, not the mechanism.** Since cwd
  does not determine the write target, **fixing `cd` discipline does not fix
  this.** `tests/run.js:48` invokes `['node','tests/browser/os-sweep.mjs']`
  *relatively*, so the whole outcome hinges on the single moment `tests/run.js`
  itself is launched; one absolute main-tree path anywhere in that chain sends
  every downstream write to main.
- **(4) root discovered by something other than cwd — CONFIRMED.** That thing is
  `import.meta.url`.

## No guard exists — verified before claiming it missing

Nothing in `tests/` or `tools/` compares `process.cwd()` to its resolved ROOT
(grep for `cwd` near root/assert/throw/exit/mismatch/worktree over source files,
excluding the bundled `browser/www/` HTML: **zero hits**).

## Goal

Convert a silent cross-tree write into a loud, immediate failure.

## Acceptance

- **One shared preflight, ~5 lines**, in the common harness both runners already
  import: assert the resolved ROOT and `process.cwd()` are the **same git tree**;
  on mismatch print **both** paths and **exit 3**.
- Because every one of the 127 sites funnels through the same launch, the guard
  fires on all of them at once — no per-site change.
- **No behaviour change on the happy path**; demonstrate that by running the
  `todos` + `unit` suites from the correct tree and showing they are unaffected.
- **A positive control in the same log:** launch a main-tree copy from a worktree
  cwd and show the guard exits 3. A guard whose failure path was never exercised
  is not a guard.
- An escape hatch is acceptable **only** if it must be set explicitly per
  invocation and is named in the failure message.

## Priority rationale

P2. Nothing is blocked on it, but it is a **recurring** fleet failure with a
standing salvage cost (see `executor-edits-main-tree-mistake`), and the fix is
cheap and one-shot. It also changes what every kickoff can honestly promise:
today "cd into your worktree" is **aspirational**; this guard is what makes it
**enforceable**. Kickoffs may keep saying it either way — but until this lands,
lane discipline is the *only* thing preventing cross-tree writes, and it has
demonstrably failed more than once.
