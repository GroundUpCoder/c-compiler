# #785 implementation v2 — RO subtree admission correction

Full independent v1 review01a09057 read and retained as review-v1.md.
Original implementation-v1.patch c41aa788, manifest22184cf2 and all v1 logs
remain unchanged. Base remains7050d4ab plus exact original srclib overlay;
no callback, Foundation/main edit, commit, rebase, guest or browser launch.

The reviewer identified a real source gap: a readonly mount does not own all
paths under its prefix if another mount is below it. New lightweight controls
executed against v1 now reproduce mismatched stat identity for both /usr with
/usr/nested and readonly / with /nested. These are new in-memory fixture
observations, not a replay of historical cmdalt or measurement of Foundation.
red.log exited1:14 pass/2 fail. Exact executed fixture is red-test.js.txt;
red-pins.txt pins v1 host/kernel and the new fixture before correction.

Correction uses the conservative whole-path fallback:

- getVolumeIdentity returns frozen {dev, readonly, leaf}; leaf is true iff no
  configured mount is a descendant. Root is handled explicitly. Same-volume
  nested readers also force fallback; no partial namespace promise is inferred.
- Kernel admission requires explicit boolean leaf:true from the owner. Missing
  coverage or leaf:false disables the entire optional RO descriptor. Explicit
  non-boolean coverage is a TypeError. Device and readonly checks are retained.
- Node BOOT_SOURCE and browser process-worker propagate roLeaf from the derived
  descriptor. RemoteFS admits a local reader only with roDev and explicit
  trusted roLeaf:true. Missing/false coverage uses the broker for all paths,
  including symlink targets, opened handles and otherwise-local ENOENT cases.
  Direct manual embedding must supply its own truthful leaf-coverage authority.
- No per-stat RPC is added for eligible leaf mounts. Existing zero-RPC and
  readonly-root-without-children controls still pass. C/WASI serializers,
  device rdev/OFD paths and the #787/#788 liability scope are unchanged from v1.

Final focused evidence in focused-results.json, with exact commands and exit
codes: new host control17 groups passes; existing kernel/test_rofs,
blockfs/test_mounts and kernel/test_mounts pass; host/kernel/browser-worker
syntax checks and git diff --check pass. No heavy runner executed.

Nested /usr and root controls use actual distinct stores with conflicting
file data, a nested-only file and symlink into the nested mount. For each path,
stat/lstat/open/fstat/read/close use the real kernel dispatcher and agree with
MountFS; read data comes from the nested volume. All six calls are brokered.
Manual descriptors missing/false coverage also perform actual brokered reads,
opens and stat/fstat without installing local mount hooks. Malformed coverage
is rejected. Custom owner descriptors without coverage fail closed.

implementation-v2.patch is the complete eight-path #785 delta from the same
base (excluding both input overlay files); reverse-apply check passes.
implementation-v2-pins.json pins all source, overlay and v2 evidence. Source
approval requested from the same independent reviewer before preparing the
concrete guest/browser/current-cmdalt instruments already described in v1.
No runtime or landing approval is inferred. Current Foundation inode pair is
still unmeasured and both original REDs remain immutable and unwaived.
