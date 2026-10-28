# #785 volume identity — preparation for independent review

Status: DESIGN ONLY. Coordinator authorized preparation, not implementation,
launch, merge, or landing. Existing reviewer: 01a0834a-4bfc-79cf-a974-4f4e93edaf28.
This is the single #785 preparation path; callback #784 remains separate.

## Inputs and evidence boundary

Worktree: /Users/jku/git/c-compiler-prep785
Branch: prep785-volume-identity
Git base: 7050d4ab03b3ffa74180593c9842dde9804a035b
Additional source input: exact staged Foundation srclib patch, copied into this
worktree without modifying land783. It changes only os/os-common.js and
tests/kernel/test_cc_srclib.js. These are OTHER WORK's inputs, not a #785 fix.
No callback commit 3bb96c0a is included. The preparation branch HEAD remains the
Foundation base; preparation artifacts and the input overlay are uncommitted.
This avoids invoking any commit hooks/tests during the launch freeze.

inputs.json records all 21 inspected source/rule hashes and the overlay hash.
Verified host SHA256:
e9d970a4cf1a7f67825092da5d73982920bda52f230fb4f318364cb2e9d3b0ca.
Overlay SHA256:
bb1acbaa7bfae06957f90c90925f1e0337bdb97fe0185892d4a67fd8c1cc71e8.

Canonical #785 read in full, including reviewer report and coordination comments.
Rules read: AGENTS.md pointer, full CLAUDE.md, todos/PRINCIPLES.md,
GAMEDEV-EPIC.md, OS.md, LIABILITIES.md; relevant KERNEL.md read-only-volume seam.
Classification: contract-violation, P0. Epic argument: correct file identity is
required by source/build/package tools and command selection in the in-OS game
development loop. The repair belongs below cmdalt, not in command policy.

The independent current downstream report is preserved as downstream-review.md.
It records four matching current cmdalt shadow-diagnostic failures and source
support for #785, after package preparation succeeds. Current observed log SHA:
c58d0cd0b93a1d6754392531060462c058eebf2222e41c0f1c31cd5a79286b4c.
Its hash verification is the reviewer's action, not a new execution by this lane.
The current Foundation inode pair remains UNMEASURED. Same-cause attribution is
supported by source plus symptoms, not claimed as a measured current collision.
Historical Small baseline measured 0:68 for the two cmdalt paths, and an
independent two-volume probe measured 0:8/0:8. Those are historical observations.
Raw committed evidence remains at:
/Users/jku/git/c-compiler-small-callbacks/logs/2026-09-11/784-evidence/
See cmdalt-baseline.log, stat-diagnostic-transcript.log, stat-probe.cjs,
stat-probe-results.jsonl, baseline-preload.cjs, baseline-loads.jsonl and
stat-diag-preload.cjs. Do not repeat the old-host replay. Neither old nor current
red is waived; final Foundation evidence is still pending.

## Governing contract

POSIX requires the device/inode pair to identify a file within the system:
https://pubs.opengroup.org/onlinepubs/007904875/basedefs/sys/stat.h.html
The primary-source search excerpt was retrieved; a subsequent direct fetch was
refused. No claim of fresh full-page retrieval. WASI preview1's device/inode
fields serve the corresponding filesystem identity role:
https://raw.githubusercontent.com/WebAssembly/WASI/wasi-0.1/preview1/docs.md
(the primary specification was retrieved). The repository owns a 120-byte C
stat layout with 32-bit dev/ino, while WASI has 64-bit dev/ino cells. This repair
must preserve those layouts, errno conventions, and existing symlink semantics.

Proposed in-scope contract for the mounted filesystem namespace:

1. A volume identity is allocated by the ONE filesystem owner for the live
   namespace. Every process and every read-only view consumes that authority.
2. Distinct volume instances receive distinct device IDs, even if their bytes
   and inode numbers match. Same-volume aliases retain the same device/inode.
3. stat follows the final symlink; lstat reports the link's own volume/inode;
   fstat reports the opened object, unaffected by later path rename/unlink.
4. Kernel JS, brokered RemoteFS, local read-only RemoteFS, C stat, and WASI
   filestat expose the SAME pair for the same filesystem object.
5. Read-only local stats remain zero-RPC once startup has supplied identity.
   Descriptor promotion, dup/dup2, and spawn inheritance preserve the pair.
6. ID allocation is checked uint32, never wraps or hashes into a collision.
   Namespace identity is stable for the live owner/mount lifetime, including
   open handles. No on-disk UUID, cross-reboot persistence, or content identity
   promise is added. Replacing a volume is not silently treated as the old one.

## Source-derived data flow (all line numbers at the pinned inputs)

