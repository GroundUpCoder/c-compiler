# todos/LIABILITIES.md — the liability register (todos/0286)

Every entry below is a **gap in shipped code that is described somewhere in the tree**: a
comment, a doc line, or an assertion that says — accurately — that something is absent,
partial, nominal, deferred, or untested. Each entry cites **where** (file + a literal anchor
line), **what** the gap is (the heading), and **which live ticket funds it**.

The register exists because a **true** gap comment is more dangerous than a false one. A false
comment contradicts behaviour and something eventually breaks; a true one reads as *known and
handled*, confers legitimacy, and **is itself the reason nobody looks again**. The 2026-07-27
sweep found 12 such gaps. All 12 survived by one mechanism: **they never entered `todos/`.**

`node todos/liabilities.js check` validates this file (also run by the `todos` suite in
`tests/run.js` and the pre-commit hook). Ticket refs come in two dialects since the 2026-07-30
queue cutover: `#N` is a cc ticket (the live tracker — the required dialect for `ticket:`,
liveness asked of `cc-meta`; absent/failing cc-meta degrades LOUDLY to structure+anchor checks),
and a legacy 4-digit `NNNN` resolves against `todos/done/` (the archive). The check fails on:

- a `ticket:` that is **closed** (cc done/dropped, or a legacy id — those can only be archived
  or missing now) or does not exist — the funding evaporated;
- a `defers-to:` that is **closed** and not pinned — *the deferral outlived its premise*
  (`0291`, `0300`, `0293` are exactly this shape today: a comment pointing at a `done/` item,
  which reads as handled to anyone who does not check);
- an `expired:` pin whose id is **open** again — the pin no longer applies, re-read the entry;
- an `anchor:` that is missing from its file or appears more than once — the comment moved or
  was rewritten, so the entry is describing something that is no longer there;
- a ticket id mentioned in an `anchor:` that the entry does not classify (see `provenance:`);
- an empty or unparsable register — an empty register would pass vacuously, so it fails.

## Entry format

```
### L07 — one line naming the gap
- ticket: #12           REQUIRED. The live cc ticket that funds closing this gap.
- file: os/wm.c         REQUIRED. Repo-relative path of the code location.
- anchor: <literal>     REQUIRED. One line that must appear EXACTLY ONCE in that file.
- defers-to: 0281       OPTIONAL. Milestone(s) this gap is deferred until. Must be OPEN
                        (`#N` for a cc ticket; legacy `NNNN` only for archived targets).
- expired: 0281         OPTIONAL. Acknowledged: this defers-to is already CLOSED, and
                        `ticket:` is the item that will fix it. Reported as a pinned
                        xfail (green). If the id reopens, or the comment stops citing
                        it, the pin fails LOUDLY instead of quietly persisting.
- provenance: 0171      OPTIONAL. Ids in the anchor that are history ("added by 0171"),
                        NOT a promise. Declaring one silences the classify check —
                        so do not launder a real deferral through it.
```

`anchor:` is a literal line, not a line number: line numbers rot on the first unrelated edit
above them, and a rotted line number is precisely the kind of true-then-stale record this file
exists to eliminate. `node todos/liabilities.js list` resolves each anchor to a live
`file:line` for reading.

## Enrolment rule — what obliges a gap to appear here

**A comment must have an entry here when it describes a gap.** The test is *not* whether it
carries a `TODO`/`XXX` marker — the sweep's 12 findings carried none, and a marker lint would
have found zero of them. The test is:

> **If this sentence is true, does it imply work? Then it is a liability, and it needs a ticket
> and an entry.**

That covers: "not in this version", "deliberately not done here", "nominal values only", "needs
a host import", "vacuously true if…", "TODO candidates", an unchecked box in a doc's
*Immediate* list, and any lane/phase left "open" in a topic doc. A topic doc is not the
scheduling system.

The rule binds at three moments:

1. **Writing one.** The commit that adds a gap sentence adds its entry (and files or cites its
   ticket) in the same diff. A diff that adds one without the other is incomplete — reviewers
   should treat it the way they treat an untested behaviour change.
2. **Closing a ticket.** Before `cc-meta ticket done`, grep this register for the ticket's
   `#N` — the check then blocks until stale entries are retired or re-pointed. This is the
   moment 0291/0293/0300 were all missed at (the retired `queue.js done` used to print the
   stale set automatically; the checker still catches a missed one on the next gate).
