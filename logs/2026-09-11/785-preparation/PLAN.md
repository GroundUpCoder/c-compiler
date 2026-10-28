# #785 volume identity — preparation for independent review

Revision 2: incorporates review 01a09040-8995-723d-8df1-7a7dc1455c4d.
Original reviewed text retained as PLAN-v1.md; full review in review-v1.md.
Read and incorporated the subsequent reviewer correction in
review-device-correction.md: the claimed device-origin contradiction was withdrawn.

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
same LIVE backing inode namespace in the OWNER, permit an explicit shared opaque volumeKey on
the array mount descriptor, and retain that field during normalization. This
key is an owner-side capability, never a filename, content hash, pid or random
integer. Distinct stores default to distinct keys, even when byte-identical.
An embedder associating two readers must actually know they refer to the same
volume. Independently opened OPFS/native handles cannot be inferred equivalent
from JS wrapper identity; the owner must bind them explicitly. A worker SAB
reader is bound by the ro descriptor, not by trying to compare cloned objects.
Explicit volumeKey must be a non-null opaque object token (not a primitive,
array, filename or content digest). Equal bytes, copied snapshots and forks are
not proof of one live namespace. Reject duplicate exact fs-instance registrations,
contradictory keys for one fs object, duplicate prefixes and invalid tokens before
installing any mutable mount hooks. Normalize/validate and allocate the entire
registry provisionally, then publish hooks; exhaustion refuses atomically.

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

Current _mountPrefix/_mountOwns hooks make mounting the EXACT SAME fs instance
at multiple prefixes unsafe (last hook wins). Reject it; no new bind-mount support
is claimed. Separate reader objects can share one explicit owner-held live-volume
token. Tests cover equality for those views and inequality for independent copies.
Single-mount hardlink and symlink aliases remain mandatory. IDs compare only
inside the one-owner namespace, not across independent kernels or reboots.

### B. Read-only view propagation and fd transitions

Kernel validates that opts.roImage.prefix names the read-only owner volume,
then derives dev; the caller is not allowed to override it with a guessed
number. Verify the existing trusted-embedder premise that sab is a snapshot of
that volume; this patch does not independently authenticate every SAB byte.
For a custom filesystem lacking identity metadata, do not invent a value:
disable the ENTIRE optional local path: reads, opens, stat and fd operations
all remain brokered. Test actual brokered operations, not only _ro===null. For contradictory metadata, throw a named configuration
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
including raw fstat, so metadata shape is explicit. ProcFS and the separately
tracked anonymous producers also receive explicit dev:0 before qualification;
see D/E for compatibility and failure contracts. No stored metadata or seal
changes; inode, time, size and on-disk fsck remain authoritative as before.

### D. Filesystem-device origin is IN scope; anonymous/native scope is tracked

An opened filesystem device is never an anonymous exception. The CURRENT
implementation already retains its originating filesystem fd/inode:
- FS_OPEN kernel.js:3768-3774 and spawn OPEN:2880-2887 create kind:file with
  bfsFd, including ordinary /dev paths.
- host.js:3005-3016 S_IFCHR opens retain inoId; BlockFS.fstat:3719 reads it.
  MountFS.fstat qualification reaches device opens through kernel.js:3943-3945.
- Dup and inheritance share that existing OFD; its retained bfsFd pins the
  filesystem object. Keep existing close/reference lifetime behavior. No second
  origin field, duplicate retained handle, or pathname re-stat is needed.
- Specialized tty/null/out in _stdOfds:2502-2515 and PTY_CREATE:3239-3240 have
  no filesystem origin in those construction seams. FS_FSTAT:3947-3952 produces
  their synthetic records; they are a separate scope, not ordinary /dev opens.

The reviewer explicitly withdrew the claimed device-origin contradiction after
reading these seams (review-device-correction.md, full ticket comment
01a09042-6225-7874-912a-63ace1031155). No speculative conversion machinery or
injected-origin test is warranted to satisfy the withdrawn claim. Preserve the
existing origin paths and test them directly.

IMPORTANT naming boundary: BlockFS fd entry.dev at host.js:3011 is the device
I/O dispatch number, derived from inode.rdev. It is NOT stat.dev. Qualify the
returned stat object only; never overwrite entry.dev or inode.rdev with the
filesystem device identity. Multiple device nodes may share rdev while having
different filesystem inodes; hardlink aliases share filesystem identity.

