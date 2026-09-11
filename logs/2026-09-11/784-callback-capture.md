# #784 — captured callbacks and direct function references

User-authorized contract: registration captures the callable; table mutation
cannot retarget it. Table-index wrappers and direct-reference c imports share
one implementation. Small/C program linking and __cfuncptr syntax are outside
this change. Epic justification: Small game/app callbacks reuse gucOS SDL
pacing and lifecycle while retaining ordinary Wasm function references.

The isolated branch starts at 0845ad42, the committed #782 async lifecycle
repair (including #783), rather than duplicating that in-progress work on main.
Those commits' authorship and validation remain their own. This change owns
only the callback capture delta. No other lane's worktree was edited.

Both callback forms prepare their JSPI wrapper at registration. All three SDL
backends store the prepared function, and the common frame loop invokes it.
Timer callbacks share #782's cancellation/failure settlement. Teardown drops
the SDL callback as well as cancelling timers. CALLBACKS.md is the API contract.
No performance improvement or complete C ABI compatibility is claimed.

Focused primary-author execution passed test_callback_capture.js in actual
JSPI and --no-experimental-wasm-jspi modes, including real C-produced table
mutation and real sibling Small-produced typed callback arguments. The Small
cases assert absence of an exported table and include a qualified imported
function. All SDL constructor registration paths were exercised under Node;
the browser constructor used a stub canvas, so this is not GPU/browser evidence.
Existing test_frame_lifecycle.js and test_async_lifecycle.js also passed.

Primary-author mapped gate: `node tests/run.js --diff HEAD` at base 0845ad42
finished exit 1 after 4155.6 seconds. Todos, unit (849 pass, 3 skip), host,
BlockFS (15/15), and the selected compiled corpus (896 pass, 111 skip) passed.
Kernel was 203/204; browser was 71/72. All selected kernel/browser members
executed fresh. This was the diff tier, not the full ship gate: netsurf-patch,
disw and sourcemap were deliberately omitted.

Both failing behaviors were reproduced with the exact unmodified 0845ad42
host, keeping the same other source and image inputs:

- #785: test_cmdalt_e2e.js retained its four shadow-diagnostic failures.
  A diagnostic variant, compiled inside the OS after creating the original
  shadow, observed stat success for both files and dev/ino 0:68 for both
  /usr/local/bin/python and /usr/bin/cmdalt. The independent two-volume
  C/Wasm probe also observed a false same-file equality before and after
  this change. writeStatBuf's constant st_dev and volume-local inodes explain
  why ca_same_file suppresses these diagnostics. No filesystem fix is included.
- #786: os-sedit.mjs failed its exact Ctrl+F replacement assertion in the sweep.
  Initial baseline/current replays passed. Three alternating replays then gave
  baseline PASS/PASS/FAIL and current PASS/PASS/PASS. The baseline failure had
  the identical gXFINDXeen text. The defect's mechanism remains unknown; neither
  successful replays nor the baseline failure turn the original gate green.

After the broad gate, the callback test's drain assertion was strengthened:
record the frame at drain, then assert outside the runtime's deliberately
swallowed drain-error handler. The final test passed again for real C and Small
producers under both JSPI and sync execution. Product host.js was unchanged.
The broad gate exercised the earlier assertion placement; it is not claimed
as a fresh gate of the final test-only revision. The pre-feature callback
control fails the capture witness ([2] instead of [1,2]).

Raw run output, summary, both failure controls, replay scripts and source hashes
are preserved in 784-evidence/. The 38 Small compiler/runtime producer hashes
were verified unchanged at completion. Small GUCOS.md documents the imports;
no Small compiler or library changes were needed. No external reviewer or
sub-agent was used. This feature branch is committed for separation/review;
it is not merged to main while #782 landing and the mapped red remain pending.