3. **Finding a pre-existing one.** The recurring liability sweep (`todos/0302`) is the
   discovery pass; this register is its output.

**Scope of the guarantee, stated plainly:** the checker guarantees the *register → tree*
direction — nothing enrolled here can rot without failing. The *tree → register* direction
(is every gap comment enrolled?) is not machine-decidable, which is why it is **funded** as a
recurring sweep rather than described as a limitation. An unfunded limitation is the exact
thing this file exists to kill.

## Register

<!-- BEGIN ENTRIES -->

### L01 — a failed deploy image fetch is swallowed and falls through to an in-worker full bake
- ticket: #92
- file: os/kernel-worker.js
- anchor: } catch (e) { /* no prebaked blob served — fall through to the bake */ }

### L02 — the manifest.image branch is the production boot path's first fetch and no test takes it
- ticket: #92
- file: os/kernel-worker.js
- anchor: var r = await fetch(manifest.image || 'os-system.img');

### L09 — NetSurf Lane D (binding fills) was left open in a topic doc, which is not the queue
- ticket: #98
- file: todos/NETSURF-JS.md
- anchor: **Lane D — binding fills (M-L, item-parallel).**

### L10 — listdir.h defers wm.c's third copy to a menu redesign that has already shipped
- ticket: #99
- file: os/listdir.h
- anchor: * todos/done/0250) — don't cite this header as covering it.
- defers-to: 0250, 0259
- expired: 0250, 0259

### L11 — `optional` bake assets make the blob machine-dependent; dependent launchers don't inherit it
- ticket: #100
- file: os/os-common.js
- anchor: *   entry.optional — (with entry.bin) a missing asset logs a skip instead of

### L12 — headless boot.js takes no lock; the guard is a "noted-only follow-up" in a closed item
- ticket: #101
- file: CLAUDE.md
- anchor: flock-style guard is a noted-only follow-up in the 0045 item). The
- defers-to: 0045
- expired: 0045

### L13 — only E/S/SE resize zones exist; "not in this version" has had no subsequent version
- ticket: #102
- file: kernel.js
- anchor: * corner -> SE (left/top edges just focus — moving-edge resizes are

### L14 — the 0211 divergence list is part-funded, so its unticketed entries read as tracked
- ticket: #103
- file: todos/WIN32.md
- anchor: - **WM_MOUSELEAVE on surface exit**: the kernel routes input per-window

### L15 — statvfs reports a fixed 4 GiB volume, so df lies about a filesystem that can fill
- ticket: #104
- file: compiler.js
- anchor: reports real free/used blocks is a TODO (needs a host import). */

### L16 — an unchecked "Immediate" box: 10 WASM imports with no C-level test
- ticket: #105
- file: todos/BLOCK_FS.md
- anchor: - [ ] **C-level unit tests for the 10 untested WASM imports** listed above.


### L18 — the dispatcher documents a Playwright-missing skip that only fires on a spawn failure
- ticket: #106
- file: tests/run.js
- anchor: // `optional` suites (browser sweep) report a launch failure as a skip, not a

### L19 — CLAUDE.md repeats the same skip-not-fail promise the sweep classifier does not keep
- ticket: #106
- file: CLAUDE.md
- anchor: process; the browser `sweep` is optional (a missing-Playwright launch

### L20 — modals still draw min/max boxes; the descope points at a closed item
- ticket: #107
- file: os/wm.c
- anchor: * title-bar boxes on modals — deliberately NOT done here, 0281.) */
- defers-to: 0281
- expired: 0281

### L21 — the WMP_F_TRANSIENT flag's own doc defers min/max suppression to the same closed item
- ticket: #107
- file: os/wm_proto.h
- anchor: boxes — not implemented here (0281 scope note). */
- defers-to: 0281
- expired: 0281

### L22 — a 900x600 non-touch window gets phone defaults with none of the mobile controls
- ticket: #108
- file: os/os.html
- anchor: // (900×600 — min() ≤ 700, innerWidth > 768) trips THIS predicate while

### L23 — registry writes since the last flush are lost on SIGKILL (the price of the batched flush)
- ticket: #42
- file: os/win32/advapi32.c
- anchor: the last flush are lost on SIGKILL — flushing is batched to

### L24 — two registry flushes in the same instant still race on the rename; there is no advisory lock
- ticket: #42
- file: os/win32/advapi32.c
- anchor: tmp+rename, and there is no advisory lock, so two flushes landing in

### L25 — search.h is absent, so four libc-tests are permanently skipped
- ticket: #111
- file: tests/run.py
- anchor: "search_hsearch": "not implemented: search.h (todos/0305)",

### L26 — the BSD random()/srandom()/initstate() family is absent
- ticket: #112
- file: tests/run.py
- anchor: "random": "not implemented: random()/srandom()/initstate()/setstate() (todos/0306)",

### L27 — strptime() is absent and strftime is missing six conversions plus width modifiers
- ticket: #113
- file: tests/run.py
- anchor: "strptime": "not implemented: strptime() (todos/0307)",

### L28 — open_memstream()/fmemopen() are absent; there are no memory-backed FILE streams
- ticket: #114
- file: tests/run.py
- anchor: "memstream": "not implemented: open_memstream()/fmemopen() (todos/0308)",

### L29 — the wcstol family and wide scanf are absent
- ticket: #115
- file: tests/run.py
- anchor: "wcstol": "not implemented: wcstol() family (todos/0309)",

### L30 — strftime %s follows glibc/BSD (TZ-dependent) where musl is TZ-independent; nobody chose
- ticket: #116
- file: tests/run.py
- anchor: # (todos/0307). %s additionally diverges from musl's expectation by the
- provenance: 0307

### L76 — setjmp p4 residue: do/for controlling expressions and nonzero-constant comparisons are still rejected after #117 accepted the common contexts
- ticket: #432
- file: todos/CONFORMANCE-REMAINING.md
- anchor: - **setjmp p4 residue: do/for controlling expressions and comparisons against nonzero integer constants are still rejected**
- provenance: 0311

### L33 — mouseover/mouseout/mouseenter/mouseleave and focusin/focusout are not generated
- ticket: #120
- file: vendor/netsurf/netsurf/content/handlers/html/interaction.c
- anchor: 	 * core generates those yet — todos/0317). */

