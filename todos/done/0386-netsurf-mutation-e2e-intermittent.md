# 0386 — test_netsurf_mutation_e2e.js is intermittently RED (pixel comparison) and hangs uncapped when run bare

- **Status**: done (2026-07-29, branch `0386-netsurf-fix`)

## Resolution

**Verdict: M1 — a product defect.** NetSurf discarded keystrokes during a live
re-conversion. The design pass's discriminators ran on a quiet box and settled it off
FAILING runs, not green ones:

- **D2 forced trigger (the reproducing conditions, written down):** a 3000-element page
  with a 300 ms tick makes the re-conversion window span the whole tick period. Type
  `abcdef` at 250 ms cadence during the ticking. Pre-fix result: **52** ink pixels
  (chrome only — every key lost), immediate AND settled. The size control (no timer) and
  the period control (5 s) both read **285**. Only `size × ticking` moves the number.
  The trigger is committed in the test (arms T/T2/C1/C2) and reproduces on demand.
- **D1 on the forced arm:** settled == immediate == 52 — the keys never reached the
  model. Not paint lag.
- **D3 per-glyph ink table** (`a=39 b=51 c=23 d=51 e=36 f=33`): the historical
  `285−234=51` is `b` or `d` — an ascender, never the trailing `f` (33). This kills the
  competing sample-too-early mechanism (M2) outright: a late sample can only lose the
  LAST glyph.
- **D4 (20 ms cadence):** 285/285 — no paint-lag component at any cadence.
- **Value-level closure:** post-fix, two `textContent` mirrors of `input.value` are
  count-identical across all arms including the known-good control — the field holds
  exactly `abcdef`.

**The fix** is §4.2's general rule (one commit with the test reshape, `975582cd`+):
interaction state that routes input stays valid for the whole build-then-swap interval
and is re-bound at the swap. `html__reconvert` keeps a text gadget's focus;
`html_reconvert_box_done` snapshots the focused gadget's node AT the swap;
`box_textarea_create_textarea` carries the caret across widget recreation (else keys
insert at position 0 — `textarea_get_caret` defaults an unset caret);
`box_textarea_callback` tolerates the mid-window `gadget->box == NULL` state and records
a mid-window caret CLAIM so a click before the new box exists still lands (`todos/0402`,
fixed by the same change). Pre-fix the T2 arm (click mid-storm) read 52; post-fix 285.

