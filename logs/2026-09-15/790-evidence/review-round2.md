# #790 independent implementation review — round 2 (re-review of the counter-pass)

Reviewer: claude-fable-5-1 (independent thread; Codex reviewer lane capped until 2026-09-19 21:30, switch disclosed). Author: coordinator thread 01a0a417-6825-79e9-abd3-bcd59dbbd86d. Reviewed the DIFF (d5a04892..229f8418, one commit, plus everything it touches re-read at the tip), not the self-report. Product code untouched by me; probes ran in my scratch worktree ~/git/c-compiler-review-790 detached at 229f8418. Also written to /tmp/790-review-round2.md.

## VERDICT: APPROVE — exact range 7799eb32..229f8418 (branch author/790-frame-identity; commits adcdfda2, d5a04892, 229f8418)

Every round-1 finding is answered in the diff, the fixes are the right shape, and the tests that pin them are real (each new leg has a way to fail, the compositor red control reproduces the exact d5a04892 algorithm inline and fails it). Any commit after 229f8418 voids this approval; the mapped gate must run on this exact tip.

## FINDINGS (round-1 disposition + what is left)

1. **BLOCK (compositor bound a never-uploaded texture on contention) — FIXED, verified.** `os/compositor.js` `makeShmUploader` (lines 92-152 at the tip): the identity check comes first, then a bounded try-lock (`SHM_TRY_SPIN` = 4096 CAS, no wait); on contention `if (c) return c.bind` keeps the previous uploaded texture whatever its gen/size, the retry flag is set, and NOTHING is created or destroyed; only a surface with no cache entry at all gets a fresh empty texture (honest — there is no previous frame). A stale entry is replaced only after `upload(n, surf)` succeeds and the old texture is destroyed only then. Copy under the lock, lock released before `writeTexture`, seq re-read under the lock. Wiring checked: `shmUploader` is built at line 645 BEFORE `initGpuState()` at 647 (whose `shmCache.clear()` at 247 therefore sees the live Map), the destroyed-surface prune at 911-919 destroys `v.tex` on the same Map, and `getDevice` reads the live `device` variable that #551 recovery reassigns at 277. `tests/host/test_compositor_shm.js`: 18/18 here; the red control re-implements the d5a04892 destroy-create-then-trylock order and asserts the bound texture has zero writes and the old one was destroyed — that is the defect, seen by the instrument. `tests/run.js` maps `os/compositor.js` to `sweep, host` (dry-run confirmed); `test_diff_rules` 101/101.
2. **major (WM.md cited a missing dev log) — FIXED.** `logs/2026-09-15/790-frame-identity.md` exists at the tip with before/after, mechanisms, tests, and the round-1 record; the cite resolves.
3. **minor (two error shapes for a stale ack) — FIXED, verified.** `kernel.js` SURFACE_CONFIGURE: `cidx < 0 || cser <= committedSerial` → ESTALE + counted, checked BEFORE the decline branch and BEFORE the SAB shape; EINVAL only for `!sc`/foreign pid/serial ≤ 0/malformed SAB. Legs flipped two-sided (test_wm_frames B/C/F, test_wm.js "nothing pending" → ESTALE). `!sc.pendingConfigure` dropped from the EINVAL test is safe: issued non-empty ⇔ pending non-null (the storm invariant pins it).
4. **minor (gpu frame size rejection was a behaviour change) — FIXED, verified.** `_wmFrame` rejects on `serial < committedSerial` only; WM.md states size is not an identity and why; test_wm_frames H accepts an other-size frame for the committed serial; `os-gpubox.mjs` gained the `framesRejected === 0` check. I did NOT run os-gpubox (heavy lock); the mapped gate's sweep will.
5. **minor (under-load claim not in the record) — FIXED, verified.** `suite-runner.js` exports `CC_UNDER_LOAD` from its real `opts.underLoad` field (lines 105-131, 327); `os-ui-frames.mjs` records `evidence.underLoad`. The author's evidence at 229f8418 (read-only): ui-frames-1789513757277 (underLoad 0) and -815761/-824270/-833851 (underLoad 10) — all four PASS, both drivers, every phase exactly w*h px / 0 stale, all probe deltas 0 including the new `shmFlipMisses`.
6. **minor (host flip misses unobservable) — FIXED, verified.** `SH_PMISS` header word 8 bumped by `wmShmFlip` on a miss; layout guard extended (`shPmiss`) both sides; per-surface `flipMisses` in wmList/GET_STATE, `shmFlipMisses()` summed into compositor-stats; browser test asserts the delta is 0 per driver; host test asserts the header word.
7. **nit (re-issue EAGAIN) — FIXED, verified.** On an undeliverable superseded re-issue the outstanding set retires, pending clears, `EV_CONFIGURE_DECLINED` names the lost target; test_wm_frames F floods the ring (`ring.cap + 4` key injections) and pins pending 0 / outstanding 0 / the event / ESTALE afterwards. WM.md states it.
8. **nit (`_bumpWm` on decline) — FIXED.** Removed, comment says why.
9. **nit (`beginConfigure` pre-0019 return) — FIXED.** Returns `true`.
10. **nit (shipper note) — recorded** in the dev log item 10.

