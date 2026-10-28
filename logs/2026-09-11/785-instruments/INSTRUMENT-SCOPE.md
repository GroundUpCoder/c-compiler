# #785 proposed focused instruments — no launch

Scoped source approval01a0905b is retained in source-approval-v2.md. Reviewed
patch60ef1825 and its original pins1859d482 remain unchanged. This directory
adds preparation artifacts only; no test registry or product source changes.
file-identity.c is an actual prepared guest witness, NOT compiled or executed.
Its prints/assertions do not establish runtime success before execution.

Transfer: sole Foundation author applies only the reviewed eight-path delta
onto actual Foundation history (coordinator last named aacbd167). Verify actual
HEAD/tree first, check dependency diff against7050d4ab plus exact srclib overlay,
and report changed dependency bytes for independent review. Do not transplant
the overlay or callback. No main/landing authorization is implied.

Proposed Node worker instrument:
- Extend existing tests/kernel/test_rofs_e2e.js only after coordinator selects
  this instrument. Reuse makeWorld, boot, nodeCreateWorker, RPC-op recorder.
  Compile file-identity.c with the final transferred compiler/host/kernel.
- Existing readonly /usr and writable root are the real volumes. Populate
  conflicting names/data on distinct volumes before sealing; add hard/symlink
  aliases, nested-only file and symlink into a child mount for fallback cases.
  Snapshot owner stat/lstat/dev/ino/data expected values into a JSON oracle.
- Invoke path mode on leaf files and aliases, separately from inherit mode.
  Compare every guest pair to the owner oracle, not only guest self-equality.
  Leaf path operations must make zero filesystem RPCs; inherit mode must show
  real promotion and child fd0 matching parent/owner. A broker-only boot of the
  SAME namespace fixture must produce identical pairs/data. Nested mounts must
  use the whole broker path. Preserve existing RO assertions and outputs.
- Proposed launch only after approval: node tests/kernel/test_rofs_e2e.js.
  Exact amended test hash, witness hash, compiler/host/kernel, Node/V8 versions,
  image/SAB bytes and owner oracle must be pinned before that launch.

Proposed browser instrument:
- Dedicated tests/browser/os-file-identity.mjs, sharing the C witness and
  openOsSession; do not change Foundation browser assertions/count.
- Observe actual boot descriptor dev/leaf and effective RemoteFS RO admission
  in opt-in instrumentation at os/process-worker.js after construction. Record
  pid/path/prefix/dev/leaf plus owner descriptor from the createWorker seam.
  Compare guest output to owner metadata, including promoted child stdin.
- Correction to earlier author wording: os/kernel-worker.js195-205 explicitly
  makes prewarmed workers SINGLE-USE. There is no used-worker reset/reuse
  mechanism. Observe a real warm-pool take (existing spawn-trace warm flag) and
  current descriptor; assert each worker serves one pid. Do not invent a reused
  realm test or introduce reset machinery. Node reference workers are also
  distinct process workers. Browser version/build, launch args, served source
  hashes, pool settings and trace records must be pinned before execution.
- Browser guest/warm-pool evidence and new test membership remain pending;
  this preparation does not launch or claim those tests exist yet.

Proposed current cmdalt instrument:
- Preserve tests/kernel/test_cmdalt_e2e.js original assertions verbatim.
  Observe only AFTER its existing printf creates /usr/local/bin/python and
  chmod sets755, before ==shadowwhich. Do not install/compile a guest helper
  before this point or replace the original fixture with a similar allocation.
- Prefer an opt-in owner-side observation at the existing filesystem dispatcher
  on completion of that chmod: read stat and lstat for /usr/local/bin/python
  and /usr/bin/cmdalt, plus owner volume descriptors; emit a separate JSONL
  diagnostic. It must not allocate guest inodes, mutate filesystem state,
  change syscall return/error behavior or alter stdout section delimiters.
  Actual guest comparisons still come from unchanged ca_same_file and the four
  shadow diagnostics; owner observation alone cannot prove guest ABI behavior.
- Pin the precise instrumentation delta for source review before launching.
  Record original and instrumented test hashes, owner/worker sources, compiled
  command modules, fixture image, full unfiltered stdout/stderr, native exit,
  all original assertions and exact diagnostic pairs. Any remaining red stays
  red. This is current-source observation, never an old-host baseline replay.

All launch commands above are proposals. Runtime instrument patches/test
membership require coordinator selection and review; they are not silently
included in the source-approved #785 patch. No guest, browser, image/package
or OS workload was launched. Original REDs remain unwaived; current Foundation
inode pair remains unmeasured. Mapper supplies impact inventory only.
