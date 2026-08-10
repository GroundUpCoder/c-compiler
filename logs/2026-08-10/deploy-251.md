# gucOS ship v251 — deployed 2026-08-10

**Live:** `groundupcoder.com` serves c-compiler **`bd3caef0`**, `os/image.json` **251**,
`imgSha256 f20de279660d9573…`, `mode: full`, alias `https://c872abab.comguc.pages.dev`.
Previous production was `5c64bc50` / v244 (2026-08-08T05:11:53Z).

## Why we shipped

Both auto-ship cadence legs were blown: **~49 h elapsed** and **92 commits** in
`5c64bc50..af2c9607`. The batch is `epic:pkgdev` work — the current exclusive P0.

The ship baseline is worth writing down because two sessions failed to find it: **both instruments
live outside this repo.** The ledger is `~/git/comguc/deploys/log.jsonl`; the live edge is
`https://groundupcoder.com` (`/build-info.json` + `/os/image.json`). Every `git ls-files` search
inside c-compiler was structurally doomed. (`groundupcoder.**net**` is not the edge — an earlier
guess whose null was never positive-controlled.)

## What blocked it, and what the delay actually bought

The pre-deploy full sweep at `af2c9607` came back **RED on exactly one leg**:
`tests/kernel/test_http_e2e.js`, `#392 __http_error: empty while healthy` — expected `pre=0
prenul=1`, got `pre=51 prenul=0`.

The feature was **sound**; the test was **racy**. `kernel.js:7568` `OP.HTTP_ERROR` answers from
`eo.xfer.error` resolved through `pcb.fds` → `_ofds` **per-fd**, and `xfer.error` is written only in
that transfer's own rejection handler — no cross-fd leak. The *test* opened an fd against a
**refused** port and peeked immediately, calling that window "healthy". It only means "the rejection
has not landed yet". On localhost the refusal is near-instant: it filled `errtext` with
`fetch failed (connect ECONNREFUSED 127.0.0.1:<port>)` — **51 bytes**, exactly the observed `pre`.

**The fix (`bd3caef0`, test-only, one file, +13/−5):** the healthy peek moves onto an fd against
`/never`, which the harness answers with a bare `return` — headers never sent — and the call arms no
deadline (`hdrs_ms=0, idle_ms=0`). The transfer therefore *provably* cannot have settled at peek
time. The refused-port fd keeps the failure-text and NUL-termination legs; the printed fields and
assertion string are unchanged, so the contract is preserved rather than weakened.

**Why this was not waved through as a known flake.** jku's 2026-08-08 ruling permits merging on an
*attributed pre-existing* flake. This leg was **added by #392 itself** (`580b14b5`) — self-introduced
by the very batch being shipped. The ruling does not reach it.

## The measurement that made it conclusive

`tests/run.js --under-load[=N]` (todos/0147) already existed and was not being used. One kernel file
runs in ~3.4 s, so this cost about two minutes:

| condition | pass rate | flake |
|---|---|---|
| pre-fix, standalone `--repeat 20` | 19/20 | 5% |
| **pre-fix, `--repeat 50 --under-load` ×10** | **22/50** | **56%** |
| **post-fix, `--repeat 50 --under-load` ×10** | **50/50** | **0%** |

**An 11× amplification.** The middle row is the important one: it is the **positive control**. A 0%
reading is a null, and a null from an instrument nobody has proven can fire is worth nothing.
Reverting the single file and watching it go to 56% is what turned "the fix looks right" into "the
fix is proven".

It also matters that **the ship gate does not validate this fix** — it runs the leg once, so a 5%
flake passes it 95% of the time. The under-load run was the validation; the gate was the gate.

## Evidence FOR the full-gate rule

The targeted `--diff` tier greened this leg **twice** (`49166d9d`, `af2c9607`) and *could not* have
done otherwise: the race only loses under load, and a one-file targeted run has no load. Only the
full unfiltered sweep, with 26 suites contending, caught it. **A targeted gate is structurally blind
to this class of defect.** Filed as **#629** (adopt `--under-load` as the standing flake gate for new
timing-sensitive tests).

## The gate that shipped it

`node tests/run.js full` on the merged tip `bd3caef0` — the declared ship verb, which *refuses*
`--filter`/`--resume` so the coverage claim is structural rather than a promise.

`GATE_EXIT=0`, `tier=full`, `filter=null`, `omitted=[]`, **44.3 min**, 26 suites / 8 rows, all
`exit 0`. blockfs **15/15**, kernel **171/171**, sweep **59/59** — each `executed == recorded ==
total`, `resumed=0`, `evidence.resumedExistenceOnly=0`, `carried=0`; py 904P/0F/111S; host exit 0
(writes no artifact by design). The previously-red leg logged
`ok #392 __http_error: empty while healthy`. Evidence at
`build/EVIDENCE-shipgate-v251-run2/`; the earlier red is preserved at `build/EVIDENCE-shipgate-v251/`.

Before the run every stale `summary.json` was deleted, so `find build -name summary.json` outside
`EVIDENCE-*` returned nothing — a stronger guarantee than mtime-checking, because any artifact that
then exists is *provably* fresh. This mattered: the positive control had left 28 failures in
`build/test-kernel`.

## Deploy notes worth keeping

- **No `os/image.json` bump commit.** Bumps have been per-ticket since v241; a standalone bump would
  move the tree backwards and break the `VERSION_ID < image.json version` re-bake invariant.
- **No reseal.** The change was test-only and `os/os-system.img` was already sealed at 126 MiB with
  an mtime newer than every baked input.
- 🔴 **`pnpm test:split` performs a real packages-only build and leaves `dist/` stamped
  `mode: "packages-only"`.** Running it after the full build and then deploying would have written a
  ledger row mislabelling a genuine v244→v251 image release. **Re-run the full `build.mjs` after
  `test:split`, immediately before the deploy.** Caught here by reading `dist/build-info.json`
  rather than trusting step order.
- Verification was server-side at both ends, never from the deploy's stdout: the immutable
  `cfDeploymentUrl` alias, then the production origin. Production served the **stale v244** on the
  first read and converged to v251 moments later — the runbook documents this, so retry before
  calling a deploy failed.
- ⚠️ **A 403 from `urllib` is the instrument, not the world** — Cloudflare rejects the default
  Python User-Agent. `curl` returned 200 throughout. A bounded retry loop that reports 14 identical
  403s is measuring itself.
- Ledger row: `comguc` `4eb51c9a`, `packageIndexVerification: {status: verified}`.
- Cosmetic: the row records `cCompiler.branch = "lane-httpe2e-flake"` because the ship worktree sits
  on the merged lane branch. The commit `bd3caef0` equals `origin/main`, so provenance is exact;
  only the branch label reads oddly.
