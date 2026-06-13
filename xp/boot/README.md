# bare-metal voxel boot

Voxel Space terrain renderer that boots directly from a floppy disk image — no
operating system.  Runs on legacy-BIOS x86 machines and in the v86 emulator.

This is the bare-metal segment from video 011 on the
[GroundUpCoder](https://www.youtube.com/@GroundUpCoder) YouTube channel.

## How it works

1. BIOS loads the first 512-byte sector (the MBR) at `0x7C00`
2. The boot sector loads stage 2 from disk via INT 13h, sets VGA Mode 13h,
   enables A20, switches to 32-bit protected mode, and jumps to the C kernel
3. The kernel generates a heightmap, sets a 3-3-2 RGB palette, and renders a
   fly-around voxel landscape directly to the VGA framebuffer at `0xA0000`

No libc.  No libm.  No standard headers.  Custom float math (`fmath.c`), port
I/O for palette registers, raw writes to video memory.

## Files

| File | Role |
|------|------|
| `boot.asm` | Stage 1: 512-byte MBR (NASM syntax, assembled by asm86.js) |
| `kernel.c` | Stage 2: voxel terrain renderer (entry point `_start`) |
| `fmath.c` / `fmath.h` | Custom sin/cos/sqrt — no libm dependency |
| `tcc_helpers.c` | TCC runtime stubs (float↔int conversion, 64-bit shifts) |
| `build.sh` | Build pipeline → `disk.img` |

## Build

```bash
./build.sh
```

The build uses two tools, both from this repo — **no external compiler needed**:

- **asm86.js** (`tools/asm86/asm86.js`) — assembles `boot.asm` to a 512-byte
  boot sector.  Produces byte-for-byte identical output to NASM 2.16.03.
- **TCC** (`build/tcc.wasm`) — compiles the C kernel to raw x86 binary.  TCC is
  itself built by `compiler.js` (this repo's C99 → wasm compiler) from
  `vendor/tcc/`, then run via `host.js`, which gives the wasm program real
  filesystem access.  No clang in the loop.

Both tools are verified — `cmp` reports zero differences against their
reference implementations (NASM for the boot sector, a clang-built native TCC
for the kernel) for this exact code.  `build.sh` builds `tcc.wasm` on first run
and caches it under `build/`.

## Deploy

To a USB stick for real hardware boot:

```bash
dd if=disk.img of=/dev/sdX
```

Requires a machine with **legacy BIOS** (not UEFI-only).

Note: on real hardware with UEFI firmware that also supports legacy/CSM boot,
the firmware will often refuse to boot a disk in BIOS mode unless it has a valid
MBR (the `0x55 0xAA` signature at bytes 510–511).  Even though legacy BIOS is
supposed to just load sector 0 and jump, in practice the UEFI+legacy hybrid
firmware checks for the MBR signature first — without it, the disk isn't
considered BIOS-bootable.

## Emulate

The same `disk.img` works in the v86 browser-based x86 emulator.  The story
repo (`~/git/story/videos/011-color-a-pixel/v86-poc/`) has `bundle.mjs` which
inlines v86 + SeaBIOS + VGA BIOS + disk.img into a single self-contained HTML
file.

## Related

- Video production: `~/git/story/videos/011-color-a-pixel/`
- C compiler: `~/git/c-compiler/` (compiler.js — C99 → WASM)
- TCC source: `~/git/c-compiler/vendor/tcc/` (Tiny C Compiler 0.9.27)
- asm86.js: `~/git/c-compiler/tools/asm86/asm86.js`
- WASM SDL-subset voxel: `~/git/sandbox/xp/voxel-terrain/` (same algorithm,
  different target)
