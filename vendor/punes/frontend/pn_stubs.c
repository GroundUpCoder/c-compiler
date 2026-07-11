/*
 *  c-compiler puNES frontend (GPLv3): stubs for the app-layer subsystems we
 *  don't compile — the host joystick backend (js_os_*), plus (added as link
 *  errors surface them) the NSF player, A/V recording, tape recorder, xdelta
 *  patcher, threading and archive loaders. Each is referenced by the core but
 *  inert for a keyboard-driven cartridge emulator.
 */
#include <stddef.h>
#include <stdlib.h>
#include "common.h"
#include "jstick.h"
#include "rom_mem.h"
#include "uncompress.h"

/* ── host joystick backend: no device is ever opened ─────────────────── */
void js_os_init(BYTE first_time) { (void)first_time; }
void js_os_quit(BYTE last_time) { (void)last_time; }
void js_os_jdev_init(_js_device *jdev) { (void)jdev; }
void js_os_jdev_close(_js_device *jdev) { (void)jdev; }
void js_os_jdev_scan(void) {}
void js_os_jdev_read_events_loop(_js_device *jdev) { (void)jdev; }

/* ── NSF music player (nsf.c/nsfe.c not compiled — cartridge emu only) ── */
void nsf_init(void) {}
void nsf_quit(void) {}
void nsf_reset(void) {}
BYTE nsf_load_rom(void) { return (EXIT_ERROR); }
void nsf_info(void) {}
void nsf_effect(void) {}
void nsf_main_screen(void) {}
void nsf_main_screen_event(void) {}
void nsf_init_tune(void) {}
void nsf_reset_prg(void) {}
void nsf_reset_song_title(void) {}
void nsf_reset_timers(void) {}
void nsf_controls_mouse_in_gui(int x_mouse, int y_mouse) { (void)x_mouse; (void)y_mouse; }
void extcl_audio_samples_mod_nsf(SWORD *samples, int count) { (void)samples; (void)count; }
BYTE nsfe_load_rom(void) { return (EXIT_ERROR); }

/* ── UNIF ROM format (unif.c not compiled — iNES/NES 2.0 only) ───────── */
BYTE unif_load_rom(void) { return (EXIT_ERROR); }

/* ── archive loaders (uncompress.c not compiled — raw .nes/.fds only) ── */
void uncompress_quit(void) {}
_uncompress_archive *uncompress_archive_alloc(uTCHAR *file, BYTE *rc) {
	(void)file; if (rc) { *rc = UNCOMPRESS_EXIT_IS_NOT_COMP; } return (NULL);
}
void uncompress_archive_free(_uncompress_archive *archive) { (void)archive; }
BYTE uncompress_archive_extract_file(_uncompress_archive *archive, BYTE type) { (void)archive; (void)type; return (EXIT_ERROR); }
uTCHAR *uncompress_archive_extracted_file_name(_uncompress_archive *archive, BYTE type) { (void)archive; (void)type; return (NULL); }

/* ── NES 2.0 external database (gui/nes20db not compiled) ─────────────── */
void nes20db_reset(void) {}
BYTE nes20db_search(void) { return (EXIT_ERROR); }

/* ── recent-files list, dipswitch UI, xdelta patcher, tape, TAS ──────── */
void recent_roms_add(uTCHAR *file) { (void)file; }
void recent_disks_add(uTCHAR *file) { (void)file; }
void dipswitch_search(void) {}
BYTE patcher_xdelta(_rom_mem *patch, _rom_mem *rom) { (void)patch; (void)rom; return (EXIT_ERROR); }
void tape_data_recorder_tick(void) {}
BYTE tas_file(uTCHAR *ext, uTCHAR *file) { (void)ext; (void)file; return (EXIT_ERROR); }
void tas_quit(void) {}

/* ── threading (single-threaded: we drive frames ourselves) ──────────── */
void emu_thread_pause(void) {}
void emu_thread_continue(void) {}

/* ── video effects / scalers (we present the raw PPU buffer) ─────────── */
void tv_noise_effect(BYTE nidx) { (void)nidx; }
void scale_surface_preview_1x(void *sb, uint32_t pitch, void *pix) { (void)sb; (void)pitch; (void)pix; }

/* ── mapper 368 excluded (compiler gap: case labels in a nested block of a
 *    braceless switch body — see the port README / follow-up todo) ────── */
void map_init_368(void) {}
