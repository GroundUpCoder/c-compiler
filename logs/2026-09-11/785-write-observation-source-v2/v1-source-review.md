# #785 changed WRITE observation source V1 — independent review

Disposition: source approval for window consideration WITHHELD for one concrete loader-identity blocker. No launch or workload was performed. The approved changed scenario is not being reopened as a design question; fix the narrow instrumentation defect in a new pinned delta.

Freeze: /Users/jku/git/c-compiler-prep785/logs/2026-09-11/785-write-observation-source-v1/run.json SHA 28e552b82ad9796c79221c431d1926129d0fa8b7a3ca3d5a290aa34eff0beaac.
Observer 06fbd2c35895cc777025ed9ba12debd84995548c28c04afa1d642671b0fc44a8; driver 738456f04628186640889ebccc12c7917b4ca8f109cd867184cc0de311cea699; delta 2281a01171333b4e83810f15251a40384b4a087a52b0fd2d3ab7f4ae3af3d5fd.

## Blocker — stale preload require.main value

observe-preload.cjs:60 emits mainModule: require.main === mod. That require is the preload's module-local require, created during -r preloading, before the application main module is loaded. It is not a dynamic lookup of the current main module. observation.cjs:49 later asserts transform.mainModule, so the instrument can complete the guest observation and still fail its mandatory loader assertion for its own stale identity measurement.

The matching upstream Node v25.8.2 source establishes the mechanism: makeRequireFunction sets an ordinary own main property from process.mainModule when constructing each module-local require. The CJS loader subsequently sets process.mainModule for the isMain module; this does not update the already-created preload-local require function. Preload modules are loaded under an internal/preload parent. This is a source-derived blocker, not a runtime reproduction, and does not assert that the pinned executable was empirically tested here.

Primary sources inspected read-only:
- https://github.com/nodejs/node/blob/v25.8.2/lib/internal/modules/helpers.js (makeRequireFunction, especially setOwnProperty(require, main, process.mainModule)).
- https://github.com/nodejs/node/blob/v25.8.2/lib/internal/modules/cjs/loader.js (main-module initialization around1324 and _preloadModules around2112).
- https://github.com/nodejs/node/blob/v25.8.2/lib/internal/process/pre_execution.js (the --require preload path).

Use an actual loader-time identity, for example process.mainModule === mod at this CJS hook, with the existing original filename checks and, if recorded, module id/cache equality. Do not manufacture mainModule:true or drop the identity requirement. Keep the transformed execution explicit. A corrected source freeze needs review before a grant; no guest launch is needed to make this correction reviewable.

Primary source copies retained by reviewer: /tmp/cc-785-node-v25.8.2-helpers.js SHA c1f07536b7e93c9178c40c6c5010988b294e42296cd7ebbab3f18775bba41fd2; /tmp/cc-785-node-v25.8.2-loader.js SHA d67189eea12e69adfb5e5d80e657d5399702ea4b68daf7a5d719f47a8c0cb8c8; /tmp/cc-785-node-v25.8.2-pre-execution.js SHA 306cfd6e3d7e08357031e99785ae0349322d29dc7e8e1d45b7b3719814c6b739. Retrieved from the corresponding raw.githubusercontent.com/nodejs/node/v25.8.2 paths; no Node code evaluated.

## Remaining concrete assessment

Read FULL REVIEW.md and coordinator scope01a090d4-c46a, actual preload/driver, replacement block and exact boot transformation. No additional blocker found in the inspected readback/forwarding/guard/finalization changes:

- The unique original block replacement exactly reconstructs transformed boot f8cc9291a3e81df1654b5dfd6dcec1918706cc738aa292f689136318275ac4f5. Loader restoration occurs before _compile on the supplied original Module with original filename. That preserves ROOT/__dirname and module paths in shape; runtime identity remains to be measured with the corrected check.
- The omission replaces the actual default-sync call site, rather than merely relying on packages=none. Ordinary wm is forwarded, other service attempts fail; package/compiler basename and COMMON build guards are explicit. Parent rejects forbidden events or observer errors. This is still the authorized changed service scenario, not unchanged boot behavior or a production no-sync option.
- FS_WRITE decoding follows the current raw fd/data ABI. Positive n is bounded, actual file OFD and volume-qualified subject are required, partial submitted writes remain unqualified, and exact final26-byte content/EOF determines qualification. Multiple normal chunks are allowed; duplicate completed-content qualifications fail. No755 success is asserted.
- Independent readback uses the actual OFD backing volume, unique physical-path mount match and a readonly createV4 view. Current host createV4 readonly handling loads without formatting and suppresses atime writes in read; the read handle is local to that view, not the guest OFD. Backing inode/size, bounded reads and EOF are checked; close occurs in finally, and original owner/mounted-backend error descriptors are restored. Unexpected read/mount/close failures remain RED. No readonly-view volume ID substitutes for the runtime owner identity.
- Snapshot and trace precede exactly-once original response forwarding. Current file writes respond synchronously. The shared bounded cleanup/output/source-finalization mechanisms remain unchanged, and success requires actual boot exit/close, complete trace and parent/native evidence. Syntax does not validate these runtime paths.

## Pins and limits

Independently verified all23 prepared,13,301 source and49 absolute entries, runtime source/fixture map equality and instrument pins, and all eight shared files byte-equal predecessor. HEAD remains aacbd167; cached binary diff SHA9d1759f4431bb6cca76361912f7a6a27ad6307ce0604cad05550a346defad277 matches the reviewed2403c16c input, with no unstaged tracked delta. Exact59 prefix equals accepted proposal. All prior49/251/38/62/58 evidence entries match. No authorization/config/claim exists in this candidate.

No source edit, syntax execution, entrypoint/module evaluation, Wasm/guest/runtime/bake/package/server or cleanup was performed by this reviewer. Source reads, offline hashes/git reads and public primary Node source retrieval only. Known line44 chmod failure, changed scheduling/fresh-root limits, old REDs and permission/historical-pair non-acceptance remain explicit. No runtime or landing approval follows.
