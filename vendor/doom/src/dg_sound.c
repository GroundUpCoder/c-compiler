// Sound effects module using SDL queue-based audio API.
// Software mixer: mixes up to 16 channels into a stereo S16 buffer,
// then queues via SDL_QueueAudio().

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <SDL.h>

#include "doomfeatures.h"

#ifdef FEATURE_SOUND

#include "doomtype.h"
#include "i_sound.h"
#include "w_wad.h"
#include "z_zone.h"

#define MIX_RATE 44100
#define MIX_CHANNELS 2
#define NUM_CHANNELS 16
#define MIX_BUF_FRAMES 512
// Keep ~100ms of audio queued
#define QUEUE_TARGET (MIX_RATE * MIX_CHANNELS * 2 / 10)

// Globals required by i_sound.c FEATURE_SOUND guards
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

// Cached (resampled) sound data
typedef struct {
    short *data;
    int length;  // number of samples
} cached_sound_t;

// Software mixer channel
typedef struct {
    cached_sound_t *sound;
    int pos;       // current sample position
    int left_vol;  // 0..255
    int right_vol; // 0..255
} mix_channel_t;

static mix_channel_t mix_channels[NUM_CHANNELS];
static SDL_AudioDeviceID audio_dev;
static boolean sound_initialized = 0;

