# 0112 — mGBA: a GBA (+GB/GBC) core (`/bin/mgba`)

**Status: landed.** `/bin/mgba` is seeded in the Games menu; `.gba` opens with
it. mGBA 0.10.5 (upstream commit `26b7884`), MPL-2.0 core + an Apache-2.0 SDL3
frontend written against the `mCore` interface. This is the **GBA** leg — the
platform Peanut-GB (`/bin/gameboy`) and SameBoy (`/bin/sameboy`) can't reach.
Additive: `.gb`/`.gbc` still default to SameBoy.

## Shape of the port

Mirrors `vendor/sameboy` (0075): vendor a real C emulator core + a thin SDL3
frontend, seed into the image. Details in `vendor/mgba/README.md`.

- **Core subset (GBA-only, no deps).** From mGBA's `src/`: all of `arm/`, the
  `gba/` board + software renderer + `cart/`/`cheats/`/`sio/{gbp,joybus}`,
  `gb/audio.c` (GBA reuses the GB PSG for two legacy channels), a `core/`
  subset, a `util/` + `vfs/` subset, and third-party `blip_buf` + `inih`. 78
  `.c` files. Excluded: the SM83/GB core, C++ frontends (`platform/`), zlib/
  libpng/minizip/SQLite/LZMA, debugger/GDB/scripting/rewind/mem-search/
  threading/SIO-link/sharkport, and the GL renderer.
- **Config = mGBA's OpenEmu tier.** `-DM_CORE_GBA -DMINIMAL_CORE=1
  -DDISABLE_THREADING`, 32-bit `color_t` (RGBA8888, matches the surface /
  compositor). `MINIMAL_CORE=1` keeps `mCore.dirs` but drops `inputMap` and —
  the load-bearing part — the video-logger / video-proxy / HLE-audio-mixer
  machinery, so those `extra`/`feature` sources are neither vendored nor linked
  (they were the undefined-symbol wall on the first link). `DISABLE_THREADING`
  drops the thread-proxy field so `mVideoThreadProxyCreate` (an *unconditional*
  init call otherwise) vanishes too.
- **HLE BIOS.** GBA runs without the official BIOS via mGBA's HLE — no boot-ROM
  blob to embed (unlike SameBoy's DMG/CGB ROMs).
- **Frontend** (`src/main.c`, Apache-2.0): `GBACoreCreate` → `init` →
  `mCoreInitConfig` → `setVideoBuffer(240×160, stride 240)` →
  `loadROM(VFile)` → `reset`; per-frame `runFrame` + blip→SDL audio drain +
  addKeys/clearKeys from SDL keysyms; `__setAnimationFrameFunc` drives it. No
  ROM ⇒ a built-in **MODE 3 bitmap-fill test ROM** (a dozen hand-assembled ARM
  words: set DISPCNT=0x0403, fill VRAM with BGR555 red) — the always-run
  pixel-test target, the `/bin/gameboy`/`/bin/sameboy` bare-mode convention.
  Commercial `.gba` ROMs are not vendored; the `VFileOpen` path handles them.

## Compiler gaps this port surfaced (all fixed in `compiler.js`)

The interesting one:

- **Angle-include resolution was non-standard.** `resolveAndLex` searched the
  *including file's own directory* first for **both** `<>` and `""` includes.
  mGBA ships `include/mgba-util/string.h` in the same dir as a `common.h` that
  does `#include <string.h>` — so every TU's `<string.h>` resolved to mGBA's
  sibling (which declares `strndup`/`strlcpy`, **not** `memcpy`/`strlen`),
  leaving 199 "undeclared memcpy/strlen/…" errors across the tree. Direct
  `#include <string.h>` worked (its baseDir has no sibling), which is what made
  it a head-scratcher. Fix: `<>` now searches `-I` paths + system headers and
  only falls back to the including directory as a last resort (C11 6.10.2p2);
  `""` keeps current-dir-first (6.10.2p3). This is the standard rule and a
  latent-bug fix for any future port with a same-named local header. Verified
  against the 711-test unit suite (0 fail) + the full image bake (doom, quake,
  busybox, all win32 apps) — nothing regressed.

The rest were missing-symbol fills:

- `__builtin_bswap16/32/64` — prelude macros (wasm has no bswap opcode; ereader
  + the LOAD/STORE_*BE macros use them).
- `exp2` / `exp2f` — `<math.h>` (GBA BIOS `_ArcTan2`/soundbias math). `exp2(x)
  = exp(x·ln2)`.
- `rewinddir` — `<dirent.h>` + `__dirent.c`; re-opens by the name captured at
  `opendir` (no host rewind import). vfs-dirent's `VDirRewind` needs it.

## mGBA-source patches (3, all gated on `__MTOTS__` so the tree still builds elsewhere)

- `common.h`: `CONSTRUCTOR(FN)` drops `__attribute__((constructor))` — the
  compiler has no ctor pass. Only `mLOG_DEFINE_CATEGORY` uses it; without the
  ctor every log category id stays 0 (cosmetic; emulation unaffected).
- `gb/serialize.h`: the GB-savestate `static_assert(sizeof==0x11800)` is gated
  off — the compiler ignores `#pragma pack`, so the packed **Game Boy**
  savestate struct sizes differently. Unused here (pulled in only transitively
  via `gb/audio.c`; the GBA savestate uses natural alignment + explicit padding
  and its own assert holds — that's why only the GB one tripped). No savestate
  API is called by the frontend.
- `core/version.c`: vendored static (CMake generates it upstream).

## Verified

- `node compiler.js vendor/mgba/bin.json -a compile` — links clean.
- Headless core smoke (throwaway harness, direct `mCore`, no SDL): the built-in
  ROM runs 240 frames → 38400/38400 pixels non-zero + red. The ARM7TDMI
  interpreter, GBA memory/IO, and the MODE 3 software renderer all work.
- `node tests/kernel/test_mgba_e2e.js` — **PASS** (8/8): full image bake +
  boot, `mgba &` opens "mGBA" at 480×320, `wmctl shot` PPM is a ≥90%-red MODE 3
  fill, `.gba`→`/bin/mgba`, `.gb`/`.gbc` still→`/bin/sameboy`. Registered in
  `tests/kernel/run.js`.
- `node tests/run-unit.js` — 708 pass / 0 fail / 3 skip (compiler changes clean).

## Scoping notes

- **"Commercial `.gba` frame" acceptance** is met via the built-in MODE 3 test
  ROM (proves ARM core + renderer end-to-end headlessly) — the exact
  sameboy/gameboy pattern, since copyrighted ROMs aren't vendored. The
  `VFileOpen` real-ROM path is wired and covered by the same code.
- **Browser sweep leg** (`os-mgba.mjs`) not written — folds into the standing
  0064 operator-owed browser-leg debt (the kernel e2e is the committed
  headless pixel test).
- **GB/GBC via mGBA** deliberately not built (SM83 core excluded) — SameBoy is
  the more accurate GB/GBC core and stays the default, exactly as the item
  intended ("free side-effect, not the reason to vendor").

## Files

- `vendor/mgba/` — core subset + `bin.json` + `src/main.c` + `README.md` +
  `LICENSE` (MPL-2.0).
- `compiler.js` — angle-include fix, bswap builtins, exp2/exp2f, rewinddir.
- `os/image.json` — `/usr/bin/mgba`, Games-menu link, `gba` openwith line;
  `version` → **68**.
- `tests/kernel/{test_mgba_e2e.js,run.js}`.
