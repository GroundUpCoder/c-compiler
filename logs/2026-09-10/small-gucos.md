# Small uses the gucOS C process host

User-requested integration: make Small a sibling compiler available inside gucOS,
automatically imported from a valid ../small checkout during image assembly.
This enables Small application development inside gucOS. There is no deployment
or language/widget-library redesign in this change.

The shared boundary is the existing C process host, not a parallel OS runtime.
Small exports its existing linear memory and wrappers over its allocator for
startup and temporary host buffers; it retains Wasm GC object/string values.
Small string helpers come from its compiler's self-contained host factory,
snapshotted into the image. String output encodes UTF-8 and calls the existing
C write import so descriptor ownership, pipes, errors and redirection are shared.
Arguments, environment and errno use the C startup hooks. Small's entry validator
rejects incompatible main signatures before writing an output binary.

The image imports compiler, runtime and library bytes together and records a
SHA-256 content identity. The Node build paths compare this identity rather than
relying on sibling mtimes, which cannot detect deletions or removal. Browser
OPFS reuse also checks the expected snapshot from adjacent image metadata;
image content is checked before installation. Missing/inconsistent metadata
forces regeneration on Node serving/fixture paths. The current image manifest requires metadata; absence refuses browser boot.
Legacy manifests without that requirement retain version-based browser refresh. Publish image and metadata together.

Validation stopped on insufficient disk space (about 2.3 GiB free; harness
minimum 3 GiB). Small's 284 tests and 3 editor tests passed; installed-host,
real kernel compile/run/pipe, and initial real Chromium compile/run/pipe probes
passed. The later browser publication cases have source-review approval but
remain unexecuted. Independent external Astra review thread:
01a08ae9-2cb9-72d1-a1e1-99696cc0b5e3 (Codex executor/model verified).

The mandatory diff gate ran todos (3/3), unit (849 pass, 3 skip), host (ONE
failing file, test_heavylock_gate), BlockFS (15 pass), and part of the Python
consumer batch before it was stopped. Full kernel/sweep and flake validation
remain. No fresh run-level completion artifact exists. Do not treat this as a
green gate or a deployment record. The failed preflight was reproduced directly;
automatic fixture cleanup could not restore the required disk headroom.

Follow-up: the user freed disk space; 27 GiB is now available. The integration
is being checkpointed separately from unrelated sedit files at the user’s
request. Regression validation will be rerun against the checkpoint parent;
this commit does not claim a completed gate or deployment.

## Disk recovery and browser publication regression

With 27 GiB free, test_heavylock_gate.js now passes and Small’s seven gucOS
target tests pass again. The extended browser test initially failed after its
compile/run/pipe checks. A diagnostic rerun reproduced Chromium’s DevTools
pipe refusal: the route.fetch/fulfill image transport exceeded 104857600 bytes.
The test now rewrites the alias request with route.continue so Chromium fetches
the binary directly. All four checks pass in real Chromium, including the
stable metadata fallback and missing-required-metadata boot refusal.
Original failure and diagnostic logs are retained in /tmp/c-small-browser-recheck.log
and /tmp/c-small-browser-diagnostic.log; passing run: /tmp/c-small-browser-fixed.log.
A fresh mapped 23-suite diff gate against cee826008152435813358a49e9dc995d78b540bc
has started; its result will be recorded separately.

## Completed mapped regression gate

Run 20260910-122716-49617 completed at 2026-09-10T13:29:49Z, exit 0,
3752.9 seconds. All seven dispatcher rows passed across 23 selected suites:
todos 3/3; C unit 849 pass/3 skip; host PASS; BlockFS 15/15; consumers
896 pass/0 fail/111 skip; kernel 204/204; browser 72/72. Kernel and browser
evidence is complete, with no resumed/carried results. The Small tests passed
inside both complete suites. This is the mapped diff gate, not the full ship
gate: netsurf-patch, disw and sourcemap were deliberately omitted by the mapper.
No push or deployment was performed.

The mapped source was defdf29b plus the already-applied browser transport fix
subsequently committed as 9d4ca336 during the run. No source was changed during
the gate; only validation documentation and the commit boundary changed.
The producer Small compiler is still the reviewed working copy, including
pre-existing access-control edits; this gate is not evidence for pristine
Small main without those edits.

The full aggregate result is preserved in small-gucos-diff-result.json. Original
child summaries and complete dispatcher logs remain under
build/test-run/history/20260910-122716-49617/. Under-load validation is running
separately; it must not overwrite the scope of this completed result.

## Completed under-load validation

All three commands exited 0: standard tests/flake.js (12 fresh kernel and
18 fresh browser executions, each selected file repeated three times), focused
Small kernel (3 fresh executions), and focused Small browser (3 fresh executions).
All ran with the default 10 CPU load generators. Every selected file was stable
3/3; carried records in filtered summaries are not counted as fresh executions.
Commands, exits and durations are in small-gucos-under-load.json; the complete
ANSI-stripped repetition log is in small-gucos-under-load.txt. The ordinary
shared heavy lock covered these sequential commands and was released at exit.

Final reviewed source pins still match: Small compiler and editor mirror
e003be360683a81fb4c3230a01e372e315fb622da22751bbe92365807744923c;
C browser test ef311776dfbb8fbd1715bd69945be07cac95f518079c0e31cc5105beb40907eb.
The earlier disk interruption and browser transport failure remain historical
failures, not relabeled passes. No unrelated worktree or source was removed.
