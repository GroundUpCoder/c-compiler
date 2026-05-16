/*
 * snd_sdl.c — SDL queue-based audio driver for the C-to-WASM Quake
 * port. Written from scratch (not imported from upstream). Replaces
 * upstream's snd_linux.c / snd_dos.c / snd_win.c (which mmap'd a
 * kernel DMA buffer — too much OS-specific machinery for us).
 *
 * The contract with the engine is the same dma_t struct everyone else
 * fills in (see sound.h). We just back it with:
 *
 *   shm->buffer  : our own ring buffer (8 KB mono samples × 16-bit × stereo
 *                  = 32 KB). The engine's mixer (snd_mix.c) writes into this
 *                  via shm->samplepos.
 *   samples      : ring buffer total mono samples (2× actual for stereo)
 *
 * Each frame, S_Update calls SNDDMA_GetDMAPos (we tell it where the
 * play cursor is so it knows how much to advance samplepos), mixes
 * new audio into shm->buffer, then calls SNDDMA_Submit. Submit copies
 * the freshly mixed bytes out to SDL_QueueAudio for the host to play.
 *
 * Position tracking: SDL_QueueAudio is push-only — once submitted, we
 * can't observe what's still queued vs played, only the byte count
 * still pending (SDL_GetQueuedAudioSize). We compute the play cursor
 * as (total_queued - still_queued) bytes since startup, modulo the
 * ring buffer length.
 */
#include "quakedef.h"
#include <SDL.h>

#define SAMPLE_RATE      22050
#define SAMPLE_BITS      16
#define CHANNELS         2

// Ring buffer: mono samples. Stereo doubles this in bytes. 16384 mono
// samples = 32768 stereo samples = 64 KB at 16-bit — about 370 ms at
// 22050 Hz, plenty for the engine's 100 ms mix budget.
#define RING_MONO        16384

static int           sdl_audio_dev;
static qboolean      sdl_audio_inited;
static unsigned char sdl_buffer[RING_MONO * (SAMPLE_BITS / 8) * CHANNELS];
static int           sdl_bytes_total;   // total bytes ever queued
static int           sdl_bytes_played;  // computed each GetDMAPos call

qboolean SNDDMA_Init (void)
{
	SDL_AudioSpec want;
	want.freq     = SAMPLE_RATE;
	want.format   = AUDIO_S16;
	want.channels = CHANNELS;

	sdl_audio_dev = SDL_OpenAudioDevice (NULL, 0, &want, NULL, 0);
	if (sdl_audio_dev == 0) {
		Con_Printf ("SNDDMA_Init: SDL_OpenAudioDevice failed\n");
		return false;
	}

	memset (sdl_buffer, 0, sizeof(sdl_buffer));

	shm = &sn;
	shm->splitbuffer      = 0;
	shm->samplebits       = SAMPLE_BITS;
	shm->speed            = SAMPLE_RATE;
	shm->channels         = CHANNELS;
	shm->samples          = sizeof(sdl_buffer) / (SAMPLE_BITS / 8); // total mono-sample slots in the buffer (counts stereo as 2)
	shm->samplepos        = 0;
	shm->submission_chunk = 1;
	shm->buffer           = sdl_buffer;
	shm->soundalive       = true;
	shm->gamealive        = true;

	sdl_bytes_total  = 0;
	sdl_bytes_played = 0;
	sdl_audio_inited = true;

	SDL_PauseAudioDevice (sdl_audio_dev, 0);  // start playback
	Con_Printf ("SNDDMA_Init: SDL audio device opened (%d Hz, %d-bit, %d ch)\n",
		SAMPLE_RATE, SAMPLE_BITS, CHANNELS);
	return true;
}

/*
 * Return the current play cursor in MONO samples. Quake's mixer uses
 * this to know where to start writing the next mix chunk: it mixes
 * from samplepos forward, up to samplepos + paintedtime - what the
 * caller knows is already mixed.
 *
 * We compute the play position from (totalQueued - stillQueued) bytes
 * since startup. Since SDL_GetQueuedAudioSize returns *bytes pending*,
 * subtracting from totalQueued gives us bytes consumed. We convert to
 * mono samples by dividing by bytes-per-frame and multiplying by
 * channels (so the result is in the same unit as shm->samplepos).
 */
int SNDDMA_GetDMAPos (void)
{
	if (!sdl_audio_inited) return 0;

	int still_queued  = (int)SDL_GetQueuedAudioSize (sdl_audio_dev);
	int bytes_played  = sdl_bytes_total - still_queued;
	int bytes_per_sample = SAMPLE_BITS / 8;
	int samples_played   = bytes_played / bytes_per_sample;
	sdl_bytes_played = bytes_played;
	shm->samplepos       = samples_played % shm->samples;
	return shm->samplepos;
}

/*
 * Submit pulls "new mix" out of the engine's ring buffer and pushes
 * it into SDL_QueueAudio.
 *
 * paintedtime is in STEREO FRAMES (snd_mix.c line 116: lpos = lpaintedtime
 * & ((shm->samples>>1) - 1) — masks against samples/2, which for stereo
 * is the frame count; the buffer cursor then advances 4 bytes per
 * paintedtime tick). To convert frames → bytes we need
 * (bytes_per_sample × channels). An earlier version of this file
 * used (bytes_per_sample) only and was queuing half the audio.
 */
extern int paintedtime;  // declared in snd_dma.c

void SNDDMA_Submit (void)
{
	if (!sdl_audio_inited) return;

	int bytes_per_frame = (SAMPLE_BITS / 8) * CHANNELS;
	int paintedtime_bytes = paintedtime * bytes_per_frame;
	int need = paintedtime_bytes - sdl_bytes_total;
	if (need <= 0) return;

	int buflen = (int)sizeof(sdl_buffer);
	int start  = sdl_bytes_total % buflen;
	if (start + need <= buflen) {
		SDL_QueueAudio (sdl_audio_dev, sdl_buffer + start, need);
	} else {
		int first = buflen - start;
		SDL_QueueAudio (sdl_audio_dev, sdl_buffer + start, first);
		SDL_QueueAudio (sdl_audio_dev, sdl_buffer, need - first);
	}
	sdl_bytes_total = paintedtime_bytes;
}

void SNDDMA_Shutdown (void)
{
	if (!sdl_audio_inited) return;
	SDL_PauseAudioDevice (sdl_audio_dev, 1);
	SDL_CloseAudioDevice (sdl_audio_dev);
	sdl_audio_inited = false;
	shm = NULL;
}
