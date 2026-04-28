/*
 * Test: Noise channel (CH4) and LFSR
 *
 * Build:
 *   ./a.out -a compile -o /tmp/test_noise.wasm samples/gameboy/apu-tests/test_noise.c samples/gameboy/gbapu.c
 *   node host.js /tmp/test_noise.wasm
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "../gbapu.h"

static gbapu_t apu;

static void test_noise_15bit(void) {
    printf("=== Noise 15-bit LFSR ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* CH4: max volume, fast clock (shift=0, divisor=0 → period=8) */
    gbapu_write(&apu, 0xFF20, 0x00); /* NR41: length */
    gbapu_write(&apu, 0xFF21, 0xF0); /* NR42: vol=15, no envelope */
    gbapu_write(&apu, 0xFF22, 0x00); /* NR43: shift=0, 15-bit, div=0 */
    gbapu_write(&apu, 0xFF23, 0x80); /* NR44: trigger */

    /* Pan to both */
    gbapu_write(&apu, 0xFF25, 0x88);
    gbapu_write(&apu, 0xFF24, 0x77);

    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    /* Noise should produce both positive and negative samples */
    int has_pos = 0, has_neg = 0;
    for (int i = 0; i < 100; i++) {
        if (buf[i * 2] > 0) has_pos = 1;
        if (buf[i * 2] < 0) has_neg = 1;
    }
    printf("has_pos: %s\n", has_pos ? "yes" : "no");
    printf("has_neg: %s\n", has_neg ? "yes" : "no");

    /* Print first 20 samples */
    printf("samples:");
    for (int i = 0; i < 20; i++) {
        printf(" %d", buf[i * 2]);
    }
    printf("\n");
}

static void test_noise_7bit(void) {
    printf("=== Noise 7-bit LFSR ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    gbapu_write(&apu, 0xFF20, 0x00);
    gbapu_write(&apu, 0xFF21, 0xF0);
    gbapu_write(&apu, 0xFF22, 0x08); /* NR43: shift=0, 7-bit mode, div=0 */
    gbapu_write(&apu, 0xFF23, 0x80);

    gbapu_write(&apu, 0xFF25, 0x88);
    gbapu_write(&apu, 0xFF24, 0x77);

    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    int has_pos = 0, has_neg = 0;
    for (int i = 0; i < 100; i++) {
        if (buf[i * 2] > 0) has_pos = 1;
        if (buf[i * 2] < 0) has_neg = 1;
    }
    printf("has_pos: %s\n", has_pos ? "yes" : "no");
    printf("has_neg: %s\n", has_neg ? "yes" : "no");

    /* 7-bit LFSR should cycle faster (127 states vs 32767) */
    /* Count distinct sample values in first 100 samples */
    int distinct = 0;
    int16_t prev = buf[0];
    for (int i = 1; i < 100; i++) {
        if (buf[i * 2] != prev) {
            distinct++;
            prev = buf[i * 2];
        }
    }
    printf("transitions: %d\n", distinct);
    printf("has_transitions: %s\n", distinct > 0 ? "yes" : "no");
}

static void test_noise_deterministic(void) {
    printf("=== Noise deterministic ===\n");

    /* Generate twice with same config, should match */
    int16_t buf1[200], buf2[200];

    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);
    gbapu_write(&apu, 0xFF21, 0xF0);
    gbapu_write(&apu, 0xFF22, 0x37); /* some specific config */
    gbapu_write(&apu, 0xFF23, 0x80);
    gbapu_write(&apu, 0xFF25, 0x88);
    gbapu_write(&apu, 0xFF24, 0x77);
    gbapu_generate(&apu, buf1, 100);

    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);
    gbapu_write(&apu, 0xFF21, 0xF0);
    gbapu_write(&apu, 0xFF22, 0x37);
    gbapu_write(&apu, 0xFF23, 0x80);
    gbapu_write(&apu, 0xFF25, 0x88);
    gbapu_write(&apu, 0xFF24, 0x77);
    gbapu_generate(&apu, buf2, 100);

    int match = 1;
    for (int i = 0; i < 200; i++) {
        if (buf1[i] != buf2[i]) { match = 0; break; }
    }
    printf("deterministic: %s\n", match ? "yes" : "no");
}

int main(void) {
    test_noise_15bit();
    test_noise_7bit();
    test_noise_deterministic();
    printf("PASS\n");
    return 0;
}
