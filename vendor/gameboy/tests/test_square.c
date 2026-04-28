/*
 * Test: Square wave channel generation
 *
 * Build:
 *   ./a.out -a compile -o /tmp/test_square.wasm samples/gameboy/apu-tests/test_square.c samples/gameboy/gbapu.c
 *   node host.js /tmp/test_square.wasm
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "../gbapu.h"

static gbapu_t apu;

static void test_silent_when_off(void) {
    printf("=== Silent when powered off ===\n");
    gbapu_init(&apu, 44100);
    int16_t buf[64];
    memset(buf, 0xAA, sizeof(buf));
    gbapu_generate(&apu, buf, 32);
    int all_zero = 1;
    for (int i = 0; i < 64; i++) {
        if (buf[i] != 0) { all_zero = 0; break; }
    }
    printf("silent: %s\n", all_zero ? "yes" : "no");
}

static void test_ch1_square_50(void) {
    printf("=== CH1 square 50%% duty ===\n");
    gbapu_init(&apu, 44100);

    /* Power on */
    gbapu_write(&apu, 0xFF26, 0x80);

    /* CH1: 50% duty, max volume, no envelope, no sweep */
    gbapu_write(&apu, 0xFF10, 0x00); /* NR10: no sweep */
    gbapu_write(&apu, 0xFF11, 0x80); /* NR11: duty=2 (50%), length=0 */
    gbapu_write(&apu, 0xFF12, 0xF0); /* NR12: vol=15, no envelope */

    /* Frequency for ~440 Hz: freq_reg = 2048 - 131072/440 ≈ 1750 */
    uint16_t freq = 1750;
    gbapu_write(&apu, 0xFF13, freq & 0xFF);         /* NR13 */
    gbapu_write(&apu, 0xFF14, 0x80 | (freq >> 8));  /* NR14: trigger */

    /* Pan CH1 to both channels */
    gbapu_write(&apu, 0xFF25, 0x11); /* NR51: CH1 left + right */
    gbapu_write(&apu, 0xFF24, 0x77); /* NR50: max volume both sides */

    /* Generate some samples */
    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    /* Check: samples should be non-zero (sound is playing) */
    int has_positive = 0, has_negative = 0;
    for (int i = 0; i < 100; i++) {
        if (buf[i * 2] > 0) has_positive = 1;
        if (buf[i * 2] < 0) has_negative = 1;
    }
    printf("has_pos: %s\n", has_positive ? "yes" : "no");
    printf("has_neg: %s\n", has_negative ? "yes" : "no");

    /* Check symmetry: left == right (both panned) */
    int symmetric = 1;
    for (int i = 0; i < 100; i++) {
        if (buf[i * 2] != buf[i * 2 + 1]) { symmetric = 0; break; }
    }
    printf("stereo_sym: %s\n", symmetric ? "yes" : "no");

    /* Print first 20 left-channel samples for manual inspection */
    printf("samples:");
    for (int i = 0; i < 20; i++) {
        printf(" %d", buf[i * 2]);
    }
    printf("\n");
}

static void test_ch2_panning(void) {
    printf("=== CH2 panning ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* CH2: 50% duty, max volume */
    gbapu_write(&apu, 0xFF16, 0x80); /* NR21: duty=2 */
    gbapu_write(&apu, 0xFF17, 0xF0); /* NR22: vol=15 */

    uint16_t freq = 1750;
    gbapu_write(&apu, 0xFF18, freq & 0xFF);
    gbapu_write(&apu, 0xFF19, 0x80 | (freq >> 8));

    /* Pan CH2 to LEFT only */
    gbapu_write(&apu, 0xFF25, 0x20); /* NR51: CH2 left only */
    gbapu_write(&apu, 0xFF24, 0x77);

    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    /* Left should have sound, right should be silent */
    int left_nonzero = 0, right_nonzero = 0;
    for (int i = 0; i < 100; i++) {
        if (buf[i * 2] != 0) left_nonzero = 1;
        if (buf[i * 2 + 1] != 0) right_nonzero = 1;
    }
    printf("left_sound: %s\n", left_nonzero ? "yes" : "no");
    printf("right_silent: %s\n", right_nonzero ? "no" : "yes");
}

static void test_dac_off(void) {
    printf("=== DAC off = silent ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* Set envelope to 0x00 → DAC disabled */
    gbapu_write(&apu, 0xFF11, 0x80);
    gbapu_write(&apu, 0xFF12, 0x00); /* DAC off */
    gbapu_write(&apu, 0xFF13, 0x00);
    gbapu_write(&apu, 0xFF14, 0x80); /* trigger */
    gbapu_write(&apu, 0xFF25, 0x11);
    gbapu_write(&apu, 0xFF24, 0x77);

    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    int all_zero = 1;
    for (int i = 0; i < 200; i++) {
        if (buf[i] != 0) { all_zero = 0; break; }
    }
    printf("dac_off_silent: %s\n", all_zero ? "yes" : "no");
}

int main(void) {
    test_silent_when_off();
    test_ch1_square_50();
    test_ch2_panning();
    test_dac_off();
    printf("PASS\n");
    return 0;
}
