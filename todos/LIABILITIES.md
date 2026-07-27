# todos/LIABILITIES.md — the liability register (todos/0286)

Every entry below is a **gap in shipped code that is described somewhere in the tree**: a
comment, a doc line, or an assertion that says — accurately — that something is absent,
partial, nominal, deferred, or untested. Each entry cites **where** (file + a literal anchor
line), **what** the gap is (the heading), and **which live ticket funds it**.

The register exists because a **true** gap comment is more dangerous than a false one. A false
comment contradicts behaviour and something eventually breaks; a true one reads as *known and
handled*, confers legitimacy, and **is itself the reason nobody looks again**. The 2026-07-27
sweep found 12 such gaps. All 12 survived by one mechanism: **they never entered `todos/`.**

`node todos/liabilities.js check` validates this file (also run by `todos/queue.js check`, the
`todos` suite in `tests/run.js`, and the pre-commit hook). It fails on:

- a `ticket:` that is **closed** (`todos/done/`) or does not exist — the funding evaporated;
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
- ticket: 0300          REQUIRED. The live item that funds closing this gap.
- file: os/wm.c         REQUIRED. Repo-relative path of the code location.
- anchor: <literal>     REQUIRED. One line that must appear EXACTLY ONCE in that file.
- defers-to: 0281       OPTIONAL. Milestone(s) this gap is deferred until. Must be OPEN.
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
2. **Closing a ticket.** `queue.js done <ID>` reports every entry that just went stale, and the
   check then blocks until they are retired or re-pointed. This is the moment 0291/0293/0300
   were all missed at.
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
- ticket: 0285
- file: os/kernel-worker.js
- anchor: } catch (e) { /* no prebaked blob served — fall through to the bake */ }

### L02 — the manifest.image branch is the production boot path's first fetch and no test takes it
- ticket: 0285
- file: os/kernel-worker.js
- anchor: var r = await fetch(manifest.image || 'os-system.img');

### L03 — "MessageBox raise stays silent" passes equally if the dialog never opened
- ticket: 0287
- file: tests/browser/os-sounds.mjs
- anchor: check('muted: MessageBox raise stays silent', w3 === w2, { w2, w3 });

### L04 — the VT-during-boot leg abstains whenever ready wins the race
- ticket: 0287
- file: tests/browser/os-boots.mjs
- anchor: // ready switch and the check passes vacuously — no flake either way).

### L05 — "boot streams on VT1" is unconditionally true once state !== booting
- ticket: 0287
- file: tests/browser/os-vt.mjs
- anchor: // fresh-OPFS first boot takes seconds; vacuously true if ready won).

### L06 — the wmctl-wait-timed-out guard exists kernel-side only; no browser harness has it
- ticket: 0287
- file: tests/kernel/lib/drive.js
- anchor: // Loud-symptom gate (todos/0171): a `wmctl wait` that can't be satisfied
- provenance: 0171

### L09 — NetSurf Lane D (binding fills) was left open in a topic doc, which is not the queue
- ticket: 0290
- file: todos/NETSURF-JS.md
- anchor: **Lane D — binding fills (M-L, item-parallel).**

### L10 — listdir.h defers wm.c's third copy to a menu redesign that has already shipped
- ticket: 0291
- file: os/listdir.h
- anchor: * todos/done/0250) — don't cite this header as covering it.
- defers-to: 0250, 0259
- expired: 0250, 0259

### L11 — `optional` bake assets make the blob machine-dependent; dependent launchers don't inherit it
- ticket: 0292
- file: os/os-common.js
- anchor: *   entry.optional — (with entry.bin) a missing asset logs a skip instead of

### L12 — headless boot.js takes no lock; the guard is a "noted-only follow-up" in a closed item
- ticket: 0293
- file: CLAUDE.md
- anchor: flock-style guard is a noted-only follow-up in the 0045 item). The
- defers-to: 0045
- expired: 0045

