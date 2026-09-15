# #790 — configure serials, buffer generations, real shm frame ownership

Author: Fable 5.1 coordinator/author thread 01a0a417-6825-79e9-abd3-bcd59dbbd86d,
branch `author/790-frame-identity`, worktree `~/git/c-compiler-790`, based on
main 7799eb32 (#794 landed). Gamedev justification: editors and tools of the
in-gucOS dev loop resize constantly (panels, docked consoles, live previews)
and the toolkits over the surface protocol (Win32 today, Swing next) need to
know WHICH configuration a frame answers and that a submitted frame cannot be
overwritten under the compositor. Contract anchor: `small/GUCOS-UI-CONTRACT.md`
"Resize, scaling and frame ownership" (configure serials, retained
intermediate resize, latest target, bounded retained configurations,
stale-configuration rejection, real frame ownership, geometry epochs on input).

## What was true before (rederived from 7799eb32)

- `kernel.js` kept ONE `pendingConfigure {w,h}` per surface with no identity:
  any ack with a matching-shaped SAB while anything was pending was accepted,
  and a client that could not allocate the new buffer left the pending state
  forever (the WM waited on nothing).
- `WINDOW_RESIZED` ring words [4..7] were zero; `EV_CONFIGURED` was `{sid,w,h}`.
- The shm mailbox was a two-buffer flip with NO ownership word: the compositor
  (`os/compositor.js shmBindFor`) read `SH_FLIP` and copied the front buffer
  while the producer's NEXT present wrote that same buffer (it had just become
  the back). `tests/kernel/test_shm_ownership.js`'s red control reproduces the
  tear with real threads against exactly that flip.
- The compositor's upload cache keyed on `(w, h, seq)`; an equal-size
  reconfigure yields a fresh SAB whose `seq` restarts, so stale pixels could be
  shown.

## Kernel (kernel.js)

- Every issued configure (`wmResize`, `SURFACE_RESIZE`, both through
  `_wmIssueConfigure`) mints a per-surface monotonic SERIAL, carried in
  `WINDOW_RESIZED` word [4]; `SURFACE_RESIZE` replies with it. The kernel keeps
  a bounded set of still-valid issued configures (`WM_CFG_OUTSTANDING` = 4,
  oldest retire) plus `committedSerial`; the newest issued is always the
  pending target. Delivery failure rolls the set back, never reuses a serial.
- `SURFACE_CONFIGURE {sid, w, h, serial}` must name its serial and the new
  SAB's `SH_GEN` (header word 6) must equal it. Accept = still-valid issued AND
  newer than committed AND the serial's dims; a superseded ack re-issues the
  pending target under ITS serial. Anything else about the identity — unknown,
  retired, already committed, nothing pending, wrong dims — is `ESTALE` with no
  geometry change (one error shape; `EINVAL` = malformed request/SAB); every
  `ESTALE` is counted (`configureStaleCount()`). `decline: true` with no SAB
  retires the serial and everything older, clears the pending target and emits
  `EV_CONFIGURE_DECLINED 0x97 {sid, serial, w, h}`. The same event fires when a
  superseded target cannot be re-delivered (full ring): the outstanding set
  retires so nothing stays pending forever. `EV_CONFIGURED` carries the serial
  as its 4th word. The reply carries `serial` + `gen`.
- `_wmFrame(pcb, sid, bmp, serial)` closes a gpu frame of a RETIRED serial
  unseen (`wmFrameRejectedCount()`); size is deliberately not an identity (a
  raw webgpu.h producer sizes its own surface and was always drawn scaled).
- Pointer records (motion/button/wheel) carry the committed serial in word [6]
  — the geometry epoch — stamped in `_wmEventTo`, the one choke.
- `GET_STATE` gains `buffer {w,h,gen,frameSeq,flipMisses}`, `dst {w,h}`,
  `configure {committed, pending, pendingW, pendingH, outstanding}`; `wmList`
  gains `committedSerial`, `pendingSerial`, `gen`, `flipMisses`.
