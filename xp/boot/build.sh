#!/bin/sh
# Build bootable floppy image: stage-1 boot sector + stage-2 C kernel.
# Uses asm86.js (NASM-compatible, byte-identical output) and TCC.
set -e

# Find c-compiler repo root (3 levels up from xp/boot/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ASM86="node $ROOT_DIR/tools/asm86/asm86.js"
TCC="$ROOT_DIR/build/tcc-native"

# --- Ensure native TCC is built ---
if [ ! -x "$TCC" ]; then
    echo "Building tcc-native..."
    cd "$ROOT_DIR"
    clang -O2 -g0 \
        -DCONFIG_TCC_CROSSPREFIX=\"i386-\" -DCONFIG_TCCDIR=\"/tcc\" \
        -DCONFIG_TCC_SYSINCLUDEPATHS=\"/tcc/include\" \
        -DCONFIG_TCC_LIBPATHS=\"/tcc/lib\" \
        -I vendor/tcc vendor/tcc/tcc.c \
        -o build/tcc-native
    echo "tcc-native build complete."
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
