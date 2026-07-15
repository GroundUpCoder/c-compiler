/* Headless SameBoy CPU/PPU benchmark: no SDL, deterministic (todos/0186).
 * usage: bench <rom> <frames>   (prints model, then a framebuffer checksum)
 * Pure GB_run_frame throughput for compiler A/B comparison — the checksum
 * is the correctness interlock: a miscompile changes it, so a "faster"
 * number with a wrong sum is rejected by tests/bench/run.js. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "gb.h"
#include "bootroms.h"

#define LCD_WIDTH  160
#define LCD_HEIGHT 144

static uint32_t fb[LCD_WIDTH * LCD_HEIGHT];
static GB_gameboy_t gb;

static uint32_t rgb_encode(GB_gameboy_t *g, uint8_t r, uint8_t gg, uint8_t b) {
    (void)g; return 0xFF000000u | ((uint32_t)b << 16) | ((uint32_t)gg << 8) | r;
}
static void vblank(GB_gameboy_t *g, GB_vblank_type_t t) { (void)g; (void)t; }
static void boot_rom_load(GB_gameboy_t *g, GB_boot_rom_t type) {
    switch (type) {
    case GB_BOOT_ROM_CGB_0: case GB_BOOT_ROM_CGB: case GB_BOOT_ROM_CGB_E:
    case GB_BOOT_ROM_AGB_0: case GB_BOOT_ROM_AGB:
        GB_load_boot_rom_from_buffer(g, cgb_boot, sizeof(cgb_boot)); break;
    default:
        GB_load_boot_rom_from_buffer(g, dmg_boot, sizeof(dmg_boot)); break;
    }
}

int main(int argc, char **argv) {
    if (argc < 3) { printf("usage: bench <rom> <frames>\n"); return 1; }
    const char *rom_path = argv[1];
    long frames = atol(argv[2]);

    FILE *f = fopen(rom_path, "rb");
    if (!f) { printf("cannot open %s\n", rom_path); return 1; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *rom = malloc(n);
    if (fread(rom, 1, n, f) != (size_t)n) { printf("read fail\n"); return 1; }
    fclose(f);

    GB_model_t model = (rom[0x143] & 0x80) ? GB_MODEL_CGB_E : GB_MODEL_DMG_B;
    GB_init(&gb, model);
    GB_set_boot_rom_load_callback(&gb, boot_rom_load);
    GB_set_pixels_output(&gb, fb);
    GB_set_rgb_encode_callback(&gb, rgb_encode);
    GB_set_vblank_callback(&gb, vblank);
    GB_load_rom_from_buffer(&gb, rom, n);
    printf("model=%s frames=%ld\n", GB_is_cgb(&gb) ? "CGB-E" : "DMG-B", frames);

    for (long i = 0; i < frames; i++) GB_run_frame(&gb);

    /* checksum fb to defeat dead-code elimination */
    uint32_t sum = 0;
    for (int i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) sum = sum * 31u + fb[i];
    printf("done sum=%08x\n", sum);
    return 0;
}
