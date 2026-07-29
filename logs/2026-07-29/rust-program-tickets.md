# Rust on gucOS — the program enters the queue

Branch `rust-tickets`. This change files tickets. It changes no code. It records
why the program has this shape, and why two of its units are deliberately absent.

Filed: `todos/0413` … `todos/0418`, plus the program document `todos/RUST.md` and
one liability entry, `L61`.

## The verdict this implements

A feasibility investigation and a design pass ran off-repo. The design pass ruled
**proceed with modifications**, and the modification is one sentence: **split the
program, and move the gate.**

The toolchain half is funded without a condition. A probe already built a stable
Rust module that gucOS ran, so the language question is answered and the remaining
work is bounded. The application half — a headless `codex exec` on gucOS — sits
behind a measurement gate, because the design pass found it materially under-costed.

## Why a program document, and not six self-contained tickets

Four tickets share one contract: the `"c"` import namespace, the three required
exports, one libc, one heap, one producer, and a base image with no Rust in it.
Repeating that contract four times gives four copies that drift.

`todos/RUST.md` holds it once, on the `todos/CLANG-CPP-EPIC.md` pattern. That
document is the same problem one language over, and every rule in `RUST.md` §3 is
its rule with the language name changed.

## Three things the tickets say that the hand-off did not

**The ABI is three exports, not two.** `host.js` plays crt0 itself. It enters at
`main` and not at `_start`, so it lays out `argv` in the memory of the module and
calls the module's own exported `alloca` to get the space. `host.js:11725` makes
`args[0]` the path of the module, so that path always runs. A C module gets the
export for free. A Rust module does not, and the probe hit exactly this. The
contract is `main`, `memory` and `alloca`.

**`todos/0413` cannot run in a browser terminal, and the ticket says so.** A binary
reaches the image only through the packaging seam, which is `todos/0416`. The
hand-off asked `0413` to print in a gucOS terminal. A kernel-suite test can do that
headless, and it does. The browser leg moved to `0416` with a sentence naming the
reason, so a later reader does not read the absent leg as a cut scope.

**The test of `todos/0413` is unconditional on purpose.** This repository has no
`rustc`, and it must not gain one. A test that only runs when the sibling repository
is present is a test that a normal kernel run never runs — the vacuous-leg pattern
of `todos/0287`. So `0413` commits a small `hello-rust.wasm` fixture and runs it
always, and it adds a second leg that rebuilds the fixture from the sibling and
asserts the bytes are equal. A fixture without a freshness check rots quietly, and a
rotted fixture proves nothing about the crate of today.

## `todos/0417` is filed on its own merits

The Rust program found the gap. The gap belongs to the estate.

An HTTP transfer id comes from a private counter. It is not a file descriptor, so
three things are true at once. `_selectScan` walks the fd table and cannot see a
transfer, so no transfer can join `FS_SELECT` or the unified `FS_WAIT`. Both HTTP
park ops write `pcb.waiter`, and a process has one waiter slot, so a process with
several transfers in flight cannot ask "wake me when any of them is ready".
`_httpStart` arms no timer, so the kernel sets no deadline at all.

The hand-off said a hung request wedges a process forever and it cannot be killed.
That is too strong, and the ticket says the accurate thing instead. The park **is**
interruptible: `kernel.js:1457-1458` passes the interruptible flag, and
`_cancelWaiter` handles both HTTP waiter kinds. The libcurl veneer builds
`CURLOPT_TIMEOUT` out of exactly that, with an `ITIMER_REAL` alarm. The real defect
is that the deadline lives in every caller, and a caller that arms no alarm waits
with no limit.

`todos/0417` also splits the deadline in two. A total-duration cap is the wrong
shape, because a legitimate download runs for minutes and a server-sent-event stream
stays open for as long as the model keeps talking. A headers deadline and an idle
deadline describe the failure everybody actually means, and an idle deadline lets a
slow but live stream through.

## `L61` — the register entry, and why no code changed

The comment at `kernel.js:7108` states the limit accurately: "At most ONE HTTP op is
parked per process". A true gap comment reads as known and handled, which is why the
register exists. The sentence implies work, so it needs a ticket and an entry.

The entry anchors on that line and names `todos/0417`. The comment itself was **not**
edited here, on purpose: this change is todos-only, and editing `kernel.js` would
make the planner select the kernel suite for a change that alters no behaviour.
`todos/0417` carries the obligation to re-anchor when the comment is rewritten.

## What is NOT filed, and why

**C2 — the standard-library work.** Its scope is whatever `todos/0418` rules. Filing
it now would pre-commit the answer.

**D1 — port `codex exec`, or write a native gucOS client on the same wire
protocol.** It waits on the ruling of `todos/0418` **and** on `todos/0417`. A
decision taken without both inputs is a guess.

**A separate ticket for the census re-run.** The census left a null result: the
machine has no C compiler that can target wasm, so 9 of its 22 failures came from
the instrument. That re-run is step 1 of the plan of `todos/0418`, because a decider
with a known-faulty input is not ready to rule. It is an input to a ruling, not a
unit of shippable work.

