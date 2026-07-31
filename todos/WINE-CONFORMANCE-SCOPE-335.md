# #335 — Wine conformance-suite scoping (C4a spike, 2026-07-31)

Read-only scoping of the Wine `dlls/comctl32/tests` + `dlls/user32/tests` import
(C4). Output of ticket #335; input to the port ticket #339. No tree changes —
this document and its dev log are the entire deliverable.

**Wine commit scoped: `3ec14378590503ffbadfa936b994e5bf849fe967`**
(wine-mirror/wine, sparse checkout of `dlls/comctl32/tests`, `dlls/user32/tests`,
`include`, cloned 2026-07-31). Every count below is against that commit.

## 1. The harness, actually read

Three layers, and they are much smaller than the ticket feared:

- **`include/wine/test.h` (905 lines).** The `ok()`/`skip()`/`todo`/`trace`
  macro surface, AND — behind `#ifdef STANDALONE` (lines 580–903) — the entire
  runtime: `main()`, arg parsing, the pass/fail counters, and the summary
  printer. A winetest binary is `#define STANDALONE` + one test `.c` file.
  There is no framework library to port. The STANDALONE runtime's Win32
  dependency set is ~20 kernel32-level calls; the ones the veneer lacks are
  thread plumbing for multi-threaded tests (`TlsAlloc`/`TlsGetValue`,
  `CreateMutexA`/`WaitForSingleObject`/`ReleaseMutex` for the print lock,
  `GetConsoleMode`, `SetUnhandledExceptionFilter`). Our world is
  single-threaded by design, so the right move is a small **single-threaded
  reduction patch to the vendored test.h** (~30 lines: static thread-data
  struct, no-op print lock, no exception filter) — NOT fake thread APIs in
  kernel32 (that would be a zombie fallback). Patch-table entry, like every
  0060-class patch.
- **`dlls/comctl32/tests/msg.h` (397 lines).** The `ok_sequence` machinery for
  the comctl32 tests: a malloc-grown array of `{message, flags, wParam,
  lParam, id}` records fed by each test's own subclass procs, compared against
  static expected tables. It is **self-contained** over test.h + libc — no
  framework beneath it. Its one optional external dep, `SetWinEventHook`,
  degrades by design: `hwineventhook == NULL` makes every `winevent_hook`-
  flagged expected message optional. The recording mechanism is
  `SetWindowLongPtrA(hwnd, GWLP_WNDPROC, …)` subclassing — **which the veneer
  already implements** (user32.c `SetWindowLongPtr`, per-window proc).
- **`dlls/user32/tests/msg.c` (21,575 lines).** user32's message tests carry
  their OWN in-file sequence framework (552 `ok_sequence` sites, CBT hooks,
  WinEvent hooks, DDE/thread/timer interleavings). This is the thing that is
  genuinely heavyweight, and it is one file, cleanly severable.

`v6util.h` (comctl32 v6 activation contexts, included by 22 of 29 comctl32
files) needs nothing: it drives `CreateActCtxA`, which the veneer does not
have, so `load_v6_module` fails and every v6 pass **skips loudly by the tests'
own logic**. The v5 pass — the one that matches our Win95-shaped veneer — runs.

The honest cost of `ok_sequence` is therefore not the harness (cheap) but the
**oracle**: the expected tables encode exact Windows message ordering
(`WM_WINDOWPOSCHANGING`/`WM_NCCALCSIZE` interleavings, defwinproc attribution,
paint ordering). The veneer will diverge from much of that forever, by design
(the kernel WM owns chrome and z-order). Editing the tables to match us would
destroy the independent-authorship property that justifies the import. So
sequence assertions must either run under a pinned-divergence regime (§4) or
not run — never be rewritten.

## 2. Buckets, in test cases

**Counting method:** a "test case" = one `ok(`/`ok_(` call site
(`grep -cE '\bok(_\(|\()'` per file); `ok_sequence` call sites counted
separately since one site checks an entire expected-message table (typically
5–40 entries, so its runtime assertion count is ~10× the site count).
Secondary unit: `static void test_*` functions. **Error bars:** ok-sites in
loops fire many times; ok-sites in shared helpers are counted once but serve
many tests; a few sites are unreachable on our platform (v6-only paths skip).
Treat totals as ±20%, and comparisons between buckets as solid.

