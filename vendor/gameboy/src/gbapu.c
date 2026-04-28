/*
 * gbapu.c — Game Boy APU emulator implementation
 */
#include "gbapu.h"
#include <string.h>

/* ── Duty table ─────────────────────────────────────────────────── */
static const uint8_t duty_table[4][8] = {
    {0, 0, 0, 0, 0, 0, 0, 1},  /* 12.5% */
    {0, 0, 0, 0, 0, 0, 1, 1},  /* 25%   */
    {0, 0, 0, 0, 1, 1, 1, 1},  /* 50%   */
    {1, 1, 1, 1, 1, 1, 0, 0},  /* 75%   */
};

/* ── OR masks for register reads (unused bits read as 1) ────────── */
static const uint8_t read_masks[0x30] = {
    /* 0xFF10-0xFF14: CH1 */
    0x80, 0x3F, 0x00, 0xFF, 0xBF,
    /* 0xFF15-0xFF19: CH2 */
    0xFF, 0x3F, 0x00, 0xFF, 0xBF,
    /* 0xFF1A-0xFF1E: CH3 */
    0x7F, 0xFF, 0x9F, 0xFF, 0xBF,
    /* 0xFF1F-0xFF23: CH4 */
    0xFF, 0xFF, 0x00, 0x00, 0xBF,
    /* 0xFF24-0xFF26: Control */
    0x00, 0x00, 0x70,
    /* 0xFF27-0xFF2F: Unused */
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    /* 0xFF30-0xFF3F: Wave RAM — no mask */
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* ── Noise divisor table ────────────────────────────────────────── */
static const int noise_divisors[8] = {8, 16, 32, 48, 64, 80, 96, 112};

/* ── Helpers ────────────────────────────────────────────────────── */

static int square_period(uint16_t freq) {
    return (2048 - freq) * 4;
}

static int wave_period(uint16_t freq) {
    return (2048 - freq) * 2;
}

static int noise_period(int divisor_code, int clock_shift) {
    return noise_divisors[divisor_code] << clock_shift;
}

static int square_sample(gbapu_square_t *ch) {
    if (!ch->enabled || !ch->dac_enabled) return 0;
    int bit = duty_table[ch->duty][ch->duty_pos];
    /* DAC: 0 → -volume, 1 → +volume (centered around 0) */
    return bit ? ch->volume : -ch->volume;
}

static int wave_sample(gbapu_wave_t *ch) {
    if (!ch->enabled || !ch->dac_enabled) return 0;
    /* Read 4-bit sample from wave RAM */
    int byte_idx = ch->wave_pos / 2;
    int nibble = (ch->wave_pos & 1)
        ? (ch->wave_ram[byte_idx] & 0x0F)
        : (ch->wave_ram[byte_idx] >> 4);
    /* Volume shift: 0=mute, 1=100%, 2=50%, 3=25% */
    static const int shifts[4] = {4, 0, 1, 2};
    int sample = nibble >> shifts[ch->volume_code];
    /* Center around 0: range [0,15] → [-15,+15] */
    return sample * 2 - 15;
}

static int noise_sample(gbapu_noise_t *ch) {
    if (!ch->enabled || !ch->dac_enabled) return 0;
    /* Bit 0 inverted = output */
    int bit = ~ch->lfsr & 1;
    return bit ? ch->volume : -ch->volume;
}

/* ── Sweep (CH1) ────────────────────────────────────────────────── */

static int sweep_calc(gbapu_square_t *ch) {
    int delta = ch->shadow_freq >> ch->sweep_shift;
    int new_freq = ch->sweep_negate
        ? ch->shadow_freq - delta
        : ch->shadow_freq + delta;
    if (new_freq > 2047) ch->enabled = 0;
    return new_freq;
}

static void sweep_clock(gbapu_square_t *ch) {
    ch->sweep_timer--;
    if (ch->sweep_timer <= 0) {
        ch->sweep_timer = ch->sweep_period ? ch->sweep_period : 8;
        if (ch->sweep_enabled && ch->sweep_period > 0) {
            int new_freq = sweep_calc(ch);
            if (new_freq <= 2047 && ch->sweep_shift > 0) {
                ch->shadow_freq = new_freq;
                ch->frequency = (uint16_t)new_freq;
                /* Overflow check again */
                sweep_calc(ch);
            }
        }
    }
}

/* ── Envelope ───────────────────────────────────────────────────── */

static void envelope_clock(int *volume, int *env_timer,
                           int env_period, int env_direction) {
    if (env_period == 0) return;
    (*env_timer)--;
    if (*env_timer <= 0) {
        *env_timer = env_period;
        if (env_direction && *volume < 15)
            (*volume)++;
        else if (!env_direction && *volume > 0)
            (*volume)--;
    }
}

/* ── Length counter ──────────────────────────────────────────────── */

static void length_clock(int *enabled, int *length_counter, int length_enable) {
    if (length_enable && *length_counter > 0) {
        (*length_counter)--;
        if (*length_counter == 0)
            *enabled = 0;
    }
}

/* ── Trigger ────────────────────────────────────────────────────── */

static void trigger_square(gbapu_square_t *ch, int has_sweep) {
    ch->enabled = ch->dac_enabled;
    if (ch->length_counter == 0) ch->length_counter = 64;
    ch->freq_timer = square_period(ch->frequency);
    ch->env_timer = ch->env_period ? ch->env_period : 8;
    ch->volume = ch->env_initial;
    if (has_sweep) {
        ch->shadow_freq = ch->frequency;
        ch->sweep_timer = ch->sweep_period ? ch->sweep_period : 8;
        ch->sweep_enabled = (ch->sweep_period > 0 || ch->sweep_shift > 0);
        if (ch->sweep_shift > 0)
            sweep_calc(ch);
    }
}

static void trigger_wave(gbapu_wave_t *ch) {
    ch->enabled = ch->dac_enabled;
    if (ch->length_counter == 0) ch->length_counter = 256;
    ch->freq_timer = wave_period(ch->frequency);
    ch->wave_pos = 0;
}

static void trigger_noise(gbapu_noise_t *ch) {
    ch->enabled = ch->dac_enabled;
    if (ch->length_counter == 0) ch->length_counter = 64;
    ch->freq_timer = noise_period(ch->divisor_code, ch->clock_shift);
    ch->env_timer = ch->env_period ? ch->env_period : 8;
    ch->volume = ch->env_initial;
    ch->lfsr = 0x7FFF;
}

/* ── Frame sequencer step ───────────────────────────────────────── */

static void frame_sequencer_step(gbapu_t *apu) {
    int step = apu->frame_seq_step;

    /* Length: steps 0, 2, 4, 6 */
    if ((step & 1) == 0) {
        length_clock(&apu->ch1.enabled, &apu->ch1.length_counter,
                     apu->ch1.length_enable);
        length_clock(&apu->ch2.enabled, &apu->ch2.length_counter,
                     apu->ch2.length_enable);
        length_clock((int*)&apu->ch3.enabled, &apu->ch3.length_counter,
                     apu->ch3.length_enable);
        length_clock(&apu->ch4.enabled, &apu->ch4.length_counter,
                     apu->ch4.length_enable);
    }

    /* Sweep: steps 2, 6 */
    if (step == 2 || step == 6) {
        sweep_clock(&apu->ch1);
    }

    /* Envelope: step 7 */
    if (step == 7) {
        envelope_clock(&apu->ch1.volume, &apu->ch1.env_timer,
                       apu->ch1.env_period, apu->ch1.env_direction);
        envelope_clock(&apu->ch2.volume, &apu->ch2.env_timer,
                       apu->ch2.env_period, apu->ch2.env_direction);
        envelope_clock(&apu->ch4.volume, &apu->ch4.env_timer,
                       apu->ch4.env_period, apu->ch4.env_direction);
    }

    apu->frame_seq_step = (step + 1) & 7;
}

/* ── Channel timer advancement ──────────────────────────────────── */

static void advance_square(gbapu_square_t *ch, int cycles) {
    ch->freq_timer -= cycles;
    while (ch->freq_timer <= 0) {
        ch->freq_timer += square_period(ch->frequency);
        ch->duty_pos = (ch->duty_pos + 1) & 7;
    }
}

static void advance_wave(gbapu_wave_t *ch, int cycles) {
    ch->freq_timer -= cycles;
    while (ch->freq_timer <= 0) {
        ch->freq_timer += wave_period(ch->frequency);
        ch->wave_pos = (ch->wave_pos + 1) & 31;
    }
}

static void advance_noise(gbapu_noise_t *ch, int cycles) {
    int period = noise_period(ch->divisor_code, ch->clock_shift);
    ch->freq_timer -= cycles;
    while (ch->freq_timer <= 0) {
        ch->freq_timer += period;
        /* Clock the LFSR */
        int xor_bit = (ch->lfsr & 1) ^ ((ch->lfsr >> 1) & 1);
        ch->lfsr >>= 1;
        ch->lfsr |= xor_bit << 14;
        if (ch->width_mode)
            ch->lfsr = (ch->lfsr & ~(1 << 6)) | (xor_bit << 6);
    }
}

/* ── Public API ─────────────────────────────────────────────────── */

void gbapu_init(gbapu_t *apu, int sample_rate) {
    memset(apu, 0, sizeof(*apu));
    apu->sample_rate = sample_rate;
    apu->frame_seq_counter = 8192;
    apu->ch4.lfsr = 0x7FFF;
}

void gbapu_write(gbapu_t *apu, uint16_t addr, uint8_t val) {
    if (addr < 0xFF10 || addr > 0xFF3F) return;
    int reg = addr - 0xFF10;

    /* Wave RAM: always writable */
    if (addr >= 0xFF30) {
        apu->ch3.wave_ram[addr - 0xFF30] = val;
        return;
    }

    /* NR52: only bit 7 (power) is writable */
    if (addr == 0xFF26) {
        int was_on = apu->power;
        apu->power = (val >> 7) & 1;
        if (was_on && !apu->power) {
            /* Power off: zero all registers, disable channels */
            memset(&apu->ch1, 0, sizeof(apu->ch1));
            memset(&apu->ch2, 0, sizeof(apu->ch2));
            /* Preserve wave RAM */
            uint8_t wave_bak[16];
            memcpy(wave_bak, apu->ch3.wave_ram, 16);
            memset(&apu->ch3, 0, sizeof(apu->ch3));
            memcpy(apu->ch3.wave_ram, wave_bak, 16);
            memset(&apu->ch4, 0, sizeof(apu->ch4));
            apu->nr50 = 0;
            apu->nr51 = 0;
        }
        if (!was_on && apu->power) {
            apu->frame_seq_step = 0;
            apu->frame_seq_counter = 8192;
            apu->ch4.lfsr = 0x7FFF;
        }
        return;
    }

    /* Ignore writes when powered off (except wave RAM, NR52) */
    if (!apu->power) return;

    switch (reg) {
    /* ── CH1: Square + Sweep ──────────────────────────────────── */
    case 0x00: /* NR10: Sweep */
        apu->ch1.sweep_period = (val >> 4) & 7;
        apu->ch1.sweep_negate = (val >> 3) & 1;
        apu->ch1.sweep_shift = val & 7;
        break;
    case 0x01: /* NR11: Duty + Length */
        apu->ch1.duty = (val >> 6) & 3;
        apu->ch1.length_counter = 64 - (val & 0x3F);
        break;
    case 0x02: /* NR12: Envelope */
        apu->ch1.env_initial = (val >> 4) & 0xF;
        apu->ch1.env_direction = (val >> 3) & 1;
        apu->ch1.env_period = val & 7;
        apu->ch1.dac_enabled = (val & 0xF8) != 0;
        if (!apu->ch1.dac_enabled) apu->ch1.enabled = 0;
        break;
    case 0x03: /* NR13: Frequency low */
        apu->ch1.frequency = (apu->ch1.frequency & 0x700) | val;
        break;
    case 0x04: /* NR14: Trigger + Length enable + Frequency high */
        apu->ch1.frequency = (apu->ch1.frequency & 0xFF) | ((val & 7) << 8);
        apu->ch1.length_enable = (val >> 6) & 1;
        if (val & 0x80) trigger_square(&apu->ch1, 1);
        break;

    /* ── CH2: Square ──────────────────────────────────────────── */
    case 0x06: /* NR21: Duty + Length */
        apu->ch2.duty = (val >> 6) & 3;
        apu->ch2.length_counter = 64 - (val & 0x3F);
        break;
    case 0x07: /* NR22: Envelope */
        apu->ch2.env_initial = (val >> 4) & 0xF;
        apu->ch2.env_direction = (val >> 3) & 1;
        apu->ch2.env_period = val & 7;
        apu->ch2.dac_enabled = (val & 0xF8) != 0;
        if (!apu->ch2.dac_enabled) apu->ch2.enabled = 0;
        break;
    case 0x08: /* NR23: Frequency low */
        apu->ch2.frequency = (apu->ch2.frequency & 0x700) | val;
        break;
    case 0x09: /* NR24: Trigger + Length enable + Frequency high */
        apu->ch2.frequency = (apu->ch2.frequency & 0xFF) | ((val & 7) << 8);
        apu->ch2.length_enable = (val >> 6) & 1;
        if (val & 0x80) trigger_square(&apu->ch2, 0);
        break;

    /* ── CH3: Wave ────────────────────────────────────────────── */
    case 0x0A: /* NR30: DAC enable */
        apu->ch3.dac_enabled = (val >> 7) & 1;
        if (!apu->ch3.dac_enabled) apu->ch3.enabled = 0;
        break;
    case 0x0B: /* NR31: Length */
        apu->ch3.length_counter = 256 - val;
        break;
    case 0x0C: /* NR32: Volume */
        apu->ch3.volume_code = (val >> 5) & 3;
        break;
    case 0x0D: /* NR33: Frequency low */
        apu->ch3.frequency = (apu->ch3.frequency & 0x700) | val;
        break;
    case 0x0E: /* NR34: Trigger + Length enable + Frequency high */
        apu->ch3.frequency = (apu->ch3.frequency & 0xFF) | ((val & 7) << 8);
        apu->ch3.length_enable = (val >> 6) & 1;
        if (val & 0x80) trigger_wave(&apu->ch3);
        break;

    /* ── CH4: Noise ───────────────────────────────────────────── */
    case 0x10: /* NR41: Length */
        apu->ch4.length_counter = 64 - (val & 0x3F);
        break;
    case 0x11: /* NR42: Envelope */
        apu->ch4.env_initial = (val >> 4) & 0xF;
        apu->ch4.env_direction = (val >> 3) & 1;
        apu->ch4.env_period = val & 7;
        apu->ch4.dac_enabled = (val & 0xF8) != 0;
        if (!apu->ch4.dac_enabled) apu->ch4.enabled = 0;
        break;
    case 0x12: /* NR43: Polynomial counter */
        apu->ch4.clock_shift = (val >> 4) & 0xF;
        apu->ch4.width_mode = (val >> 3) & 1;
        apu->ch4.divisor_code = val & 7;
        break;
    case 0x13: /* NR44: Trigger + Length enable */
        apu->ch4.length_enable = (val >> 6) & 1;
        if (val & 0x80) trigger_noise(&apu->ch4);
        break;

    /* ── Control ──────────────────────────────────────────────── */
    case 0x14: /* NR50 */
        apu->nr50 = val;
        break;
    case 0x15: /* NR51 */
        apu->nr51 = val;
        break;
    }
}

uint8_t gbapu_read(gbapu_t *apu, uint16_t addr) {
    if (addr < 0xFF10 || addr > 0xFF3F) return 0xFF;
    int reg = addr - 0xFF10;

    /* Wave RAM */
    if (addr >= 0xFF30)
        return apu->ch3.wave_ram[addr - 0xFF30];

    /* NR52: power bit + channel status bits */
    if (addr == 0xFF26) {
        uint8_t val = apu->power ? 0x80 : 0;
        if (apu->ch1.enabled) val |= 0x01;
        if (apu->ch2.enabled) val |= 0x02;
        if (apu->ch3.enabled) val |= 0x04;
        if (apu->ch4.enabled) val |= 0x08;
        return val | 0x70;
    }

    uint8_t val = 0;
    switch (reg) {
    case 0x00: /* NR10 */
        val = (apu->ch1.sweep_period << 4)
            | (apu->ch1.sweep_negate << 3)
            | apu->ch1.sweep_shift;
        break;
    case 0x01: /* NR11 — only duty bits readable */
        val = apu->ch1.duty << 6;
        break;
    case 0x02: /* NR12 */
        val = (apu->ch1.env_initial << 4)
            | (apu->ch1.env_direction << 3)
            | apu->ch1.env_period;
        break;
    case 0x04: /* NR14 — only length enable readable */
        val = apu->ch1.length_enable << 6;
        break;
    case 0x06: /* NR21 */
        val = apu->ch2.duty << 6;
        break;
    case 0x07: /* NR22 */
        val = (apu->ch2.env_initial << 4)
            | (apu->ch2.env_direction << 3)
            | apu->ch2.env_period;
        break;
    case 0x09: /* NR24 */
        val = apu->ch2.length_enable << 6;
        break;
    case 0x0A: /* NR30 */
        val = apu->ch3.dac_enabled << 7;
        break;
    case 0x0C: /* NR32 */
        val = apu->ch3.volume_code << 5;
        break;
    case 0x0E: /* NR34 */
        val = apu->ch3.length_enable << 6;
        break;
    case 0x11: /* NR42 */
        val = (apu->ch4.env_initial << 4)
            | (apu->ch4.env_direction << 3)
            | apu->ch4.env_period;
        break;
    case 0x12: /* NR43 */
        val = (apu->ch4.clock_shift << 4)
            | (apu->ch4.width_mode << 3)
            | apu->ch4.divisor_code;
        break;
    case 0x13: /* NR44 */
        val = apu->ch4.length_enable << 6;
        break;
    case 0x14: /* NR50 */
        val = apu->nr50;
        break;
    case 0x15: /* NR51 */
        val = apu->nr51;
        break;
    default:
        val = 0;
        break;
    }

    return val | read_masks[reg];
}

void gbapu_generate(gbapu_t *apu, int16_t *buf, int frames) {
    if (!apu->power) {
        memset(buf, 0, frames * 2 * sizeof(int16_t));
        return;
    }

    int left_vol  = ((apu->nr50 >> 4) & 7) + 1;  /* 1-8 */
    int right_vol = (apu->nr50 & 7) + 1;

    for (int i = 0; i < frames; i++) {
        /* Compute cycles to advance for this sample */
        int cycles = GBAPU_CPU_CLOCK / apu->sample_rate;
        apu->cycle_acc += GBAPU_CPU_CLOCK % apu->sample_rate;
        if (apu->cycle_acc >= apu->sample_rate) {
            apu->cycle_acc -= apu->sample_rate;
            cycles++;
        }

        /* Frame sequencer */
        apu->frame_seq_counter -= cycles;
        while (apu->frame_seq_counter <= 0) {
            apu->frame_seq_counter += 8192;
            frame_sequencer_step(apu);
        }

        /* Advance channel timers */
        advance_square(&apu->ch1, cycles);
        advance_square(&apu->ch2, cycles);
        advance_wave(&apu->ch3, cycles);
        advance_noise(&apu->ch4, cycles);

        /* Sample channels: range [-15, +15] each */
        int s1 = square_sample(&apu->ch1);
        int s2 = square_sample(&apu->ch2);
        int s3 = wave_sample(&apu->ch3);
        int s4 = noise_sample(&apu->ch4);

        /* Mix with panning (NR51) */
        int left = 0, right = 0;
        if (apu->nr51 & 0x10) left  += s1;
        if (apu->nr51 & 0x01) right += s1;
        if (apu->nr51 & 0x20) left  += s2;
        if (apu->nr51 & 0x02) right += s2;
        if (apu->nr51 & 0x40) left  += s3;
        if (apu->nr51 & 0x04) right += s3;
        if (apu->nr51 & 0x80) left  += s4;
        if (apu->nr51 & 0x08) right += s4;

        /* Apply master volume and scale to S16 */
        /* Range: ±60 * 8 * 64 = ±30720, fits in int16 */
        left  = left  * left_vol  * 64;
        right = right * right_vol * 64;

        buf[i * 2]     = (int16_t)left;
        buf[i * 2 + 1] = (int16_t)right;
    }
}
