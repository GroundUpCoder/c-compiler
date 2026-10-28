# #785 implementation v1 — frozen source review request

Author lane: prep785-volume-identity, /Users/jku/git/c-compiler-prep785.
HEAD remains 7050d4ab03b3ffa74180593c9842dde9804a035b. No implementation commit
or landing yet. Exact Foundation srclib overlay bb1acbaa7bfae06957f90c90925f1e0337bdb97fe0185892d4a67fd8c1cc71e8
remains an unchanged input in os/os-common.js and tests/kernel/test_cc_srclib.js;
neither file belongs to implementation-v1.patch. Callback3bb96c0a is excluded.
Accepted PLAN9df34483 and original preparation artifacts remain unchanged.
Coordinator ticket comment01a0904d records Foundation srclib f0a36ae0 plus doc
checkpoint aacbd167, product-byte equivalent to the pinned inputs; no mid-work
rebase or repeated tests solely for that history was performed here. Transfer
is for the sole Foundation author after source review and coordination.

## Source contract implemented

- MountFS assigns checked owner-local live-volume IDs; validates prefixes,
  reader uniqueness and opaque shared volume tokens before publishing hooks.
  Separate readers may share one trusted live-volume token. Equal copies do
  not automatically share identity. getVolumeIdentity returns frozen metadata.
- stat/lstat qualify a copy at the final resolved owner; fstat uses retained
  volume/fd. Device rdev and file-backed inode/OFD paths are unchanged.
- Kernel derives immutable RO descriptors from the readonly mount owner.
  Node BOOT_SOURCE and browser process-worker propagate dev. Local RemoteFS
  qualifies stat/lstat/fstat, while broker responses pass through. Missing
  optional identity disables the whole local path; explicit invalid/contradictory
  configuration throws. The SAB correspondence remains trusted embedding input.
- C uint32 and WASI uint64 cells serialize the same checked uint32 dev/ino pair,
  with EIO before any output write for invalid metadata. No compiler/header,
  stat layout, cmdalt source, or cmdalt assertion changes.
- Private BlockFS/ProcFS and excluded anonymous producers emit explicit dev=0.
  L81/#787 records the unchanged native adapter limitation (comment only there).
  L82/#788 records anonymous identity as still unfixed; compatibility is not repair.

## Executed evidence and limits

See implementation-v1-pins.json for every final source and evidence hash.
implementation-v1.patch includes exactly eight source/test/doc paths; the new
host test is enrolled in tests/host/run.js. Reverse-apply check passes.

red-first.log: pinned host e9d970a4/kernel a3934723; exit1, 1 pass/9 failed
groups. red-first-pins.txt records source/test hashes. red-first-test.js.txt
preserves exact original test bytes (97f91608), reconstructed after transport
refinement and verified against the hash recorded before implementation. It
was NOT rerun against the old source. The first implementation passed 9/10;
its remaining error was my test transport calling nonexistent MountFS.dup2.
The final test instead calls the actual Kernel._fsRpc/OFD implementation,
with synchronous response capture. Intermediate logs are troubleshooting
records, not separate frozen-source acceptance claims.

frozen-controls.log: exit0, 14 groups. Real in-memory volumes cover equal inos
on distinct volumes, same-file aliases, cross-volume symlinks, lstat ownership,
opened/duplicated fd identity after rename/unlink, device rdev/I/O preservation,
shared live-volume readers versus independent byte copies, RO local zero-RPC
metadata, broker escape, actual fallback reads/opens/stats/fds, fd promotion,
configuration rejection, checked high-bit/max uint32 ABI values and invalid
metadata with untouched output. Registry exhaustion uses explicitly fault-
injected Map.size; it does not allocate billions of volumes. Kernel spawn
OPEN/inheritance and process descriptors use an inert worker capability;
no actual worker/program executes. Fresh descriptor controls are NOT a claim
of warm-worker runtime validation. Production mounted/RemoteFS pairs pass
through both actual C and WASI adapter functions using WebAssembly.Memory;
no C compilation or Wasm guest execution was needed for these adapter checks.

Existing lightweight files all exited0 (focused-results.json and individual
logs): blockfs/test_mounts, blockfs/test_dev, kernel/test_mounts,
kernel/test_rofs, kernel/test_procfs. The initial focused new test entry in
that JSON predates expanded coverage; frozen-controls.log is the final new
control result. Existing test_rofs now supplies explicit test-owner roDev=7;
its canned broker remains a mechanism fixture, while the new test uses the
real kernel dispatcher and mounted volumes.

node --check host.js/kernel.js/os/process-worker.js and git diff --check pass.
Liabilities first check rejected malformed provenance fields; corrected to
#785 and retained both logs. Corrected check passes, 39 entries. Mapper
--diff7050d4ab --dry-run ran only for impact inventory, including input overlay
and artifact paths; it is not a launch request or evidence of suite success.
No full host runner (which prebakes an image), OS/image/package/browser workload,
historical baseline replay, Foundation-source edit, main change or cleanup.

## Independent review and next authorization boundary

Please review the exact patch and retained evidence against FULL V2, including
error/fallback guards, device/anonymous separation and registry authority.
Read-only source/evidence review requested; no runtime launch by this request.

After source review, prepare pinned focused current instruments for coordinator
selection: actual Node/C RO and promoted/inherited fd equality, browser worker
RO descriptor and warm reuse witness, and a current cmdalt diagnostic added
only after the existing shadow fixture is created (preserve allocation order
and all original assertions). These guest/browser instruments are NOT yet
implemented or launched in this phase; coordinator approval must cover their
exact source and inputs. No automatic mapped whole-gate repetition.

Current Foundation cmdalt inode pair remains UNMEASURED. Original broad and
targeted REDs, including c58d0cd0 raw current log, remain immutable and unwaived.
These lightweight passes establish the bounded identity contract controls;
they do not establish cmdalt, browser or Foundation acceptance.
