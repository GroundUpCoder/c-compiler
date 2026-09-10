# #782: invocation-owned async callback termination

Classification: contract-violation / stability, P0. Author external thread
01a08ae6-ef89-7135-8805-dfbd01b925c9, verified codex/gpt-6-astra. Base cee82600.
Game/editor callbacks must terminate their owning runtime so the run/crash/
diagnose/iterate loop can finish reliably.

Both baseline compiler.js and host.js from cee82600 reproduce a plain C timer
callback exit134 as an unhandled rejection, with no runModule settlement.
Retained evidence in #781 worktree: build/objc781/baseline-async-r3v8k7i4/run.json.
Observer73 is instrument status, not application status. The earlier modified-host
C probe alone did not prove historical presence; baseline extraction does.

The common host seam now owns synchronous throws and Promise rejections, routes
the original exit/error to entry or frame lifetime, cancels callbacks before
awaiting terminal drain, and drains once. Pending filesystem suspension
subscriptions are removed on successful completion. Cancellation unwinds Wasm;
an underlying host operation, such as a sleep timer, may finish without resuming
application code.

Independent review found ordinary ExitStatus rejection lets C __catch consume
cancellation and continue. The repair uses the engine native uncatchable trap
as a PRIVATE cancellation token and restores the original termination reason by
object identity in the owning host catch. No compiler C-catch change or parallel
unwinder; the token is never reported as an application trap. A JavaScript-created
RuntimeError is not equivalent. The tiny lazy module has one function containing
unreachable, no imports/memory, and a fresh token per terminated invocation.
The Wasm EH [JS trap contract](https://github.com/WebAssembly/spec/blob/main/proposals/exception-handling/Exceptions.md#traps)
preserves uncatchability across JavaScript frames; a bounded author engine probe
also observed it across Promise rejection. Browser acceptance is separate.

The same review exposed normal-return drain starting before timer cancellation.
The once-only drain helper now closes callback admission and cancels pending
continuations before its first await. Independent valid failure evidence remains
/tmp/review781-delta-nw4t8d/run.json; the earlier reviewer decoder-bug artifact is
explicitly invalid and retained separately.

Permanent tests compile real C with unchanged baseline compiler and launch actual
JSPI-enabled/disabled Node children with strict unhandled-rejection failure.
They cover exit/error identity, successful callback work, main/frame/callback
suspension with and without C catch-all, and queued callbacks during delayed
normal-return drain. Injected drain counts/delays measure ordering, not a GPU.

This ticket has its own isolated worktree and registry addition. #781 supplies
only the dependent ObjC callback lookup/guard and compiler/ObjC contracts. The
registered async test/evidence helper do not depend on #781 files. Source review
and serialized gates precede landing; no browser/OS/GPU/stress/mapper acceptance
is inferred from lightweight Node results.

Direct __exit uses the same private trap, so a callback's own C __catch cannot
consume process exit before the host sees it. Callback admission closure and
invocation termination are distinct states: normal return closes admission before
drain; later libc exit preserves its nonzero return status. The first explicit
termination reason wins. Tests include C catch around direct callback exit and
normal-return statuses0/7 through a delayed drain.


## Focused batch integration (2026-09-11)

Direct user policy now groups #783 -> #782 -> #781 -> #778 -> #779 with
focused per-ticket checks and one final combined broad gate. The older
per-ticket gate wording above describes the historical plan. Broad batch
validation remains PENDING.

Integrated onto batch commit1d077229 (Small main93310c63 plus #783).
The sole textual conflict was final return: Small undefined-exit normalization
is preserved inside the lifecycle try/finally, keeping cancellation/drain.
Original frozen #782 source and all failure evidence remain unchanged.

Actual focused Node runs pass: async lifecycle in real JSPI-enabled and
disabled Node children, installed Small execution, captured stack14, trap
backtrace, abort backtrace and frame lifecycle. Evidence is in
build/trap783/integrate782-965lmu7p/focused.json and build/async782/node-*
in the integration worktree. Injected drain tests measure ordering, not GPU
execution. Browser engine evidence on these integrated bytes remains pending;
no new browser/OS or broad gate ran during this integration.

Actual bounded browser attempt at tree5ccf23a5: 13 fixture passes (Chromium149
seven, WebKit26.5 enabled six), ONE engine admission failure and six unrun.
Requested JSC_useJSPI=false still exposed both JSPI APIs. Cause of option
propagation/effective-setting failure is unproven; no host regression inferred.
The genuine WebKit trap now reports its index-only backtrace correctly.
Native child/pane exited1; all three browser launch/cleanup logs preserved.
Audit40938f4a in durable-run-gate-cmvbbhqb and child
build/async782/engine-admission-v3-dc4f8k retain the red unchanged.
Independent audit78201a08d35-aec5 accepts only the13 scoped passes.
Disabled-browser coverage remains PENDING and the overall admission FAILED.
Coordinator78201a08d35-46d8 authorizes separate batch commit/progress while
this browser configuration is investigated read-only. No retry performed.
Final five-ticket broad validation and main advancement remain pending.