- `SH_LOCK` (header word 7): `wmScreenshot` — the ONE kernel-side front-buffer
  read (headless composite and thumbnails funnel through it) — holds it across
  its copy with a bounded CAS spin (`WM_SHM_LOCK_SPIN`, ~1.5 ms measured), reads
  unlocked past the bound and counts the miss (`shmLockMisses()`).
- `SH_PMISS` (header word 8): the producer's own flip-lock misses, visible
  kernel-side (`shmFlipMisses()` summed for the compositor-stats probe).

## host.js / compositor / veneer

- `allocFb(w, h, gen)` stamps the generation; `beginConfigure(win, w, h,
  serial)` keeps ONE outstanding configure host-side (the newest serial) and
  DECLINES the serial at once when the SAB cannot be allocated; `ackConfigure`
  names the serial and keeps the old buffer on `ESTALE` (`frameStats()`).
- `wmShmFlip(fb, back)`: all three shm present sites (shmPresent, the software
  renderer's present, the Dawn readback tail) flip under `SH_LOCK` with a
  bounded `Atomics.wait` (caught on a main thread), never across their memcpy
  (the back buffer is never read by a consumer); a miss past the bound flips
  unlocked and bumps `SH_PMISS`.
- gpu transport: `shipFrame` ships with the committed serial (`win.serial`),
  the ack still goes first.
- `os/compositor.js makeShmUploader` (factored out for a Node test): upload
  gated on `(gen, seq)`, a short bounded try-lock, never a wait; on contention
  the PREVIOUS uploaded texture stays bound (a new-generation texture replaces
  the old one only after its first successful upload) and `takeRetry()` forces
  a re-submit next rAF; `stats.shmContended`.
- SDL veneer: `SDL_GetWindowSizeInPixels` / `SDL_GetWindowPixelDensity` /
  `SDL_GetWindowDisplayScale` with their real 1:1 contracts (1 buffer px = 1
  screen px; WM scaling of a fixed-size window is presentation policy the app
  never sees); `os/doc/sdl-api-index.md` regenerated. No new C API for
  serials: an SDL client's renderable configuration is its latest RESIZED
  event, and the RESIZED event is historical while the size queries are
  current (SDL3 semantics — the browser fixture's first version wrongly
  demanded equality and was corrected).
- `os/wm_proto.h`: `WMP_EV_CONFIGURE_DECLINED 0x97`; image 294 → 295 (wm_proto.h
  and the veneer are bake inputs).

## Tests and evidence (`790-evidence/`)

- `tests/kernel/test_wm_frames.js` (LIGHT, 73 checks): create identity,
  issue/ack identity, ESTALE on unknown/retired/backward/wrong-dims/nothing-
  pending, the outstanding bound, equal-size regeneration, decline (incl. of an
  older serial, and the undeliverable re-issue), destroy with a configure and a
  gpu frame in flight, gpu frame identity by serial, pointer geometry epochs,
  GET_STATE/wmList identities, a seeded 300-op storm pinning SAB W/H/GEN ==
  surface w/h/committedSerial after EVERY op, SH_LOCK bounded reads,
  SH_PMISS visibility, wm-sabs hygiene on decline.
- `tests/kernel/test_shm_ownership.js` (LIGHT, worker_threads): a real
  producer hammering 4 MB locked flips vs the kernel's locked read — hundreds
  of concurrent frames, 400 reads, 0 torn, 0 misses on either side; RED
  CONTROL: the pre-#790 unlocked flip tears within a few reads.
- `tests/host/test_surface_configure.js` (26): both host flavours — serial
  reaches beginConfigure, SH_GEN = serial, ack names it, ESTALE keeps the old
  buffer, allocation failure declines (SharedArrayBuffer wrapper refuses),
  supersession, locked flips, wedged consumer → bounded producer + SH_PMISS,
  gpu ships carry the committed serial.
- `tests/host/test_compositor_shm.js` (18): the uploader with a fake device —
  (gen, seq) gating, equal-size regeneration = new texture, contention after a
  reconfigure binds the PREVIOUS uploaded texture (the review-1 blocker), old
  texture destroyed only after the upload lands, retry flag; RED CONTROL: the
  d5a04892 algorithm binds a never-uploaded texture.
- `tests/browser/os-ui-frames.mjs` + `ui-frames.c` (installed OPFS image,
  software AND WebGPU renderers, automated Playwright — NOT manual): every
  frame encodes its own geometry in its fill colour; three wmctl resize storms
  (latest-wins to 400x300; end-where-you-started equal-size regeneration;
  twenty alternating sizes) and a real SE frame drag must each settle on
  EXACTLY w*h pixels of the committed geometry's colour and ZERO of any
  retired colour; kernel probes assert zero SH_LOCK misses (kernel and
  producer side) and zero rejected frames; the gpu run must ship bitmaps and
  the software run none. Evidence JSON records commit, sha256 of every source
  and served file, the installed VERSION_ID pinned to the manifest, browser
  version, per-phase counts, probe deltas, the transcript, and the load the
  run executed under (`CC_UNDER_LOAD`, exported by the suite runner since this
  batch). Screenshots are WebGPU copies of the composited canvas.
- Two-sided edits: `test_wm.js` (serials + the nothing-pending ack is now
  ESTALE), `test_wm_policy.js` (EV_CONFIGURED serial), `test_wm_anchored.js`
  (child resize serial); `os-gpubox.mjs` asserts zero rejected gpu frames.

## Independent review round 1 → counter-pass

Reviewer thread 01a0a73c-8aae-75ee-b218-377ff863ffaa (claude-code /
claude-fable-5-1 — disclosed switch: the Codex reviewer lane is capped until
2026-09-19 21:30; a first reviewer thread 01a0a441-83ab-7355-a9a5-492c75b336ed
died on its own session limit before reading anything and was re-spawned).
REJECTED 7799eb32..d5a04892 with one blocking and nine lesser findings:

1. **BLOCK — compositor bound a never-uploaded texture on SH_LOCK contention
   right after a reconfigure — fixed.** `shmBindFor` destroyed the old texture
   and created the new entry BEFORE the try-lock. Now `makeShmUploader`
   try-locks first; on contention the previous uploaded texture stays bound
   (whatever its generation/size — drawn into the current rect, the
   contract's "temporary scaling is presentation policy"); a new-generation
   entry replaces the old only after its first successful upload. Pinned by
   `tests/host/test_compositor_shm.js` (fake device, red control = the old
   algorithm); `os/compositor.js` now also maps to the host suite.
2. **major — WM.md cited this log before it existed — fixed** (this file).
3. minor — one error shape: ESTALE for any serial that is not a still-valid
   issued one, nothing-pending included; every ESTALE counted — fixed, legs
   updated two-sided.
4. minor — `_wmFrame` size rejection was a behaviour change for raw webgpu.h
   producers — fixed: serial-only rejection; contract stated in WM.md;
   `os-gpubox.mjs` asserts `framesRejected === 0`.
5. minor — "under load" claim not in the record — fixed: the suite runner
   exports `CC_UNDER_LOAD` to members, evidence.json records it.
6. minor — host-side flip misses unobservable outside the unit test — fixed:
   `SH_PMISS` header word, wmList/GET_STATE/`shmFlipMisses()` +
   compositor-stats, asserted zero per driver by the browser test.
7. nit — superseded re-issue ignored EAGAIN — fixed: retire + EV_CONFIGURE_
   DECLINED, leg added.
8. nit — `_bumpWm()` on decline — dropped.
9. nit — `beginConfigure` pre-0019 early return — returns true.
10. nit (shipper note) — the header grew words, so a mixed-cache deploy window
    trips the CD26 layout guard on every spawn until both files are the same
    deploy; expect it in the ship log.

Re-review of the exact counter-pass tip and the mapped gate on it are
recorded below.
