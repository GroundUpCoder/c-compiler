/*
 * Test: Multi-channel mixing and envelope
 *
 * Build:
 *   ./a.out -a compile -o /tmp/test_mixing.wasm samples/gameboy/apu-tests/test_mixing.c samples/gameboy/gbapu.c
 *   node host.js /tmp/test_mixing.wasm
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "../gbapu.h"

static gbapu_t apu;

static void test_two_channels(void) {
    printf("=== Two channels mixed ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* CH1: 50% duty, vol=15, ~440 Hz */
    gbapu_write(&apu, 0xFF10, 0x00);
    gbapu_write(&apu, 0xFF11, 0x80);
    gbapu_write(&apu, 0xFF12, 0xF0);
    uint16_t f1 = 1750;
    gbapu_write(&apu, 0xFF13, f1 & 0xFF);
    gbapu_write(&apu, 0xFF14, 0x80 | (f1 >> 8));

    /* CH2: 50% duty, vol=15, ~880 Hz */
    gbapu_write(&apu, 0xFF16, 0x80);
    gbapu_write(&apu, 0xFF17, 0xF0);
    uint16_t f2 = 1899; /* 2048 - 131072/880 ≈ 1899 */
    gbapu_write(&apu, 0xFF18, f2 & 0xFF);
    gbapu_write(&apu, 0xFF19, 0x80 | (f2 >> 8));

    /* Both channels to both sides */
    gbapu_write(&apu, 0xFF25, 0x33); /* CH1+CH2 left+right */
    gbapu_write(&apu, 0xFF24, 0x77);

    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    /* With two channels, samples can be larger than with one */
    int max_abs = 0;
    for (int i = 0; i < 100; i++) {
        int v = buf[i * 2];
        if (v < 0) v = -v;
        if (v > max_abs) max_abs = v;
    }
    /* One channel max: 15 * 8 * 64 = 7680. Two channels: up to 15360 */
    printf("max_abs: %d\n", max_abs);
    printf("mixed_louder: %s\n", max_abs > 7680 ? "yes" : "no");
}

static void test_master_volume(void) {
    printf("=== Master volume ===\n");

    /* Generate with max master volume */
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);
    gbapu_write(&apu, 0xFF11, 0x80);
    gbapu_write(&apu, 0xFF12, 0xF0);
    gbapu_write(&apu, 0xFF13, 0x00);
    gbapu_write(&apu, 0xFF14, 0x86); /* freq=0x600, trigger */
    gbapu_write(&apu, 0xFF25, 0x11);
    gbapu_write(&apu, 0xFF24, 0x77); /* max volume (7+1=8) */

    int16_t buf_loud[20];
    gbapu_generate(&apu, buf_loud, 10);

    /* Generate with min master volume */
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);
    gbapu_write(&apu, 0xFF11, 0x80);
    gbapu_write(&apu, 0xFF12, 0xF0);
    gbapu_write(&apu, 0xFF13, 0x00);
    gbapu_write(&apu, 0xFF14, 0x86);
    gbapu_write(&apu, 0xFF25, 0x11);
    gbapu_write(&apu, 0xFF24, 0x00); /* min volume (0+1=1) */

    int16_t buf_quiet[20];
    gbapu_generate(&apu, buf_quiet, 10);

    /* Loud should be ~8x louder than quiet */
    int loud_max = 0, quiet_max = 0;
    for (int i = 0; i < 10; i++) {
        int vl = buf_loud[i * 2]; if (vl < 0) vl = -vl;
        int vq = buf_quiet[i * 2]; if (vq < 0) vq = -vq;
        if (vl > loud_max) loud_max = vl;
        if (vq > quiet_max) quiet_max = vq;
    }
    printf("loud_max: %d\n", loud_max);
    printf("quiet_max: %d\n", quiet_max);
    /* loud should be 8x quiet */
    int ratio = quiet_max > 0 ? loud_max / quiet_max : 0;
    printf("ratio: %d\n", ratio);
    printf("volume_scales: %s\n", ratio >= 7 ? "yes" : "no");
}

static void test_envelope_decay(void) {
    printf("=== Envelope decay ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* CH1: vol=15, envelope decrease, period=1 (fastest decay) */
    gbapu_write(&apu, 0xFF10, 0x00);
    gbapu_write(&apu, 0xFF11, 0x80);
    gbapu_write(&apu, 0xFF12, 0xF1); /* vol=15, decrease, period=1 */
    gbapu_write(&apu, 0xFF13, 0x00);
    gbapu_write(&apu, 0xFF14, 0x86);
    gbapu_write(&apu, 0xFF25, 0x11);
    gbapu_write(&apu, 0xFF24, 0x77);

    /* Generate a larger buffer to let envelope run */
    /* Envelope ticks at 64 Hz (frame seq step 7, every 8 steps at 512 Hz) */
    /* At 44100 Hz, 64 Hz = ~689 samples per envelope tick */
    /* With period=1, volume decreases by 1 each tick */
    /* After 15 ticks (~10335 samples), volume should reach 0 */

    /* Sample at start */
    int16_t buf[20];
    gbapu_generate(&apu, buf, 10);
    int start_max = 0;
    for (int i = 0; i < 10; i++) {
        int v = buf[i * 2]; if (v < 0) v = -v;
        if (v > start_max) start_max = v;
    }

    /* Skip ahead past most envelope decay (~12000 samples) */
    int16_t skip[24000];
    gbapu_generate(&apu, skip, 12000);

    /* Sample after decay */
    gbapu_generate(&apu, buf, 10);
    int end_max = 0;
    for (int i = 0; i < 10; i++) {
        int v = buf[i * 2]; if (v < 0) v = -v;
        if (v > end_max) end_max = v;
    }

    printf("start_max: %d\n", start_max);
    printf("end_max: %d\n", end_max);
    printf("decayed: %s\n", end_max < start_max ? "yes" : "no");
}

static void test_length_counter(void) {
    printf("=== Length counter ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* CH1: length=63 (so counter=1), length_enable=1 → very short */
    gbapu_write(&apu, 0xFF10, 0x00);
    gbapu_write(&apu, 0xFF11, 0xBF); /* duty=2, length=63 → counter=1 */
    gbapu_write(&apu, 0xFF12, 0xF0);
    gbapu_write(&apu, 0xFF13, 0x00);
    gbapu_write(&apu, 0xFF14, 0xC6); /* trigger + length_enable + freq high */
    gbapu_write(&apu, 0xFF25, 0x11);
    gbapu_write(&apu, 0xFF24, 0x77);

    /* Length counter ticks at 256 Hz. Counter=1 means it will expire
     * after 1 tick (1/256 sec ≈ 172 samples at 44100 Hz) */
    int16_t buf[1000];
    gbapu_generate(&apu, buf, 500);

    /* Check: channel should be off by the end */
    int early_sound = 0, late_sound = 0;
    for (int i = 0; i < 50; i++) {
        if (buf[i * 2] != 0) early_sound = 1;
    }
    for (int i = 400; i < 500; i++) {
        if (buf[i * 2] != 0) late_sound = 1;
    }
    printf("early_sound: %s\n", early_sound ? "yes" : "no");
    printf("late_silent: %s\n", late_sound ? "no" : "yes");
}

int main(void) {
    test_two_channels();
    test_master_volume();
    test_envelope_decay();
    test_length_counter();
    printf("PASS\n");
    return 0;
}
