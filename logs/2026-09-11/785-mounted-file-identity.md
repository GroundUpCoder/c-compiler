# #785 — mounted file identity and Foundation batch integration

MountFS now qualifies filesystem identity at the namespace owner, so two
independent mounted volumes cannot collapse into the same `(st_dev, st_ino)`
pair. This fixes the identity seam used by command-alternative shadow detection;
it does not special-case cmdalt or change its original assertions.

The owner issues checked device identifiers, can explicitly share a volume key
for readers of one live inode namespace, and returns qualified metadata copies.
Read-only worker acceleration requires an owner-issued, explicitly eligible leaf
volume descriptor. Any descendant mount disables that descriptor, including a
second reader of the same volume. Missing coverage keeps operations brokered;
malformed metadata refuses. Both Node and browser workers propagate the same
identity/leaf information. C/WASI serializers validate identity before writing
results. No ABI layout change or per-stat cross-layer identity registry is added.
Native-adapter and anonymous-object boundaries remain tracked in #787/#788.

The sole #785 author implemented and ran the focused backend work in its existing
external thread; Foundation executor `01a08d63` transferred the exact eight-path
patch and prepared this journal without repeating execution. Independent reviewer
`01a0834a` remained distinct. Source approval `01a0905b-cb50` and actual-dependency
approval `01a0905f-7277` cover eight-path tree
`2403c16ccff8faf749ff78df17aa0fb10987fe7e` on real parent
`aacbd1675336927543b6ad2434de9d5188767ff3`. The original patch is
`60ef1825ef00697212e4506cfa1a4bff12ebfe78a3428936b1613239cd8d23a1`;
the actual-history index patch is
`9d1759f4431bb6cca76361912f7a6a27ad6307ce0604cad05550a346defad277`.
The two committed srclib inputs and Foundation journals are retained. No callback
`3bb96c0a` or unpublished preparation seed is included.

## Scoped evidence and retained failures

All run directories below are under `build/trap783/durable-run-gate-` in the
integration lane. They are retained evidence, not additional committed fixtures.
Their `author-audit.json` and `author-evidence-pins.json` identify the full archives.

| Attempt | Independent disposition | What the record establishes |
| --- | --- | --- |
| Node V2 | RED, retained | Earlier incomplete attempt is not reused as a completed case. |
| `86r0_bd2` / `01a0908a` | Four-case Node acceptance | 48 exact rows across leaf-local, leaf-broker, inherited fd and nested-broker cases; generated owner witnesses, local zero enumerated FS RPCs and brokered behavior. |
| `wg6qwl94` / `01a090ab` | Browser acceptance | 28 exact rows, three positive eligible RO identity processes, real warm single-use witnesses, aliases and `/dev/null`; served/transformed source provenance retained. |
| `w8muo0_1` / `01a090b4` | RED stage; original tests accepted | All 53 original checks and both boots pass, including four former shadow failures. Required identity file is absent; no historical shadow pair or inherited-hook cause is established. |
| `le3ges2n` / `01a090cd` | RED with scope violation | Explicit hook installation/entry is observed, but zero qualifying chmod observations; both requested chmod executions fail. Default-package sync/fetch was attempted contrary to the no-package grant. No successful installation/network delivery is inferred. |
| `sir4jj5z` / `01a090e5-675c` | Changed WRITE observation accepted | Exactly one completed-content observation measures shadow `1:67` and dispatcher `2:68` in an explicitly changed fresh-root/default-sync-omission scenario. |

The v1 implementation's nested-mount red control (14 pass, two fail) is also
retained. The corrected lightweight test reports 17 pass; existing mount/RO
checks passed. Historical lightweight records did not pin the Node executable;
source equality after transfer does not reconstruct engine provenance. No fresh
lightweight run was claimed solely for that transfer.