| Source | Current behavior | Proposed change |
|---|---|---|
| host.js:3659 _statOf; :3719 fstat | BlockFS emits inode and other metadata, no dev | Keep inode authority in BlockFS. Explicitly describe standalone private-volume dev=0; MountFS qualifies volume metadata as below. |
| host.js:6196 MountFS constructor | Owns mounted volumes and fd routing, no device registry | Own checked volume-to-device registry, allocated once. |
| host.js:6303 _dispatch; :6356 stat; :6377 lstat | Retries escapes and returns final volume metadata | Stamp a fresh result with the FINAL owning volume's dev inside the successful dispatch callback. Never select dev from the original lexical prefix. |
| host.js:6479 MountFS.fstat, _fdOp | Has original volume and volume fd | Qualify metadata using that stored volume; do not re-stat a saved path. |
| host.js:4223 writeStatBuf | Writes constant C st_dev=0 | Serialize authoritative st.dev to uint32 at byte 0. Preserve remaining 120-byte layout. |
| host.js:5179 writeFilestat | Writes constant WASI dev=0n | Widen the SAME st.dev exactly into the uint64 cell at byte 0. Preserve inode and rest of layout. |
| kernel.js:2172-2182 Kernel fs/roImage | Receives fs and passes {prefix,sab} through | Derive dev from the owner mount descriptor, validate it, create immutable ro descriptor {prefix,sab,dev}. |
| kernel.js:2963 process specification | Forwards ro descriptor | Forward dev unchanged, including warm-worker reuse; no worker-side allocation. |
| kernel.js:3938-3945 FS_STAT/LSTAT/FSTAT(file) | Forwards fs stat object in JSON | Preserve dev through existing transport; no new opcode/packing structure. |
| kernel.js:8620 RemoteFS RO setup; :8910-8928 stat/lstat/fstat | Local calls return raw BlockFS metadata | Accept owner-provided roDev; stamp successful local results with it; remote results stay untouched. |
| kernel.js:9275-9278 Node worker bootstrap | Creates local reader and RemoteFS | Pass wd.ro.dev to RemoteFS alongside roFs/roPrefix. |
| os/process-worker.js:58-61 browser bootstrap | Same construction | Pass identical descriptor field; browser is first-class. |
| os/boot.js:447,492; os/kernel-worker.js:778,819 | Construct MountFS and supply roImage | Keep construction seam; Kernel derives dev. Update comments/any helpers to show owner derivation, not fixed /usr=2 numbers. |
| kernel.js:9609-9642,9753 ProcFS stats | Synthetic volume has stable own inode map | MountFS qualification gives /proc its own dev, with stat/fstat agreement. No ProcFS on-disk change. |
| compiler.js:28750-28751; stat_layout corpus | Existing dev_t/ino_t and layout | Inspection/validation only; no compiler or C header edit proposed. |
| os/cmdalt.h:96-99,183-187; cmdalt test:362-374 | Correct dev+ino comparisons and four diagnostics | NO change. Preserve identity checks and exact assertions. |

## Concrete proposed mechanism

### A. Owner registry and result qualification

Add private registry state to MountFS, keyed by backing-volume identity, with
checked uint32 IDs in 1..0xffffffff. Device zero stays reserved for a private
standalone BlockFS namespace / existing non-mounted objects (see boundaries).
Allocation occurs during MountFS construction, not each stat. The numeric ID is
an owner-assigned device number backed by the actual mounted volume, NOT a
process-local counter pretending to be a shared file identity.

Default volume key is the mounted fs object. For two independent readers of the
same backing volume in the OWNER, permit an explicit shared opaque volumeKey on
the array mount descriptor, and retain that field during normalization. This
key is an owner-side capability, never a filename, content hash, pid or random
integer. Distinct stores default to distinct keys, even when byte-identical.
An embedder associating two readers must actually know they refer to the same
volume. Independently opened OPFS/native handles cannot be inferred equivalent
from JS wrapper identity; the owner must bind them explicitly. A worker SAB
reader is bound by the ro descriptor, not by trying to compare cloned objects.

A helper qualifies a SUCCESSFUL stat object by copying it and setting dev from
the registry. Do not mutate a backend-returned object shared with another view.
MountFS.stat/lstat qualify inside _dispatch's final successful callback;
fstat qualifies using the fd entry's vol. Neither operation changes ino.
Failure remains null plus _lastError. Alias equality comes from resolving the
same owner/ino, not special-casing /usr/local or command names.

Propose a narrow public owner query, getVolumeIdentity(prefix), accepting only
an exact configured mount prefix and returning {dev, readonly}. Kernel uses
this to construct roImage metadata. No _mounts indexing or lexical pathname
hash in worker code. Registry entries never reuse an ID during owner lifetime;
if dynamic replacement is later supported, old handles retain old identity and
new volume instances receive new IDs. Current MountFS is static.