### L13 — only E/S/SE resize zones exist; "not in this version" has had no subsequent version
- ticket: 0294
- file: kernel.js
- anchor: * bottom-right corner -> SE (left/top edges just focus — moving-edge

### L14 — the 0211 divergence list is part-funded, so its unticketed entries read as tracked
- ticket: 0295
- file: todos/WIN32.md
- anchor: - **WM_MOUSELEAVE on surface exit**: the kernel routes input per-window

### L15 — statvfs reports a fixed 4 GiB volume, so df lies about a filesystem that can fill
- ticket: 0296
- file: compiler.js
- anchor: reports real free/used blocks is a TODO (needs a host import). */

### L16 — an unchecked "Immediate" box: 10 WASM imports with no C-level test
- ticket: 0297
- file: todos/BLOCK_FS.md
- anchor: - [ ] **C-level unit tests for the 10 untested WASM imports** listed above.


### L18 — the dispatcher documents a Playwright-missing skip that only fires on a spawn failure
- ticket: 0299
- file: tests/run.js
- anchor: // `optional` suites (browser sweep) report a launch failure as a skip, not a

### L19 — CLAUDE.md repeats the same skip-not-fail promise the sweep classifier does not keep
- ticket: 0299
- file: CLAUDE.md
- anchor: process; the browser `sweep` is optional (a missing-Playwright launch

### L20 — modals still draw min/max boxes; the descope points at a closed item
- ticket: 0300
- file: os/wm.c
- anchor: * title-bar boxes on modals — deliberately NOT done here, 0281.) */
- defers-to: 0281
- expired: 0281

### L21 — the WMP_F_TRANSIENT flag's own doc defers min/max suppression to the same closed item
- ticket: 0300
- file: os/wm_proto.h
- anchor: boxes — not implemented here (0281 scope note). */
- defers-to: 0281
- expired: 0281

### L22 — a 900x600 non-touch window gets phone defaults with none of the mobile controls
- ticket: 0301
- file: os/os.html
- anchor: // (900×600 — min() ≤ 700, innerWidth > 768) trips THIS predicate while

### L23 — registry writes since the last flush are lost on SIGKILL (the price of the batched flush)
- ticket: 0162
- file: os/win32/advapi32.c
- anchor: the last flush are lost on SIGKILL — flushing is batched to

### L24 — two registry flushes in the same instant still race on the rename; there is no advisory lock
- ticket: 0162
- file: os/win32/advapi32.c
- anchor: tmp+rename, and there is no advisory lock, so two flushes landing in

### L25 — search.h is absent, so four libc-tests are permanently skipped
- ticket: 0305
- file: tests/run.py
- anchor: "search_hsearch": "not implemented: search.h (todos/0305)",

### L26 — the BSD random()/srandom()/initstate() family is absent
- ticket: 0306
- file: tests/run.py
- anchor: "random": "not implemented: random()/srandom()/initstate()/setstate() (todos/0306)",

### L27 — strptime() is absent and strftime is missing six conversions plus width modifiers
- ticket: 0307
- file: tests/run.py
- anchor: "strptime": "not implemented: strptime() (todos/0307)",

### L28 — open_memstream()/fmemopen() are absent; there are no memory-backed FILE streams
- ticket: 0308
- file: tests/run.py
- anchor: "memstream": "not implemented: open_memstream()/fmemopen() (todos/0308)",

### L29 — the wcstol family and wide scanf are absent
- ticket: 0309
- file: tests/run.py
- anchor: "wcstol": "not implemented: wcstol() family (todos/0309)",

### L30 — strftime %s follows glibc/BSD (TZ-dependent) where musl is TZ-independent; nobody chose
- ticket: 0310
- file: tests/run.py
- anchor: # (todos/0307). %s additionally diverges from musl's expectation by the
- provenance: 0307

### L31 — three setjmp contexts C11 7.13.1.1p4 REQUIRES are rejected; the diagnostic even advertises one
- ticket: 0311
- file: todos/CONFORMANCE-REMAINING.md
- anchor: - **setjmp contexts required by C11 7.13.1.1p4 but rejected**:

### L33 — mouseover/mouseout/mouseenter/mouseleave and focusin/focusout are not generated
- ticket: 0317
- file: vendor/netsurf/netsurf/content/handlers/html/interaction.c
- anchor: 	 * core generates those yet — todos/0317). */

### L34 — a PROGRAMMATIC form.submit() would wrongly fire the cancelable `submit` event
- ticket: 0317
- file: vendor/netsurf/netsurf/content/handlers/html/form.c
- anchor: 	 * (Per spec a PROGRAMMATIC submit — form.submit() — does not fire

### L38 — tests/run.js's RULES table maps no vendor/ path except micropython; every other vendored project is UNMAPPED
- ticket: 0318
- file: tests/run.js
- anchor: // UNMAPPED on a diff. That gap is todos/0318.)

### L39 — SDecl's child-rewrite hook is a no-op, so a generic walker's rewrite of a declaration initializer is silently discarded
- ticket: 0326
- file: compiler.js
- anchor: // children-based rewriter's new subtree is silently discarded here.

### L40 — `inline` spelled only on a prototype or a re-declaration is dropped, so the inliner never raises its callee cap
- ticket: 0328
- file: compiler.js
- anchor: // only on a prototype or a re-declaration is dropped and the
- provenance: 0321

### L41 — a function with more than 65520 basic blocks still dispatches through an O(n) linear compare chain
- ticket: 0335
- file: compiler.js
- anchor: // more than 65520 blocks still degrade to the linear chain — see todos/0335.

### L42 — python's `time.localtime` is `gmtime`: there is no timezone database, so local timestamps are UTC
- ticket: 0117
- file: vendor/micropython/README.md
- anchor: - **`time.localtime` is `time.gmtime`.** There is no timezone database on this

### L43 — datetime/argparse/subprocess/hashlib/select/socket are absent from python's stdlib
- ticket: 0117
- file: vendor/micropython/README.md
- anchor: - **Modules a Python programmer will reach for and not find**: `datetime`,

<!-- END ENTRIES -->
