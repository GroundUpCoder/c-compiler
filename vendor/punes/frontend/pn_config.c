/*
 *  c-compiler puNES frontend (GPLv3): the emulator configuration.
 *
 *  Upstream puNES defines `cfg`/`cfg_from_file` and its table-driven settings
 *  system in the Qt shell (gui/settings.cpp, C++). This is our plain-C
 *  replacement: a single `_config` with sane defaults and no-op settings
 *  persistence (we do not read/write puNES .cfg files). Everything the
 *  emulation core reads off `cfg->…` lives here.
 */

#include <string.h>
#include "conf.h"
#include "common.h"
#include "apu.h"
#include "video/gfx.h"

_config cfg_from_file;
_config *cfg = &cfg_from_file;

/* Called once from our main() before emu_turn_on(). */
void pn_config_defaults(void) {
	memset(&cfg_from_file, 0x00, sizeof(cfg_from_file));

	cfg = &cfg_from_file;

	cfg->mode = AUTO;                 /* region auto-detected from the ROM   */
	cfg->initial_ram_value = IRV_0X00;
	cfg->scale = X3;
	cfg->palette = 0;                 /* default (generated) palette         */
	cfg->ntsc_format = 0;
	cfg->filter = NO_FILTER;
	cfg->shader = NO_SHADER;

	/* audio */
	cfg->samplerate = 0;              /* index → snd_sample_rate()           */
	cfg->channels_mode = 0;           /* mono                                */
	cfg->audio_buffer_factor = 0;
	for (int i = APU_S1; i <= APU_MASTER; i++) {
		cfg->apu.channel[i] = TRUE;
		cfg->apu.volume[i] = 1.0;
	}

	/* video framing */
	cfg->oscan = PERGAME_DEFAULT;
	cfg->oscan_default = 0;
	cfg->vsync = FALSE;
	cfg->interpolation = FALSE;

	/* overclock: cfg->oclock points into oclock_all */
	cfg->oclock = &cfg->oclock_all.def;

	cfg->save_battery_ram_file = FALSE;
	cfg->save_on_exit = FALSE;
	cfg->dipswitch = 0;
	cfg->language = 0;
}

/* ── settings persistence — stubs (we don't read/write puNES cfg files) ── */
void settings_init(void) {}
void settings_save(void) {}
void settings_save_GUI(void) {}
void settings_pgs_parse(void) {}
void settings_jsc_parse(int index) { (void)index; }