Binding caveat for reviewer: current _mountPrefix/_mountOwns hooks make mounting
the EXACT SAME fs instance at multiple prefixes unsafe already (the last hook
wins). This proposal must not advertise new bind-mount support. Same-volume
multiple-prefix coverage should use separate readers plus an explicit shared
volumeKey. Single-mount hardlinks and symlink aliases are mandatory, not optional.
If multi-reader aliases are rejected from implementation scope, explicitly
refuse unsupported duplicate registrations instead of assigning contradictory
IDs; settle this at design review before coding.

### B. Read-only view propagation and fd transitions

Kernel validates that opts.roImage.prefix names the read-only owner volume,
then derives dev; the caller is not allowed to override it with a guessed
number. Verify the existing trusted-embedder premise that sab is a snapshot of
that volume; this patch does not independently authenticate every SAB byte.
For a custom filesystem lacking identity metadata, do not invent a value:
preferred compatible behavior is disable the optional local fast path and use
brokered stats/reads. For contradictory metadata, throw a named configuration
error before launching workers. Missing roDev in manually constructed RemoteFS
must likewise disable the local optimization; explicitly invalid roDev must
throw a named construction error. Never silently serve dev=0 as /usr's identity.

Once configured, RemoteFS stores roDev with _ro. Only local successful
stat/lstat/fstat results are qualified there. Escaping symlinks, relative paths,
and write-intent operations still use the existing brokered path. Invalid
local paths preserve existing final-error semantics. _roPromote opens the
kernel twin through existing code; its fstat must now equal local fstat. Reused
workers receive the new process descriptor rather than retaining the prior
namespace's device number. No per-stat RPC, alternate clock, or new transport.

### C. Serialization and standalone behavior

C adapter writes st.dev as a checked unsigned 32-bit value. WASI writes
BigInt(st.dev) with no signed `|0` coercion. Test a device value above 2^31 and
at the upper uint32 boundary. Invalid supplied metadata must fail loudly rather
than truncate. Existing raw standalone BlockFS has one private volume and may
explicitly carry dev=0; do not use a missing-dev fallback to conceal a broken
MountFS/RemoteFS producer. Prefer adding dev:0 to BlockFS-produced stat records,
including raw fstat, so metadata shape is explicit. No stored metadata or seal
changes; inode, time, size and on-disk fsck remain authoritative as before.

### D. Scope boundaries requiring an explicit reviewer decision

The mounted-file repair above covers regular files, directories, links,
filesystem-backed device nodes and ProcFS, across every requested view/ABI.
It does NOT by itself establish universal identity for all existing backends:

- kernel.js:3947-3952 fabricates ino=0 for anonymous pipe/socket/tty descriptors.
  This is source-observed, not a new measured failure in this preparation.
  Reserving dev=0 keeps them distinct from mounted-volume IDs but does not
  distinguish them from each other. If #785 scope includes anonymous objects,
  add kernel-owner identity at their real resource allocation seam: one inode
  per pipe object (both ends and inherited/dup handles share it), per socket
  object (not per numeric fd), and per actual tty/device resource. A dup must
  not allocate an identity; two independent opens of the same device require
  the same identity. Propagate through existing FSTAT RPC. Never use an OFD ID
  for filesystem-backed files or merely the process fd. Extend standalone
  pseudo-object handling similarly within its private namespace. This is an
  additional object-identity slice, not necessary to explain cmdalt's regular
  files; reviewer/coordinator must fix its boundary before implementation.
- host.js:272-285 is a DIFFERENT native-Node filesystem adapter and also writes
  dev=0, while serializing native inode into uint32. It does not participate in
  gucOS MountFS or the current WASI path. A full native-host repair needs native
  dev/ino preservation plus an explicit overflow policy for the existing C ABI
  (EOVERFLOW versus an ABI-width change). No process-local remapping is valid.
  Recommendation: scope #785 to the mounted gucOS namespace and explicitly
  track the native adapter separately rather than silently widening compiler
  ABI changes into this Foundation repair. If reviewer requires it in #785,
  design checked native stat/lstat/fstat conversion together, never one method.

These are concrete review questions, not permission to claim that remaining
identity defects are fixed. Do not alter them during the current preparation.

## Exact proposed tests and acceptance observations (NOT EXECUTED)

Extend existing registered Node files; add one dedicated browser member with
its membership change declared in advance. Distinct instruments, no replacement
of old reds:

1. tests/blockfs/test_mounts.js: construct two actual BlockFS volumes with equal
   local inode numbers; assert different dev and pair. Include a third /proc-like
   backend, stable repeated calls, same-volume hardlink and relative/absolute
   symlink equality, lstat link-vs-target distinction, cross-volume escape in
   both directions, and fd stat before/after rename and unlink. Add separate
   owner-side readers with explicit shared key if that scope is approved;
   distinct copied-image stores must remain different. Check fsck as existing
   suite does; no image format/version change expected.
