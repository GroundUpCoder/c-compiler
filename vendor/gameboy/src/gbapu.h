/*
 * gbapu.h — Game Boy APU (Audio Processing Unit) emulator
 *
 * Emulates the 4 sound channels of the Game Boy:
 *   CH1: Square wave with frequency sweep
 *   CH2: Square wave
 *   CH3: Programmable wave
 *   CH4: Noise (LFSR)
 *
 * Usage:
 *   gbapu_t apu;
 *   gbapu_init(&apu, 44100);
 *   // Wire register reads/writes from the GB emulator:
 *   gbapu_write(&apu, addr, val);
 *   uint8_t v = gbapu_read(&apu, addr);
 *   // Generate stereo S16 audio:
 *   int16_t buf[frames * 2];
 *   gbapu_generate(&apu, buf, frames);
 */
#ifndef GBAPU_H
#define GBAPU_H

#include <stdint.h>

#define GBAPU_CPU_CLOCK 4194304

/* Square wave channel (CH1 has sweep, CH2 does not) */
typedef struct {
    int enabled;
    int dac_enabled;

    /* Duty */
    int duty;        /* 0-3 */
    int duty_pos;    /* 0-7 */

    /* Frequency */
    uint16_t frequency;  /* 11-bit register */
    int freq_timer;

    /* Length */
    int length_counter;  /* counts down from 64 */
    int length_enable;

    /* Volume envelope */
    int volume;          /* 0-15 */
    int env_initial;
    int env_direction;   /* 1 = increase, 0 = decrease */
    int env_period;      /* 0-7, 0 = disabled */
    int env_timer;

    /* Sweep (CH1 only) */
    int sweep_period;
    int sweep_negate;
    int sweep_shift;
    int sweep_enabled;
    int sweep_timer;
    int shadow_freq;
} gbapu_square_t;

/* Wave channel (CH3) */
typedef struct {
    int enabled;
    int dac_enabled;

    uint16_t frequency;
    int freq_timer;
    int wave_pos;        /* 0-31 */

    int length_counter;  /* counts down from 256 */
    int length_enable;
    int volume_code;     /* 0-3: mute, 100%, 50%, 25% */

    uint8_t wave_ram[16]; /* 32 x 4-bit samples */
} gbapu_wave_t;

/* Noise channel (CH4) */
typedef struct {
    int enabled;
    int dac_enabled;

    int freq_timer;
    uint16_t lfsr;       /* 15-bit linear feedback shift register */

    int length_counter;  /* counts down from 64 */
    int length_enable;

    int volume;
    int env_initial;
    int env_direction;
    int env_period;
    int env_timer;

    int clock_shift;     /* 0-15 */
    int width_mode;      /* 0 = 15-bit, 1 = 7-bit */
    int divisor_code;    /* 0-7 */
} gbapu_noise_t;

/* Main APU state */
typedef struct {
    gbapu_square_t ch1;
    gbapu_square_t ch2;
    gbapu_wave_t ch3;
    gbapu_noise_t ch4;

    /* Global control */
    uint8_t nr50;  /* Master volume + VIN panning */
    uint8_t nr51;  /* Channel panning (L/R per channel) */
    int power;     /* NR52 bit 7: master power */

    /* Frame sequencer (512 Hz, steps 0-7) */
    int frame_seq_counter;
    int frame_seq_step;

    /* Sample generation */
    int sample_rate;
    int cycle_acc;  /* fractional cycle accumulator */
} gbapu_t;

void gbapu_init(gbapu_t *apu, int sample_rate);
void gbapu_write(gbapu_t *apu, uint16_t addr, uint8_t val);
uint8_t gbapu_read(gbapu_t *apu, uint16_t addr);
void gbapu_generate(gbapu_t *apu, int16_t *buf, int frames);

#endif /* GBAPU_H */
