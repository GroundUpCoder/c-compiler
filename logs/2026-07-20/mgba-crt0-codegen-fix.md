# mGBA crt0 derail — root cause is an in-OS short-read, NOT compiler.js codegen

**Date:** 2026-07-20
**Branch:** `mgba-crt0-codegen-fix`
**Ticket:** `todos/0140-mgba-cpu-miscompile.md`
**Charter:** land the compiler.js *codegen* fix behind the Mario Tennis crt0
derail (`BX` → `0x09000000`), anchored on the clang differential.

## Verdict

**The derail is not a compiler.js codegen bug.** The mGBA wasm is fine — the
*identical* binary boots Mario Tennis clean under bare `node host.js` (and so
does the clang golden build). It derails **only in-OS**, and the trigger is a
**short `read(2)`**: the in-OS RemoteFS/kernel `read()` caps each `FS_READ` RPC
at `KP_FS_CHUNK`, so a single large read returns far fewer bytes than requested.
mGBA's non-mmap `_vfdMap` ROM loader issues **one unlooped `read(fd, mem, 16MB)`
and ignores the return value**, so the `calloc`-zeroed 16 MB ROM buffer is left
mostly empty → the emulated ARM7TDMI reads open-bus ROM → `BX` to
`0x09000000`. Per the ticket's guard rail ("if the derail is a port or libc
gap, STOP and report"), no compiler.js change was made. This log is the
handoff; master sequences the fix + its P0 classification.

## How the prior threads missed it

- **2026-07-18 `mgba-clang-differential`** ran the clang build **bare**
  (`node host.js …/mariotennis.gba`, null-SDL) and saw it boot to the language
  selector. Its "compiler.js derails" column was labeled *"(prior controlled
  run)"* — cited from an earlier **in-OS** observation, **not re-run** in that
  differential.
- **2026-07-18 `mgba-compilerjs-fix`** rebuilt compiler.js fresh and found it
  boots Mario Tennis clean — but tested the **bare** path only, and concluded
  "could not reproduce / stale artifact."
- So both same-day threads compared **bare-vs-bare** (where compiler.js and
  clang *agree — both clean*) and never exercised the **in-OS** path, which is
  where the derail lives. The derail is **in-OS-only and compiler-independent.**

## Evidence (all on current `origin/main`, compiler.js `f38adc6…`)

Build is deterministic — two `node compiler.js vendor/mgba/bin.json -a compile`
runs are byte-identical (`59ba57…`), ruling out a nondeterministic miscompile.

| binary | bare (full read) | bare + 60 KB read cap | in-OS |
|---|---|---|---|
| mgba, single-read `_vfdMap` (stock) | **CLEAN** (873 DMA-to-VRAM/OAM) | **DERAIL** `0900…` | **DERAIL** `0900…` |
| mgba, looped-read `_vfdMap` (fix)   | CLEAN | **CLEAN** | (expected clean) |

- **In-OS derail reproduced:** booted gucOS (FAT fixture; mgba is the
  `packages/mgba.json` gucman package), seeded the 16 MB ROM, ran
  `mgba /root/mariotennis.gba &`. stdout: `GBA core ready (MARIOTENNISA)` then
  **1,507,954** `Jumped to invalid address: 09000000` / `Illegal opcode:
  0000ea00 / 0000b710`, **0** DMA-to-VRAM lines; shot series t=4…20 s = **100 %
  white**.
- **ROM file is intact in-OS:** `cksum /root/mariotennis.gba` =
  `2964597390 16777216` — byte-identical to the host file. Not on-disk
  corruption. `ROM[0x4B0]` (the crt0 literal) reads `0x08013349` — correct.
- **The in-OS `read()` short-reads (smoking gun):**
  `dd if=/root/mariotennis.gba bs=16M count=1` → `0+1 records` (one *partial*
  block); `bs=1M count=1` → `0+1 records`; `bs=64k` → `0+280 records` (all 280
  blocks partial). Every large single `read()` returns short in-OS.
- **The baked binary that derails in-OS runs CLEAN bare** (0 invalid-address,
  873 DMA-to-VRAM/OAM) — so it is **not the binary**.
- **Causation proven, bare, no OS:** temporarily capping bare `host.js`
  `readImpl` to 60 000 B/call (simulating the in-OS cap) makes the same baked
  binary derail bare — **1,401,312** invalid-address lines, identical
  `0x09000000`. Remove the cap → clean.
- **Fix proven, bare:** with the 60 KB cap still in place, looping `_vfdMap`'s
  `read()` until the buffer is filled → **clean boot** (873 DMA-to-VRAM/OAM).

## Root cause, precisely

- `vendor/mgba/src/gba/gba.c` `GBALoadROM`: for a 16 MB ROM the `else` branch
  runs `gba->memory.rom = vf->map(vf, pristineRomSize, MAP_READ)`.
- `vendor/mgba/src/util/vfs/vfs-fd.c` `_vfdMap` (`#else`, the no-`mmap` wasm
  path): `anonymousMemoryMap(size)` (= `calloc`, `util/memory.c`) then a single
  `read(vfd->fd, mem, size);` — **return value ignored, no loop.** POSIX allows
  `read()` to return fewer bytes than requested; this code assumes a full fill.
- `host.js`: the **bare** `readImpl` uses `fs.readSync(fd, buf, 0, count, pos)`,
  which fills a 16 MB regular-file read in one call → mgba boots. The **in-OS**
  path is RemoteFS → kernel `FS_READ` (`kernel.js` `KP_FS_CHUNK =
  floor((KP_PAYLOAD_CAP-4)/10000)*10000`), one RPC per call, returning ≤ chunk
  bytes → short read → mgba's unlooped fill leaves the ROM buffer zero-tailed.

## Two fix sites (master's call)

- **A — mGBA port fix (narrow).** Loop `_vfdMap`'s `read()` until `size` bytes
  or EOF. Correct, upstream-worthy (short reads are legal); fixes mgba only.
  Exact proven diff is in this log's table. Rebuild the `mgba` package +
  fixture; bump `image.json` version.
- **B — in-OS `read()` fill (broad, recommended P0).** Make the RemoteFS/kernel
  read path fill up to `count` (loop `FS_READ` RPCs) for regular files, so a
  single guest `read()` of a regular file returns as much as native/Node does.
  This fixes mgba **and the whole class**: *any* in-OS program doing one large
  `read()` of a regular file currently gets silently truncated data — a latent
  correctness landmine (mgba is just the first caught). File as **P0**.

Recommend **B** (or **B + A**). A regression that pins the actual bug and needs
no copyrighted ROM: an in-OS kernel/blockfs test asserting a single
`read(fd, buf, N)` of an `N`-byte regular file (`N > KP_FS_CHUNK`) returns `N`
(fails today, passes after B) — land it **with** the fix.

## Housekeeping

compiler.js **untouched**. No conformance test added (there is no C codegen
defect to pin). All experiment patches (`host.js` cap, `_vfdMap` loop) and the
throwaway ROM/`image.json` seeding were reverted; the branch carries docs only.
Real ROM used for the repro: `~/git/c-compiler-copy/vendor/gameboy/roms/
mariotennis.gba` (not committed — commercial).
