/* winmm.c — the winmm veneer slice (todos/0068; real PlaySound todos/0094,
 * design todos/WIN32.md). PlaySound plays WAVs through the 0017 kernel
 * mixer via the shared event-sound core (os/sounds.h — the scheme store,
 * the WAV parser, and the drain-dry fire-and-forget are all there; wm.c's
 * boot chime is the same code). user32's MessageBeep and MessageBox icon
 * sounds ride PlaySoundA with SND_ALIAS.
 *
 * Semantics (the PlaySound contract, trimmed to this world):
 *   - ONE sound at a time per process: a new play stops the current one
 *     (clear + destroy = immediate reclaim); SND_NOSTOP refuses instead
 *     while the current clip still has queued frames.
 *   - name resolution: SND_FILENAME = a path; SND_MEMORY = an in-memory
 *     WAV image; SND_ALIAS (and the flagless default) = a scheme event
 *     name (sounds.h store). An unknown alias falls back to SystemDefault
 *     unless SND_NODEFAULT; an alias mapped to `none` (or a muted scheme)
 *     is EXPLICIT silence — no fallback, returns TRUE.
 *   - SND_RESOURCE stays silent success: the 0068 decision stands — the
 *     corpus' wave assets (winmine's .wavs) are deliberately not vendored,
 *     and a missing resource must NOT fall back to the default ding
 *     (winmine plays a tick EVERY timer second).
 *   - SND_SYNC waits for the clip (duration-capped poll — kernels without
 *     a mixer pump never drain, so never trust the queue alone).
 *   - SND_LOOP plays the clip once: looping needs a process-side refill
 *     pump that fire-and-forget deliberately doesn't have (recorded in
 *     todos/0094's closeout; no corpus consumer loops).
 *   - PlaySound(NULL, ...) / SND_PURGE stops the current sound. */

#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <mmsystem.h>
#include <unistd.h>
#include "win32_internal.h"
#include "../sounds.h"

static SDL_AudioStream *g_snd;                   /* the one current sound */

static void snd_stop_current(void) {
    if (!g_snd) return;
    SDL_ClearAudioStream(g_snd);                 /* empty ring = instant reclaim */
    SDL_DestroyAudioStream(g_snd);
    g_snd = NULL;
}

BOOL PlaySoundA(LPCSTR sound, HMODULE mod, DWORD flags) {
    (void)mod;
    if (!sound || (flags & SND_PURGE)) {
        snd_stop_current();
        return TRUE;
    }
    /* NB SND_RESOURCE (0x00040004) contains the SND_MEMORY bit — full match */
    if ((flags & SND_RESOURCE) == SND_RESOURCE) {
        /* silent success BY DESIGN (0068: the corpus wave assets are not
         * vendored, and the default ding must not fire per winmine timer
         * tick) — but report ONCE so an inert soundscape is an inventoried
         * decision, not a mystery (todos/0145 gap #13) */
        WIN32_UNSUPPORTED("PlaySound SND_RESOURCE: resource waves not "
                          "vendored (silent success, 0068)");
        return TRUE;
    }
    if (flags & SND_NOSTOP) {
        if (g_snd && SDL_GetAudioStreamQueued(g_snd) > 0) return FALSE;
    }
    snd_stop_current();

    int dur_ms = 0;
    SDL_AudioStream *s = NULL;
    if (flags & SND_MEMORY) {
        /* the RIFF header carries the length */
        const unsigned char *img = (const unsigned char *)sound;
        size_t n = 8 + ((size_t)img[4] | ((size_t)img[5] << 8) |
                        ((size_t)img[6] << 16) | ((size_t)img[7] << 24));
        s = snd_play_mem(img, n, &dur_ms);
    } else if (flags & SND_FILENAME) {
        s = snd_play_path(sound, &dur_ms);
        if (!s && !(flags & SND_NODEFAULT)) {    /* real: default ding (0211) */
            char path[SND_PATH_MAX];
            if (snd_lookup("SystemDefault", path, sizeof path) == 1)
                s = snd_play_path(path, &dur_ms);
        }
    } else {                                     /* alias (scheme event) —
                                                    real also retries the name
                                                    as a path (0211) */
        char path[SND_PATH_MAX];
        int r = snd_lookup(sound, path, sizeof path);
        if (r == -1) return TRUE;                /* explicit silence */
        if (r == 0) {                            /* unknown alias */
            s = snd_play_path(sound, &dur_ms);   /* the name as a filename */
            if (!s) {
                if (flags & SND_NODEFAULT) return FALSE;
                if (snd_lookup("SystemDefault", path, sizeof path) != 1)
                    return TRUE;
                s = snd_play_path(path, &dur_ms);
            }
        } else {
            s = snd_play_path(path, &dur_ms);
        }
    }
    if (!s) return FALSE;

    if (!(flags & SND_ASYNC)) {
        /* SND_SYNC: poll the queue, capped at the clip duration + slack —
         * a pumpless kernel (headless boot.js) never drains the ring.
         * usleep and SDL_Delay block identically here since todos/0224;
         * usleep keeps this unit SDL-video-agnostic. */
        int waited = 0;
        while (SDL_GetAudioStreamQueued(s) > 0 && waited < dur_ms + 250) {
            usleep(20000);
            waited += 20;
        }
        SDL_DestroyAudioStream(s);               /* tail drains kernel-side */
        return TRUE;
    }
    g_snd = s;                                   /* async: current sound */
    return TRUE;
}

BOOL PlaySoundW(LPCWSTR sound, HMODULE mod, DWORD flags) {
    if (!sound || (flags & SND_MEMORY) ||
        (flags & SND_RESOURCE) == SND_RESOURCE)
        return PlaySoundA((LPCSTR)sound, mod, flags);
    /* narrow the name (alias/path names are ASCII in this world) */
    char buf[SND_PATH_MAX];
    size_t i = 0;
    while (sound[i] && i + 1 < sizeof buf) { buf[i] = (char)sound[i]; i++; }
    buf[i] = 0;
    return PlaySoundA(buf, mod, flags);
}
