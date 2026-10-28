# #785 Node-worker stage v2 — bounded durable preparation, NOT a launch grant

Only this stage is prepared for the next serialized coordinator window. No
cmdalt/browser launch or automatic chain. Original instrument freeze86e1437e
is unchanged; its full findings are retained as review-v1.md. This separate
revision addresses the Node exact-record/native-finalization findings. Browser
positive-RO and exact-record/data/alias findings remain pending in its separate
revision; the old browser draft is NOT accepted for execution.

## Source and execution contract

Actual input: parentaacbd1675336927543b6ad2434de9d5188767ff3, staged tree
2403c16ccff8faf749ff78df17aa0fb10987fe7e; manifest3ece6c3c; index patch9d1759f4.
Product remains hostfbe30fe0/kernel2efb7afd/worker345c96d1, unchanged approved
v2. run.json pins full reviewed input set, instruments, executables, unchanged
parent-watch/health guards and V4 reference. Exact prospective Node executable
926d267c is current preparation evidence only, never retrospective test history.

Workload: one C compile (120s compiler timeout), then four sequential cases:
leaf local, equivalent broker fixture, local-fd child inheritance/promotion,
nested-mount whole fallback. Four boots have90s watchdogs each. Outer owned
child deadline600s, then TERM and >=5s escalation if needed. No retry, fallback
run, signal-control replay or successful-corpus repetition. Finalization uses
V4's signal servicing/cutover contract; the600s limit is a CHILD deadline, not
an invented bound on every filesystem fsync/archive or native post-cutover event.

Exact direct child argv is in run.json: pinned Node -r unchanged parent-watch,
this revision's node-worker.cjs --execute authorized-config.json. There is no
extra shell between Python Popen and Node. Python owns start_new_session child
and truthfully sets CC_HARNESS_GROUP_LEADER=1. Compiler is a native child of that
Node, same process group; guest workers are actual worker_threads. Capture the
compiler pid/status/signal, per-guest kernel status, terminate-request flag and
real worker onExit value. A worker exit after requested termination is not
misreported as a normal guest exit; guest wait0 is independent.

Exact op/path multiset, not just total count, is checked for each invocation.
Every DATA record is compared to the independently read owner fixture byte.
The three inheritance records must each appear once. Hardlink and absolute
symlink aliases remain in the leaf fixture. The broker comparison uses the same
namespace contents/owner assignment contract; volume timestamp bytes can differ
between independently generated fixtures and no byte-identical-image claim is
made. All actual volume images, compiled module and owner oracle are saved and
hashed before guest execution. Native worker exits are awaited before inner
source-after.json and outcome.json. Early exceptions/timeouts may lack inner
terminal files; that is a failure/partial record, never repaired into a pass.

## V4 durable wrapper, explicit adaptation

supervisor-v4-reference.py.txt is exact accepted supervisor3aab9dfa; current
supervisor.py changes ONLY the archive folder from previous global test-output
trees to this run's payload, and adds retained wasm/img/stdout/stderr extensions.
The pending-signal queue, owned-child forwarding/escalation, process-local clocks,
source verification, signal service through finalization, default-handler cutover,
child returncode and intended supervisor exit algorithm are unchanged. This
adaptation still requires source review; no new control run is requested.

common.py adapts verification to the accepted785 source/parent/index and exact
runtime config. It records actual source/executable hashes at each check, including
supervisor finalization, before asserting equality. No unrelated live Small
working-set freeze is required for this C-only instrument. launch.py selects only
focused785-node, retains current health/disk/lock refusals, and does not archive
old corpus summaries. inspect.py records this actual author thread and native
pane/process/lock observations. Node/health targets are only syntax-checked on a
future approved launch; no entrypoint is evaluated during this preparation.

Freshness: launcher creates a new mkdtemp durable-run-gate-* directory under
land783/build/trap783 ONLY after a separate invocation is authorized. It uses a
new private tmux socket, explicit remain-on-exit config and multi-argv submission.
It requires actual authorization-gate.json bound to the final run.json SHA,
independent acceptance references, and a one-shot exclusive claim. None of these
authorization/claim/runtime-config/run-output files exists in this preparation.
The internal gate key is V4's dispatch key, not a broad test-gate command.
The generated authorized-config.json differs from pinned runtimeTemplate ONLY
in verified grant reference, ['node-worker'] and fresh run/payload path. Its hash
is sealed in launch.json; verify rechecks those exact permitted differences.

Resource admission: existing host-health refusal; at least12GiB free as in the
accepted focused V4 wrapper; reject live/ambiguous heavy/gate lock owners. No
manual lock recovery/removal. Any canonical stale recovery requires explicit
grant; only this Node instrument's normal heavy-lock path acquires/releases its
own heavy lock. It does not acquire or clear the broad gate lock. No cleanup of
old panes/sockets/worktrees or other stage artifacts is authorized.

## Required actual evidence, before any pass claim

1. Actual coordinator grant, frozen plan/config hashes, one-shot claim and fresh
   launch path; launch/source-before/health/disk/lock observations.
2. Native tmux server/pane/supervisor PID plus lstart/ppid/pgid and actual owned
   Node child identity/command. An observation while live, if claimed, must be
   taken while live; never relabel a post-exit ps snapshot as during-run proof.
   Cross-turn persistence requires actual distinct turnStartedAt observations;
   a short run may finish before one exists, so do not fabricate that coverage.
3. Complete outer stdout/stderr; actual Python child signed returncode, exit and
   signal; direct compiler native result; guest statuses and real worker exits;
   generated fixture/module hashes and exact owner/guest records for all4 cases.
4. Supervisor sourceUnchanged and actual final source-check hashes, zero pin/
   archive/finalization/deadline errors, and terminal intended status. Independently
   observe retained pane_dead, pane_dead_status and pane_dead_signal. Pane native
   status is authoritative after terminal handler cutover. Inner pass alone is
   insufficient. Preserve any missing/partial/conflicting terminal evidence as red.
5. Final ps observation for recorded identities, heavy/gate lock observation and
   retained payload/archive hashes. Keep the dead pane/socket for audit; no cleanup
   grant. Every source/instrument/executable after-check must agree with launch.

## Future stages remain separate

Browser plan must explicitly authorize and pin server/fixture preparation:
owned server argv/PID/native lifecycle, /__serve-id, complete served image/package
inventory and hashes, source freshness and exact executable/imported Playwright
pins. No assumption that an already-approved server exists. Browser correction
must require positive leaf/usr admission on an actually warm single-use worker,
exact metadata/DATA/alias coverage and terminal evidence after browser cleanup.
Cmdalt remains a separate later window including its actual package prep/two boots;
unchanged assertions plus post-shadow observation. No allocations before original
shadow creation, no old-host replay. Neither stage is chained by this plan.

Current Foundation cmdalt pair remains unmeasured; original REDs remain unwaived.
Preparation has performed file reads/writes, hashes and syntax/AST parsing only.
No guest/compiler/browser/worker/OS/image/package launch, no staged edit, commit,
landing or cleanup. Launch readiness remains withheld pending instrument/wrapper
source review and exact coordinator grant.
