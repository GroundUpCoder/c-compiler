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
