# #335 — Wine conformance-suite scoping spike (C4a)

Read-only spike; deliverable is `todos/WINE-CONFORMANCE-SCOPE-335.md`. Scoped
Wine at `3ec14378590503ffbadfa936b994e5bf849fe967` (sparse clone in /tmp, not
vendored). Worked in an isolated worktree; no test suites run (another lane
held the editing lane + heavy lock).

## What the reading changed

The ticket's uncertainty was "is the `ok_sequence` harness worth bringing
across?" — and the premise dissolved on contact:

- **There is no framework to port.** `wine/test.h` carries its own runtime
  behind `#ifdef STANDALONE` (905 lines total); comctl32's `msg.h` is 397
  self-contained lines over it. The comctl32 sequence machinery records via
  `SetWindowLongPtr(GWLP_WNDPROC)` subclassing, which user32.c already
  implements. The genuinely heavyweight thing is `user32/tests/msg.c` — a
  21.6k-line file with its OWN in-file framework — and it severs cleanly.
- **The real cost of sequence tests is the oracle, not the harness.** The
  expected tables encode exact Windows message ordering the veneer diverges
  from by design (kernel WM owns chrome/z). Rewriting tables would destroy
  the independent-authorship property that justifies the import — hence the
  failure-ratchet run mechanism (pin expected failures per target; up = red,
  down = re-pin) instead of either chasing green or editing assertions.
- **The graceful-degradation paths are already in the tests**: v6 activation
  contexts self-skip when `CreateActCtxA` fails; `SetWinEventHook` absence
  makes winevent-flagged messages optional inside `ok_sequence` itself.

## Numbers (method: `ok(`/`ok_(` call sites; `ok_sequence` sites separate)

15,437 ok sites + 902 sequence sites across 54 files. Buckets: (a) portable
as-is 4,085 · (b) small general shims 2,021 · (c) sequence-framework-bound
1,614 + the 902 seq sites · (d) not applicable 7,717 (5,776 deliberate — DDE,
winstations, SendInput, win.c's real-WM minutiae; 1,941 awaiting unimplemented
controls).

## Recommendation (for #339)

Slice 1 = test.h + msg.h + `comctl32/listview.c` + `comctl32/header.c` +
`user32/scroll.c` + `user32/listbox.c`: 1,350 ok sites / 116 test fns, all on
controls implemented TODAY. Agree with the decider's thin default, two loud
amendments: treeview.c waits for a TreeView implementation ticket (it is
unimplemented; #337 is taskmgr/ListView — landing it now is the wall of red
the decider warned about), and comctl32's msg.h comes along because the two
highest-value files include it unconditionally — excluding it means editing
the oracle for zero savings; user32/msg.c's framework stays out as ruled.

Licensing: `vendor/winetest/` in the 0060 shape, per-file LGPL headers +
COPYING.LIB preserved, tests-only sparse checkout so Wine's implementation
tree never even lands on disk — veneer purity enforced at checkout time.
