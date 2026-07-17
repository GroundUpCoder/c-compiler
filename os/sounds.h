/* sounds.h — the event-sound scheme, ONE policy in ONE place (todos/0094).
 *
 * Header-only by design (the openwith.h precedent): static functions shared
 * by textual inclusion — os/wm.c (the SystemStart boot chime) and
 * os/win32/winmm.c (PlaySound, which user32's MessageBeep rides) include
 * this and must stay behaviorally identical through it.
 *
 * The store is a plain text map from event names to WAV paths in three
 * layers, overlaid PER KEY (cfgstore.h, arch CS3 — the openwith rule):
 *   $HOME/.config/sounds     per-user (what snd_set_mute writes)
 *   /etc/sounds              admin override
 *   /usr/share/sounds/scheme baked default (os/image.json; clips are the
 *                            tools/mksounds.js synthesized set)
 * Lines: EVENT<ws>PATH; '#' starts a comment; matching is case-insensitive.
 * PATH `none` silences that event explicitly (no default fallback). The
 * reserved key `mute` with value `on` silences EVERY event — the Control
 * Panel Sounds applet toggles it via snd_set_mute, which writes ONLY the
 * mute key to the user layer, so baked mappings keep reaching the user
 * through the overlay. No store at all = silence (standalone processes
 * outside the OS image keep the pre-0094 quiet).
 *
 * Events shipped in the baked scheme (Win95-canonical alias names):
 *   SystemStart, SystemDefault, SystemHand (error), SystemQuestion,
 *   SystemExclamation, SystemAsterisk.
 *
 * Playback is the 0017 kernel mixer via the SDL3 audio-stream veneer
 * (usable without SDL_Init, the 0090 clipboard precedent): open a stream
 * at the WAV's spec, push the whole clip, resume, and for fire-and-forget
 * destroy immediately — AUDIO_CLOSE marks the kernel stream dying, which
 * DRAINS DRY before reclaim, so the tail plays out with no process-side
 * pump. One push means one source-ring fill: clips beyond the 256 KB ring
 * (~5.9s at the shipped 22050 mono s16) truncate — ship short clips.
 * Kernels without a mixer (boot.js headless) accept and drop the clip on
 * close: silent by design, never an error. */
#ifndef SOUNDS_H
#define SOUNDS_H

#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#include "cfgstore.h"

#define SND_STORE_MAX CFG_STORE_MAX
#define SND_PATH_MAX  256
#define SND_WAV_MAX   (512 * 1024)

/* Load the effective store (per-key overlay of the existing layers).
 * Returns 1 and the NUL-terminated text, or 0 with text[0] == 0. */
static int snd_load(char *text, size_t sz) {
    char user[300];
    cfg_user_path(user, sizeof user, "sounds");
    return cfg_load3(text, sz, user, "/etc/sounds", "/usr/share/sounds/scheme");
}

/* Find `key` in store text; copies its value into val. */
static int snd_find(const char *text, const char *key, char *val, size_t sz) {
    return cfg_find(text, key, val, sz);
}

/* Is the whole scheme muted? (the reserved `mute` key) */
static int snd_muted(void) {
    char text[SND_STORE_MAX], val[16];
    if (!snd_load(text, sizeof text)) return 0;
    return snd_find(text, "mute", val, sizeof val) && strcasecmp(val, "on") == 0;
}

/* Resolve an event to a WAV path.
 * Returns 1 = path found, 0 = no entry (caller may fall back to
 * SystemDefault), -1 = explicitly silent (`none`, or the scheme is muted,
 * or there is no store) — the caller must NOT fall back. */
static int snd_lookup(const char *event, char *path, size_t sz) {
    char text[SND_STORE_MAX], val[16];
    if (!snd_load(text, sizeof text)) return -1;
    if (snd_find(text, "mute", val, sizeof val) && strcasecmp(val, "on") == 0)
        return -1;
    if (!snd_find(text, event, path, sz)) return 0;
    if (strcasecmp(path, "none") == 0) return -1;
    return 1;
}

/* Set or clear the mute flag in the USER layer only (cfgstore.h
 * delta-write — the baked event mappings keep reaching the user through
 * the overlay). Returns 0, or -1. */
