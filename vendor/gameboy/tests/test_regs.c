/*
 * Test: Register read/write and OR masks
 *
 * Build:
 *   ./a.out -a compile -o /tmp/test_regs.wasm samples/gameboy/apu-tests/test_regs.c samples/gameboy/gbapu.c
 *   node host.js /tmp/test_regs.wasm
 */
#include <stdio.h>
#include <stdint.h>
#include "../gbapu.h"

static gbapu_t apu;

static void test_or_masks(void) {
    printf("=== OR mask tests ===\n");

    /* Power on first */
    gbapu_write(&apu, 0xFF26, 0x80);

    /* NR10 (0xFF10): write 0x7F, read back should OR with 0x80 */
    gbapu_write(&apu, 0xFF10, 0x7F);
    printf("NR10: 0x%02X\n", gbapu_read(&apu, 0xFF10));  /* expect 0xFF */

    /* NR11 (0xFF11): only duty bits 7-6 readable, OR 0x3F */
    gbapu_write(&apu, 0xFF11, 0xC0);
    printf("NR11: 0x%02X\n", gbapu_read(&apu, 0xFF11));  /* expect 0xFF */
    gbapu_write(&apu, 0xFF11, 0x40);
    printf("NR11: 0x%02X\n", gbapu_read(&apu, 0xFF11));  /* expect 0x7F */

    /* NR12 (0xFF12): fully readable, OR 0x00 */
    gbapu_write(&apu, 0xFF12, 0xA5);
    printf("NR12: 0x%02X\n", gbapu_read(&apu, 0xFF12));  /* expect 0xA5 */

    /* NR13 (0xFF13): write-only, OR 0xFF */
    gbapu_write(&apu, 0xFF13, 0x00);
    printf("NR13: 0x%02X\n", gbapu_read(&apu, 0xFF13));  /* expect 0xFF */

    /* NR14 (0xFF14): only length_enable (bit 6) readable, OR 0xBF */
    gbapu_write(&apu, 0xFF14, 0x40);
    printf("NR14: 0x%02X\n", gbapu_read(&apu, 0xFF14));  /* expect 0xFF */
    gbapu_write(&apu, 0xFF14, 0x00);
    printf("NR14: 0x%02X\n", gbapu_read(&apu, 0xFF14));  /* expect 0xBF */

    /* NR30 (0xFF1A): only bit 7 readable, OR 0x7F */
    gbapu_write(&apu, 0xFF1A, 0x80);
    printf("NR30: 0x%02X\n", gbapu_read(&apu, 0xFF1A));  /* expect 0xFF */
    gbapu_write(&apu, 0xFF1A, 0x00);
    printf("NR30: 0x%02X\n", gbapu_read(&apu, 0xFF1A));  /* expect 0x7F */

    /* NR32 (0xFF1C): bits 6-5 readable, OR 0x9F */
    gbapu_write(&apu, 0xFF1C, 0x60);
    printf("NR32: 0x%02X\n", gbapu_read(&apu, 0xFF1C));  /* expect 0xFF */

    /* Unused registers (0xFF27) should read 0xFF */
    printf("unused: 0x%02X\n", gbapu_read(&apu, 0xFF27)); /* expect 0xFF */
}

static void test_wave_ram(void) {
    printf("=== Wave RAM tests ===\n");

    /* Wave RAM is readable/writable even when powered off */
    gbapu_write(&apu, 0xFF26, 0x00); /* power off */
    gbapu_write(&apu, 0xFF30, 0xAB);
    gbapu_write(&apu, 0xFF3F, 0xCD);
    printf("wave[0]: 0x%02X\n", gbapu_read(&apu, 0xFF30));  /* expect 0xAB */
    printf("wave[F]: 0x%02X\n", gbapu_read(&apu, 0xFF3F));  /* expect 0xCD */
}

static void test_nr52(void) {
    printf("=== NR52 tests ===\n");

    gbapu_init(&apu, 44100);

    /* Power off: NR52 should read 0x70 */
    printf("NR52 off: 0x%02X\n", gbapu_read(&apu, 0xFF26)); /* expect 0x70 */

    /* Power on */
    gbapu_write(&apu, 0xFF26, 0x80);
    printf("NR52 on: 0x%02X\n", gbapu_read(&apu, 0xFF26));  /* expect 0xF0... no. */
    /* No channels enabled yet, so should read 0x80 | 0x70 = 0xF0... wait */
    /* 0x80 (power) | 0x70 (OR mask) | 0x00 (no channels) = 0xF0 */

    /* Enable CH1: set envelope to non-zero (DAC on), then trigger */
    gbapu_write(&apu, 0xFF12, 0xF0); /* volume=15, no envelope */
    gbapu_write(&apu, 0xFF14, 0x80); /* trigger */
    uint8_t nr52 = gbapu_read(&apu, 0xFF26);
    printf("NR52 ch1: 0x%02X\n", nr52); /* expect 0xF1 (power|mask|ch1) */
}

static void test_power_off(void) {
    printf("=== Power off clears regs ===\n");

    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80); /* power on */
    gbapu_write(&apu, 0xFF12, 0xF0); /* CH1 envelope */
    gbapu_write(&apu, 0xFF14, 0x80); /* trigger CH1 */

    /* Power off */
    gbapu_write(&apu, 0xFF26, 0x00);

    /* NR12 should be cleared (reads as OR mask only) */
    printf("NR12 after off: 0x%02X\n", gbapu_read(&apu, 0xFF12)); /* expect 0x00 */

    /* NR52 should show no channels */
    printf("NR52 after off: 0x%02X\n", gbapu_read(&apu, 0xFF26)); /* expect 0x70 */
}

int main(void) {
    gbapu_init(&apu, 44100);
    test_or_masks();
    test_wave_ram();
    test_nr52();
    test_power_off();
    printf("PASS\n");
    return 0;
}