## The evidence that must not be quoted alone

`todos/0418` carries the census numbers, and it carries the population warnings with
them. The two that a later reader will be tempted to drop:

- **1334 is not the graph.** It is the package count of `Cargo.lock`. The
  `codex-exec` graph is **838**, and **543** of those already compile for
  `wasm32-wasip1`.
- **9 of the 22 failures are unmeasured.** `ring` is refuted outright — its
  `build.rs:594-599` cross-compiles for wasm — and it failed only because Apple
  clang has no wasm backend.

And the blocker the design pass missed, which now has a home: **2 of 132 codex
workspace manifests declare a `[features]` section**, and neither `exec` nor `core`
is one of them. "Cut the subsystem" is not a cargo flag. It is manifest surgery plus
call-site deletion, and it had no estimate anywhere. `todos/0418` owes one.

---

# Amendment — a second design pass

A second design pass ran on the same investigation document, independently and
adversarially. **It never saw these tickets**, so it neither blessed nor faulted the
filing. It read the same source and reached its own answers. Where those answers
meet the first pass, the meeting is evidence. Where they disagree, the disagreement
is now recorded as a disagreement.

## What two passes agreeing bought

`todos/0417` was reached twice, separately. That is the strongest signal this
program produced, and the ticket now states its standing accordingly: a **hard
unconditional prerequisite**, not a Rust-contingent one. It blocks a port of
`codex exec` and a native client **equally**, because both must multiplex one
long-lived stream against timers and child waits.

The second pass added two facts. `_selectScan` (`kernel.js:6766`) knows five OFD
kinds — `tty`, `ptm`, `pipe`, `socket`, `watch` — and an HTTP handle is none of
them, so a transfer never enters the fd table at all. And at most one HTTP operation
is in flight per process. Together they give the consequence the ticket now states
plainly: **an async runtime cannot multiplex a server-sent-event stream against
timers, a child-process wait, or a second request.**

## Two readings, reconciled rather than overwritten

The second pass wrote that `__http_read` parks "the entire process, with no
non-blocking variant". The first hand-off wrote that a hung request wedges a process
forever and cannot be killed. This lane's own reading found the park interruptible.

The ticket now says the thing all three were circling: **interruptible is not
pollable, and it is not multiplexable.** A signal releases the park
(`kernel.js:1457-1458`, `_cancelWaiter`, and the `ITIMER_REAL` alarm in
`os/curl/libcurl.c`), so a process can be killed. It still cannot ask "is it ready?",
and it still cannot wait on a transfer beside anything else. The correction changes
the wording and leaves both defects standing.

## Where the two passes disagree — recorded as open, not resolved

**`ring`.** Pass one refuted it as a blocker on `build.rs:594-599`, which
cross-compiles for wasm. Pass two read `ring` and `aws-lc-rs` and found "no wasm
story" for either. `todos/0418` now carries the dispute as a dispute, to be settled
by one build and not by more reading. Neither verdict is inherited as fact.

**`tokio`.** "It has a wasm arm, so this is a feature reduction, not a fork" is true
in general and misleading here. codex hand-builds a multi-thread runtime,
`rt-multi-thread` is explicit in five crates, and two `block_in_place` sites
hard-panic on a `current_thread` runtime — which is the only runtime gucOS can
offer. The general claim stays; the qualification now sits beside it.

## The contradiction the tickets had to resolve

"Stable `rustc 1.96.1` is sufficient" was measured on `wasm32-unknown-unknown` with
`#![no_std]` and a `cdylib`. The custom-target path is a **different** path: it needs
`-Zbuild-std`, which is unstable, and no nightly toolchain is installed here. Left
unqualified, the stable claim would have quietly licensed a nightly dependency.

`todos/0418` now names the resolution as a required output of the ruling: say which
path, and therefore whether nightly is required. If it is, the estate also buys a
pinned nightly and a documented bump procedure, which the investigation never
mentions. `todos/0414` and `todos/RUST.md` §5 carry the narrow true version — Lanes
A1 to A4 stay stable, because `core` and `alloc` ship precompiled for that target.

## Two traps that would each have cost a debugging session

**`alloca` is effectively mandatory, not one export of three.** `host.js:11523` reads
`instance.exports.alloca` and calls it with no test, inside a branch that always
runs. A Rust module without the export traps before `main`. The tickets now spell out
the consequence, and `todos/0413` asks for a test that proves it — a contract nothing
exercises is a contract nobody keeps.

**`--allow-undefined` routes a missing import to module `env`, and `host.js` serves
only `"c"`.** So a Rust `extern` block without
`#[link(wasm_import_module = "c")]` produces a module that fails when it loads, far
from the block that caused it. The Rust build therefore links **without**
`--allow-undefined`, so a miss fails at link time with the name of the symbol. This
is the loud-failure rule, not a style preference. The clang sibling does use the flag
in one test harness (`run-libc-test.sh:94`); the Rust build must not copy it.

## Two scope corrections that make the census a floor, not a ceiling