### L34 — a PROGRAMMATIC form.submit() would wrongly fire the cancelable `submit` event
- ticket: #120
- file: vendor/netsurf/netsurf/content/handlers/html/form.c
- anchor: 	 * (Per spec a PROGRAMMATIC submit — form.submit() — does not fire

### L39 — SDecl's child-rewrite hook is a no-op, so a generic walker's rewrite of a declaration initializer is silently discarded
- ticket: #125
- file: compiler.js
- anchor: // children-based rewriter's new subtree is silently discarded here.

### L41 — a function with more than 65520 basic blocks still dispatches through an O(n) linear compare chain
- ticket: #130
- file: compiler.js
- anchor: // more than 65520 blocks still degrade to the linear chain — see todos/0335.

### L42 — python's `time.localtime` is `gmtime`: there is no timezone database, so local timestamps are UTC
- ticket: #19
- file: vendor/micropython/README.md
- anchor: - **`time.localtime` is `time.gmtime`.** There is no timezone database on this

### L43 — datetime/argparse/subprocess/hashlib/select/socket are absent from python's stdlib
- ticket: #19
- file: vendor/micropython/README.md
- anchor: - **Modules a Python programmer will reach for and not find**: `datetime`,

### L45 — the cross-tree guard covers the test runners only; the tools/ writers and os/boot.js can still write into another tree
- ticket: #142
- file: tests/lib/tree-guard.js
- anchor: // NOT GUARDED YET: the tools/ writers and os/boot.js — funded by todos/0357.
- provenance: 0341

### L48 — `tcflush` validates and reports success without discarding anything, though the line discipline really holds an input queue
- ticket: #124
- file: compiler.js
- anchor: RPC. No shipping consumer asks for it (nothing in the CPython stdlib
- provenance: 0340

### L49 — cpython-clang (né python-clang) has no sockets, so `asyncio` ships and imports nowhere
- ticket: #3
- file: vendor/cpython/README.md
- anchor: (`_socket` is not built), so **`asyncio` does not import and is not
- provenance: 0340

### L52 — id allocation is blind to an unpushed id in a different clone, and no probe can see it
- ticket: #145
- file: todos/idspace.js
- anchor: // coordination point (a pushed reservation ref), which is todos/0364, register
- provenance: 0360

### L55 — the two host.js sleep backends disagree about a zero-length nanosleep, and the test declines to pin either
- ticket: #146
- file: tests/host/test_sleep_clamp.js
- anchor: // KNOWN GAP, funded by todos/0365 (register L55): the two backends disagree
- provenance: 0361

### L56 — the wall-clock survey is a hand-run audit, so a NEW elapsed-time budget can enter tests/unit unnoticed
- ticket: #147
- file: tests/scan-wallclock.sh
- anchor: # classification of the current 22 lives in logs/2026-07-28/0361-wallclock.md).
- provenance: 0361

### L57 — umask is real per-process state but does not cross __spawn, so a shell's `umask 077` silently stops at the process boundary
- ticket: #168
- file: compiler.js
- anchor: inheritance through __spawn is a separate, ticketed gap (todos/0399). */
- provenance: 0382

### L58 — no fd can refer to a directory, so the *at family's dirfd resolution mode is unreachable
- ticket: #169
- file: compiler.js
- anchor:  * todos/0400 (directory file descriptors: O_DIRECTORY, dirfd(3), fdopendir(3))
- provenance: 0325

### L59 — mkfifo is absent on purpose; a link-testable stub would move a consumer's failure from configure time to run time
- ticket: #170
- file: compiler.js
- anchor:    time. Funded by todos/0401, which is also what keeps todos/0382 open. */
- provenance: 0382

### L63 — nothing emits BW_CS_SCRIPT_ERROR, so an uncaught JS exception reaches no console, no log and no tty
- ticket: #177
- file: vendor/netsurf/gucos/gui.c
- anchor: through this table is todos/0424 — it belongs at dukky's error

### L64 — the dynamic-restyle chain walk misses a sibling combinator and cannot reach a `display: none` element
- ticket: #178
- file: vendor/netsurf/netsurf/content/handlers/html/interaction.c
- anchor:  * Both are recorded in todos/LIABILITIES.md against todos/0426.
- provenance: 0420

### L66 — moduleKey's rw validation floor is one store timestamp tick: a same-ino, same-size, same-tick rewrite runs a stale Module silently (accepted — window unreachable in-OS; complete closure = a content-hash key term, refused because it re-adds the per-spawn read the cache exists to skip)
- ticket: #109
- file: host.js
- anchor: //    would collide — and the failure is SILENT stale code, not an

### L71 — the #318 style net allowlists SBARS_SIZEGRIP on the status bar (notepad passes it): no size grip is drawn and none is planned before the W5 residue pass
- ticket: #334
- file: os/win32/user32.c
- anchor:                                   (self-bottom-parking); SBARS_SIZEGRIP is W5

### L72 — the gucOS http fetcher refuses multipart POST (loud FETCH_ERROR): the todos/0433 file gadget builds a correct fetch_multipart_data list whose bytes still cannot reach a server
- ticket: #360
- file: vendor/netsurf/gucos/httpfetch.c
- anchor: 			"multipart POST is not supported yet (todos/0433)");
- provenance: 0433

### L73 — gdiplus-mini's draw is SRCCOPY, so a translucent image lands OPAQUE: GdipGetImageFlags reports the alpha honestly (a viewer still draws its checkerboard) but nothing shows through, because the compositing primitive does not exist yet
- ticket: #285
- file: os/win32/gdiplus.c
- anchor:          * compositing primitive is gdi32 AlphaBlend, ticket #285. */

### L74 — gdiplus-mini decodes PNG/JPEG/GIF/BMP only: an ICO/CUR is a loud UnknownImageFormat, and the shimgvw loader hands GDI+ exactly that container (libnsbmp's ico_* is already linked — the decode is absent, not the decoder)
- ticket: #379
- file: os/win32/gdiplus.c
- anchor:      * decode it yet — ticket #379 funds it. Until then it is a loud

### L75 — gdiplus-mini's encoder table is BMP+PNG only, so the viewer's "rotate clockwise and save" will REFUSE on a JPEG: shimgvw looks the image's own rawFormat up in this list and gives up when it is absent
- ticket: #379
- file: os/win32/gdiplus.c
- anchor:  * of THIS list, so it will refuse on a JPEG until ticket #379 lands one. */

### L77 — `--resume` freshness stops at the test file itself: a member whose own source is unchanged resumes even if a HELPER it reads (a tests/lib/ module, a fixture, the product code under test) changed since that pass, so the resumed green still rests on an old measurement
- ticket: #151
- file: tests/lib/suite-runner.js
- anchor: // dependency-level freshness is ticket #151 and is a much heavier mechanism.

<!-- END ENTRIES -->
