# Handoff — start of thread (updated 2026-07-11; 0112 mGBA closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0112 (mGBA GBA core) is CLOSED and COMMITTED.** `/bin/mgba` is a real
ARM7TDMI Game Boy Advance emulator — mGBA 0.10.5's C core (MPL-2.0) with an
Apache-2.0 SDL3 frontend written against the `mCore` interface. It's the third
emulator leg (after 0075 SameBoy, 0088 puNES-still-open) and the platform
`/bin/gameboy` + `/bin/sameboy` can't reach: **GBA**. Additive — `.gb`/`.gbc`
still default to SameBoy; `.gba` → `/bin/mgba`. Seeded in the Games menu. Dev
log `logs/2026-07-11/0112-mgba-gba-core.md`; item at
`todos/done/0112-mgba-emulator.md`; port lives in `vendor/mgba/`
(`README.md` has the license split + patch table + excluded-subsystem list).

One breath: GBA-only, mGBA's OpenEmu config (`M_CORE_GBA`/`MINIMAL_CORE=1`/
`DISABLE_THREADING`, 32-bit RGBA color, HLE BIOS — no boot-ROM blob). 78 core
`.c` files (arm + gba board/software-renderer + gb/audio + core/util subsets +
blip_buf/inih); the SM83/GB core, C++ frontends, and all optional deps (zlib/
png/zip/sqlite/lzma) are excluded. `MINIMAL_CORE=1` is load-bearing: it drops
the video-logger/proxy/HLE-mixer machinery that was the undefined-symbol wall.
Frontend `vendor/mgba/src/main.c`: `GBACoreCreate` → run frames → blip→SDL
audio + SDL-keysym input; bare `mgba` runs a built-in MODE 3 test ROM (a dozen
hand-assembled ARM words → red frame) as the headless pixel-test target.

**This port drove 4 compiler.js changes** (all general, unit-suite-clean):
1. **Angle-include resolution is now standard** — `#include <string.h>` no
   longer resolves to a same-dir sibling. `<>` searches `-I` paths + system
   headers before the including directory (C11 6.10.2p2); `""` unchanged. This
   was the whole ballgame: mGBA's `include/mgba-util/string.h` was shadowing
   the real `<string.h>` for every TU → 199 undeclared-memcpy errors.
2. `__builtin_bswap16/32/64` prelude macros.
3. `exp2` / `exp2f` in `<math.h>`.
4. `rewinddir` in `<dirent.h>` (re-opens by name; no host import).

Plus 3 `__MTOTS__`-gated mGBA patches (no-ctor-attr CONSTRUCTOR, GB-savestate
`#pragma pack` assert off, static `version.c`) — all marked `PATCH(c-compiler)`.

**Verified** (all PASS): `node tests/kernel/test_mgba_e2e.js` (8/8 — bake+boot,
window at 480×320, `wmctl shot` ≥90%-red MODE 3 frame, `.gba`→mgba,
`.gb`/`.gbc`→sameboy); `node tests/run-unit.js` (708/0/3); the e2e's full image
bake compiled doom/quake/busybox/all win32 apps unbroken. `node
todos/queue.js check` passes.

## Operator-owed (browser)

No `os-mgba.mjs` written — the browser sweep leg folds into the standing **0064**
operator-owed debt (the kernel e2e is the committed headless pixel test). 0064
still owes the operator: the pointer-lock human check + the 0094–0107 browser
legs (incl. the unrun `os-paint.mjs` from 0107). Run the browser sweep with
`node tests/browser/os-sweep.mjs` when Playwright is available (not installed
in-repo here).

## Gotchas carried forward (trimmed to the live ones)

- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (hit + fixed this session; the
  rename showed `RM` until re-added). **Concurrent sessions exist: stage ONLY
  your own files.**
- **Don't edit bake inputs while a suite runs** (0082): `.md`/`tests/` are NOT
  inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`, `vendor/` ARE. Bump
  `image.json` `version` (now **68**) when seeded-source edits must reach a
  persistent browser OPFS image.
- **New kernel test files must be added to `tests` in run.js** (did so for
  `test_mgba_e2e.js`).
- **Vendoring a mature C codebase**: the include-shadowing class (a project
  header named like a system header, in the same dir as a file that includes
  the system one) is now handled by the compiler — but watch for `#pragma pack`
  (silently ignored → mis-sized structs; only bites packed savestate/wire
  structs) and `__attribute__((constructor))` (no ctor pass — gate it off).
- **mCore config tiers**: `MINIMAL_CORE=1` = OpenEmu (keeps dirs, drops
  inputMap + video-log/proxy/mixer); `=2` = libretro (also drops dirs). Use 1
  for a full frontend; the extra sources you *don't* want to vendor are exactly
  the ones it `#ifndef`s out.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium with
  `--enable-unsafe-webgpu --enable-features=Vulkan`.

## Next in queue

`node todos/queue.js list` — after 0112: **0088** (puNES NES core → `/bin/punes`
— note its GPL means a repo-wide license quarantine, unlike mGBA's file-scoped
MPL), then **0079/0080**, **0052/0053**, the 0083/0084 pair, **0064** (WM
browser sweep round 3 — the standing operator debt). Heavier P1→P3 tail after.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0111's recorded decisions (see todos/done/); **0112's
calls (GBA-only — SM83/GB core excluded, SameBoy stays the GB/GBC default;
OpenEmu `MINIMAL_CORE=1` config; HLE BIOS not a boot-ROM blob; built-in MODE 3
test ROM as the headless acceptance since commercial `.gba`s aren't vendored;
the standard-correct angle-include resolution fix)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0112 mGBA just landed; next
is 0088 puNES). 0064 WM sweep round 3 still owes the operator the pointer-lock
check and the 0094–0107 + new mgba browser legs."
