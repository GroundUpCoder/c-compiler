# 0235 — arch CS6: dedup the kernel-page payload chunk constants onto derived KP_PAYLOAD_CAP

- **Status**: done (2026-07-17)
- **Design**: —

## Goal

The kernel-page payload margin was re-derived by hand at several unrelated
sites, shadowing the true cap (`KP_PAYLOAD_CAP`, kernel.js) — a drift trap
that blocks any future kernel-page-size change (the HAIRY H4 prereq):

- kernel.js RemoteFS read/write: `Math.min(count, 60000)` bare literals.
- host.js clipboard `__clip_set` + http body staging: `CHUNK = 49152` bare
  literals ("well under the kernel page payload cap" by comment only).
- kernel.js pty `PTY_OUT_CAP` sizing proof: prose-only ("60000 … 120000 <
  cap") — nothing enforced it, so a cap change could silently rot the
  whole-or-block discipline.

## Plan

One true source, everything derives:

- `KP_FS_CHUNK` / `KP_HOOK_CHUNK` derived from `KP_PAYLOAD_CAP` next to its
  definition (framing headroom, rounded down to each lane's historical
  granule — values numerically unchanged today: 60000 / 49152). Exported.
- RemoteFS read/write chunk on `KP_FS_CHUNK`.
- The pty ONLCR proof becomes a load-time assert: `2*KP_FS_CHUNK <=
  PTY_OUT_CAP` throws if violated — the proof can't silently rot.
- **Small API** (host.js can't import kernel.js — standalone layering, the
  two files share constants only by convention): `KernelClient.spawnHooks()`
  now publishes `payloadChunk: KP_HOOK_CHUNK`; host.js's clipboard/http
  staging lanes take the chunk from the hooks seam, and REQUIRE it (loud
  throw) when a kernel lane is actually live — no shadow literal, no silent
  fallback (hooks and kernel.js ship from the same tree, so a missing field
  means version skew, which should fail loud).

## Acceptance

- Grep: no bare 60000/49152 payload literals left in kernel.js/host.js.
- Kernel suite green (incl. pty/clipboard/http e2es); host + unit suites
  green; browser sweep green.
- Pure JS — no C touched, no image version bump.
