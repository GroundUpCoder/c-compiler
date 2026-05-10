# TinyEMU 2019-12-21

Unmodified upstream sources from https://bellard.org/tinyemu/tinyemu-2019-12-21.tar.gz

- **Version**: 2019-12-21 (latest available; upstream has not released since)
- **Author**: Fabrice Bellard
- **License**: MIT (see `MIT-LICENSE.txt`)
- **SHA256**: `be8351f2121819b3172fcedce5cb1826fa12c87da1b7ed98f269d3e802a05555`

Sources are vendored verbatim — no patches applied. Files match the upstream
tarball exactly (62 files, ~27,000 lines of C). The tarball was extracted
directly into this directory; nothing has been reorganized into `src/` yet
(unlike `vendor/zlib` and `vendor/lua`), pending a decision on how this
project will be wired into the build system.

## What this is

TinyEMU is Bellard's emulator suite. It includes:

- A RISC-V system emulator (RV128IMAFDQC, both 32/64/128-bit, FP, compressed
  instructions): `riscv_cpu*.c`, `riscv_machine.c`
- An x86 system emulator (KVM-based on Linux, but the C source is portable):
  `x86_cpu*.c`, `x86_machine.c`
- VirtIO devices (console, network, block, input, 9P): `virtio.c`
- Graphical display (SDL): `sdl.c`, `simplefb.c`, `vga.c`
- Soft-float implementation: `softfp.c` (with `softfp_template*.h`)
- Misc utilities: `cutils.c`, `aes.c`, `sha256.c`, `json.c`
- Filesystem support (disk, network, 9P): `fs*.c`
- Slirp user-mode networking: `slirp/` subdirectory
- A JavaScript demo runtime: `js/`, `jsemu.c`

## Notes for adapting to this compiler

The previous port (in `~/git/c-compiler-old/projects/tinyemu/`) added these
files on top of the upstream tarball — they are NOT in this fresh extraction:

- `block_file.c` — wasm-specific block-device implementation
- `tinyemu_main.c` — wasm host entry point
- `project.json` — old build-system config
- `diskimage-linux-riscv-2018-09-23` — Linux RISC-V disk image (binary,
  shipped alongside tinyemu by Bellard at the same URL)

If the goal is a fresh port, those will need to be re-created or copied over
and adapted. `softfp.c` is the cleanest standalone candidate for an early
compile-test — it has minimal external dependencies and exercises a lot of
bit-level integer code.
