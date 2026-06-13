#!/bin/sh
# Build bootable floppy image: stage-1 boot sector + stage-2 C kernel.
# Both tools come from this repo, no external compiler needed:
#   - asm86.js  (NASM-compatible, byte-identical output) assembles the boot sector
#   - tcc.wasm  (TCC built by compiler.js, run via host.js) compiles the kernel
set -e

# Find c-compiler repo root (3 levels up from xp/boot/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ASM86="node $ROOT_DIR/tools/asm86/asm86.js"
TCC_WASM="$ROOT_DIR/build/tcc.wasm"
TCC="node $ROOT_DIR/host.js $TCC_WASM"

# --- Ensure compiler.js-built TCC (wasm) is available ---
# No clang: compiler.js (this repo's C99->wasm compiler) builds TCC itself,
# and host.js runs it with real-filesystem access.  Output is byte-identical
# to a native (clang-built) tcc for this kernel.
if [ ! -f "$TCC_WASM" ]; then
    echo "Building tcc.wasm with compiler.js..."
    mkdir -p "$ROOT_DIR/build"
    node "$ROOT_DIR/compiler.js" "$ROOT_DIR/vendor/tcc/bin.json" -o "$TCC_WASM"
    echo "tcc.wasm build complete."
fi

cd "$SCRIPT_DIR"

# Stage 1 — boot sector (512 bytes)
echo "=== Stage 1: boot sector ==="
$ASM86 -f bin boot.asm -o boot.bin
echo "boot.bin: $(stat -f %z boot.bin) bytes"

# Stage 2 — kernel.  Linked at 0x10000, entry _start at offset 0.
# -nostdlib drops crt, -static drops dyn-linker, --oformat=binary strips ELF.
# Multiple .c files passed; first must be the entry point.
echo "=== Stage 2: kernel ==="
$TCC -nostdlib -static -fno-pic \
     -Wl,--oformat=binary -Wl,-Ttext=0x10000 \
     kernel.c fmath.c tcc_helpers.c \
     -o kernel.bin
echo "kernel.bin: $(stat -f %z kernel.bin) bytes"

# Pad kernel.bin to a multiple of 512 (one sector).
KSIZE=$(stat -f %z kernel.bin)
PAD=$(( (512 - (KSIZE % 512)) % 512 ))
if [ "$PAD" -gt 0 ]; then
    dd if=/dev/zero bs=1 count=$PAD of=kernel.bin conv=notrunc oseek=$KSIZE 2>/dev/null
    KSIZE=$((KSIZE + PAD))
fi
echo "kernel.bin: $KSIZE bytes (+$PAD pad)"

# Concatenate to one floppy image.
cat boot.bin kernel.bin > disk.img
echo ""
echo "Built disk.img ($(stat -f %z disk.img) bytes)"
echo "  boot sector:  boot.bin  (512 bytes, assembled by asm86.js)"
echo "  kernel:       kernel.bin ($KSIZE bytes, compiled by TCC)"
echo ""
echo "Deploy:  dd if=disk.img of=/dev/sdX      # USB stick"
echo "Emulate: use v86, QEMU, or any x86 emulator that supports legacy BIOS"