New, non-blocking:

- **nit — the dev log heading says "Tests and evidence (`790-evidence/`)" but no `logs/2026-09-15/790-evidence/` exists at the tip** (`git ls-tree 229f8418 logs/2026-09-15/` shows only the .md). The previous phase committed `794-evidence/`; the browser evidence.json (with the sha256 identities the Acceptance asks for) currently lives only in the gitignored `build/test-browser/ui-frames-*/`. Either commit the four 229f8418 evidence.json files under `790-evidence/` when you append the gate record, or fix the heading. Not a merge blocker; can land with the gate-record commit (docs are exempt from re-review).
- **nit — the log ends with "Re-review ... recorded below"** and nothing is below yet; expected to be appended with the gate record.

## Verified clean at the tip (beyond the round-1 list)

- ESTALE-before-SAB ordering means a stale ack with a bad SAB is ESTALE, not EINVAL — one shape, as intended; the host treats both the same and now counts every stale.
- The EAGAIN-retire path leaves `committedSerial` = the just-accepted serial and clears `issued`, so `_wmIssueConfigure`'s next mint continues monotonic; no serial reuse.
- `shmFlipMisses()` sums live surfaces only, so the browser delta could go negative if a surface with misses dies mid-run — that would fail the `!== 0` check loudly, which is the right direction.
- No UNMAPPED paths in `node tests/run.js --diff 7799eb32 --dry-run`.

## COMMANDS RUN (in ~/git/c-compiler-review-790 at 229f8418 unless noted)

- `git fetch -q && git log --oneline d5a04892..229f8418 && git diff d5a04892 229f8418 --stat` (main checkout) — 1 commit, 15 files, +572/-89; full delta read (kernel.js, host.js, os/compositor.js, os/kernel-worker.js, tests, tests/run.js, suite-runner.js, WM.md, the new log).
- `git checkout -q --detach 229f8418` in the review worktree.
- `node tests/host/test_compositor_shm.js` — exit 0, 18 ok.
- `node tests/host/test_surface_configure.js` — exit 0, 26 ok.
- `node tests/host/test_diff_rules.js` — exit 0, 101 ok.
- `node tests/host/test_gpu_present_clamp.js` — exit 0, 29 ok (+PASS banner).
- `node tests/host/test_sdl_api_index.js` — exit 0, 10 ok.
- `node tests/kernel/test_wm_frames.js` — exit 0, 73 ok.
- `node tests/kernel/test_wm.js` — exit 0, 171 ok.
- `node tests/kernel/test_wm_policy.js` — exit 0, 247 ok.
- `node tests/kernel/test_wm_anchored.js` — exit 0, 73 ok (+banner).
- `node tests/kernel/test_shm_ownership.js` — exit 0, 6 ok (0 torn in 400 locked reads, 0 misses both sides; red control tore on its first read, 38 frames).
- `node tests/kernel/test_wm_owned.js` — exit 0, 67 ok (+banner).
- `node tests/kernel/test_wm_lifecycle.js` — exit 0, 44 ok (+banner).
- `node tests/run.js --diff 7799eb32 --dry-run` — `os/compositor.js → sweep, host`, `test_compositor_shm.js → host`, no UNMAPPED.
- greps/reads at the tip: `shmCache`/`device =`/`initGpuState()` sites in compositor.js; `underLoad` in suite-runner.js; `git ls-tree 229f8418 logs/2026-09-15/`.
- Read-only: `~/git/c-compiler-790/build/test-browser/ui-frames-17895137*/evidence.json` (4 runs at 229f8418, summarized above). Kernel suite and browser sweep NOT run (heavy lock), per instruction.
