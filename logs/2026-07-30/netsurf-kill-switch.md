# netsurf: kill switches for the pointer path (todos/0431)

The 0419/0420 engine patches landed without the `-DNETSURF_NO_*` convention.
This change restores it. The convention comes from lanes B and C: a switch
header under `include/netsurf/`, positive macros, gates at the choke points,
and a `smoke-js.mjs` baseline leg that builds the variant and requires the
pristine behaviour back.

## Decisions

**Two switches, not one.** The merge `a865e5a1` was one commit, but it
carried two independent behaviours. The convention is per-behaviour.
`-DNETSURF_NO_CLICK_CANCEL` covers the cancelled click (0419).
`-DNETSURF_NO_DYNAMIC_PSEUDO` covers `:hover` / `:active` (0420). Both live
in one new header, `include/netsurf/pointerpath.h`, because they are one
patch layer. The decision is on the ticket's Design line.

**Three gates restore pristine behaviour.** The click gate wraps the one
block that consumes the dispatch result (`interaction.c`). The pseudo-class
gates sit at the two chokes: `html_update_dynamic_chains` returns before it
tracks anything, and `node_is_hover` / `node_is_active` answer "no match"
the way the upstream stubs did. The rest of the 0420 machinery
(`box_restyle_element`, the chain walk, the teardown unrefs) then has no
live caller and no live state.

**One baseline wasm per switch.** Legs 15 and 16 each build their own
variant. A combined build would not prove that each switch builds and
changes behaviour alone. The `uievents.h` doc promises independence; the
legs now test it. Sizes: product 5256701 B, no-click-cancel 5256608 B,
no-dynamic-pseudo 5256736 B — all three differ, so the tautology guard
holds.

## Gotchas

**The monkey plot stream carries no colours.** `plot.c` prints geometry
only. A colour-flip `:hover` rule is invisible to the gate. The A/B page
(`test/ptr-hover.html`) therefore uses rules that change GEOMETRY: the
applied rule grows its subject by a known delta, and the leg reads the
plotted Y of a marker text below it. The in-OS
`test_netsurf_pointer_e2e.js` keeps the colour and ancestor-chain
assertions.

**A move onto a rule-free subject plots nothing.** The chain still changes
(empty → far/body/html), but no computed style changes, so the restyle
requests no repaint. The park step before the enter transition cannot wait
on a marker; it relies on stdin ordering instead.

**The A/B pages are test pages, not demos.** A demo folder buys the whole
demos contract: a landing-page link, an INTERACTIONS entry, a desktop seed,
a kernel e2e visit. The pages live under `vendor/netsurf/test/` (the
`squares.html` precedent) and stay out of the shipped set.

## The survey

The ticket asked for a survey, not a sample: 68 patch sections, 4
engine-behaviour layers (all 4 now switched), 2 runtime-switched features
(JS via `enable_javascript`, core select menu via `core_select_menu`), 7
upstream bug fixes with no switch by design, the rest porting or additive
plumbing. Zero unswitched engine-behaviour patches remain. The
classification with reasons is in the ticket
(`todos/0431-netsurf-engine-patch-kill-switch-convention.md`).

One structural point made the survey short: the lane B bridge funnels every
re-conversion through `html_schedule_reconvert`, which is the `#ifdef`
site. Later bridge amendments (0410's object-completion reformat, 0412's
select-menu anchor fix) are unreachable without the bridge, so they inherit
the switch instead of needing their own.
