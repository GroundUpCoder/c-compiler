# #158 (0384) — SysListView32 horizontal scroll, and gap #31's five silences

Report view scrolled vertically through a real embedded SCROLLBAR child but
had no horizontal scroll at all. Past the summed column widths the trailing
columns clipped at the right edge — nothing corrupted, just unreachable, and
reachable-only-by-not-resizing is not a report view. The ticket also folds in
**gap #31** of the win32 UI gap inventory (per @master's ruling, not re-filed):
listview.c's small silences.

## The one design call: the header does NOT move

The ticket's Plan says the header "must scroll in lockstep — Windows does this
by making the header wider than the client and moving it left". That is what
Windows does, and it is what I did **not** do. Here it is not a divergence, it
is a cliff:

- A child DC in this veneer is a **span of the top-level surface**
  (`user32.c` `hwnd_span_dc`). If a child's absolute origin goes negative the
  function returns the 1×1 scratch DC. So the header would simply **vanish**
  the moment `xoff` passed the control's own inset — silently, mid-scroll.
- Before that point it would be worse than useless: a child is clipped to the
  **surface**, not to its parent, so a header hanging left of the listview
  would paint over the parent's background beside the control.

So the origin lives *inside* the header (`hd_scroll_to`) and the window stays
put. The pixels are the same, the header's own client rect does the clipping
by construction, and the two x spaces are named where they meet
(`hd_content_x`: content x measures from segment 0, client x is what the
pointer and the paint speak). Divider drags convert at entry, which is why
`158 divider drag is origin-aware` exists as its own leg — the drag arithmetic
is the one place the conversion is easy to forget and impossible to see.

Fixing `hwnd_span_dc` to clip children against their parent would be the other
answer. That is a user32 change with every control in the corpus downstream of
it, and nothing else needs it today; it belongs in its own ticket if a second
customer appears.

## Both bars are one fixpoint, not two decisions

Each bar steals from the other's axis: the vertical one narrows the view (which
can *create* the horizontal need) and the horizontal one shortens the row band
(which can create the vertical need). Deciding them independently is wrong in
both directions, and deciding them in sequence is wrong in one. `lv_bars` runs
the two-pass fixpoint — two passes suffice because a bar can only ever appear
*because* the other one did — and **everything** that needs the view rectangle
goes through it (`lv_view_w`, `lv_vis_rows`). That is the invariant to keep: no
second place may guess at the view width.

The corner the two bars leave is filled with the 3D face and is not a control.
`158 the two bars leave a dead corner` is a `GetPixel` probe, and its red
control (drop the fill) turns it white — the two states are visibly distinct,
which is the only reason the leg is worth having.

## Gap #31, item by item

- **LVS_SHOWSELALWAYS unread** — now read. Unfocused, a plain listview hides
  its selection; with the style it draws in the inactive 3D face. Only pixels
  move: `LVM_GETITEMSTATE`, the `"> "` agent marker and the tree `sel` flag are
  untouched, and there is a leg for each of those saying so. `user32.c`'s class
  style audit went `0x0007` → `0x000F` in the same commit — that table is the
  #317 structural fix, and leaving it behind would keep reporting a bit that is
  now read.
- **LVCF_SUBITEM unread** — stored, round-tripped, and **honoured** at render,
  join and hit-test time. The slot invariant is written out at `lv_col_insert`:
  a column insert/delete splices one subitem slot, so a mapping that names a
  slot moves with it, and a mapping that pointed *at* a deleted slot
  re-identifies to its own column index. That is the only total answer, and it
  is what the identity default would have said anyway.
- **fmt bits masked `& 3`** — the mask was not a formatting choice, it was data
  loss in both directions: the whole `LVCFMT_*` word was being stuffed into
  `HDITEM.fmt`, where it aliases the `HDF_*` bits, so anything wider than the
  justification bits was destroyed going in and could not come back out. The
  word now lives per-column in `LvCol`; only the justification bits cross into
  the header, and a bit nothing draws reports once.
- **NM_RETURN never sent, unrecognized keys eaten** — `LVN_KEYDOWN` for every
  key, `VK_RETURN` raises `NM_RETURN`, and an unhandled key falls through to
  `DefWindowProc` instead of `return 0`. `VK_LEFT`/`VK_RIGHT` are now the
  report view's horizontal scroll, which is both the real behaviour and the
  reason those keys stopped being "unrecognized".
- **LVHT_ONITEMLABEL never set — REFUTED.** The red control would not go red.
  `LVHT_ONITEM` is *defined* as `(ONITEMICON | ONITEMLABEL | ONITEMSTATEICON)`
  = `0x000E`, so a caller testing the sub-flag has always read true. The gap
  report read the source literally (the identifier never appears) and inferred
  a behaviour that was never absent. The explicit OR stays as documentation of
  that; the assertion I had written was deleted, because a green leg that
  cannot fail is anti-evidence. **This is a correction to the inventory, not a
  fix.**

## Four messages added, because the feature is otherwise unusable

