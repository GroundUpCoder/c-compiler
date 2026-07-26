# 0299 — Correct the stale optional-browser-sweep-degrades-to-a-skip comments (tests/run.js:37, CLAUDE.md:147)

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27, bucket 2 (stale/
  inaccurate comments — the class we generally *do* catch, because false comments are
  self-limiting).

## Goal

Fix a comment that advertises a tolerance narrower than reality.

`tests/run.js:37` (+ `:369-375`) and `CLAUDE.md:147` both say:

> the browser `sweep` is optional (a missing-Playwright launch failure degrades to a skip, not a
> hard fail)

**What actually happens:** the skip only fires on `r.spawnError`, i.e. failure to spawn the
**node process**. A missing Playwright is an import error *inside* `os-sweep.mjs`, which exits 1
or 2 (`os-sweep.mjs:68-69`) and therefore classifies as **fail**.

So the real behaviour is **stricter** than documented — a missing Playwright hard-fails the
sweep rather than skipping it. That is arguably the better behaviour; the defect is that the docs
promise otherwise, so a contributor without Playwright hits a hard failure the docs told them
would be a skip.

## Status — PLAUSIBLE, not CONFIRMED

The sweep read both code paths but **ran no suites**. **Verify by actually inducing it** (hide
Playwright, run the sweep, observe fail vs skip) before editing the comments. If it turns out to
skip after all, the finding is void — close this item and record that.

## Plan

- Reproduce: with Playwright unavailable, run the sweep and record the actual classification.
- Then either:
  - **(a)** correct `tests/run.js:37`, `:369-375` and `CLAUDE.md:147` to describe the real
    (stricter) behaviour; or
  - **(b)** if the documented tolerance is the *intended* behaviour, make the code match it —
    classify an in-process Playwright import failure as a skip.
- **Decide which of (a)/(b) is wanted rather than defaulting to the comment edit** — the docs
  may be describing the intent correctly and the code may be the thing that is wrong.

## Acceptance

- Documented behaviour and actual behaviour agree, verified by inducing the condition.
- The decision between (a) and (b) is recorded here with its reason.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.

## VERIFICATION (cont-78, 1e8a940)

**Verdict: CONFIRMED — but the ticket's stated mechanism is wrong in one detail.**

Settled statically and decisively; no suite was run (two heavy lanes were live).

### The skip branch is unreachable for a missing Playwright

`tests/run.js:395-402` is the whole classifier:

```js
function classify(r, optional) {
  if (r.spawnError) {
    // Couldn't even launch the runner. Optional suites (browser sweep with
    // no Playwright) degrade to a skip; required ones are a hard failure.
    return { status: optional ? 'skip' : 'fail', ms: r.ms,
             note: `could not launch: ${r.spawnError.message}` };
  }
  return { status: r.status === 0 ? 'pass' : 'fail', ms: r.ms,
           exit: r.status, signal: r.signal || undefined };
}
```

`r.spawnError` is `spawnSync`'s `error` field, set at `tests/run.js:317`
(`return { ms, status: r.status, signal: r.signal, spawnError: r.error };`).
Node sets `spawnSync().error` **only when the child could not be spawned at all**
— i.e. `node` itself is missing/not executable. Any exit code from a *running*
child, including 1 and 2, takes the second branch and classifies as `fail`.

So `optional: true` on the `sweep` suite (`tests/run.js:47-49`) is effectively
inert: the only condition it can ever soften is "the `node` binary is missing",
which would sink every other suite too. **The documented tolerance is
unreachable in practice.**

### Correction to the ticket: `os-sweep.mjs` does not import Playwright at all

The ticket says "a missing Playwright is an import error *inside* `os-sweep.mjs`".
It is not. `os-sweep.mjs:20-26` imports only `node:fs`, `node:path`, `node:url`,
`../lib/suite-runner.js`, `../lib/image-fixture.js`, `../lib/heavy-lock.js`,
`../lib/harness-leaks.js`. `grep -rn playwright tests/lib/*.js` → **0 hits**.