2. tests/kernel/test_mounts.js: drive the real existing RPC dispatcher/fd
   tables and compare stat/lstat/fstat metadata for regular files and ProcFS,
   dup/dup2/inherited descriptors; preserve existing EXDEV/EBUSY contracts.
   Do not equate lack of runtime workers in this instrument with an OS test.
3. tests/kernel/test_rofs.js: supply owner-derived roDev to the explicit local
   view; test local stat/lstat/fstat dev, zero-RPC invariant, both escape paths,
   missing/invalid descriptor handling and descriptor promotion. Update fake
   replies only to match the declared metadata contract; add equality checks,
   do not merely preserve old size-only witnesses.
4. tests/kernel/test_rofs_e2e.js: real compiled C in Node process workers compares
   raw printed dev/ino for /usr path (local), equivalent /bin or relative path
   (brokered), hardlink/symlink aliases and local/promoted/inherited fds.
   Retain ZERO filesystem RPC assertion for the eligible /usr workload.
   Add a real distinct writable-volume equal-ino control. Capture actual values;
   do not assert magic dev assignments or reuse the historical 0:68 figure.
5. tests/kernel/test_rust_std_e2e.js: in the existing WASI shim leg, inspect
   path_filestat_get with/without symlink-follow and fd_filestat_get over the
   same mounted/RemoteFS objects, and compare uint64 dev/ino cells to the C
   adapter's uint32 cells. Include high-bit dev metadata in an explicitly
   adapter-only fixture; do not call injected metadata a real-volume test.
6. tests/unit/stdlib/stat_layout: retain current 120-byte ABI/layout test
   unchanged; no compiler change intended.
7. tests/kernel/test_cmdalt_e2e.js: keep every original assertion, including
   shadow execution, all four diagnostics, and package install/dispatch/remove/
   bin-refusal controls. After freeze release, append an OBSERVATIONAL stat
   diagnostic only after the original shadow creation, before diagnostic
   commands, so probe-file allocation does not create the original collision.
   Print both current dev/ino pairs and explicit equality; no hardcoded pair.
   Preserve the original failing log; do not replace it with probe output.
8. Add tests/browser/os-file-identity.mjs using openOsSession from the existing
   os-harness.mjs. A dedicated identity test avoids changing os-foundation.mjs's
   installed-library/count instrument (inspected: it imports foundation/browser
   and drives foundation/os-script.js). Author one real C probe in the OS,
   compile it with /bin/cc, and assert pair equality across an absolute /usr file,
   its /bin alias, a relative path, and local/promoted/inherited fds; assert
   inequality against a root-volume fixture with an equal inode when deliberately
   constructed by the fixture. Print actual pairs and assert process exit.
   A shared tests/fixtures/file-identity.c may supply the RO/browser C checks;
   the two-volume equal-ino construction belongs to the controlled BlockFS
   instrument if a baked image cannot guarantee it without allocation tricks.
   This is actual browser-worker evidence, not a Node proxy. The sweep discovers
   os-*.mjs; verify registry guards and mapper after authorization. This adds a
   suite member: pin the new membership in advance and do not fold it into an
   unrelated batch under CLAUDE.md rule 3a.3. Callback tests remain separate.

Proposed post-review, POST-FREEZE evidence order, subject to coordinator launch:
(a) record exact new source/image pins and preserve axqqhvbk final artifacts;
(b) run focused mount/RO/ABI instrument(s) on unchanged current inputs for a
current control, then the approved repair; no duplicate old-host baseline;
(c) run current cmdalt with preserved four diagnostic assertions and current
pair observation, distinguishing observation from inference;
(d) run the focused browser identity witness;
(e) ask tests/run.js --diff <approved-base> --dry-run for the authoritative
mapped scope, then run only that coordinated gate after launch authorization.
No --resume or carried-green evidence. Focused green does not waive broader red.
No commands in this section have been executed by this preparation.

## Review and implementation boundary

Reviewer must settle A's volume-key/multiple-reader representation, B's missing
metadata behavior and D's anonymous/native scope. The proposed dedicated browser
file is named above and changes sweep membership explicitly.
Recommended core: owner-qualified MountFS stats + owner-issued RO descriptor +
unchanged C/WASI layouts, with explicit coverage of every mounted-file path.
No cmdalt special case, filename hash, random device number, process-local
registry, on-disk UUID retrofit, or per-stat RPC is proposed.

No repair claim, no current inode measurement, no new gate result, no merge or
landing approval. The preparation alone is ready to review; implementation
must wait for the coordinator's next scope authorization and source freeze.
