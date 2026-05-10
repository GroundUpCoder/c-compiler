/*
 * TinyEMU main() wrapper for the WASM build.
 *
 * Calls vm_start() with argv[1] as the config file path. The VM runs
 * via emscripten_async_call callbacks after main() returns, so the
 * runtime must NOT exit when main returns.
 *
 * Usage: tinyemu <config.cfg> [ram_size_mb]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cutils.h"
#include "virtio.h"
typedef enum { BF_MODE_RO, BF_MODE_RW, BF_MODE_SNAPSHOT } BlockDeviceModeEnum;
BlockDevice *block_device_init(const char *filename, BlockDeviceModeEnum mode);

/* Sentinel export: the host treats the presence of __no_exit_runtime as
 * "don't process.exit after main; this program has async work pending."
 * Definition is trivial — only the exported symbol matters. */
static void __no_exit_runtime(void) { }
__export __no_exit_runtime = __no_exit_runtime;

/* Override the JS-imported HTTP block-device init with a file-backed one.
 * jsemu's init_vm_drive calls block_device_init_http unconditionally,
 * but for a Node-headless build we want the disk image read from disk.
 *
 * The caller writes our return value into `p->tab_drive[0].block_dev`
 * AFTER we return — so we must defer the start callback (which walks
 * that field) until after the current call unwinds. */
typedef void EmuCB(void *);
void emscripten_async_call(EmuCB *fn, void *arg, int millis);
BlockDevice *block_device_init_http(const char *url, int chunk_size,
                                    EmuCB *start_cb, void *opaque)
{
    BlockDevice *bs = block_device_init(url, BF_MODE_RW);
    if (start_cb) emscripten_async_call(start_cb, opaque, 0);
    return bs;
}

/* From jsemu.c. Defined unconditionally — the host feeds keyboard input
 * by calling console_queue_char one char at a time. */
void console_queue_char(int c);
__export console_queue_char = console_queue_char;

/* From jsemu.c. */
void vm_start(const char *url, int ram_size, const char *cmdline,
              const char *pwd, int width, int height, int has_network);
__export vm_start = vm_start;

int main(int argc, char **argv) {
    const char *config = "root-riscv32.cfg";
    int ram_size = 128;

    if (argc > 1) config = argv[1];
    if (argc > 2) ram_size = atoi(argv[2]);

    vm_start(config, ram_size, "", 0, 0, 0, 0);
    return 0;
}