**The tolerance went the narrow direction:** the `* 0.9` slack is deleted. Every gating
shot is SETTLED (the test pages' ticks are finite now) and asserts EXACT ink equality.
Un-settled shots print as diagnostics only.

**Filed, not folded:** `todos/0406` (the §4.3 `wmctl shot` crop / region-settle seam —
the other fix §4.4 wants), `todos/0407` (mid-window renders of a recreated widget use
the default 10pt fstyle until the swap reformat — the deterministic `204` the trigger
arms print, pre-existing, made visible by this fix), `todos/0408` (`HTMLElement.style`
is a disconnected stub, found by this ticket's probe work).

**Item 4 (the bare-invocation cap) is DEFERRED to `todos/0369`, explicitly.** The design
pass's §6 correction stands: this file's `driveBoot` calls ARE capped (420 s / 300 s);
what is missing is the PER-FILE cap when the runner is bypassed, and that is the same
class as 0369's bare-`spawnSync` survey findings. 0369 is open and owns it.
- **Design**: `todos/0386-netsurf-mutation-e2e-intermittent-design.md` (read-only diagnosis
  pass, 2026-07-28; no test was run). Decisions, one line each:
  - **The numbers are fully accounted for**: `285 = 52 chrome + 233 six-glyph ink`,
    `234 = 52 + 182 five-glyph ink` — one glyph worth **51 px** is missing; the `52` is
    `2 border columns × 26 scanned rows` and matches lane B's measured zero-keystroke reading.
  - **Mechanism (bet): keystroke loss during live re-conversion** — `html__reconvert` surrenders
    `focus_type` at teardown-start and only `html_reconvert_box_done` restores it, and
    `html_keypress` drops printable keys at `HTML_FOCUS_SELF`; the window is one gucOS event-loop
    iteration wide and a typed key wakes its 1 ms park *early*, into the unsafe drain.
  - **Competing mechanism kept alive**: the ticky leg's single un-settled `wmctl shot` may sample
    before the last repaint — the test as written cannot tell the two apart, which is itself a
    defect.
  - **Repeated integers explained** by the key cadence (`250 ms + a wmctl spawn`) approaching
    resonance with the 300 ms tick under load, so the same key sits at the same phase every run.
  - 🔴 **Controlled trigger**: D1 = one extra settled shot (separates the two mechanisms in one
    run); D2 = a ~3000-element ticking page widens the reconvert window to ≈ the whole tick
    period, with a no-timer and a 5000 ms-period control — forces the failure on a **quiet** box.
  - **Verdict: deterministic-able, NOT load-tolerant** — and the existing `* 0.9` slack already
    swallows a dropped small glyph silently, so the tolerance should **tighten**, not widen.
  - **Fix shape**: keep input-routing state valid across the whole build-then-swap interval and
    re-bind at the swap (general rule, not a keypress queue); plus a `wmctl shot` crop rect so a
    never-settling page can still be settled on **per region** — the reusable determinism seam.
  - **Image bump**: test-only outcome owes **none**; the netsurf fix or the `wmctl` crop each owe
    one (`/usr/bin/netsurf` and `wmctl` are baked; `os/image.json` is at 186).
  - **Item 4 correction**: this file's `driveBoot` calls *are* capped (420 s / 300 s); what is
    missing is the **per-file** cap — design it inside `0369`, per this ticket's own cross-ref.
  - **Second defect filed, not folded**: `todos/0402` (P0) — a click landing mid-re-conversion
    can leave `focus_owner.textarea` pointing into the `talloc_free`d old box tree.

## Goal

`tests/kernel/test_netsurf_mutation_e2e.js` has now failed **twice, in two different lanes'
kernel gates, on two different byte-sets**, and passes solo on re-run. Two sightings is the
filing threshold, so this is being tracked as a **real intermittent**, not a one-off.

Make the test either **deterministic** or **honestly load-tolerant** — and establish which of
the two it actually is before changing anything.

## Evidence (all first-hand, do not re-derive from summaries)

**Sighting 1** — cont-126's `0374` gate: failed on **ink pixels 285 vs 234**; green solo on
re-run.

**Sighting 2** — the `0376` lane's kernel gate, 2026-07-28, the **first ever full 125-file
run** (`runs` has 1 entry, filter null, `selected` 125 == `executed` 125, `carried` 0,
`done` true, `elapsedMs` 985271, `jobs` 2). Result **122 pass / 3 fail**:

| file | time | verdict |
|---|---|---|
| `test_mounts.js` | 47 ms | REAL — `0376`'s own EROFS→EBADF errno change, **not this ticket** |
| `test_rofs.js` | 39 ms | REAL — same defect as above, **not this ticket** |
| `test_netsurf_mutation_e2e.js` | 11104 ms | **this ticket** |

⭐ The 47 ms / 39 ms failures are what isolate this one: **a test that dies in 47 ms has no
timeout story** — it failed at an assertion instantly. Fast failures are not load flakes. The
netsurf failure is the only one of the three with a contention-shaped profile.

⚠️ **Both sightings were on a LOADED box** (`jobs 2`, other lanes live). That is a correlation,
not a cause — nobody has yet reproduced it under controlled load.

**Sighting 3** — the `0388` lane's kernel gate, 2026-07-28 ~08:27Z. Full 125-file run
(`runs` 1 entry, filter null, `selected`/`executed`/`recorded` all 125, `carried` 0, `jobs` 2,
`elapsedMs` 911100): **124 pass / 1 fail**, the single failure being this file at **10756 ms**.
Green solo on immediate re-run, same tree. That lane's diff is `tools/mkpkg.js` + package-test
isolation; `test_netsurf_mutation_e2e.js` contains **zero** references to `mkpkg`/
`dist/packages` (grep -c = 0), so it is causally untouched by that work.

🔴 **The failing assertion and its NUMBERS were byte-identical to sighting 1**:
`typing: a page re-boxing under the caret types just as well  static 285 vs ticking 234 ink
pixels`. Two independent lanes, two byte-sets, the **same two integers** — that is not the
signature of timing noise, which would scatter the counts. It points at a **bimodal
deterministic state** (one of two stable layouts/paint outcomes gets selected early), and
means the bug is likely reproducible under a controlled trigger rather than only under load.
⭐ Worth trying before any load-tolerance work: if the counts are always exactly 285/234, the
"ticking" path is probably losing one specific mutation, not rendering late.

**Third observation, 2026-07-28 ~05:20Z (master cont-128, off `ps`)** — the `0376` lane ran
this file **bare** (`node tests/kernel/test_netsurf_mutation_e2e.js`, no runner) to check
whether the failure reproduced. The process sat at **elapsed 3m21s, %CPU 0.0, STAT S** — ~18×
its 11 s in-gate time, asleep rather than spinning.
🔴 **A bare invocation carries NO cap at any layer** — the kernel runner's timeout table is
what bounds this test, and invoking the file directly bypasses it entirely. So a hang here is
*silent and unbounded*, and it stalled a live lane's turn.
⚠️ **Followed up — IT WAS NOT A HANG.** The process **exited on its own** a few minutes later
(observed gone; the lane then pushed its next commit and re-took the heavy lock). So the
correct reading is **very slow, not stuck**: roughly 20–30× its 11 s in-gate time when run
bare on a box that had just been under load. 🔴 **Do not open this ticket by hunting a
deadlock** — chase the slowness and the pixel nondeterminism. The uncapped-bare-invocation
point in item 4 stands on its own merits regardless.

**Sighting 4** — the `0397` lane's kernel gate, 2026-07-28 21:50Z. Full 128-file run
(`runs` 1 entry, filter null, `total`/`selected`/`executed`/`recorded` all 128, `resumed` 0,
`carried` 0, `jobs` 2, `elapsedMs` 997301): **127 pass / 1 fail**, the single failure being
this file at **10.9 s**. Green solo on immediate re-run, same tree. That lane's diff is
`os/clip.c` + `os/clipio.h` + `os/pbcopy.c` + `os/pbpaste.c` + `os/image.json` +
`tests/kernel/`, so it is causally untouched by that work.

🔴 **The numbers were byte-identical AGAIN**: `static 285 vs ticking 234 ink pixels`. Three
independent lanes now, three diffs, the **same two integers**. This is the third confirmation
of the bimodal reading above, and it retires the "timing noise" hypothesis: noise scatters
counts, and these do not scatter.

⚠️ This sighting adds a data point the earlier ones lack. The same lane ran
`tests/flake.js` immediately after, and the whole tripwire set — plus its own new file —
came back **0% flake over 3 runs each under load ×10**. So the box was capable of stable
repeats at the time. The trigger is therefore narrower than "a loaded box".

## Plan

1. **Reproduce deliberately** — run it under synthetic load (the box has a heavy-lock story;
   `jobs 2` is the observed condition) until it fails. **A green solo run proves nothing** and
   must not be accepted as a fix.
2. **Classify the failure.** Is the ink-pixel delta (285 vs 234) a *partial render* the
   assertion sampled too early — i.e. a missing wait/settle — or genuinely nondeterministic
   rasterisation? These need opposite fixes. Answer this before touching the assertion.
3. 🔴 **Do NOT "fix" it by widening the pixel tolerance until step 2 says the variance is
   legitimate.** Loosening a threshold to silence an early-sample bug destroys the signal the
   test exists for.
4. **Separately, close the bare-invocation gap**: a kernel test run directly should still be
   bounded, or the runner should be the only sanctioned entry point and say so loudly.

## Acceptance

- The failure has been **reproduced under stated conditions**, with the conditions written
  down — not merely observed twice in the wild.
- Step 2's classification is recorded with evidence (which of partial-render vs true
  nondeterminism), and the fix matches that classification.
- A **flake gate**: N consecutive runs under the reproducing load, N stated and justified.
  Bare re-runs on a quiet box do not satisfy this.
- The bare-invocation cap gap is either closed or explicitly deferred to a named ticket.

## Relationship to 0369 — cross-reference, DO NOT FOLD

`0369` (harness fixed timeouts under contention) is about **fixed timeout caps**. This test
fails on **pixel comparison**, not on a cap — folding it into `0369` would mis-file it.

But `0369`'s step-2 static survey (branch `0369-timeout-survey` @ `e9164c06`) is directly
relevant to the *third* observation above: it found that several runners are **bare
`spawnSync` with no cap at any layer** (`tests/run.js`, `tests/host/run.js`,
`tests/todos/run.js`), and that `run.py` **crashes with a traceback and emits no summary** on
timeout in its handler-less categories. Read that survey before designing item 4.
