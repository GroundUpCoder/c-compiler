# #780 — restart interrupted stream operations after SA_RESTART handlers

A full #777 mapped gate failed solely because the sedit literal-colon polling
leg omitted its success token. Its original log did not retain guest output,
so its exact interleaving cannot be reconstructed. The original red remains
archived in the Foundation worktree; passing retries do not explain it.

Independent source investigation found that real guest pipe reads use RemoteFS
and interruptible kernel RPCs. SIGCHLD could cancel a pending read with EINTR.
The generic import safe point delivered the C handler but returned the failed
read even when the handler had SA_RESTART. Stdio consequently reported a stream
error as getc EOF; hush's command substitution stopped reading and its unquoted
empty expansion made a for-loop execute zero times.

A controlled real-hush experiment reproduced this on unchanged main 5fb9f091:
a normal seq substitution yielded 120 iterations; a background sleep exited
while a delayed substitution was reading, which yielded zero; the following
control yielded 120. Artifacts: build/777/substitution-baseline-red/
20260909-010543-58065 in the isolated signal780 worktree. The corresponding
Foundation-tree reproduction is preserved separately. This demonstrates the
restart defect independently of Foundation, without claiming direct observation
of the historical sedit event.

The existing BlockFS.toWasmEnv wrapper now opts read, write and accept into
restart handling. It captures the failed operation's errno before running a
handler, retries only EINTR with an exactly-true restart verdict, and invokes
the complete marshalling callback again to refresh memory views. Successful
partial transfers and EOF are final. Handler exceptions/nonlocal exits propagate.
Close and readiness/sleep waits retain their interruption behavior. Socket data
operations already use read/write; waitpid retains its existing restart loop.
No hush-specific retry or alternate signal dispatcher was introduced.

The external design reviewer, cc-meta thread
01a0819e-9dcb-7bad-ba89-934f1f18d5bf, was verified as Codex/gpt-6-astra.
Design comment 01a083b4-f8b9-7c87-9116-acfbb2ca81ee recommended this scope and
algorithm; it is not final source/evidence approval.

Validation so far: the controlled shell test changed from 120/0/120 to
120/120/120 with only the host fix. The import-seam test covers 28 boundary
controls, including handler errno clobbering and actual Wasm memory growth.
The compiled-C test observes a registered kernel waiter before delivering each
signal: read/write/accept with and without SA_RESTART, plus select's nonrestart
boundary. Its first run passed all seven intervals. The same C test using the
old main host failed at the restartable read (errno EINTR); the old host bytes
were verified against 5fb9f091. Those separate run manifests and raw outputs are
under build/777/restart-c-first and restart-c-old-host-red. Permanent hush
coverage checks every expanded value in order, rather than only counting them.
The sedit assertion now includes raw guest output when its token is absent.

Final author validation completed on staged tree
1047d0060180d3a76c0c4cc4f50e2f3d6910edcc. The standard flake gate passed
12 fresh kernel and 18 fresh browser repetitions under ten CPU-load workers;
the four focused restart/signal/sedit tests then passed three fresh repetitions
each under the same load. Carried results were excluded, repeat indices checked,
and manifests plus individual logs archived before subsequent runs.

The complete mapped gate build/777/restart-gate/20260909-013629-64090 passed
at 2026-09-09T02:45:00Z, with sourceUnchanged=true. Dispatcher run
20260909-013629-64095 selected all 23 mapped suites with no filter/resume;
all seven aggregate rows passed. Kernel 202/202, browser 70/70 and BlockFS
15/15 were fresh passes. Python reported 896 passes and 111 skips; the named
skip baseline was checked with zero violations and zero exempt skips. Unit
reported 849 passes and three existing skips; all host tests passed. This is
the repository's mapped merge gate, not its full deployment gate. Complete
history and child logs are archived under the wrapper run directory.

Independent source review by verified Codex/gpt-6-astra thread
01a0834a-4bfc-79cf-a974-4f4e93edaf28 found no blockers (ticket comment
01a083c6-50c6-779c-ba75-8d248a2a0ca1); that reviewer independently passed
the 28 permanent host controls and eight additional boundary probes. Final
evidence approval and merge are pending. This final journal update changes no
implementation or tests. #777 and the authorized Foundation/string/collection
chain remain pending their own validation and integration; no Foundation source
is changed by this isolated fix. The historical sedit interleaving remains
unobserved; the controlled restart defect and its fix have direct red/green
evidence, rather than an attribution invented from a passing retry.
