# Deploy — gucOS v244 (2026-08-08)

**Live at `https://groundupcoder.com` as of 2026-08-08T05:11:53Z (14:11:53 KST).**

| field | value |
|---|---|
| c-compiler commit | `5c64bc5071666b87077c70df5bfd864364d9adc3` |
| image | `os-system.15c03d254b2e3e92.img` (122,838,810 bytes) |
| imgSha256 | `15c03d254b2e3e92de9d3d5d584e16f3105b51120829b542c51bbf394febc700` |
| comguc commit | `6d04fa1ecb8b507b7852ff851ffb607c10ff83be` |
| clang packages | `true` |
| cfDeploymentUrl | `https://bc86b804.comguc.pages.dev` |
| previous live | v241 / `9708d889` / `os-system.bb6b26e1526e2b5a.img` (2026-08-06T08:31:30Z, ~53.7 h earlier) |
| batch | `9708d889..5c64bc50` — **77 commits** |

## 🔴 `os/image.json` IS the ship counter, and this ship resets it

The tree walked **241 → 242 → 243 → 244** *before* this deploy, because each image-touching ticket
bumps the version inside its own commit (`#551` → 242, `#330` → 243, `#395` → 244; read out of each
blob, not inferred). **There was therefore NO dedicated bump commit for this ship, and there must not
be one** — authoring one would have moved the tree backwards and broken the
`VERSION_ID < image.json version` re-bake invariant.

⚠️ Note for future ships: the *older* convention IS visible in the same log — `343ab9e4`
("batch-k: image v241") is a dedicated bump commit. The convention CHANGED to per-ticket bumps. A
brief that says "bump the version before shipping" is reasoning from the pre-241 shape and is wrong.

## Gate

Full gate `node tests/run.js all` in an isolated worktree at `5c64bc50`, pristine tree.
`GATE_EXIT=0`, elapsed **3121655 ms (52.0 min)**, `filter` null, `resume` null.

| suite | done | executed / selected / total |
|---|---|---|
| blockfs | true | 15 / 15 / 15 |
| kernel | true | **169 / 169 / 169** |
| sweep (browser) | true | 58 / 58 / 58 |

All 8 top-level rows `status: "pass"`, `exit: 0`. Final: `8 passed, 0 failed (3121.7s)`.

### Two numbers that did not match expectation, both RESOLVED rather than waved
- **Sweep 58, not 59.** `os-sweep.mjs` excludes *itself* from its own membership — the discovery
  filter is `f !== 'os-sweep.mjs'`, and the evidence allowlist names it with owner *"the runner
  itself"*. **58 is full membership.**
- **113 skips in the py suite.** Documented capability gates (e.g. `projects/cpython-clang`, gated on
  `todos/0327` `__extension__` and `todos/0336` startup cost). Suite exits 0 and every FILE-level
  completeness check passes. ⚠️ **Honest gap: no prior gate log was preserved, so the count could not
  be proven unchanged.** A gate should carry its own pass/fail/skip tally forward so a skip
  *regression* is detectable — worth a ticket.

Every `FAIL` string in the log sits inside an `ok e2e:` assertion (patchcheck negative controls) or
is one of the two deliberate `record fixture: 3 passed, 1 failed` RED-EVIDENCE sentinels.

## 🔴 This was the SECOND gate. The first was invalid and looked fine.

The first attempt's lane ended its turn ~11 min into the run, reasoning that harness tracked-task
adoption meant the process survived independently. The parent did survive (reparented to PPID 1) —
but its in-flight **grandchildren took the turn-end SIGINT**. The kernel suite died at
`done:false, executed 23 of 169`, with **zero failures**, and `run.js` moved to the next suite 0.15 s
later. Left alone it would have produced a plausible green summary ~50 min later, silently missing
146 kernel files.

**Therefore the first check on any gate artifact is COMPLETENESS, not pass-rate:** per suite,
`done == true` **and** `files.executed == files.selected == files.total`. An all-passing 23/169 is a
FAILED gate. Forensics preserved at `build/EVIDENCE-cont539-v244/`; this run's at
`build/EVIDENCE-shipgate2-v244/`.

## Capacity event during the ship

Deploy attempt 1 died seconds after spawn with `alreadyIdle:true`. `assistant.errors[]` gave the real
cause: **`"You've hit your weekly limit · resets Aug 12 at 3pm (Asia/Seoul)"`** — the account
`josephkimpublic`, which is the **gucos project's default**. Until Aug 12, gucos lanes must be
spawned with an explicit `--account`. Attempt 2 ran on `josephkimgpt` and succeeded.

## Verified at the edge (not from push output)

- `curl https://groundupcoder.com/build-info.json` → commit `5c64bc50`, image
  `os-system.15c03d254b2e3e92.img`
- `curl https://groundupcoder.com/os/image.json` → **version 244** (was 241)
- new ledger line in `~/git/comguc/deploys/log.jsonl`

⚠️ The first `build-info.json` fetch still served the OLD build; `cf-cache-status: DYNAMIC`,
`cache-control: max-age=0, must-revalidate`. A cache-busted retry and a plain retry both returned the
new build. **Do not call a deploy failed on a single stale edge read — retry before concluding.**
`os/image.json` flipped to 244 immediately, so the two endpoints disagreed for ~1 minute.

## Also landed after the ship

`#576` **Batch 1.5** (`lane-576b15` → `main`): the gate-membership guard. Merged as `7c065084` with a
real merge commit — `--ff-only` was NOT valid, main had moved 1 commit (`5c64bc50`, the Batch 1 dev
log amendment) past the lane's base `de2aae1b`. The guard was re-run **on the merged tree** (green,
26 suites) because its original verification was at `030b109f`, pre-merge. `#576` stays OPEN —
Batches 2 and 3 remain.
