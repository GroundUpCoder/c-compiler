# 0333 — `tools/bench2x2/` (and most of `tools/`) matches no rule in the diff planner

- **Status**: DONE (2026-07-28)
- **Found by**: router CHECK lane (cont-100), verified independently by @master cont-101

## Goal

Add a `RULES` entry in `tests/run.js` covering `tools/bench2x2/`, and decide
deliberately what the rest of `tools/` owes, so that a diff touching only a tools
directory cannot plan an empty gate.

## What is established

`RULES` in `tests/run.js:105` maps `tools/` only by two **exact-file** rules:

```
[/^tools\/mkpkg\.js$/,   ['kernel', 'host']]
[/^tools\/mkimage\.js$/, ['kernel', 'sweep']]
```

There is no general `^tools/` rule. So `tools/bench2x2/` — 17 files, added at
`c1b1f47c` — matches nothing, and a diff touching only that directory resolves to
**zero suites**.

**Precision, because it changes the severity:** this is **not silent**. `printDiffPlan`
(`tests/run.js:441-445`) prints a yellow `⚠ unmapped (no rule — not covered by this
plan)` block listing every unmapped path, followed by `→ add a rule to RULES in
tests/run.js, or run a suite by name.` So the planner reports the hole accurately. The
defect is that **nothing runs**, and a reader who takes "suites: (none)" as "no gate
owed" gets no enforcement — only a warning they may skip.

## Why it matters now

`todos/0332` is actively editing `tools/bench2x2/` — it re-runs the harness to validate
any dispatch fix. That is precisely the workload this hole exposes.

## Scope note — do not over-fix

`tools/` contains genuinely gate-irrelevant material (one-shot generators, demo
scripts) alongside load-bearing build tooling. A blanket `^tools/` → full-gate rule
would tax every unrelated tool edit. The right shape is probably a rule for the
harness/measurement directories plus an explicit decision (recorded in a comment) that
the remainder is intentionally unmapped — the same treatment `^os/ksvc` got, where a
comment says why the rule exists so a later split cannot orphan it.

## Acceptance

- `tools/bench2x2/` maps to at least one suite; a diff touching only it plans a
  non-empty gate.
- The decision for the rest of `tools/` is recorded as a comment in `RULES`, not left
  implicit.
- `node todos/queue.js check` and the `todos` suite stay green (4/4).

## Resolution

A `tools/` block in `RULES` (`tests/run.js`), with **no blanket `^tools/` rule** —
each remaining path states its own answer, including the ones whose answer is
`[]`:

| path | suites | why |
|---|---|---|
| `tools/bench2x2/` | `host` | every cell runs `node host.js <wasm>` standalone; that is the seam under the harness |
| `tools/mksounds.js` | `kernel, sweep` | generates the committed `os/sounds/*.wav` the sounds e2es assert |
| `tools/mkgif.js` | `kernel, sweep` | generates the committed `vendor/magicpoint/demo.gif` the present e2es assert |
| `tools/mkwebfixtures.js` | `kernel` | generates the committed NetSurf image fixtures `test_netsurf_content_e2e.js` decodes |
| `tools/build-libc-ext.js` | `ext, unit` | generates `libc-ext.js`; `ext` pins its contract, the unit `ext_*` tests consume it |
| `tools/{idlemeter,peek-repro}.mjs` | `sweep` | ride `tests/browser/lib/os-harness.mjs`, the `^tools/os-drive` precedent |
| `tools/{asm86,cfg,disasm,sample-wasm-filegen}/` | `[]` | self-contained side projects, own runners, no product artifact |

Two decisions worth naming, both recorded in the comment rather than left implicit:

- **bench2x2 does not pull `kernel`.** Its in-OS leg (`inos-startup.js`) drives
  `os/boot.js`, so `kernel` is arguably in the seam — but taxing a measurement
  harness with the heavy suite is exactly the over-fix this ticket warned about.
  Declined deliberately; a bench edit that wants it can name the suite.
- **The `[]` entries are rules, not silence.** An explicit `[]` suppresses the
  UNMAPPED warning *because a decision was made*; a NEW `tools/` path still
  reports UNMAPPED, which is the intended prompt to decide. That is why no
  catch-all was added.

Verified: a diff touching only `tools/bench2x2/analyze.js` planned `(nothing)`
before and `host` after; a probe touching one file per unmapped area listed 11
UNMAPPED paths before and 0 after.

## No liability register entry

The register scopes to gaps described by a **real comment in shipped code**. The
planner's unmapped warning is runtime output, not a source comment naming this gap, and
manufacturing a comment solely to create an anchor is explicitly declined here — the
same call made for `0329`, `0330`, `0331` and `0332`.
