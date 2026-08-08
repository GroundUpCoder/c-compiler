# #562 + #575 — the browser-sweep timing-flake pair: root causes and fixes

Two P0 flakes paired on one instrument (the browser sweep). They turned out to
be UNRELATED defects: #562 is a PRODUCT bug in the clipboard seam, #575 is a
TEST bug in a pixel probe. Both determinations are evidence-backed below.

## #562 — os-loopguard "AppInit-allowance leg": PRODUCT (clipboard seam)

**The loop guard was never racy.** The refused process named `splashcb` was
not running the splash program at all.

Reproduced at 80% (`--repeat 5 --under-load`, 1/5 pass, tree = origin/main
31fabde3). Instrumented `presentTo`/`setMainLive` in host.js with full stacks:

- Failing reps show "splashcb" issuing TWO `SDL_RenderPresent`s 0.2 ms apart,
  synchronously inside main — a spin loop, exactly what the guard exists to
  refuse.
- V8's wasm script hashes are content-derived: delayloop = `wasm/00014d82`,
  spinloop = `wasm/00014d3a`, "splashcb" = **`wasm/00014d3a`** — byte-identical
  to spinloop. `/root/splash.c` had received SPIN_C, not SPLASH_C.
- Seam probes then showed why: pbpaste's data CLIP_GET hit the kernel-worker's
  `CLIP_FRESH_MS` (300 ms) freshness-window skip — **no host `readText` at
  all** — and was served the slot from the PREVIOUS pbpaste's refresh. The
  three fixture pipelines run ~250 ms apart at Playwright speed, inside the
  window.

**The staleness fired in most runs, loaded or not.** In unloaded PASSING reps
the skip landed on pbpaste #2 instead: `spin.c` silently got DELAY_C, and the
leg still passed because both blocking shapes produce the identical refusal —
a partially vacuous green. Load only shifts WHICH inter-fixture gap falls
under 300 ms; when it is the #2→#3 boundary the observable flips (clean run
expected vs refusal) and the leg goes red. That is the 60% gate flake.

**Why this is a product defect, not a test-driving artifact.** The seam's own
contract (kernel-worker.js comment, test_hostclip_e2e's leg name) is "first
paste fresh by construction". The window exists so one consumer's
size-then-read pair (SDL_GetClipboardText, clipio — two CLIP_GETs ms apart)
costs one page round-trip. A pid-blind window ALSO handed one process's
refresh to a DIFFERENT process's first paste — with the host clipboard
rewritten in between, that first paste read superseded data. Agents driving
gucOS at robot cadence (a first-class use: wmctl, the agent tree) hit this.

**Fixes (product):**
- kernel.js: `onClipRead(done)` → `onClipRead(done, pid)` — the hook names the
  parked consumer.
- os/kernel-worker.js: the freshness window is scoped to the pids the last
  settle actually served (`clipFreshPids`); a consumer outside that set always
  takes its own round-trip. The todos/0398 D6 host-paste-files stamp stays
  fresh-for-ALL pids (`clipFreshPids = null`) — the staged fmt-2 slot is
  authoritative for whichever process the forwarded chord lands in.
- os/os.html: the clip-read handler now ALWAYS attempts `readText` instead of
  pre-skipping when transient activation lapsed. Activation is only needed to
  RAISE a permission prompt; under a granted permission the read succeeds
  without it, and under 'prompt' an activation-less read rejects quietly into
  the existing cached-slot fallback. This closes the same staleness under
  organic gate load, where a paste can reach its consumer >5 s after the
  triggering keystroke (spawn pipelines under contention).

**Regression pins:**
- tests/browser/os-clipboard.mjs: new #562 leg — two pbpastes from two
  processes around a host rewrite, `read`-gated so the second fires within the
  old window; asserts the round-trip probe (`__osClipRead`) AND the content.
  RED CONTROL verified: with only the product files reverted, both legs fail
  (`pw2` = the stale text, probe flat) while every pre-existing leg passes.
- tests/kernel/test_hostclip_e2e.js: pins that every deferred read carries the
  consumer pid.
- tests/browser/os-loopguard.mjs: each fixture compile now echoes
  `Z<n>=$(wc -c < src)` asserted against the pasted string's byte count
  (338/324/827, pairwise distinct) — a stale paste now fails AT THE FIXTURE
  STEP naming the real cause (todos/0171: make the failure point at its
  cause), never as a misattributed refusal.

Measured after fix: `--repeat 5 --under-load --filter=os-loopguard` → 5/5
(pre-fix same tree: 1/5).

## #575 — os-pollball "ball animates": TEST (probe geometry)

**The product was never at fault** — the ticket's own gate evidence shows the
same run measuring 67 presents/s (seq legs) while the probe saw nothing, and
`--repeat 5 --under-load` on the UNMODIFIED tree passed 5/5 here (the red is
not reproducible via the acceptance instrument; it is a low-probability
geometric miss).

The old probe sampled THREE FIXED POINTS every ~300 ms against a fixed
baseline. The 36×36 ball in a 320×240 field covers a given point ~2.2% of the
time; three points ≈ 6.7% per instantaneous sample, so a run misses motion
entirely with roughly (1−0.067)^40 ≈ 7% probability — worse when the near-
resonant trajectory (x period ≈ 4.06 s, y ≈ 3.71 s, ~12:11) parks the orbit
away from all three points for the whole window. A ~7%-per-run coin explains
one gate red among a history of passes, with no product change anywhere near
the compositor (the failing lane's diff was git-CLI/fakegit/run.py).

**Fix (test):** whole-client-rect frame differencing between consecutive
grabs, computed in-page. The ball moves ≥ ~33 px between samples (wall-clock
motion ≥110 px/s), repainting ~2400 px; a static frame differs in ZERO px.
Threshold 600 changed px. This is strictly STRONGER than the old probe: a
frozen screen (the one product failure the old probe could have been hiding —
compositor damage stall) now fails loudly with `maxChangedPx: 0` instead of
being indistinguishable from a sampling miss, and a real animation can never
be missed by phase luck. Bonus: under-load reps dropped from 61–369 s to
~14 s (the old probe burned dozens of slow triple-evaluate rounds waiting to
catch the ball; the new one trips on the first pair).

Measured after fix: `--repeat 5 --under-load --filter=os-pollball` → 5/5.

## Shared-cause check

The two tickets do NOT share a root cause (#562 product seam, #575 test
probe). What they share is the failure GRAMMAR that made both look like
"timing flakes in the member": an instrument observing a narrow slice of a
correct signal, red exactly when the slice misses. #562's deeper lesson is
nastier: its green runs were also wrong (fixture 2 mis-compiled, invisibly) —
the new byte-count asserts make fixture identity part of the record.