static int snd_set_mute(int on) {
    return cfg_set("sounds", "mute", on ? "on" : "off");
}

/* ------------------------------------------------------------- playback */

/* Parse a RIFF/WAVE image: PCM u8/s16, mono/stereo, 4k..192k (the kernel
 * AUDIO_OPEN limits). Points *data at the sample bytes inside `wav`.
 * Returns 1 and fills the spec, or 0. */
static int snd_wav_parse(const unsigned char *wav, size_t n, SDL_AudioSpec *spec,
                         const unsigned char **data, size_t *dlen) {
    if (n < 44 || memcmp(wav, "RIFF", 4) != 0 || memcmp(wav + 8, "WAVE", 4) != 0)
        return 0;
    int fmt = 0, channels = 0, freq = 0, bits = 0;
    *data = NULL; *dlen = 0;
    size_t off = 12;
    while (off + 8 <= n) {
        const unsigned char *c = wav + off;
        size_t clen = (size_t)c[4] | ((size_t)c[5] << 8) |
                      ((size_t)c[6] << 16) | ((size_t)c[7] << 24);
        if (off + 8 + clen > n) clen = n - off - 8;   /* tolerate a short tail */
        if (memcmp(c, "fmt ", 4) == 0 && clen >= 16) {
            fmt = c[8] | (c[9] << 8);
            channels = c[10] | (c[11] << 8);
            freq = c[12] | (c[13] << 8) | (c[14] << 16) | (c[15] << 24);
            bits = c[22] | (c[23] << 8);
        } else if (memcmp(c, "data", 4) == 0) {
            *data = c + 8;
            *dlen = clen;
        }
        off += 8 + clen + (clen & 1);                 /* chunks are word-aligned */
    }
    if (fmt != 1 || !*data || !*dlen) return 0;
    if ((bits != 8 && bits != 16) || (channels != 1 && channels != 2) ||
        freq < 4000 || freq > 192000)
        return 0;
    spec->format = bits == 16 ? SDL_AUDIO_S16 : SDL_AUDIO_U8;
    spec->channels = channels;
    spec->freq = freq;
    /* whole frames only (the mixer's ring math needs frame alignment) */
    *dlen -= *dlen % (size_t)((bits / 8) * channels);
    return *dlen != 0;
}

/* Play a WAV image through the mixer. Returns the LIVE stream (caller owns
 * it: destroy to let it drain out, clear+destroy to stop it) and the clip
 * duration in ms, or NULL if the image doesn't parse / no audio device. */
static SDL_AudioStream *snd_play_mem(const unsigned char *wav, size_t n, int *dur_ms) {
    SDL_AudioSpec spec;
    const unsigned char *data;
    size_t dlen;
    if (!snd_wav_parse(wav, n, &spec, &data, &dlen)) return NULL;
    SDL_AudioStream *s = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,
                                                   &spec, NULL, NULL);
    if (!s) return NULL;
    SDL_PutAudioStreamData(s, data, (int)dlen);
    SDL_ResumeAudioStreamDevice(s);
    if (dur_ms) {
        int frameBytes = (spec.format == SDL_AUDIO_S16 ? 2 : 1) * spec.channels;
        *dur_ms = (int)((long long)(dlen / (size_t)frameBytes) * 1000 / spec.freq);
    }
    return s;
}

/* Play a WAV file. NULL if unreadable/oversized/unparseable. */
static SDL_AudioStream *snd_play_path(const char *path, int *dur_ms) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    unsigned char *buf = (unsigned char *)malloc(SND_WAV_MAX);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, SND_WAV_MAX, f);
    fclose(f);
    SDL_AudioStream *s = n ? snd_play_mem(buf, n, dur_ms) : NULL;
    free(buf);   /* the clip lives in the source ring now */
    return s;
}

/* Fire-and-forget an event sound: resolve, play, destroy (the kernel
 * drains the tail). Returns 1 if a clip was submitted. */
static int snd_play_event(const char *event) {
    char path[SND_PATH_MAX];
    if (snd_lookup(event, path, sizeof path) != 1) return 0;
    SDL_AudioStream *s = snd_play_path(path, NULL);
    if (!s) return 0;
    SDL_DestroyAudioStream(s);
    return 1;
}

#endif /* SOUNDS_H */