// Load and resample a DMX sound lump
static cached_sound_t *CacheSFX(sfxinfo_t *sfxinfo)
{
    int lumpnum;
    int lumplen;
    unsigned char *data;
    unsigned int samplerate;
    unsigned int length;
    unsigned int expanded_length;
    cached_sound_t *cached;
    int i;

    if (sfxinfo->driver_data != NULL)
        return (cached_sound_t *)sfxinfo->driver_data;

    lumpnum = sfxinfo->lumpnum;
    data = W_CacheLumpNum(lumpnum, PU_STATIC);
    lumplen = W_LumpLength(lumpnum);

    // Validate DMX header
    if (lumplen < 8 || data[0] != 0x03 || data[1] != 0x00)
    {
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    samplerate = data[2] | (data[3] << 8);
    length = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);

    // Sanity check length against lump size
    if (length > (unsigned int)(lumplen - 8))
        length = lumplen - 8;

    // Skip first and last 16 padding bytes (DMX quirk)
    if (length <= 32)
    {
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    unsigned char *samples = data + 8 + 16;
    unsigned int sample_count = length - 32;

    if (samplerate == 0)
        samplerate = 11025;

    // Resample to MIX_RATE using nearest-neighbor
    expanded_length = (unsigned int)((long)sample_count * MIX_RATE / samplerate);
    if (expanded_length == 0)
    {
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    cached = malloc(sizeof(cached_sound_t));
    cached->length = expanded_length;
    cached->data = malloc(expanded_length * sizeof(short));

    for (i = 0; i < (int)expanded_length; i++)
    {
        unsigned int src_idx = (unsigned int)((long)i * samplerate / MIX_RATE);
        if (src_idx >= sample_count)
            src_idx = sample_count - 1;
        // Convert unsigned 8-bit to signed 16-bit
        cached->data[i] = ((int)samples[src_idx] - 128) << 8;
    }

    W_ReleaseLumpNum(lumpnum);
    sfxinfo->driver_data = cached;
    return cached;
}

static boolean SND_Init(boolean use_sfx_prefix)
{
    audio_dev = SDL_OpenAudioDevice(NULL, 0,
        &(SDL_AudioSpec){ .freq = MIX_RATE, .format = AUDIO_S16, .channels = MIX_CHANNELS },
        NULL, 0);

    if (audio_dev == 0)
    {
        printf("DG_sound: failed to open audio device\n");
        return false;
    }

    memset(mix_channels, 0, sizeof(mix_channels));
    SDL_PauseAudioDevice(audio_dev, 0);
    sound_initialized = true;
    return true;
}

static void SND_Shutdown(void)
{
    if (audio_dev != 0)
    {
        SDL_CloseAudioDevice(audio_dev);
        audio_dev = 0;
    }
    sound_initialized = false;
}

static int SND_GetSfxLumpNum(sfxinfo_t *sfxinfo)
{
    char namebuf[9];

    if (sfxinfo->link != NULL)
        sfxinfo = sfxinfo->link;

    snprintf(namebuf, sizeof(namebuf), "ds%s", sfxinfo->name);
    return W_GetNumForName(namebuf);
}

// --- OPL3 music engine ---
// MUS sequencer -> OPL register writes -> Nuked-OPL3 -> PCM mixed with SFX

#include "opl3.h"

// OPL register base addresses for 9 channels
static const int opl_chan_offsets[9] = {0,1,2,8,9,10,16,17,18};

// OPL note frequencies (OPL f-number table for one octave, C..B)
static const unsigned int opl_fnums[12] = {
    0x157, 0x16B, 0x181, 0x198, 0x1B0, 0x1CA,
    0x1E5, 0x202, 0x220, 0x241, 0x263, 0x287
};

// GENMIDI instrument data (DMX format)
typedef struct {
    unsigned char tremolo;
    unsigned char attack;
    unsigned char sustain;
    unsigned char waveform;
    unsigned char scale;
    unsigned char level;
} genmidi_op_t;

typedef struct {
    genmidi_op_t modulator;
    genmidi_op_t carrier;
    unsigned char feedback;
    short detune;
} genmidi_voice_t;

#define GENMIDI_FLAG_FIXED  0x0001
#define GENMIDI_FLAG_2VOICE 0x0002

typedef struct {
    unsigned short flags;
    unsigned char fine_tuning;
    unsigned char fixed_note;
    genmidi_voice_t voices[2];
} genmidi_instr_t;

// MUS format header
typedef struct {
    unsigned char id[4];        // "MUS\x1a"
    unsigned short score_len;
    unsigned short score_start;
    unsigned short channels;
    unsigned short sec_channels;
    unsigned short instr_cnt;
    unsigned short dummy;
} mus_header_t;

// MUS event types
#define MUS_EV_RELEASE    0
#define MUS_EV_NOTE_ON    1
#define MUS_EV_PITCH      2
#define MUS_EV_SYSEVENT   3
#define MUS_EV_CONTROLLER 4
#define MUS_EV_END        6

// OPL voice state
#define OPL_NUM_VOICES 9

typedef struct {
    int active;
    int channel;    // MUS channel
    int note;       // MIDI note number
    int instrument; // patch number
    unsigned int age;  // for voice stealing
} opl_voice_t;

// MUS sequencer state
typedef struct {
    unsigned char *data;
    int len;
    unsigned char *score;
    int score_len;
    int pos;
    int playing;
    int looping;
    unsigned int delay;  // delay in MUS tics remaining
    int channel_volume[16];
    int channel_patch[16];
    int channel_pitch[16]; // pitch wheel (0=center, range 0..255)
} mus_state_t;

// Module globals
static opl3_chip opl_chip;
static genmidi_instr_t genmidi_instr[175];
static int genmidi_loaded = 0;
static opl_voice_t opl_voices[OPL_NUM_VOICES];
static unsigned int opl_voice_counter = 0;
static mus_state_t mus;
static int music_initialized = 0;
static int music_volume = 127;  // 0..127
static int music_paused = 0;

// Samples per MUS tic at MIX_RATE (MUS runs at 140 tics/sec)
#define SAMPLES_PER_TIC (MIX_RATE / 140)

static int opl_samples_until_tic = 0;

// OPL3 raw output is low amplitude; scale up to audible level
#define OPL_VOLUME_SCALE 4

static void OPL_WriteRegister(int reg, int val)
{
    OPL3_WriteReg(&opl_chip, (unsigned short)reg, (unsigned char)val);
}

static void OPL_SetupVoice(int voice, genmidi_voice_t *instr,
                           int note, int volume)
{
    int off = opl_chan_offsets[voice];
    int octave;
    int fnum;
    int vol;

    // Apply base note offset from GENMIDI instrument
    note += instr->detune;
    if (note < 0) note = 0;
    if (note > 95) note = 95;

    // Modulator (op offset + 0x00)
    OPL_WriteRegister(0x20 + off, instr->modulator.tremolo);
    OPL_WriteRegister(0x60 + off, instr->modulator.attack);
    OPL_WriteRegister(0x80 + off, instr->modulator.sustain);
    OPL_WriteRegister(0xE0 + off, instr->modulator.waveform);

    // Carrier (op offset + 0x03)
    OPL_WriteRegister(0x23 + off, instr->carrier.tremolo);
    OPL_WriteRegister(0x63 + off, instr->carrier.attack);
    OPL_WriteRegister(0x83 + off, instr->carrier.sustain);
    OPL_WriteRegister(0xE3 + off, instr->carrier.waveform);

    // Feedback/connection
    OPL_WriteRegister(0xC0 + voice, instr->feedback | 0x30);

    // Modulator level: scale has KSL in bits 6-7, level has TL in bits 0-5
    OPL_WriteRegister(0x40 + off, instr->modulator.scale | instr->modulator.level);

    // Carrier level (apply volume scaling to TL)
    vol = 0x3F - (instr->carrier.level & 0x3F);
    vol = (vol * volume) / 127;
    vol = 0x3F - vol;
    if (vol < 0) vol = 0;
    if (vol > 0x3F) vol = 0x3F;
    OPL_WriteRegister(0x43 + off, (instr->carrier.scale & 0xC0) | (vol & 0x3F));

    // Calculate frequency
    // fnum table is for block 0 = MIDI notes 12-23 (C0-B0)
    // So block = note/12 - 1 to get correct octave
    octave = note / 12 - 1;
    fnum = opl_fnums[note % 12];

    // Clamp octave
    if (octave < 0) octave = 0;
    if (octave > 7) octave = 7;

    // Key on
    OPL_WriteRegister(0xA0 + voice, fnum & 0xFF);
    OPL_WriteRegister(0xB0 + voice, 0x20 | ((octave & 7) << 2) | ((fnum >> 8) & 3));
}

static void OPL_NoteOff(int voice)
{
    // Key off: clear bit 5 of 0xB0+voice
    OPL_WriteRegister(0xB0 + voice, 0);
}

static int OPL_AllocVoice(int channel, int note, int instrument)
{
    int i;
    int best = -1;
    unsigned int oldest = 0xFFFFFFFF;

    // Find free voice
    for (i = 0; i < OPL_NUM_VOICES; i++)
    {
        if (!opl_voices[i].active)
        {
            best = i;
            break;
        }
    }

    // Steal oldest if none free
    if (best < 0)
    {
        for (i = 0; i < OPL_NUM_VOICES; i++)
        {
            if (opl_voices[i].age < oldest)
            {
                oldest = opl_voices[i].age;
                best = i;
            }
        }
        if (best >= 0)
            OPL_NoteOff(best);
    }

    if (best >= 0)
    {
        opl_voices[best].active = 1;
        opl_voices[best].channel = channel;
        opl_voices[best].note = note;
        opl_voices[best].instrument = instrument;
        opl_voices[best].age = opl_voice_counter++;
    }

    return best;
}

static void OPL_ReleaseVoice(int channel, int note)
{
    int i;
    for (i = 0; i < OPL_NUM_VOICES; i++)
    {
        if (opl_voices[i].active &&
            opl_voices[i].channel == channel &&
            opl_voices[i].note == note)
        {
            OPL_NoteOff(i);
            opl_voices[i].active = 0;
        }
    }
}

static void OPL_SilenceAll(void)
{
    int i;
    for (i = 0; i < OPL_NUM_VOICES; i++)
    {
        OPL_NoteOff(i);
        opl_voices[i].active = 0;
    }
}

static void MUS_ProcessEvent(void)
{
    unsigned char event_byte;
    int channel;
    int event_type;
    int last;
    unsigned char b1;
    unsigned char b2;
    int note;
    int volume;
    int patch;

    if (mus.pos >= mus.score_len)
    {
        if (mus.looping)
        {
            mus.pos = 0;
            return;
        }
        mus.playing = 0;
        return;
    }

    event_byte = mus.score[mus.pos++];
    channel = event_byte & 0x0F;
    event_type = (event_byte >> 4) & 0x07;
    last = event_byte & 0x80;

    switch (event_type)
    {
    case MUS_EV_RELEASE:
        if (mus.pos >= mus.score_len) break;
        b1 = mus.score[mus.pos++];
        note = b1 & 0x7F;
        OPL_ReleaseVoice(channel, note);
        break;

    case MUS_EV_NOTE_ON:
        if (mus.pos >= mus.score_len) break;
        b1 = mus.score[mus.pos++];
        note = b1 & 0x7F;
        if (b1 & 0x80)
        {
            if (mus.pos >= mus.score_len) break;
            b2 = mus.score[mus.pos++];
            volume = b2 & 0x7F;
            mus.channel_volume[channel] = volume;
        }
        else
        {
            volume = mus.channel_volume[channel];
        }
        // MUS channel 15 = percussion: instrument from note number
        if (channel == 15)
        {
            if (note >= 35)
                patch = 128 + note - 35;
            else
                patch = 128;
        }
        else
        {
            patch = mus.channel_patch[channel];
        }
        if (patch >= 0 && patch < 175 && genmidi_loaded)
        {
            genmidi_instr_t *inst = &genmidi_instr[patch];
            int play_note = note;
            int v;

            // Fixed-pitch instruments always play at their fixed note
            if (inst->flags & GENMIDI_FLAG_FIXED)
                play_note = inst->fixed_note;

            v = OPL_AllocVoice(channel, note, patch);
            if (v >= 0)
            {
                // Use channel volume directly for OPL TL;
                // music_volume is applied as linear post-mix scaling
                OPL_SetupVoice(v, &inst->voices[0],
                                play_note, volume);
            }
        }
        break;

    case MUS_EV_PITCH:
        if (mus.pos >= mus.score_len) break;
        b1 = mus.score[mus.pos++];
        mus.channel_pitch[channel] = b1;
        break;

    case MUS_EV_SYSEVENT:
        if (mus.pos >= mus.score_len) break;
        b1 = mus.score[mus.pos++];
        if (b1 == 12)  // All notes off
        {
            int i;
            for (i = 0; i < OPL_NUM_VOICES; i++)
            {
                if (opl_voices[i].active && opl_voices[i].channel == channel)
                {
                    OPL_NoteOff(i);
                    opl_voices[i].active = 0;
                }
            }
        }
        break;

    case MUS_EV_CONTROLLER:
        if (mus.pos + 1 >= mus.score_len) break;
        b1 = mus.score[mus.pos++];
        b2 = mus.score[mus.pos++];
        if (b1 == 0)  // Patch change
            mus.channel_patch[channel] = b2;
        else if (b1 == 3)  // Volume
            mus.channel_volume[channel] = b2;
        break;

    case MUS_EV_END:
        if (mus.looping)
        {
            mus.pos = 0;
        }
        else
        {
            mus.playing = 0;
        }
        break;

    default:
        break;
    }

    // Read delay if last bit set
    if (last)
    {
        unsigned int delay = 0;
        unsigned char db;
        do
        {
            if (mus.pos >= mus.score_len) break;
            db = mus.score[mus.pos++];
            delay = (delay << 7) | (db & 0x7F);
        } while (db & 0x80);
        mus.delay = delay;
    }
}

static void MUS_GenerateSamples(short *buf, int nframes)
{
    int i;
    for (i = 0; i < nframes; i++)
    {
        // Process MUS events when timer expires
        while (opl_samples_until_tic <= 0 && mus.playing && !music_paused)
        {
            if (mus.delay > 0)
            {
                mus.delay--;
                opl_samples_until_tic += SAMPLES_PER_TIC;
                break;
            }
            MUS_ProcessEvent();
        }
        opl_samples_until_tic--;

        // Generate one stereo OPL sample (resampled to MIX_RATE)
        short opl_out[2];
        OPL3_GenerateResampled(&opl_chip, opl_out);

        // Apply music_volume as linear scaling (not via OPL TL which is logarithmic)
        int l = opl_out[0] * OPL_VOLUME_SCALE * music_volume / 127;
        int r = opl_out[1] * OPL_VOLUME_SCALE * music_volume / 127;
        if (l > 32767) l = 32767; if (l < -32768) l = -32768;
        if (r > 32767) r = 32767; if (r < -32768) r = -32768;
        buf[i * 2]     = (short)l;
        buf[i * 2 + 1] = (short)r;
    }
}

// --- SFX + Music mixer ---

static void SND_Update(void)
{
    short buf[MIX_BUF_FRAMES * MIX_CHANNELS];
    short mus_buf[MIX_BUF_FRAMES * MIX_CHANNELS];

    if (!sound_initialized)
        return;

    // Feed audio queue to stay near QUEUE_TARGET
    while ((int)SDL_GetQueuedAudioSize(audio_dev) < QUEUE_TARGET)
    {
        int i;
        int ch;
        memset(buf, 0, sizeof(buf));

        // Generate OPL music samples for this buffer
        if (mus.playing && music_initialized && !music_paused)
        {
            MUS_GenerateSamples(mus_buf, MIX_BUF_FRAMES);
        }
        else
            memset(mus_buf, 0, sizeof(mus_buf));

        for (i = 0; i < MIX_BUF_FRAMES; i++)
        {
            int left = 0;
            int right = 0;

            // Mix SFX channels
            for (ch = 0; ch < NUM_CHANNELS; ch++)
            {
                mix_channel_t *c = &mix_channels[ch];
                if (c->sound == NULL || c->pos >= c->sound->length)
                    continue;

                int sample = c->sound->data[c->pos];
                left += (sample * c->left_vol) >> 8;
                right += (sample * c->right_vol) >> 8;
                c->pos++;
            }

            // Mix OPL music
            left += mus_buf[i * 2];
            right += mus_buf[i * 2 + 1];

            // Clamp
            if (left > 32767) left = 32767;
            if (left < -32768) left = -32768;
            if (right > 32767) right = 32767;
            if (right < -32768) right = -32768;

            buf[i * 2] = (short)left;
            buf[i * 2 + 1] = (short)right;
        }

        SDL_QueueAudio(audio_dev, buf, sizeof(buf));
    }
}

static void SND_UpdateSoundParams(int channel, int vol, int sep)
{
    if (channel < 0 || channel >= NUM_CHANNELS)
        return;

    mix_channels[channel].left_vol = ((254 - sep) * vol / 127);
    mix_channels[channel].right_vol = (sep * vol / 127);
}

static int SND_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep)
{
    cached_sound_t *cached;

    if (channel < 0 || channel >= NUM_CHANNELS)
        return -1;

    // Resolve links
    if (sfxinfo->link != NULL)
        sfxinfo = sfxinfo->link;

    // Load the sound if not cached
    if (sfxinfo->lumpnum < 0)
        sfxinfo->lumpnum = SND_GetSfxLumpNum(sfxinfo);

    cached = CacheSFX(sfxinfo);
    if (cached == NULL)
        return -1;

    mix_channels[channel].sound = cached;
    mix_channels[channel].pos = 0;
    SND_UpdateSoundParams(channel, vol, sep);

    return channel;
}

static void SND_StopSound(int channel)
{
    if (channel < 0 || channel >= NUM_CHANNELS)
        return;

    mix_channels[channel].sound = NULL;
}

static boolean SND_SoundIsPlaying(int channel)
{
    if (channel < 0 || channel >= NUM_CHANNELS)
        return false;

    mix_channel_t *c = &mix_channels[channel];
    return c->sound != NULL && c->pos < c->sound->length;
}

static snddevice_t sound_devices[] = {
    SNDDEVICE_SB,
    SNDDEVICE_PAS,
    SNDDEVICE_GUS,
    SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS,
    SNDDEVICE_AWE32,
};

sound_module_t DG_sound_module = {
    sound_devices,
    sizeof(sound_devices) / sizeof(sound_devices[0]),
    SND_Init,
    SND_Shutdown,
    SND_GetSfxLumpNum,
    SND_Update,
    SND_UpdateSoundParams,
    SND_StartSound,
    SND_StopSound,
    SND_SoundIsPlaying,
    NULL,  // CacheSounds - not needed, we cache on demand
};

// --- OPL3 music module callbacks ---

static void LoadGENMIDI(void)
{
    int lump;
    unsigned char *data;
    int len;
    int i;

    lump = W_GetNumForName("GENMIDI");
    if (lump < 0)
    {
        printf("OPL Music: GENMIDI lump not found\n");
        return;
    }

    data = W_CacheLumpNum(lump, PU_STATIC);
    len = W_LumpLength(lump);

    // GENMIDI: 8-byte header "#OPL_II#" + 175 instruments x 36 bytes
    if (len < 8 + 175 * 36)
    {
        printf("OPL Music: GENMIDI lump too small (%d bytes)\n", len);
        W_ReleaseLumpNum(lump);
        return;
    }

    // Skip 8-byte header
    unsigned char *p = data + 8;
    for (i = 0; i < 175; i++)
    {
        genmidi_instr[i].flags = p[0] | (p[1] << 8);
        genmidi_instr[i].fine_tuning = p[2];
        genmidi_instr[i].fixed_note = p[3];

        // Voice layout (16 bytes each):
        //   mod(6): tremolo,attack,sustain,waveform,scale,level
        //   feedback(1)
        //   carrier(6): tremolo,attack,sustain,waveform,scale,level
        //   unused(1)
        //   base_note_offset(2)

        // Voice 0 - modulator
        genmidi_instr[i].voices[0].modulator.tremolo = p[4];
        genmidi_instr[i].voices[0].modulator.attack  = p[5];
        genmidi_instr[i].voices[0].modulator.sustain  = p[6];
        genmidi_instr[i].voices[0].modulator.waveform = p[7];
        genmidi_instr[i].voices[0].modulator.scale    = p[8];
        genmidi_instr[i].voices[0].modulator.level    = p[9];
        genmidi_instr[i].voices[0].feedback = p[10];
        // Voice 0 - carrier
        genmidi_instr[i].voices[0].carrier.tremolo = p[11];
        genmidi_instr[i].voices[0].carrier.attack  = p[12];
        genmidi_instr[i].voices[0].carrier.sustain  = p[13];
        genmidi_instr[i].voices[0].carrier.waveform = p[14];
        genmidi_instr[i].voices[0].carrier.scale    = p[15];
        genmidi_instr[i].voices[0].carrier.level    = p[16];
        // p[17] = unused
        genmidi_instr[i].voices[0].detune = (short)(p[18] | (p[19] << 8));

        // Voice 1 - modulator
        genmidi_instr[i].voices[1].modulator.tremolo = p[20];
        genmidi_instr[i].voices[1].modulator.attack  = p[21];
        genmidi_instr[i].voices[1].modulator.sustain  = p[22];
        genmidi_instr[i].voices[1].modulator.waveform = p[23];
        genmidi_instr[i].voices[1].modulator.scale    = p[24];
        genmidi_instr[i].voices[1].modulator.level    = p[25];
        genmidi_instr[i].voices[1].feedback = p[26];
        // Voice 1 - carrier
        genmidi_instr[i].voices[1].carrier.tremolo = p[27];
        genmidi_instr[i].voices[1].carrier.attack  = p[28];
        genmidi_instr[i].voices[1].carrier.sustain  = p[29];
        genmidi_instr[i].voices[1].carrier.waveform = p[30];
        genmidi_instr[i].voices[1].carrier.scale    = p[31];
        genmidi_instr[i].voices[1].carrier.level    = p[32];
        // p[33] = unused
        genmidi_instr[i].voices[1].detune = (short)(p[34] | (p[35] << 8));

        p += 36;
    }

    W_ReleaseLumpNum(lump);
    genmidi_loaded = 1;
    printf("OPL Music: GENMIDI loaded (%d instruments)\n", 175);
}

static boolean MUS_Init(void)
{
    OPL3_Reset(&opl_chip, MIX_RATE);
    // Enable OPL3 mode and waveform select
    OPL_WriteRegister(0x105, 0x01);  // OPL3 enable
    OPL_WriteRegister(0x01, 0x20);   // Waveform select enable
    memset(opl_voices, 0, sizeof(opl_voices));
    memset(&mus, 0, sizeof(mus));
    opl_voice_counter = 0;
    opl_samples_until_tic = 0;
    music_initialized = 1;
    LoadGENMIDI();
    return true;
}

static void MUS_Shutdown(void)
{
    OPL_SilenceAll();
    music_initialized = 0;
}

static void MUS_SetMusicVolume(int volume)
{
    music_volume = volume;
}

static void MUS_PauseMusic(void)
{
    music_paused = 1;
}

static void MUS_ResumeMusic(void)
{
    music_paused = 0;
}

static void *MUS_RegisterSong(void *data, int len)
{
    unsigned char *raw;
    mus_header_t *hdr;

    if (!music_initialized || !genmidi_loaded)
        return NULL;
    if (len < (int)sizeof(mus_header_t))
        return NULL;

    hdr = (mus_header_t *)data;
    // Check MUS magic "MUS\x1a"
    if (hdr->id[0] != 'M' || hdr->id[1] != 'U' ||
        hdr->id[2] != 'S' || hdr->id[3] != 0x1A)
        return NULL;

    // Allocate a copy of the data
    raw = malloc(len);
    if (!raw) return NULL;
    memcpy(raw, data, len);

    return raw;
}

static void MUS_UnRegisterSong(void *handle)
{
    if (handle)
        free(handle);
}

static void MUS_PlaySong(void *handle, boolean looping)
{
    mus_header_t *hdr;
    int i;

    if (!handle || !music_initialized)
        return;

    OPL_SilenceAll();

    // Full OPL3 reset for clean state
    OPL3_Reset(&opl_chip, MIX_RATE);
    OPL_WriteRegister(0x105, 0x01);  // OPL3 enable
    OPL_WriteRegister(0x01, 0x20);   // Waveform select enable
    memset(opl_voices, 0, sizeof(opl_voices));
    opl_voice_counter = 0;

    hdr = (mus_header_t *)handle;
    mus.data = (unsigned char *)handle;
    mus.len = hdr->score_start + hdr->score_len;
    mus.score = mus.data + hdr->score_start;
    mus.score_len = hdr->score_len;
    mus.pos = 0;
    mus.playing = 1;
    mus.looping = looping;
    mus.delay = 0;
    music_paused = 0;
    opl_samples_until_tic = 0;

    for (i = 0; i < 16; i++)
    {
        mus.channel_volume[i] = 100;
        mus.channel_patch[i] = 0;
        mus.channel_pitch[i] = 128;  // center
    }

}

static void MUS_StopSong(void)
{
    mus.playing = 0;
    OPL_SilenceAll();
}

static boolean MUS_MusicIsPlaying(void)
{
    return mus.playing;
}

static snddevice_t music_devices[] = {
    SNDDEVICE_SB,
    SNDDEVICE_PAS,
    SNDDEVICE_GUS,
    SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS,
    SNDDEVICE_AWE32,
    SNDDEVICE_ADLIB,
    SNDDEVICE_GENMIDI,
};

music_module_t DG_music_module = {
    music_devices,
    sizeof(music_devices) / sizeof(music_devices[0]),
    MUS_Init,
    MUS_Shutdown,
    MUS_SetMusicVolume,
    MUS_PauseMusic,
    MUS_ResumeMusic,
    MUS_RegisterSong,
    MUS_UnRegisterSong,
    MUS_PlaySong,
    MUS_StopSong,
    MUS_MusicIsPlaying,
    NULL,  // Poll
};

#endif // FEATURE_SOUND
