/* sameboy_core_bench.c — headless SameBoy CORE benchmark, for todos/0332.
 *
 * Why this exists: /bin/sameboy is the ONE binary in the SHIPPED (minimal)
 * gucOS image whose lowering changed at the 0332 br_table cap bump, and the
 * function that changed is `GB_display_run` — the PPU, called from
 * `GB_advance_cycles` on every machine cycle. But /bin/sameboy is a win32/SDL
 * GUI app: run standalone under host.js it draws nothing and prints nothing,
 * so there is no way to time it without the full kernel harness.
 *
 * This harness links the SAME 14 core/*.c translation units the shipped binary
 * links (only src/main.c, the frontend, is replaced) and runs the emulator's
 * real `GB_run_frame` cadence headlessly, so the PPU cost is measured on the
 * shipped code path rather than inferred from it.
 *
 * The ROM is a self-contained minimal cartridge: a valid header (Nintendo
 * logo + checksum, so the boot ROM hands off) and an infinite `JR -2`. The CPU
 * is then idle by construction, which is the POINT — it isolates the
 * per-cycle PPU/timing work that GB_display_run does regardless of what the
 * program executes. Frame count is argv[1] (default 600 = 10 emulated seconds).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "gb.h"
#include "bootroms.h"

static uint32_t fb[160 * 144];
static GB_gameboy_t gb;
static unsigned long frames_done;

static uint32_t rgb_encode(GB_gameboy_t *g, uint8_t r, uint8_t gg, uint8_t b) {
    (void)g;
    return 0xFF000000u | ((uint32_t)b << 16) | ((uint32_t)gg << 8) | r;
}

static void vblank(GB_gameboy_t *g, GB_vblank_type_t type) {
    (void)g;
    if (type != GB_VBLANK_TYPE_REPEAT) frames_done++;
}

static void boot_rom_load(GB_gameboy_t *g, GB_boot_rom_t type) {
    switch (type) {
    case GB_BOOT_ROM_CGB_0:
    case GB_BOOT_ROM_CGB:
    case GB_BOOT_ROM_CGB_E:
    case GB_BOOT_ROM_AGB_0:
    case GB_BOOT_ROM_AGB:
        GB_load_boot_rom_from_buffer(g, cgb_boot, sizeof(cgb_boot));
        break;
    default:
        GB_load_boot_rom_from_buffer(g, dmg_boot, sizeof(dmg_boot));
        break;
    }
}

static uint8_t rom[32768];

static void build_rom(void) {
    static const uint8_t logo[48] = {
        0xCE,0xED,0x66,0x66,0xCC,0x0D,0x00,0x0B,
        0x03,0x73,0x00,0x83,0x00,0x0C,0x00,0x0D,
        0x00,0x08,0x11,0x1F,0x88,0x89,0x00,0x0E,
        0xDC,0xCC,0x6E,0xE6,0xDD,0xDD,0xD9,0x99,
        0xBB,0xBB,0x67,0x63,0x6E,0x0E,0xEC,0xCC,
        0xDD,0xDC,0x99,0x9F,0xBB,0xB9,0x33,0x3E,
    };
    memset(rom, 0, sizeof(rom));
    rom[0x100] = 0x00;                  /* NOP          */
    rom[0x101] = 0xC3;                  /* JP $0150     */
    rom[0x102] = 0x50;
    rom[0x103] = 0x01;
    memcpy(&rom[0x104], logo, 48);
    rom[0x134] = 'B'; rom[0x135] = 'E'; rom[0x136] = 'N'; rom[0x137] = 'C';
    rom[0x147] = 0x00;                  /* ROM only     */
    rom[0x148] = 0x00;                  /* 32 KB        */
    rom[0x149] = 0x00;                  /* no cart RAM  */
    {
        uint8_t ck = 0;
        for (int i = 0x134; i <= 0x14C; i++) ck = ck - rom[i] - 1;
        rom[0x14D] = ck;
    }
    rom[0x150] = 0x18;                  /* JR -2  (spin) */
    rom[0x151] = 0xFE;
}

int main(int argc, char **argv) {
    unsigned long want = (argc > 1) ? strtoul(argv[1], NULL, 10) : 600;
    build_rom();
    GB_init(&gb, GB_MODEL_DMG_B);
    GB_set_boot_rom_load_callback(&gb, boot_rom_load);
    GB_set_pixels_output(&gb, fb);
    GB_set_rgb_encode_callback(&gb, rgb_encode);
    GB_set_vblank_callback(&gb, vblank);
    GB_load_rom_from_buffer(&gb, rom, sizeof(rom));

    for (unsigned long i = 0; i < want; i++) GB_run_frame(&gb);

    /* Print a checksum of the final framebuffer as well as the frame count:
     * a timing harness whose work got optimized away, or whose two builds
     * disagree, must be caught rather than reported as a speedup. */
    uint32_t sum = 0;
    for (int i = 0; i < 160 * 144; i++) sum = sum * 31u + fb[i];
    printf("frames=%lu vblanks=%lu fbsum=%08x\n", want, frames_done, sum);
    return 0;
}