**WebSockets cannot be configured away.** `supports_websockets = true` is hardcoded
for the built-in provider, and `disable_websockets` is a private atomic latch rather
than a configuration key. The original plan assumed a setting would select the HTTP
and server-sent-event path. It will not.

**The 838-crate census may understate the port.** An in-process application server of
roughly 64,000 lines now rides the exec path, and the crate map predates it. The
figure is flagged wherever it appears.

The sandbox note lands the other way, in the estate's favour:
`should_run_in_sandbox()` is platform-blind and re-executes a helper subprocess per
file operation. **The browser tab is already the sandbox**, so the fix is to default
to full access and delete a process per file.

## One instruction that reads backwards until you see why

The census left 9 crates unmeasured, because this machine has no C compiler that can
target wasm. The obvious next step is to install one and re-run. **The standing call
is not to.**

It is correct. All 9 are C or C++ build scripts, so they price the **application**
half. `todos/0418` rules on the standard library, and that ruling does not depend on
them. So the null result stays open, it is carried to D1 as an open input, and the
ruling must say which answer it assumed. A decider that fires probes for inputs it
does not need is a decider that never rules.

## Port versus native stays open, on purpose

A coordinator leans toward a native client. The second pass explicitly refuses to
pre-judge: it recommends the decision be made on the numbers of the census, not on
the sizing of a document that is now refuted.

`todos/0418` records both, and marks which is which. **A lean is not a
measurement**, and D1 inherits the refusal rather than the lean.

---

# Amendment 2 — the reconciliation of the two passes

A reconciliation of the two design passes arrived with seven corrections, A to G.
**Five of them were already in the branch**, and the master verified that before
sending. This note records which five, so that no later reader re-litigates them.

- **B** — the 9 asm-FFI failures are the instrument, not the crates, and no probe
  fires. Already at `0418`.
- **C** — `tokio` has a wasm arm, and the fork work sits at the codex layer. Already
  at `0418`, with the two `block_in_place` sites.
- **D** — 838 measured crates, not the 1334 lockfile count, and the understatement
  caveat. Already at `0418`.
- **E** — the base and `alloc` rung is stable-only; nightly, `-Zbuild-std` and a
  custom target belong to the standard-library rung. Already at `0413` and `0414`.
- **F** — `wasm-ld --allow-undefined` attributes to module `env`, so link without it.
  Already at `0413` and `RUST.md`.

Two items were live. One of them ruled that the existing text was right.

## `ring` — the request to mark it refuted was declined, and the reason is the record

Correction A asked for `ring` to be recorded as **refuted** as a blocker. The master
ruled the other way, and the ticket keeps its open-dispute framing.

The reason is that correction A is in tension with correction B, which the same
message also makes. B rules that a crate which failed the census for want of a wasm
C toolchain is **unmeasured** — neither buildable nor unbuildable, with no probe
fired. `ring` failed for exactly that reason, so `ring` is a **member** of the B
class, and B's own discipline forbids promoting it to "cleared" on a source read.

The distinction the ticket now states: **a source read can refute a claim that a
crate is a blocker; a source read cannot establish that a crate builds.** Those are
different claims, and only the first one is answerable by reading.

Two edits landed. The section now says `ring` belongs to the unmeasured class, and
the standing no-probe call covers it — so nobody reads it as a loose end that a cheap
check could close. And it records the asymmetry of the evidence plainly: pass one
cites two locations, pass two cites an impression with none. That asymmetry is a fact
about the evidence, and it is not a licence to settle the dispute.

The operative half of A needed nothing: the true-blocker list already reads
`socket2`, `tokio`, `aws-lc-sys`, `v8`, with `ring` correctly absent.

## The auth line — a real defect, and the class of defect matters more than its size

`RUST.md` asserted that a ChatGPT sign-in is "structurally impossible" on gucOS,
because the sign-in needs a local TCP listener for an OAuth redirect.

**The conclusion survives. The mechanism was false.** Three checks refute it, and
this lane ran them rather than take them on trust.
`~/git/codex/codex-rs/login/src/device_code_auth.rs` exists — a device-code flow, in
the very login crate the claim was about. `grep -cE 'TcpListener|bind\('` on that file
returns **0**; it polls over HTTP, so it needs no redirect and no listener. And
`TcpListener` appears in **no** file under `login/src/`.

The line now rests on the true ground: **API-key-only, because `codex login` is out
of scope for the headless `codex exec` form this program targets.** The
impossibility claim and the listener reasoning are deleted, and both `RUST.md` and
`todos/0418` carry a short retraction naming the file to read if the scope ever
changes. Leaving the false mechanism in place would have cost a later reader an auth
design built on a property that does not hold.

⭐ **Why the class matters.** This was a line that **asserted a property holds**, not
one that truthfully named a gap. Nothing machine-checks it, and it reads as settled
research, so the next reader prices work off it and never derives it again. That is
the inverse of a liability comment: a gap comment invites the check, and an assertion
suppresses it. So **no `LIABILITIES.md` entry was added** — the register is for lines
that accurately say something is absent, partial or untested, and this line did the
opposite. Correcting the text is the whole remedy.
