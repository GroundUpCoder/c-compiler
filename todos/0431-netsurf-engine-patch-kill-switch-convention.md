# 0431 — 0419/0420 engine patches ship no -DNETSURF_NO_* kill switch or A/B baseline leg

- **Status**: open
- **Design**: —

## Goal

Restore the **kill-switch convention** to the NetSurf engine patches landed by `0419` + `0420`
(merged in `a865e5a1`), so that the most invasive layer of our engine patch series can still be
diffed against pristine upstream behaviour **at runtime**.

## Where this came from

jku raised a vendoring-policy concern directly (meta-meta thread `019fad36`, 2026-07-29): *"why have
we edited raw NetSurf code? Why did we not only make external additions, or just patch at the
interface with the OS?"*, naming commit `a865e5a1`.

The answer on the substance was **the patches are justified** — `node_is_hover` was a
`\todo Support hovering` stub inside a file-scope `static css_select_handler`
(`content/handlers/css/select.c:97`), and the cancelled-click fix is four lines in the tail of
`html_mouse_action`. No embedder seam reaches either, so neither could have been external.

But the scoping pass found a real, **unfiled** gap while checking, and this ticket is it.

## The gap — measured, not hypothetical

The established convention on this patch series is that an engine patch ships **both**:

1. a **`-DNETSURF_NO_*` build-time kill switch** that restores pristine upstream behaviour, and
2. an **A/B baseline leg in `tests/browser/smoke-js.mjs`** that actually builds with the switch on.

Both prior engine lanes honour it:

- lane B ships `-DNETSURF_NO_LIVE_RECONVERT` with baseline **leg 8**;
- lane C ships `-DNETSURF_NO_UI_EVENTS` with baseline **leg 11**.

**0419/0420 ship neither.** Verified by grepping `interaction.c`, `select.c` and `box_construct.c` —
there is no such switch. ⇒ **The newest and most invasive layer is the only one you can no longer
diff against upstream behaviour at runtime**, which is precisely the property the convention exists
to preserve.

## Relationship to `todos/0423` — SIBLINGS, NOT DUPLICATES

Both came out of the same review, and they are different failures:

- **`0423`** — the **patch record** is authoritative but **nothing checks it**. `update.sh` step 6 is
  `rm -rf` + `cp -R`, so committed-tree drift from `patches/` is **silently destroyed, not
  reported**. (Drift window measured: 0407 landed source in `1a0909c4`/`436a024b` and the patch
  record caught up two commits later *because a person remembered*.) That is about **static** record
  integrity.
- **This ticket** — a landed, correctly-recorded patch that you **cannot A/B against upstream at
  runtime**. That is about **behavioural** falsifiability.

0423 does not cover this and this does not cover 0423. Neither blocks the other.

## Plan

1. **Re-derive the convention from the two lanes that follow it** before writing anything — read how
   `-DNETSURF_NO_LIVE_RECONVERT` and `-DNETSURF_NO_UI_EVENTS` are threaded through the build and how
   `smoke-js.mjs` legs 8 and 11 consume them. Match that shape exactly; do not invent a third
   spelling.
2. Add the switch(es) covering 0419 (cancelled click, `interaction.c`) and 0420 (`:hover`/`:active`,
   `select.c` + `box_construct.c`). Decide and **record in the Design line** whether this is one
   combined switch or two — they were one merge but they are two independent behaviours, and the
   convention is per-behaviour.
3. Add the corresponding A/B baseline leg(s) to `tests/browser/smoke-js.mjs`, following legs 8/11.
4. Update `vendor/netsurf/README.md`'s patch table so the switch is recorded alongside the hunks.
5. **Check whether any OTHER landed engine patch is missing its switch.** Two lanes honoured the
   convention and one did not; that is a sample, not a survey. If the sweep is clean, say so
   explicitly in the close-out — a stated "I checked all of them and found one" is the deliverable,
   not a silent fix of the one already known.

## Acceptance

- Every engine-behaviour patch in the series has a `-DNETSURF_NO_*` switch and a `smoke-js.mjs`
  baseline leg, or the ticket states in writing which ones do not and why.
- Building with the new switch(es) restores pristine upstream behaviour, demonstrated by the new
  baseline leg(s) passing.
- `vendor/netsurf/README.md`'s patch table records the switch(es).
- The survey in Plan (5) is reported with a **number**, not an impression.
- Full kernel suite green, full browser sweep green, **artifact tallied** (`recorded == total` is
  not enough — tally `results[].status`; if `carried > 0` / `runs > 1` / a `filter` is set, report
  the **first full run's** numbers). `node tests/todos/run.js` 5/5.
- ⚠️ A full browser sweep rewrites 3 tracked `logs/` PNGs and drops 1 untracked one. **Restore them.**
