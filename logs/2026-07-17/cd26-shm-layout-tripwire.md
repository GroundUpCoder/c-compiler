# CD26 — shared-SAB layout tripwire (host.js ↔ kernel.js)

## The debt

The shm double-buffered surface SAB header was hand-declared on BOTH sides of
the module boundary with nothing enforcing agreement: kernel.js `SH_MAGIC/W/H/
FORMAT/FLIP/SEQ` + `SH_HDR_BYTES` (the compositor/screenshot reader) vs
host.js `WMSH_*` (shmPresent + the WebGPU shmSurface present path). Repad or
add a field on one side only and presents/screenshots corrupt SILENTLY — no
error, exactly the fail-loud-doctrine violation. The same disease covered the
input ring (`IR_*` vs `WMIR_*`), the event codes riding it (`WMEV` vs
`WMEV_*`), and the audio ring header (`AU_*` vs bare `16`/`0`/`1`/`2`
literals scattered through host.js's three audio flavors).

## Why not single-source

host.js is a standalone module that CANNOT import kernel.js (the layering
rule; the todos/0235 KP_PAYLOAD_CAP precedent), and kernel.js has no host.js
dependency either — both load side-by-side via `importScripts`/`require` in
each embedder. There is no shared module spanning the two, and inventing one
would touch every embedder's loading story (os.html, both workers, boot.js,
BOOT_SOURCE, tests). So the 0235 shape is the genuinely clean fix, not a
shortcut:

## The fix (the 0235 published-value shape, widened to a table)

- kernel.js declares `WM_SAB_LAYOUT` — ONE table built from its own constants
  covering every field: shm header (magic/w/h/format/flip/seq + magic value +
  header bytes), input ring (wpos/rpos/cap/dropped + header bytes + record
  words), the full `WMEV` event-code map, and the audio ring header
  (wpos/queued/playing + header bytes). Published on the spawnHooks seam as
  `wmSabLayout` (right next to 0235's `payloadChunk`) and in the module
  exports.
- host.js `assertWmSabLayout(hooks)` rebuilds the same table from its OWN
  `WMSH_*/WMIR_*/WMEV_*/WMAU_*` declarations and cross-checks BOTH key sets
  and every value (recursive), throwing a named error listing each drifted
  field. A missing `wmSabLayout` is itself a loud throw (one tree — missing =
  version skew, the 0235 rule).
- The check runs at `createSurfaceSDL` entry, which runModule builds for
  EVERY kernel-attached process — so it fires at pid 1 spawn, i.e. kernel
  boot, before any SAB traffic. Both-direction key comparison means adding a
  field on either side alone trips it — the drift CLASS is closed, not one
  offset.
- To make the audio claim real (not just a parallel table), host.js's audio
  literals became the checked constants: `WMAU_WPOS/QUEUED/PLAYING/HDR_BYTES`
  now used by audioRingPush, buildAudioEnv (kernel mixer source rings), the
  browser-flavor queue ops, createSharedAudioBuffer and createAudioReceiver.
  host.js also gained the two fields it never named (`WMSH_FORMAT`,
  `WMIR_DROPPED`) so the check covers the WHOLE header, not just the fields
  it happened to touch.

Not covered (surfaced, not silently narrowed): os.html is a standalone HTML
bridge (not a host.js importer) and keeps comment-synced copies of page-side
tables (e.g. CURSOR_CSS); it holds no copy of these SAB layouts (it consumes
them through host.js's createAudioReceiver), so nothing to check there. The
console-ring header (createSharedConsoleBuffer) is host.js↔page only — no
kernel-side declaration exists, so it's outside this class.

## Proof

- Perturbed `WMSH_FLIP` 4→9 in host.js only: boot fails immediately with
  `pid 1 crashed: Error: shared-SAB layout drift between host.js and
  kernel.js (CD26): shFlip (host.js 9 vs kernel.js 4) — the two declarations
  MUST move together`. Reverted; boot green again.
- Gate: unit 757 passed / 0 failed / 8 xfailed / 3 skipped; host all-pass;
  blockfs 15/0; kernel 75/0 (the boot/compositor/present/audio e2es all run
  through the live assert). No image bake, no os/ C, no compiler.js.
