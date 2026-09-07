# #762 — orthogonal debug metadata and inline controls

Epic: in-OS C/SDL developers need to preserve the actual faulting call chain
without annotating every function in their program. Claimed by the serial
campaign thread 01a07a75-35a9-7147-8cef-df7a705cd802, after #761 completed its
focused validation. No parallel implementation workers.

At `4f307d0a`, createCcDriver accepts -g/-g1 but rejects -g2 and -fno-inline;
the host frontend accepts -g2 but silently ignores -fno-inline. runPasses calls
inlineFunctions without per-module options. These are verified source paths,
not the stale line numbers in the original ticket.

RED `458c1432`: direct in-OS and host default -g builds pass the positive
control (three helpers inline, one main frame at line 4). In-OS -g2 and
-fno-inline refuse; host -fno-inline still emits the collapsed one-frame trace.
Four intended failures. The earlier test attempt matched the wrong textual
frame format; corrected before the RED commit. No such failure is product
evidence.

Implementation: `noInline` in both frontend compilerOptions flows into the
module's existing inliner-options shape (`enabled:false`), consumed by the
normal runPasses seam. It does not mutate inlineDefaults or any global setting.
-g2 in createCcDriver sets emitNames + embedSources AND supplies pp.sourceBuffers
to generateCode, matching the host path. Merely adding the two booleans did
not embed sources; the regression caught the missing buffer plumbing.

Decision: -g/-g2 remain metadata-only. Neither implies -fno-inline. The crash
footer teaches `cc -g -fno-inline`; developer docs explain both flags and the
embedded c.sources format. Image version 285 refreshes the baked driver/docs.

Focused host test now passes with positive WAST.lastPassStats.inline evidence:
ordinary/-g builds inline >=3 calls, disabled builds inline zero, and a later
ordinary build in the same process again inlines >=3. Both actual frontends'
-g -fno-inline builds report depth3/depth2/depth1/main with the fault at line1,
where ordinary -g reports main at the call site line4. The in-OS -g2 section is
parsed as JSON and its source is exactly the input text. Unknown -g3, a misspelled
-fno-inlien, and --unknown still refuse by name in-OS. Existing trap-backtrace
host tests pass with the updated footer. Host unknown-option policy is the
next separate concrete audit item; this ticket does not claim to fix it.

Real browser and headless abort-backtrace e2es additionally compile and run the
unannotated chain with `cc -g2 -fno-inline`, asserting exit139, all four frames,
and the actual line1. Integration and repetition results follow below.

Focused integration `762-integration`: one newly executed kernel file and one
newly executed browser file PASS, including the prior abort/assert controls
and new debug-flag chain. `762-flake`: the changed file passes **3/3 in EACH
host under load10**, freshly executed; carried rows excluded. Four existing
AST files pass (WAST inliner, passes, validator, inline-hint propagation).
No full-estate claim: final standard flake, fresh unfiltered full dispatcher
and manual both-host campaign validation remain required.
