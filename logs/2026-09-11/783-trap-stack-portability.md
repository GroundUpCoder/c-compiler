# #783: retain function-only WebKit trap frames

The #782 browser admission failed its required diagnostic assertion even
though the real RuntimeError propagated and teardown drained once. A separately
authorized one-record WebKit26.5 diagnostic captured
`57@wasm-function[57]`, followed by a JavaScript caller line. The existing
formatter found no offset-bearing frame and returned null. Independent
attribution: #782 comment 01a08bee-9f03-7876-89d2-a2d9a53c2c5c.

This separate repair starts from cee82600. The parser/formatter source seam
was unchanged in #782, but historical WebKit execution is unproven; this is
not evidence of a regression introduced by #782. Its approved snapshot and
all admission failures remain preserved. #782 validation depends on #783.

Recognize the complete JSC `NAME@wasm-function[IDX]` line separately from
V8's offset-bearing form. Resolve the index through a name section when
available, keep absent offsets as null, and omit both the offset and source
location in that case. The report explains why those frames lack locations.
Neither function index nor adjacent JavaScript caller is a Wasm byte offset.
The original V8 parse and known-offset source lookup remain unchanged.
Reporter ownership, error classification, delivery and once-only handling
are unchanged.

The captured-stack formatter regression was actually red on baseline source
and passes after the repair: 14 Node checks cover named/unnamed modules,
with/without source maps, a map starting at zero (to catch invented zero),
real zero and nonzero offsets, mixed frames, and malformed/non-frame text.
It is captured-engine fixture evidence, not another browser run. Existing
trap-backtrace, abort-backtrace and frame-lifecycle Node tests also pass.
Fresh real-engine validation and mapped gate scope remain coordinator-owned
and pending; no backend acceptance is implied by these focused tests.


## Final validation record

The pending validation above is now complete for the #783 targeted merge
gate. Independent source approval is recorded in #783 comment
`01a08bf7-2398-7391-98c0-e9090f6cd631`. Four real synchronous-main trap
records (named and unnamed modules in WebKit 26.5 and Chromium
149.0.7827.55) passed: WebKit preserved unknown offsets honestly and Chromium
retained its actual offsets/source locations. Independent stage0 acceptance:
`01a08c05-91d3-7548-90f2-c69ce03ea527`; evidence under
`build/trap783/validation-_piith5l/` and `browser-probe-mO1aKH/`.

The fresh diff-mapped gate against
`cee826008152435813358a49e9dc995d78b540bc` completed as run
`20260910-170630-83674`, using the reviewed durable supervisor under the
one-shot coordinator grant `01a08c48-27ad-7953-a6c8-1d3a4387fe74`.
Dispatcher and native supervisor pane both exited 0 after 4,176.25 seconds.
All 23 selected suites (seven aggregate rows) passed: todos 3/3, unit
849 passed / 0 failed / 3 skipped, host all passed, BlockFS 15/15,
kernel 203/203, and browser 71/71. Member manifests and logs were fresh,
with no filter, resumed or carried results. Browser abort-backtrace,
null-trap and frame-lifecycle diagnostics/status/lifecycle checks passed.

Python reported 895 passed / 0 failed / 112 skipped: 111 fixed skip names
and reasons matched the checked-in baseline exactly; the remaining exempt
`fuzz/live-680273963` skipped because its csmith/native leg timed out.
Not every generated native comparison ran. The quiet unit output does not
identify its three skip names. Raw stderr, including fixture diagnostics
and MaxListenersExceededWarning, is preserved; this was not a warning-free
run.

Final evidence is under `build/trap783/durable-run-gate-oymt513s/`, including
`launch.json`, `supervisor.json`, raw logs, process/pane observations,
`gate-artifacts/` and `author-audit.json` (SHA256
`ee095ebe33da2ad32d8987a521de85ddca346b52a941cff15ec74c647654735b`).
Independent final acceptance `01a08d17-daa7-7a8c-bf5c-d618dce5813e`
verified all 309 archive/current hashes, source/instrument pins, native
outcomes and the skip qualifications. The implementation/test bytes remain
identical to those reviewed and exercised; only this journal record follows
that validation.

The original interrupted gate in `validation-qqhu3ues/` remains incomplete:
its actual exit, signal, actor and termination cause are unknown. Its logs,
manifest and old lock bytes remain preserved, alongside the earlier #782
admission/diagnostic failures. The successful run used authorized canonical
stale-lock acquisition after current-owner checks, without manual unlink;
normal completion released its locks. The three supervisor controls were
independently accepted only within their cooperative forwarding, ignoring
child escalation and admitted late queued-signal drain scopes.

This evidence satisfies the targeted #783 merge gate, not the full ship tier:
`netsurf-patch`, `disw` and `sourcemap` were deliberately omitted by the mapper.
It does not accept #782/#781 or their future integrated bytes. Dependent
integration, fresh pins/mapping/validation and landing sequencing remain
separate. No deployment or retained-server cleanup was performed.
