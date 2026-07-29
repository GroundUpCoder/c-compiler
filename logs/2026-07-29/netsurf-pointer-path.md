# netsurf: the pointer path — a cancelled click (0419) and the dynamic pseudo-classes (0420)

Both defects come from the `netsurf-bughunt` lane. Both live in the tail of
`html_mouse_action`, so they are one lane and not two.

## 0419 — the dispatch result was thrown away

The cancelable DOM `click` already fired BEFORE the deferred
`ACTION_NAVIGATE` switch. The order was right. The code simply ignored what
the dispatch answered.

Nothing new was needed to learn the answer. `fire_dom_mouse_event` and
`fire_generic_dom_event` both return the value of libdom's
`dom_event_target_dispatch_event`, which is false when a listener cancelled
the event. `html_fire_mouse_events` was already reading it for `mousedown`
(`html->mouse_default_prevented`). The click site just did not.

The interesting decision is WHICH actions a cancelled click cancels. The DOM
says a cancelled click suppresses the element's ACTIVATION BEHAVIOUR, so the
set is `ACTION_SUBMIT`, `ACTION_NAVIGATE` and `ACTION_JS`. `ACTION_SUBMIT` is
in the set even though `form_submit()` already honours the cancelable
`submit`: that is a different event, and a page that cancels the click on a
submit button expects the submission to stop. `ACTION_BACK` and
`ACTION_FORWARD` are not element behaviour — they are the mouse's history
buttons, and they need CLICK_4/CLICK_5, which the click block cannot see.

The control leg matters more than the fix leg. A "fix" that stopped
navigating on every click passes the cancelled-click assertion. So the test
clicks a SECOND link whose listener runs and does not cancel, and asserts
page B renders.

## 0420 — `:hover` had no answer, and no repaint

`node_is_hover` was a `\todo Support hovering` stub. libcss asked; netsurf
answered "never".

Four things had to exist.

**The state.** `html_content` gains `hover_node` and `active_node`: the
deepest ELEMENT of each chain, referenced. A DOM node rather than a box, so
the state survives a live re-conversion — the box tree is replaced, the
element is not.

**The answer.** `nscss_select_ctx` carries both nodes and the two callbacks
walk up from the subject. A pseudo-class matches a chain, not one element,
which is what makes `li:hover a` work and what the test's "ancestor" leg
pins.

**The invalidation.** libcss caches the pseudo-class flags on the node
itself, so a re-selection that does not first call `nscss_node_data_clear`
hands back the answer it is trying to replace. That was the first thing that
had to be got right.

**The bound.** Re-selecting the whole document per pointer move is not an
option — hover fires on every motion. Moving the pointer leaves every common
ancestor hovered, so the elements whose answer moved are the two chains below
their deepest common ancestor, and re-selecting the box subtree of the
topmost element of each covers them plus everything they restyle by
inheritance or by a descendant combinator.

### Three things that only became clear by measuring

**The topmost changed node usually has no box.** The chain runs up to the
DOCUMENT node, and an empty old chain therefore makes the whole new chain
"changed". The first version restyled `box_for_node(document)` — NULL — and
did nothing at all. The hover probe stayed red with the whole mechanism in
place. The walk now descends to the first chain entry that really has a box.

**Re-selected is not the same as changed.** The first working version
repainted the union of the re-selected SUBTREE roots. Moving off a link and
onto a 3000 px block therefore invalidated 784x3212 px, because the block was
re-selected even though nothing about it changed. `box_restyle_element` now
reports each box whose computed style really changed, and the repaint is
driven by that set: the same transition became 300x112 px.

The test for "really changed" is pointer equality. libcss interns computed
styles in a global arena (`css__arena_intern_style`), so an unchanged
selection hands back the SAME pointer. That is exact, it is free, and it is
what keeps a page with no dynamic rule from paying a reflow per mouse move.

**Boxes share styles they do not own.** A text box, a `BOX_INLINE_END`, a
list marker and a `::before` box all point INTO the selection results of the
element they belong to — and an inline element's text boxes are not its
children, they are its SIBLINGS inside the same inline container. So the
re-point walk covers the box's own subtree and its siblings' subtrees, and it
matches every pseudo-element slot, not just the base one.

That walk still cannot reach one shape: an inline element split across two
containers by a block child. So the replaced results are RETIRED onto the box
tree's talloc context instead of being destroyed. A missed alias then renders
one frame with a stale style; destroying instead would leave it dangling,
which is a crash. The retired results die with the tree they belong to.

### Layout

A dynamic rule can move boxes (`a:hover { padding: 4px }`) and this engine
has no partial relayout, so a real style change reflows the document. The
reflow runs with `background: true`, which is the flag that stops
`browser_window` repainting the whole window behind it; the bounded request
is the repaint. The reflow is skipped entirely when nothing changed, which is
every page without a dynamic rule.

### What is not covered

A sibling combinator (`a:hover ~ span`) puts its subject outside both
subtrees, and a rule that displays a `display: none` element has no box to
re-select from. Both need a real invalidation engine — libcss reporting which
selectors an element takes part in, and an invalidation set per element.
Filed as `todos/0426`, register entry L64.

## Numbers

Measured with the monkey frontend under `host.js`, on a page with a 3000 px
block above two 100 px links (2026-07-29):

| transition | invalidated |
| --- | --- |
| first pointer entry onto link one | 300x212 (both links: they also flip `:link` to `:visited`) |
| link one to link two | 300x212 |
| link two to the block above | 300x112 |
| block to link one | 300x112 |

Before the change: no invalidation at all, because nothing restyled.

## Files

- `content/handlers/html/interaction.c` — the click result, the chains, the
  delta and the repaint
- `content/handlers/html/box_construct.c` / `.h` — `box_restyle_element`, the
  alias re-point and the retire list
- `content/handlers/css/select.c` / `select.h` — the two callbacks
- `content/handlers/html/private.h` — the two chain subjects
- `content/handlers/html/html.c` — three lines of teardown, and nothing else

## Note for the coordinator

`html.c` is owned by the `0412` lane. The only edit here is the pair of
`dom_node_unref` calls in `html_destroy`, ~900 lines from the nearest `0412`
hunk. Without them the last hovered element and its whole ancestor chain leak
per document. The alternatives — a weak reference through libdom user data,
or anchoring the chain to the box tree's talloc context — are more machinery
than three lines and cost the hover state at every re-conversion.