Playwright is imported **lazily, in the per-file CHILD processes**, at
`tests/browser/lib/os-harness.mjs:118` inside `launchBrowser()`:

```js
export async function launchBrowser(args = [...], opts = {}) {
    checkPlaywrightPin();
    const { chromium } = await import('playwright');
```

That laziness is deliberate and documented at `os-harness.mjs:11-14` ("Playwright
is imported LAZILY (inside launchBrowser) so this module … load[s] in plain Node
without the operator's separate `playwright` install").

The path is therefore: each spawned `os-*.mjs` throws at `launchBrowser` →
`suite-runner.js` records a nonzero-exit child as `FAIL` (`suite-runner.js:247-256`;
it has no skip-on-child-exit-code path at all) → `os-sweep.mjs:68`
`process.exit(r.failed ? 1 : 0)` exits **1** → `classify` returns `fail`.

The ticket's cited exit codes and its conclusion are right; only the location of
the import error is wrong. The conclusion stands: **reality is stricter than the
docs.**

### Where the doc claim actually lives

- `tests/run.js:37-38` — "`optional` suites (browser sweep) report a launch
  failure as a skip, not a hard fail — Playwright isn't installed in every clone."
- `CLAUDE.md:159-160` — "the browser `sweep` is optional (a missing-Playwright launch
  failure degrades to a skip, not a hard fail)." *(the ticket cited `CLAUDE.md:147`;
  that line has since drifted to the `--repeat N` paragraph — the real anchor is 159.)*
- `tests/run.js:369-375` cited in the ticket is likewise drift; the classifier is now
  at `:395-402` and its call site at `:382`.

### Heavy-lock ordering (the second question)

**The lock is taken FIRST, strictly before any Playwright import.**

`os-sweep.mjs:44` — `if (!opts.list) acquireHeavyLock({ name: 'browser os sweep' });`
— runs at module top level, before `preflight()` (`:53`), before
`ensurePrebakedImage()` (`:59`), and before `runSuite()` (`:61`) spawns any child.
Playwright is only touched much later, in a child, at `os-harness.mjs:118`.
`heavy-lock.js:87` is the `process.exit(3)` on a lost lock.

Consequence: **while another heavy lane holds the lock, the induction experiment
cannot reproduce the bug — it exits 3 at `os-sweep.mjs:44` and never reaches a
child, and `classify` reports that exit 3 as `fail` too** (same second branch,
which is itself worth noting: an exit-3 lock-loss is *also* misreported as a suite
failure by `tests/run.js`).

### The induction command, NOT run here

```sh
# from a clean worktree, with NO other heavy lane running:
mv node_modules/playwright /tmp/pw-hidden          # and tests/browser/node_modules/playwright if present
node tests/run.js sweep ; echo "run.js exit=$?"    # expect: sweep FAIL, exit 1 — not skip
mv /tmp/pw-hidden node_modules/playwright
```
It would prove empirically what the read above proves statically. It is a full
heavy run (real Chromium per file for the non-hidden case; with Playwright hidden
every file dies fast, so it is cheap — but it still takes the heavy lock and still
bakes the image at `os-sweep.mjs:59`).

### Recommendation for the (a)/(b) decision — for the ticket owner, not decided here

(b) — make the code match the docs — is the better shape, and is *more* than a
comment edit: the honest fix classifies **exit 3 (lock lost)** and **a
Playwright-absent run** distinctly from a product failure. Today both read as
"the OS is broken". Note that (b) cannot be done in `classify` alone: the sweep's
exit code is generic, so `os-sweep.mjs`/`suite-runner.js` would need to surface a
distinguishable code (e.g. exit 4 = environment-missing) for `run.js` to map to
`skip`. That is why this is not a one-line change and should not be filed as one.
