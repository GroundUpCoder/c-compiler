# 0400 — click during a live re-conversion can leave focus_owner.textarea pointing into freed memory

- **Status**: open
- **Design**: —

## Goal

Found by source reading during `0386`'s diagnosis pass
(`todos/0386-netsurf-mutation-e2e-intermittent-design.md` §7). **Filed, deliberately NOT folded
into `0386`**: it shares that ticket's root cause (interaction state vs. the live-re-conversion
window) but it is a distinct defect — memory safety, not a lost keystroke — and it stands on its
own even if `0386` turns out to be a test-barrier problem.

⚠️ **Source-derived, no repro yet.** The first job is to reproduce it, not to fix it.

### The defect

`html_reconvert_box_done()` (`vendor/netsurf/patches/netsurf.diff`, the live-re-conversion
completion callback) frees the outgoing box tree **unconditionally and first**, then re-binds the
focus **conditionally**:

```c
    if (c->reconvert_old_bctx != NULL) {          /* the OLD box tree dies here */
        talloc_free(c->reconvert_old_bctx);
        c->reconvert_old_bctx = NULL;
    }
    imagemap_extract(c);
    content__reformat(...);  content__request_redraw(...);

    if (c->reconvert_focus_node != NULL) {        /* CONDITIONAL re-bind */
        struct box *fb = box_for_node(c->reconvert_focus_node);
        ...
    }
```

`reconvert_focus_node` is the snapshot taken at `html__reconvert()` **entry**. If nothing was
focused then, it is `NULL` and the whole re-bind block is skipped.

But `html__reconvert()` also sets `c->focus_type = HTML_FOCUS_SELF`, and the old tree is
**deliberately kept alive serving input** for the whole `dom_to_box` run. So a click that lands
inside that window routes through `html->layout` (still the old tree), reaches the input's old
box, and `box_textarea_callback`'s `TEXTAREA_MSG_CARET_UPDATE` calls
`html_set_focus(html, HTML_FOCUS_TEXTAREA, {.textarea = <OLD box>}, ...)`
(`content/handlers/html/box_textarea.c:226-244`).

At completion the `talloc_free` above releases that box and the conditional re-bind does not run.
`c->focus_owner.textarea` is left dangling; the next `html_keypress` dispatches
`box_textarea_keypress(html, <freed box>, key)`
(`content/handlers/html/interaction.c:1921-1926`) — **use after free**.

### Honest scoping

The window is narrower than it first looks. Once box construction reaches that `<input>`, the
gadget's `data.text.ta` is released and recreated bound to the **new** box (lane B's textarea-leak
fix), so a click *after* that point focuses a box in the surviving `bctx`. The exposed interval is
therefore "reconvert started **and** the focused element's new box does not exist yet" — real, but
short. In a wasm/talloc world freed memory often reads back intact, so the symptom is likely
**silent misbehaviour** (input routed to a dead box, keystrokes apparently ignored) rather than a
clean trap — which is exactly why it needs an explicit repro rather than a crash report.

Reachable by an ordinary user sequence, and by `tests/kernel/test_netsurf_mutation_e2e.js`'s own
ticky leg (`wmctl click` immediately after the window appears, on a page that re-converts every
300 ms).

## Plan

1. **Repro first.** Force a wide re-conversion window with `0386`'s D2 trigger (a ticking page of
   ~3000 elements re-converts for ≈ the whole tick period), then click into a text field with
   nothing previously focused, then type. Assert on the field's value / ink. Add an
   `NSLOG(netsurf, ERROR, ...)` or an assertion at the `reconvert_focus_node == NULL &&
   focus_type == HTML_FOCUS_TEXTAREA` combination at the swap to prove the state is reached even
   if the UAF is silent.
2. **Fix.** The recommended shape is `0386` §4.2's general rule — *interaction state that routes
   input stays valid for the whole build-then-swap interval and is re-bound at the swap* — which
   subsumes this case: take the focus snapshot **at the swap** rather than at teardown-start, so a
   focus change during the window is carried across rather than left dangling. A narrower
   defensive fix (unconditionally reset `focus_type`/`focus_owner` to `HTML_FOCUS_SELF` before the
   `talloc_free` when there is no snapshot) closes the memory-safety hole but keeps the "click is
   silently lost" behaviour, so prefer the general one.
3. **Coordinate with `0386`** — if `0386` lands the general rule, this ticket's fix is that same
   change and this reduces to its regression test. If `0386` lands a test-only barrier instead,
   this keeps the product fix.

## Acceptance

- A committed repro that reaches the state (a landed assertion/log at the swap counts as the
  proof, given the UAF is expected to be silent), NOT just a code argument.
- After the fix: a click landing mid-re-conversion keeps its focus into the new tree, and typing
  after it lands in the field.
- The regression test survives the `--repeat`/`--under-load` flake gate.
- If the fix touches `vendor/netsurf/` it changes the baked `/usr/bin/netsurf`
  (`os/image.json` `system` entry) and therefore **owes an image bump**.