Mandatory device evidence: real /dev/null and another filesystem-backed device,
stat(path) versus fstat(open), lstat of a device symlink versus followed stat,
dup/dup2/spawn-inherited and spawn-OPEN descriptors, device rename/unlink while
open, and unchanged rdev/I/O dispatch. Observe that these traverse kind:file.
Separately cover truly origin-less standard streams/PTYs through specialized
FSTAT as compatibility evidence for explicit dev:0 metadata; do not invent a
/dev origin or require false path-identity equality for those resources.

Separate tracked scope (no source work authorized here):
- #787 (01a09042-7883-7b76-9aad-7f9a275e1958): native Node adapter
  host.js:272-285. Native dev/ino width and overflow policy require their own
  coherent conversion design. It is not gucOS MountFS or the WASI backend.
- #788 (01a09042-c933-7ee0-96da-5f0501695a00): genuinely anonymous resource
  identity (pipes, sockets, origin-less tty/null/out/PTM and private analogues).
  Identity must eventually follow the actual shared resource, not numeric fd.

Strict serializers must preserve current excluded-producer behavior explicitly:
add documented dev:0 at each existing anonymous producer, retain its existing
ino and other metadata, and test that C/WASI fstat still succeeds. Raw private
BlockFS records and raw ProcFS records also explicitly carry dev:0 before owner
qualification. No serializer-wide missing-dev default may conceal a mounted or
remote producer bug. Preserve all existing producer fields when adding dev.
This compatibility metadata is NOT a fix for #787/#788 and no universal identity
conformance is claimed. Any new gap comment cites its separately tracked ticket
and is enrolled under the canonical liability rule in the implementation diff.

### E. Explicit error and mutation contracts

- Invalid mount configuration/token, contradictory explicit RO metadata, or a
  non-readonly/exact-mount mismatch: named TypeError before publishing hooks or
  creating workers. Valid-looking IDs exceeding uint32 capacity: named RangeError.
- Owner registry exhaustion: RangeError before any partial mount-hook setup;
  never wrap, silently renumber, or reuse an active/retired owner-lifetime ID.
- Missing optional RO authority: whole broker fallback, not a syscall error.
- Successful backend stat with missing, noninteger, negative, or out-of-range
  dev/ino is an internal metadata contract error. C adapter returns -1 and
  sets EIO through the existing errno channel; WASI returns its EIO code.
  Validate the entire identity pair before any stat output write. Backend
  syscall failures retain their original errno (ENOENT, EBADF, etc.). Do not
  turn invalid metadata into a guessed identity. Tests assert the unchanged
  destination sentinel for rejection; native EOVERFLOW policy belongs to #787.
- Internal qualification/getVolumeIdentity misuse is a named programmer error;
  no background catch silently falls back to dev0. Explicit legacy producers
  listed in D satisfy the adapter shape without pretending stronger semantics.

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
   Extend tests/blockfs/test_dev.js and tests/kernel/test_fs_e2e.js with the
   real filesystem-device/origin assertions in D. Include anonymous fstat
   compatibility checks in tests/kernel/test_tty.js and test_pty.js; verify
   those specialized FSTAT paths succeed with explicit legacy metadata. No
   injected-origin test is needed for the withdrawn conversion claim. Do not
   equate lack of runtime workers with an OS test.
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
(e) use tests/run.js --diff <approved-base> --dry-run as an impact inventory.
Do NOT mechanically restart a complete mapped gate. Under the coordinator's
focused batch exception, run only the coordinator-selected affected validation,
preserving prior unaffected evidence and every red. Any wider gate/landing
still requires explicit coordinator scope and launch authorization.
No --resume or carried-green evidence. Focused green does not waive broader red.
No commands in this section have been executed by this preparation.

## Review and implementation boundary

The reviewer accepted the owner/RO direction for PLANNING, not implementation.
Revision 2 adopts explicit live-volume tokens, whole broker fallback, explicit
legacy producer metadata and concrete error behavior. Filesystem device origins
stay in #785; native and genuinely anonymous identities are tracked separately.
The device-path reachability clarification in D is resolved by source audit
and explicit reviewer withdrawal; no additional origin machinery is proposed.
Recommended core: owner-qualified MountFS stats + owner-issued RO descriptor +
unchanged C/WASI layouts, with coverage of every mounted-file/device path.
No cmdalt special case, filename hash, random device number, process-local
registry, on-disk UUID retrofit, or per-stat RPC is proposed.

No repair claim, no current inode measurement, no new gate result, no merge or
landing approval. This revision is preparation for further review; implementation
must wait for the coordinator's next scope authorization and source freeze.
