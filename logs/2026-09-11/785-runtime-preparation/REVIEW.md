# #785 backend instrument preparation — review only, no launch

Prepared by sole #785 author in prep785 artifacts. No staged implementation,
Foundation source, original test assertion, registry, image or package edit.
Current accepted input is exact integrated tree2403c16c on parentaacbd167,
manifest3ece6c3c; eight source pins match approved v2. common.cjs checks the
actual source bytes, parent and index-patch hash before any workload. If the
batch checkpoint advances, coordinator must supply a reviewed updated config;
these checks do not silently accept a different source dependency set.

Files prepared (none executed as workloads):
- file-identity.c: guest stat/lstat/open/fstat/dup/read metadata, and real
  posix_spawn DUP2 child-stdin equality. Source-only C witness.
- node-worker.cjs: compiles that source with the pinned Node/compiler; creates
  actual BlockFS fixture volumes; saves every fixture image and owner metadata
  before guest boot; launches actual nodeCreateWorker for leaf/local, the same
  namespace fixture brokered, promotion/inheritance and nested-mount fallback.
  Compares all guest rows with owner oracle, complete row counts and exit.
  Leaf-only filesystem operations must make zero selected filesystem RPCs.
- browser.mjs: uses existing harness launchBrowser/osHelpers against a separately
  approved server (never starts serve.js or triggers its bake). Requires pinned
  actual served fixtures and exact /__serve-id. Validates host/kernel/worker
  HTTP bytes and applies instrumentation only in intercepted HTTP responses.
  Records exact instrumented worker source and hashes. Existing spawn traces
  carry owner metadata plus actual worker RO descriptor/admission. C is pasted,
  compiled, module SHA printed, path/inherit modes run. Guest pairs match owner
  metadata, all three process traces exist, and one actual prewarmed single-use
  pool take is required. There is no cross-process realm reuse/reset.
- cmdalt-preload.cjs + cmdalt.cjs: execute the UNCHANGED original cmdalt test
  only if selected/authorized. Retain full stdout/stderr/native status and
  fixture images/hash+scripts before driveBoot. Observe owner stat/lstat after
  the original shadow chmod succeeds. The hook creates no guest inode, retains
  error slots and the original response method, and leaves return values alone.
  A separate diagnostic file records real pairs, source and executable pins.
  The unchanged original test must pass AND diagnostic pairs must exist/differ;
  a baseline attribution never waives an original failure.
- common.cjs: rejects absent grant/config, wrong workload, source/instrument/
  fixture/Node hashes, wrong current parent/index and unstaged tracked edits.
  Requires an unused output directory; retains outputs, never deletes fixtures.
  Host helper literal-node resolution must hash-match the launched executable.

Prospective engine file pins captured by reading files, not launching engines:
Node /Users/jku/Library/pnpm/nodejs/25.8.2/bin/node,
SHA926d267c151bcb240522d4a1cff9a474a80bfdffadb07246a5b70f9baea9c24c.
Chromium1228 Google Chrome for Testing executable,
SHAb1b9e2dd063115031f08eadc10ed381ca0fa05b2284baff8f721d87f5f0f61b7.
Playwright browsers.json declares149.0.7827.55; that is not an observed engine
version. A future launch records process.execPath/versions and browser.version.
Historical lightweight records still specify literal node without an executable
pin; these prospective pins do not repair or reconstruct that history.

launch-template.json is intentionally NON-LAUNCHABLE: grantReference PENDING,
allowedKinds empty, output/server unspecified, browser actual fixture map empty.
Coordinator must select a serialized window and concrete unused evidence path;
for browser, supply actual server identity and sealed fixture file hashes after
approved fixture preparation. Node generated volume bytes and compiled module
are retained/hashed before the first guest starts. Cmdalt generated fixture bytes
are retained/hashed at driveBoot, with original scripts/assertions unchanged.
No claim that pending generated fixtures have already been produced or pinned.

Proposed commands after source review AND separate launch grant/config:
  <pinned-node> node-worker.cjs --execute <approved-config.json>
  <pinned-node> browser.mjs --execute <approved-config.json>
  <pinned-node> cmdalt.cjs --execute <approved-config.json>
Run separately, not in parallel. Existing heavy-lock mechanisms are retained.
The cmdalt test itself includes package preparation and two boots; its grant must
cover those actual operations rather than pretending this is a stat-only probe.
Expect retained images for each Node volume and cmdalt boot; coordinator should
budget disk for these immutable artifacts before selecting the workload.

Verification executed in preparation: node --check on the five JS/MJS files
only; no imports of workload entrypoints, compiler, guest, real worker, browser,
OS, image/package builder or test corpus execution. Syntax success is not runtime
correctness. Independent instrument source review is requested before any launch.
Original REDs remain unwaived; current Foundation identity pair unmeasured.
