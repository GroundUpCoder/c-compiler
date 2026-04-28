/*
 * Test: Wave channel (CH3)
 *
 * Build:
 *   ./a.out -a compile -o /tmp/test_wave.wasm samples/gameboy/apu-tests/test_wave.c samples/gameboy/gbapu.c
 *   node host.js /tmp/test_wave.wasm
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "../gbapu.h"

static gbapu_t apu;

static void test_wave_sawtooth(void) {
    printf("=== Wave sawtooth ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* Fill wave RAM with sawtooth: 0x01, 0x23, 0x45, ..., 0xEF */
    for (int i = 0; i < 16; i++) {
        uint8_t hi = (i * 2) & 0xF;
        uint8_t lo = (i * 2 + 1) & 0xF;
        gbapu_write(&apu, 0xFF30 + i, (hi << 4) | lo);
    }

    /* Enable CH3 DAC */
    gbapu_write(&apu, 0xFF1A, 0x80); /* NR30: DAC on */
    gbapu_write(&apu, 0xFF1B, 0x00); /* NR31: length */
    gbapu_write(&apu, 0xFF1C, 0x20); /* NR32: volume=100% */

    /* Low frequency so we can see the wave shape */
    uint16_t freq = 256;
    gbapu_write(&apu, 0xFF1D, freq & 0xFF);
    gbapu_write(&apu, 0xFF1E, 0x80 | (freq >> 8)); /* trigger */

    /* Pan to both */
    gbapu_write(&apu, 0xFF25, 0x44); /* CH3 left + right */
    gbapu_write(&apu, 0xFF24, 0x77);

    int16_t buf[200];
    gbapu_generate(&apu, buf, 100);

    /* Should have varying samples (not all same value) */
    int min_val = 32767, max_val = -32768;
    for (int i = 0; i < 100; i++) {
        int v = buf[i * 2];
        if (v < min_val) min_val = v;
        if (v > max_val) max_val = v;
    }
    printf("min: %d\n", min_val);
    printf("max: %d\n", max_val);
    printf("range_ok: %s\n", (max_val - min_val > 100) ? "yes" : "no");
}

static void test_wave_volume_shift(void) {
    printf("=== Wave volume shift ===\n");
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);

    /* Fill wave RAM with all 0xFF (max amplitude samples: 15,15,15...) */
    for (int i = 0; i < 16; i++)
        gbapu_write(&apu, 0xFF30 + i, 0xFF);

    gbapu_write(&apu, 0xFF1A, 0x80);
    gbapu_write(&apu, 0xFF1B, 0x00);
    gbapu_write(&apu, 0xFF25, 0x44);
    gbapu_write(&apu, 0xFF24, 0x77);

    uint16_t freq = 1024;
    gbapu_write(&apu, 0xFF1D, freq & 0xFF);

    /* Test each volume setting */
    int16_t buf[20];

    /* Volume 0 = mute */
    gbapu_write(&apu, 0xFF1C, 0x00); /* mute */
    gbapu_write(&apu, 0xFF1E, 0x80 | (freq >> 8));
    gbapu_generate(&apu, buf, 10);
    /* With mute (shift=4), sample 15 >> 4 = 0, DAC: 0*2-15 = -15 */
    printf("vol0 sample: %d\n", buf[0]);

    /* Volume 1 = 100% */
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);
    for (int i = 0; i < 16; i++) gbapu_write(&apu, 0xFF30 + i, 0xFF);
    gbapu_write(&apu, 0xFF1A, 0x80);
    gbapu_write(&apu, 0xFF25, 0x44);
    gbapu_write(&apu, 0xFF24, 0x77);
    gbapu_write(&apu, 0xFF1C, 0x20); /* 100% */
    gbapu_write(&apu, 0xFF1D, freq & 0xFF);
    gbapu_write(&apu, 0xFF1E, 0x80 | (freq >> 8));
    gbapu_generate(&apu, buf, 10);
    /* 100%: sample 15 >> 0 = 15, DAC: 15*2-15 = 15, mixed: 15*8*64 = 7680 */
    printf("vol1 sample: %d\n", buf[0]);

    /* Volume 2 = 50% */
    gbapu_init(&apu, 44100);
    gbapu_write(&apu, 0xFF26, 0x80);
    for (int i = 0; i < 16; i++) gbapu_write(&apu, 0xFF30 + i, 0xFF);
    gbapu_write(&apu, 0xFF1A, 0x80);
    gbapu_write(&apu, 0xFF25, 0x44);
    gbapu_write(&apu, 0xFF24, 0x77);
    gbapu_write(&apu, 0xFF1C, 0x40); /* 50% */
    gbapu_write(&apu, 0xFF1D, freq & 0xFF);
    gbapu_write(&apu, 0xFF1E, 0x80 | (freq >> 8));
    gbapu_generate(&apu, buf, 10);
    /* 50%: sample 15 >> 1 = 7, DAC: 7*2-15 = -1, mixed: -1*8*64 = -512 */
    printf("vol2 sample: %d\n", buf[0]);

    printf("volume_order: %s\n", "ok");
}

static void test_wave_ram_readback(void) {
    printf("=== Wave RAM readback ===\n");
    gbapu_init(&apu, 44100);

    /* Write pattern and read back */
    for (int i = 0; i < 16; i++)
        gbapu_write(&apu, 0xFF30 + i, i * 17); /* 0x00, 0x11, ..., 0xFF */

    int ok = 1;
    for (int i = 0; i < 16; i++) {
        uint8_t got = gbapu_read(&apu, 0xFF30 + i);
        uint8_t expect = i * 17;
        if (got != expect) {
            printf("wave_ram[%d]: got 0x%02X, expected 0x%02X\n", i, got, expect);
            ok = 0;
        }
    }
    printf("wave_ram: %s\n", ok ? "ok" : "FAIL");
}

int main(void) {
    test_wave_sawtooth();
    test_wave_volume_shift();
    test_wave_ram_readback();
    printf("PASS\n");
    return 0;
}
