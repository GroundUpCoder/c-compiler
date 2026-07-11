/*
 *  c-compiler puNES frontend (GPLv3): the audio backend.
 *
 *  puNES abstracts audio as a portable pipeline (blip_buf → the `handler`
 *  timing layer → a `channels` mixer that writes into an `_snd`/`_callback_data`
 *  ring) fronted by a platform backend (alsa/sndio/xaudio) whose device thread
 *  drains the ring. We compile the portable pipeline (blipbuf.c/channels.c/
 *  mono.c/handler.c) and supply this backend in place of the platform ones:
 *  no device, no thread — instead our SDL3 main() calls pn_snd_drain() once a
 *  frame to pull the ring's samples and hand them to the SDL audio stream.
 *
 *  Modelled on audio/alsa/snd.c minus the alsa/thread machinery.
 */

#include <string.h>
#include <stdlib.h>
#include "audio/snd.h"
#include "audio/channels.h"
#include "audio/blipbuf.h"
#include "conf.h"
#include "clock.h"
#include "common.h"

/* the globals the portable pipeline + core reference */
_snd snd;
_snd_list snd_list;
void (*snd_apu_tick)(void);
void (*snd_end_frame)(void);

static _callback_data cbd;

static int samplerate_from_cfg(void) {
	switch (cfg->samplerate) {
		case S192000: return (192000);
		case S96000:  return (96000);
		case S48000:  return (48000);
		case S44100:  return (44100);
		case S22050:  return (22050);
		case S11025:  return (11025);
	}
	return (48000);
}

BYTE snd_playback_start(void) {
	static int factor[10] = { 90, 80, 70, 60, 50, 40, 30, 20, 10, 5 };

	if (cbd.start) {
		free(cbd.start);
	}
	if (cbd.silence) {
		free(cbd.silence);
	}
	memset(&snd, 0x00, sizeof(_snd));
	memset(&cbd, 0x00, sizeof(_callback_data));

	snd.cache = &cbd;
	audio_channels(cfg->channels_mode);
	snd.samplerate = samplerate_from_cfg();

	snd.period.samples = (snd.samplerate / factor[cfg->audio_buffer_factor & 0x0F]);
	if (snd.period.samples < 1) {
		snd.period.samples = snd.samplerate / 50;
	}
	snd.frequency = machine.cpu_hz / (double)snd.samplerate;
	snd.period.size = snd.period.samples * snd.channels * sizeof(*cbd.write);
	snd.buffer.size = (int32_t)snd.period.size * ((snd.samplerate / snd.period.samples) + 1);
	snd.buffer.limit.low = snd.period.size * 2;
	snd.buffer.limit.high = snd.period.size * 7;

	if (!(cbd.start = (SWORD *)malloc(snd.buffer.size))) {
		return (EXIT_ERROR);
	}
	if (!(cbd.silence = (SWORD *)malloc(snd.period.size))) {
		return (EXIT_ERROR);
	}
	cbd.write = cbd.start;
	cbd.read = (SBYTE *)cbd.start;
	cbd.end = (SBYTE *)cbd.start + snd.buffer.size;
	memset(cbd.start, 0x00, snd.buffer.size);
	memset(cbd.silence, 0x00, snd.period.size);

	audio_channels_init_mode();
	audio_init_blipbuf();

	snd.buffer.start = FALSE;
	snd.initialized = TRUE;
	return (EXIT_OK);
}

BYTE snd_init(void) {
	memset(&snd, 0x00, sizeof(_snd));
	memset(&cbd, 0x00, sizeof(_callback_data));
	snd_apu_tick = NULL;
	snd_end_frame = NULL;
	return (snd_playback_start());
}

void snd_playback_stop(void) {
	snd.initialized = FALSE;
}

void snd_quit(void) {
	snd.initialized = FALSE;
	if (cbd.start) { free(cbd.start); }
	if (cbd.silence) { free(cbd.silence); }
	memset(&cbd, 0x00, sizeof(_callback_data));
}

void snd_reset_buffers(void) {
	if (snd.initialized) {
		cbd.samples_available = 0;
		cbd.bytes_available = 0;
		cbd.write = cbd.start;
		cbd.read = (SBYTE *)cbd.start;
		memset(cbd.start, 0x00, snd.buffer.size);
		audio_channels_reset();
		audio_reset_blipbuf();
		snd.buffer.start = FALSE;
	}
}

/* no audio thread: locks are no-ops */
void snd_thread_pause(void) {}
void snd_thread_continue(void) {}
void snd_thread_lock(void) {}
void snd_thread_unlock(void) {}
void snd_playback_pause(void) {}
void snd_playback_continue(void) {}

uTCHAR *snd_playback_device_desc(int dev) { (void)dev; return (NULL); }
uTCHAR *snd_playback_device_id(int dev) { (void)dev; return (NULL); }
uTCHAR *snd_capture_device_desc(int dev) { (void)dev; return (NULL); }
uTCHAR *snd_capture_device_id(int dev) { (void)dev; return (NULL); }
void snd_list_devices(void) {}

/* ── our consumer: drain up to `max` int16 mono samples into `out`,
 *    returning how many we produced. Mirrors the backend device callback. ── */
int pn_snd_drain(SWORD *out, int max) {
	int got = 0;

	if (!snd.initialized || !snd.buffer.start) {
		return (0);
	}
	while ((got < max) && (cbd.samples_available > 0)) {
		out[got++] = *((SWORD *)cbd.read);
		cbd.read += sizeof(SWORD);
		if (cbd.read >= cbd.end) {
			cbd.read = (SBYTE *)cbd.start;
		}
		cbd.samples_available--;
		cbd.bytes_available -= sizeof(SWORD);
	}
	return (got);
}

int pn_snd_channels(void) { return (snd.channels ? snd.channels : 1); }
int pn_snd_samplerate(void) { return (snd.samplerate ? snd.samplerate : 48000); }