`LVM_SCROLL` (the programmatic scroll), `LVM_GETITEMRECT`,
`LVM_GETSUBITEMRECT` and `HDM_GETITEMRECT` (the only way an app — or a test —
can learn where a row or a column *landed* once the view scrolls). All four are
real Win32, all four were in the fail-loud demand log, and without them
"columns are reachable" is unobservable from outside the control.
`LVM_GETSUBITEMRECT` keeps the documented column-0 + `LVIR_BOUNDS` quirk
(whole row, not the first cell) rather than quietly being nicer than Windows.

## Test notes

42 new `lvtest` legs, and they are **font-independent by construction**: the
view width is not assumed, it is *derived* — scroll to the right clamp, read
the ceiling back out of the layout, `viewW = colw - maxXoff`. Everything after
that is exact arithmetic. Real header divider drags are driven synchronously
(down/move/up), including one at a non-zero origin.

The e2e's `zero listview/header fail-loud reports` leg was **vacuous**: the
reports go to stderr and the test read only stdout, so it could never fire. It
now reads both streams, allows exactly the one report `lvtest` provokes, and
asserts that one *does* fire. End to end, shrinking the pane past its columns
brings the second bar up — counted as *shown* SCROLLBAR children under the
listview, because both bars always exist (created hidden) and `vis=1` is the
difference between "a bar is there" and "a bar is up". `lvdemo` gained
`WS_THICKFRAME` so the WM can perform that shrink; the pane has always
described itself as a resizable-content window.

Every new leg has a recorded red control (six sabotage rounds: header lockstep;
notifications/fmt/subitem/showsel/corner; the range ceiling; the geometry
readers and drag; both clamps; and two e2e rounds forcing the horizontal bar
off and on). The `hittest column at rest` and `header locked … at 0` legs are
the control halves of before/after pairs — the `at 0` one still went red under
the geometry sabotage, so it is not vacuous either.

## Counter pass: the lockstep legs were geometry-only (Codex, confirmed)

The review found the one hole this file was too pleased with itself to see.
`lv_lockstep` compares `HDM_GETITEMRECT` against `LVM_GETSUBITEMRECT` — and
**both subtract the same `xoff`**, so they agree by construction. Neither
observes rendering. The reviewer named the exact mutation that walks through
them: `listview.c`'s header paint, `int left = -st->xoff;` → `int left = 0;`.
The header then freezes visually while every reported rectangle still scrolls.

I ran that mutation against the unmodified tests rather than arguing about it.
**The whole listview e2e passed, 0 FAIL.** The finding is confirmed, not
rebuttable, and my "header lockstep was sabotaged" claim in the round above was
true of a *different* failure (dropping the origin from the state) and blind to
this one. Geometry-vs-geometry cannot catch a paint-only regression, and no
amount of adding more geometry legs would have.

The fix is a leg that reads what the header **drew**. The seam between column 0
and column 1 is column 1's left bevel — one `COLOR_BTNHIGHLIGHT` rule at its
left edge — so with 100px columns it sits at client x=100 at rest and must be
at x=60 once `xoff` is 40. `hd_px` samples it through `GetDC(hdr)`/`GetPixel`,
after `UpdateWindow(lv)` so the parent's full-client fill happens *before* the
child paints (sample the other order and you read a wiped band). The vacated
position is asserted as "not the rule" rather than "flat face": a glyph could
in principle land there, but glyphs blend `BTNFACE` toward `BTNTEXT` and can
never reach highlight white.

### Evidence

Mutation applied, unmodified tests — the finding, reproduced:

```
$ node tests/kernel/test_listview_e2e.js       # listview.c:234  -st->xoff -> 0
  ok   lvtest 0 failed
  ...
PASS
$ grep -c FAIL /tmp/mut-a.log
0
```

Mutation reverted, new leg present — the green half:

```
$ echo 'ctldemo lvtest' | node os/boot.js
ok 158 header seam is drawn where the columns say (at rest)
ok 158 nothing drawn at the scrolled-to position yet
ok 158 the header seam MOVED with the scroll
ok 158 the header seam left its old position
ctldemo lvtest: 105 checks, 0 failed
```

**OWED: the red control for these four legs has NOT been run.** The coordinator
stood this lane down from the machine-wide heavy lock mid-round — my short
back-to-back probes were starving #473's long gate window, and #473 merges
first. Two of the four legs are expected to go red under the mutation (the two
`at rest` ones are no-ops at `xoff == 0` and must stay green); that is a
prediction, not a result, and it stays written here as OWED until it is a
transcript. This branch is not merge-ready until it is.

## Left alone, deliberately

Classic report view without `LVS_EX_FULLROWSELECT` does not hit-test an item
outside column 0's label; ours hits the row anywhere and reports the column in
`iSubItem`. That is what the AQM agent seam and the existing tests assume, and
gap #31 does not mention it. Changing it is a behaviour change with real
consequences for the demo and the fileman migration — it wants its own ticket
if anyone wants it at all.

Image v231 → v232 (`listview.c`/`user32.c` are bake inputs through
`os/win32/lib.json`); the `demos` package 1 → 2, since `ctldemo` changed and it
ships there rather than in the bake.