The observation RED exposed a mistaken instrument assumption: `--packages=none`
selects image contents; it does not disable runtime default synchronization.
Its native boot exited 127, with parent/pane 1. The later approved instrument
explicitly omits that service in pinned transformed boot bytes while retaining
ordinary wm and original module paths. This is a changed scenario, not a repair
of product boot behavior or a retroactive waiver of the violation.

WRITE acceptance retains system `f07105d6...`, fresh root `9f155399...`, exact
59-line prefix and transformed boot `f8cc9291...`. All 247 sequential records
link 79 WRITE conditions, responses and completions with responder restoration.
A complete 10-byte submitted write is excluded for incomplete content; a complete
16-byte submitted write finishes the exact 26-byte shadow content. These are two
ordinary writes, not a short-write test. The qualifying owner stat/lstat pair is
shadow dev1/ino67/mode0644/rdev0 versus dispatcher dev2/ino68/mode0755/rdev0.
Known chmod execution failure remains in stderr: no chmod755 or permission
correctness is established. Default-sync omission changes scheduling and inode
allocation; this pair cannot reconstruct an earlier writable root or old pair.
Offset/atime nonmutation is supported by the reviewed separate readonly handle
and backing view, not an independent before/after state-diff experiment.

Native outcomes remain distinct. Node guests halt0; five workers exit1 after
kernel-requested termination, not worker-native0. Node parent/pane exit0.
Browser guest waits are kernel observations, not Worker native callbacks;
Chromium and owned server native exit/close0 and browser temporary cleanup were
captured. Cmdalt original test and two boots exit0 while its enclosing stage
parent/pane exit1; package-server native exit remains unknown. WRITE boot
exit/close0 and parent/pane0 were captured; worker native callbacks were not.
Selected process/lock absence is point-in-time evidence, not exhaustive descendant
history. Failure-injection, deadline and forced-cleanup branches are not validated
by successful ordinary cleanup. Browser's retained daemon diagnostic is preserved.

## Combined batch evidence and landing boundary

The original mapped 25-suite run `osq5fb9_` remains RED permanently: 182/206 kernel
and 70/74 browser passes, all 28 failures containing Foundation source-requirement
drift diagnostics. Its unaffected passes and scoped Foundation/array/ObjC results
retain their own source pins, skips and native/image-provenance qualifications.
The srclib repair is separately committed as `f0a36ae0`; its exact affected run
`axqqhvbk` has 24/25 fresh kernel and 4/4 fresh browser passes, including all 61
checker checks. Its sole cmdalt failure remains RED. The 181 kernel/70 browser
carried entries in that follow-up are historical, not fresh executions.

The current #785 original cmdalt checks now pass at the repaired host inputs,
and the accepted focused worker/browser/WRITE records address their stated
obligations. Combining these records requires explicit independent final review;
this journal does not turn either earlier run green, assert all old successful
corpora ran on the new host, or declare blanket all-engine coverage. Previously
accepted #782 six Firefox controls are preserved at their tested pins and were
not repeated. Original WebKit/import and all subsequent diagnostic reds remain.

At preparation, root main is `93310c636f24ff022f114acc2d030db9eedb37e0`, an
ancestor of the batch parent. Local `origin/main` is `cee82600...`; no remote
query/fetch is implied. Root untracked projects and editor probes are preserved.
Current CLAUDE.md requires a journal, targeted merge validation and ordinary
hooks; a full ship gate is a separate deployment obligation. The user's scoped
batch policy permits review of retained unaffected broad evidence plus affected
repair evidence instead of mechanical whole-gate or successful-control replays.

Remaining: exact staged candidate/journal and combined-evidence acceptance;
coordinator commit/landing decision; normal-hook separate #785 commit with its
verified parent/tree; fresh main-drift and root-untracked collision checks before
main advance; final committed identity and ticket outcomes recorded. No commit,
main advance, deployment, cleanup or additional workload is performed by this
preparation. Dispatch optimization remains deferred to real workloads.