Corpus total at the pinned commit: **15,437 ok sites + 902 ok_sequence sites**
across 54 files (plus user32/generated.c's 493 type-layout asserts, counted
apart — it tests Windows ABI struct layouts we do not promise; bucket d).

| Bucket | Definition | ok sites | share |
|---|---|---|---|
| **(a) portable as-is** | compiles & runs against TODAY'S veneer after mechanical patches only (`L"…"`→`u"…"`, GetProcAddress→direct-bind, test.h single-thread reduction) | **4,085** | 26% |
| **(b) small shim** | needs small, general support APIs the veneer should grow anyway (SetWindowSubclass, an ImageList subset, DC-cache corners, dialog/menu/class gaps) | **2,021** | 13% |
| **(c) needs the full sequence harness** | user32/msg.c's in-file framework + the sequence oracle problem | **1,614** ok + **902** seq sites | 16% (runtime-weighted far more) |
| **(d) not applicable** | d1 deliberate absences (DDE, winstations, SendInput, SPI, cursor/icon assets, DPA/MRU internals, win.c's real-WM minutiae, generated.c ABI): 5,776. d2 control absent & unscheduled (treeview, combo, tab, toolbar, trackbar, monthcal, propsheet, …): 1,941 | **7,717** (+493) | 50% |

Per-file assignment (ok sites; seq sites in parens where nonzero):

- **comctl32 (a):** listview 710 (118), edit 455 (10), listbox 358 (8),
  button 355 (19), header 118 (28), static 69 — controls all exist in the veneer.
- **comctl32 (b):** imagelist 428 (needs ImageList impl — listview/treeview/tab
  all want it, clearly in-scope), misc 102, subclass 38 (needs
  `SetWindowSubclass`, absent today).
- **comctl32 (d2, control absent):** treeview 280 (39), combo 204, propsheet
  144, toolbar 354, tooltips 120, tab 102, monthcal 92, pager 69, syslink 69,
  updown 63, status 56, datetime 48, rebar 41, progress 29, ipaddress 26,
  taskdialog 22, animate 15, trackbar 72. **(d1):** dpa 82, mru 49.
- **user32 (a):** clipboard 621, edit 403, listbox 341, text 226 (DrawText
  exists — gdi32w.c), scroll 181, resource 113, static 78, wsprintf 30,
  uitools 27.
- **user32 (b):** menu 591, class 505, dialog 200, dce 157.
- **user32 (c):** msg.c 1,614 (552).
- **user32 (d1):** win 2,607 (real-WM z-order/owner/parenting minutiae — the
  kernel WM deliberately owns this), sysparams 683, dde 606, monitor 564,
  input 557, cursoricon 326, winstation 270, broadcast 32, generated 493 TYPE.
  **(d2):** combo 135.

## 3. Recommended first slice

**Vendor `wine/test.h` + comctl32 `msg.h` + four test files:
`comctl32/listview.c`, `comctl32/header.c`, `user32/scroll.c`,
`user32/listbox.c`** — 1,350 ok sites (incl. 146 sequence sites) across 116
test functions, every one exercising a control the veneer implements TODAY
(SysListView32/SysHeader32 per todos/0370; SCROLLBAR + the scroll API; LISTBOX).

Mechanical patch classes (all patch-table'd, 0060 shape):

1. `L"…"` → `u"…"` (8 sites in listview.c, 29 in user32/listbox.c, 0 in the
   other two).
2. `init_functions()`-style `LoadLibraryA`+`GetProcAddress` binds → direct
   symbol references where the veneer exports the symbol, `NULL` otherwise
   (the tests' own `if (!pFoo)` guards then skip) — static-link world, no DLLs.
3. test.h single-threaded reduction (§1).
4. Nothing else by default. v6 passes self-skip; `SetWinEventHook` absence
   self-degrades; scroll.c's `CreateProcessA` self-respawn subtest should
   actually WORK (kernel32 CreateProcess → `__spawn`).

**Run mechanism — the failure ratchet.** Assertions are never edited and
sub-tests are not commented out. Each winetest binary is seeded in-OS
(`/bin/wtest-listview` …), a kernel e2e drives it and parses winetest's
summary line, and the expected-failure count is **pinned** per target (the
xfail/knownBug philosophy at corpus scale): count goes UP → red, loud; count
goes DOWN → xpass-style loud prompt to re-pin. Divergence is thereby recorded,
not hidden, and every veneer fix moves a number that jku can watch. The 146
sequence sites in listview/header run under the same ratchet — their failures
are pinned divergence, and any that pass are free extra conformance.

**Slice 2 (when a TreeView implementation ticket exists):** `treeview.c`
(280 ok, 39 seq, 40 test fns) enters as that ticket's independent acceptance
oracle — imported by this corpus lane per the placement ruling, sequenced with
the implementation. **Slice 3 candidates:** comctl32 edit/listbox/button +
user32 edit/static/text/wsprintf/clipboard (≈2,600 ok sites, all bucket (a)).

## 4. Position on the decider default — agree, with two explicit amendments

The thin-slice, plain-`ok()`, no-message-framework default is **right**, and I
am not widening it. Two compositional amendments, stated openly:

1. **TreeView out of slice 1.** The default named "listview/treeview +
   scrollbar", but TreeView is UNIMPLEMENTED (ticket-verified) and #337 — the
   gate for #339 — is taskmgr (report ListView), not a TreeView
   implementation. Landing treeview.c now yields the decider's own "wall of
   red, not signal". Swapped in: header.c + user32/listbox.c, which test
   implemented controls and keep the slice the same size. treeview.c is
   explicitly slice 2, not dropped.
2. **comctl32's `msg.h` comes along; user32's `msg.c` framework stays out.**
   The default said "do not port Wine's msg.h message-sequence framework".
   Measured, `msg.h` is 397 self-contained lines that listview.c and header.c
   `#include` unconditionally — excluding it means hand-editing the two
   highest-value files (oracle contamination) for zero savings. What the
   default is actually protecting against is user32/msg.c's 21.6k-line
   in-file framework and its hook plumbing — that stays bucket (c), not
   ported. So: carry the header, run its assertions under the ratchet, chase
   green only on plain-ok content.

## 5. What the slice proves that regedit/taskmgr/mspaint/winfile cannot

- **Independent, adversarial oracles.** App ports prove "the calls this app
  happens to make don't crash and render plausibly" — the happy path, at link
  granularity (`links | 0`), and the demand signal is currently EXHAUSTED at
  that granularity (7/7 green). Wine's tests assert exact return values,
  clamping rules, notification codes and their parameters, state-image
  round-trips — written by people testing against real Windows, with no
  knowledge of this veneer. That is assertion-granularity conformance, and it
  re-arms the saturated signal with ~1,350 new independent checks.
- **Negative-path coverage no app exercises.** Invalid indices, out-of-range
  `SetScrollInfo`, zero-size rects, deleting items during iteration, LVM
  messages on empty controls. Apps never do these things on purpose; bug
  reports arrive when a user does.
- **A conformance NUMBER.** The per-target pinned-failure ratchet turns
  "Win32 fidelity" from a vibe into a monotonic metric — each veneer fix
  visibly lowers a pin. App targets are binary (links/plays); this is a dial.
- Honest limit: the slice does NOT prove visual correctness or in-OS
  usability — the app targets and pixel e2es keep owning that. The two
  corpora are complements, not substitutes; this is why recommending both
  lanes is not scope creep.

## 6. Licensing & veneer purity (confirmation, per the ruled boundary)

The recommended slice lands as `vendor/winetest/` in the 0060 shape: pinned
upstream commit `3ec14378590503ffbadfa936b994e5bf849fe967`, Wine's
`COPYING.LIB` (LGPL-2.1+) copied alongside, every vendored file keeping its
per-file LGPL header, and a README carrying the full patch table (the three
mechanical classes above, per-file). The vendored files compile ONLY into
standalone test binaries that link the veneer — aggregation, the exact
`vendor/winmine` shape already publicly shipped. Nothing from Wine is copied
into `os/win32/*`, `compiler.js`, or `tools/`: the sparse checkout for #339
should take **only** `dlls/*/tests` + `include/wine/test.h`, never Wine's
implementation trees, so the structural temptation the ruling flags is removed
at checkout time; veneer fixes motivated by red assertions are original work
from observed behaviour and documentation. Per decider point 4, #339 should
also add the one-line top-level NOTICE ("vendor/ subdirectories carry their
own licenses") — proposed here, deliberately not landed from this read-only
ticket.
