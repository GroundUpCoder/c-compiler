# KP_PAYLOAD_CAP dedup (todos/0235, arch CS6)

The kernel-page payload margin was restated by hand at four unrelated
sites: RemoteFS read/write chunked at a bare `60000`, host.js's clipboard
and http staging lanes at a bare `49152` ("well under the kernel page
payload cap" — by comment only), and the pty `PTY_OUT_CAP` sizing proof
cited "60000 … 120000 < cap" as prose. A drift trap: any future
kernel-page-size change (the HAIRY H4 bulk-lane work) would have to find
every shadow by grep, and the pty whole-or-block discipline could rot
silently if one site moved.

Now there is one source. `KP_FS_CHUNK` and `KP_HOOK_CHUNK` are derived
next to `KP_PAYLOAD_CAP` (framing headroom, rounded down to each lane's
historical granule — both values numerically unchanged, so zero behavior
change today) and exported. The pty proof is enforced at module load:
`2*KP_FS_CHUNK > PTY_OUT_CAP` throws, so the proof can't silently rot.

The one non-mechanical bit: host.js can't import kernel.js (standalone
pages load host.js alone; the two files share constants only by
MUST-MATCH convention). The chunk therefore rides the existing
`KernelClient.spawnHooks()` seam as `payloadChunk` — the kernel already
owned "host.js does the chunking, payloads pre-framed" for these lanes,
so the cap is naturally a property of the kernel connection. host.js
REQUIRES the field when a kernel lane is actually live and throws loud
otherwise (no shadow fallback literal — kernel.js and host.js ship from
one tree, so a missing field means version skew).

Gate: host (118s) + blockfs (15/15) + kernel (75/75, incl. the pty/
clipboard/http e2es that ride the derived values) + browser sweep 27/27
(os-shell flaked once on the first post-bake boot, green on isolated
rerun). Pure JS — no C touched, no image.json bump; the test runners
re-baked the fixture only because host.js/kernel.js are bake *inputs*
(staleness mtime gate), not image contents.
