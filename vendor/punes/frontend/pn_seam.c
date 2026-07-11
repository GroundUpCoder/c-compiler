/*
 *  c-compiler puNES frontend (GPLv3): the gui_* / log_* seam.
 *
 *  Upstream puNES routes ~65 gui_* callbacks + a log_* family from the core
 *  into its Qt shell (gui/qt.cpp et al). We have no Qt: this file provides the
 *  `_gui`/`_gui_mouse`/`_external_windows` globals and plain-C implementations
 *  of the whole seam. The vast majority are UI cosmetics (overlay text, menu/
 *  widget refreshes, dialogs) → no-ops; a handful are genuine OS utilities
 *  (millisecond clock, sleep, cpu count, folder/path helpers) → real code; the
 *  log_* family prints to stderr.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdarg.h>
#include <time.h>
#include <sys/time.h>
#include "qt.h"
#include "common.h"

/* ── the globals the core reads ─────────────────────────────────────── */
_gui gui;
_gui_mouse gmouse;
_external_windows ext_win;

/* ── millisecond clock (the one real timing primitive the core needs) ── */
static double pn_get_ms(void) {
	struct timeval tv;
	gettimeofday(&tv, NULL);
	return ((double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0);
}
double (*gui_get_ms)(void) = pn_get_ms;

void gui_sleep(double ms) {
	if (ms <= 0.0) {
		return;
	}
	{
		struct timespec ts;
		ts.tv_sec = (time_t)(ms / 1000.0);
		ts.tv_nsec = (long)((ms - (ts.tv_sec * 1000.0)) * 1000000.0);
		nanosleep(&ts, NULL);
	}
}
unsigned int gui_hardware_concurrency(void) { return (1); }

/* ── folders: a single writable working dir (cwd) for saves/config ───── */
static const uTCHAR *pn_cwd_folder(void) { return ("."); }
const uTCHAR *gui_home_folder(void) { return (pn_cwd_folder()); }
const uTCHAR *gui_application_folder(void) { return (pn_cwd_folder()); }
const uTCHAR *gui_config_folder(void) { return (pn_cwd_folder()); }
const uTCHAR *gui_data_folder(void) { return (pn_cwd_folder()); }
const uTCHAR *gui_temp_folder(void) { return (pn_cwd_folder()); }

/* ── path / string helpers (uTCHAR == char here) ─────────────────────── */
size_t gui_utf8_to_utchar(char *input, uTCHAR **output, size_t max_size) {
	size_t len = input ? strlen(input) : 0;
	if (max_size && (len > max_size)) {
		len = max_size;
	}
	(*output) = (uTCHAR *)malloc(len + 1);
	if ((*output)) {
		if (len) {
			memcpy((*output), input, len);
		}
		(*output)[len] = 0;
	}
	return (len);
}
char *gui_dup_wchar_to_utf8(uTCHAR *w) {
	size_t len = w ? strlen(w) : 0;
	char *out = (char *)malloc(len + 1);
	if (out) {
		if (len) {
			memcpy(out, w, len);
		}
		out[len] = 0;
	}
	return (out);
}
void gui_utf_dirname(uTCHAR *path, uTCHAR *dst, size_t len) {
	const char *slash = path ? strrchr(path, '/') : NULL;
	if (!slash) {
		snprintf(dst, len, ".");
		return;
	}
	{
		size_t n = (size_t)(slash - path);
		if (n >= len) {
			n = len - 1;
		}
		memcpy(dst, path, n);
		dst[n] = 0;
	}
}
void gui_utf_basename(uTCHAR *path, uTCHAR *dst, size_t len) {
	const char *slash = path ? strrchr(path, '/') : NULL;
	snprintf(dst, len, "%s", slash ? slash + 1 : (path ? path : ""));
}
int gui_utf_strcasecmp(uTCHAR *s0, uTCHAR *s1) {
	return (strcasecmp(s0 ? s0 : "", s1 ? s1 : ""));
}
const uTCHAR *gui_extract_base(const uTCHAR *path) {
	const char *slash = path ? strrchr(path, '/') : NULL;
	return (slash ? slash + 1 : path);
}

/* ── log family → stderr ─────────────────────────────────────────────── */
#define PN_LOG(prefix) do { \
	va_list ap; \
	fprintf(stderr, prefix); \
	va_start(ap, txt); \
	vfprintf(stderr, txt ? txt : "", ap); \
	va_end(ap); \
	fputc('\n', stderr); \
} while (0)
void log_info(const uTCHAR *txt, ...) { PN_LOG("[info] "); }
void log_info_open(const uTCHAR *txt, ...) { PN_LOG("[info] "); }
void log_info_box(const uTCHAR *txt, ...) { PN_LOG("[info] "); }
void log_info_box_open(const uTCHAR *txt, ...) { PN_LOG("[info] "); }
void log_warning(const uTCHAR *txt, ...) { PN_LOG("[warn] "); }
void log_warning_open(const uTCHAR *txt, ...) { PN_LOG("[warn] "); }
void log_warning_box(const uTCHAR *txt, ...) { PN_LOG("[warn] "); }
void log_warning_box_open(const uTCHAR *txt, ...) { PN_LOG("[warn] "); }
void log_error(const uTCHAR *txt, ...) { PN_LOG("[error] "); }
void log_error_open(const uTCHAR *txt, ...) { PN_LOG("[error] "); }
void log_error_box(const uTCHAR *txt, ...) { PN_LOG("[error] "); }
void log_error_box_open(const uTCHAR *txt, ...) { PN_LOG("[error] "); }
void log_close(const uTCHAR *txt, ...) { PN_LOG("[info] "); }
void log_close_box(const uTCHAR *txt, ...) { PN_LOG("[info] "); }
void log_append(const uTCHAR *txt, ...) { PN_LOG(""); }
void log_newline(void) { fputc('\n', stderr); }
void gui_warning(const uTCHAR *txt) { fprintf(stderr, "[warn] %s\n", txt ? txt : ""); }
void gui_critical(const uTCHAR *txt) { fprintf(stderr, "[crit] %s\n", txt ? txt : ""); }

/* ── everything else: UI cosmetics / dialogs → no-ops ────────────────── */
BYTE gui_init(int *argc, char **argv) { (void)argc; (void)argv; return (EXIT_OK); }
void gui_quit(void) {}
BYTE gui_control_instance(void) { return (EXIT_OK); }
BYTE gui_create(void) { return (EXIT_OK); }
void gui_start(void) {}
void gui_set_dark_theme(void) {}
void gui_set_light_theme(void) {}
double gui_device_pixel_ratio(void) { return (1.0); }
void gui_set_window_size(void) {}
void gui_state_save_slot_set(BYTE slot, BYTE on_video) { (void)slot; (void)on_video; }
void gui_state_save_slot_set_tooltip(BYTE slot) { (void)slot; }
void gui_update(void) {}
void gui_update_gps_settings(void) {}
void gui_update_status_bar(void) {}
void gui_update_ntsc_widgets(void) {}
void gui_update_apu_channels_widgets(void) {}
void gui_update_recording_widgets(void) {}
void gui_update_ppu_hacks_lag_frames(void) {}
void gui_update_fds_menu(void) {}
void gui_update_tape_menu(void) {}
void gui_update_recording_tab(void) {}
void gui_egds_set_fps(void) {}
void gui_egds_stop_unnecessary(void) {}
void gui_egds_start_pause(void) {}
void gui_egds_stop_pause(void) {}
void gui_egds_start_rwnd(void) {}
void gui_egds_stop_rwnd(void) {}
void gui_fullscreen(void) {}
void gui_dipswitch_dialog(void) {}
int gui_uncompress_selection_dialog(_uncompress_archive *archive, BYTE type) { (void)archive; (void)type; return (0); }
void gui_control_pause_bck(WORD event) { (void)event; }
void gui_active_window(void) {}
void gui_set_focus(void) {}
void *gui_objcheat_get_ptr(void) { return (NULL); }
void gui_objcheat_init(void) {}
void gui_objcheat_read_game_cheats(void) {}
void gui_cursor_init(void) {}
void gui_cursor_set(void) {}
void gui_cursor_hide(BYTE hide) { (void)hide; }
void gui_control_visible_cursor(void) {}
void *gui_wdgdlgmainwindow_get_ptr(void) { return (NULL); }
void gui_wdgdlgmainwindow_coords(int *x, int *y, BYTE border) { (void)border; if (x) { *x = 0; } if (y) { *y = 0; } }
void gui_wdgdlgmainwindow_before_set_res(void) {}
void *gui_wdgrewind_get_ptr(void) { return (NULL); }
void gui_wdgrewind_play(void) {}
void gui_emit_cmdlinehelp(BYTE type) { (void)type; }
void gui_emit_et_reset(BYTE type) { (void)type; }
void gui_emit_et_gg_reset(void) {}
void gui_emit_et_vs_reset(void) {}
void gui_emit_et_external_control_windows_show(void) {}
void gui_max_speed_start(void) {}
void gui_max_speed_stop(void) {}
void gui_nsf_author_note_open(const uTCHAR *string) { (void)string; }
void gui_nsf_author_note_close(void) {}
void gui_toggle_audio(void) {}
void gui_decode_all_input_events(void) {}
void gui_screen_update(void) {}
void *gui_wdgoverlayui_get_ptr(void) { return (NULL); }
void gui_overlay_update(void) {}
BYTE gui_overlay_is_updated(void) { return (FALSE); }
void gui_overlay_enable_save_slot(BYTE mode) { (void)mode; }
void gui_overlay_set_size(int w, int h) { (void)w; (void)h; }
void gui_overlay_info_init(void) {}
void gui_overlay_info_emulator(void) {}
void gui_overlay_info_append_subtitle(uTCHAR *msg) { (void)msg; }
void gui_overlay_info_append_msg_precompiled(int index, void *arg1) { (void)index; (void)arg1; }
void gui_overlay_info_append_msg_precompiled_with_alignment(BYTE alignment, int index, void *arg1) { (void)alignment; (void)index; (void)arg1; }
void gui_overlay_blit(void) {}
void gui_overlay_slot_preview_set_from_ppu_screen(int slot, void *buffer, uTCHAR *file) { (void)slot; (void)buffer; (void)file; }
void gui_overlay_slot_preview_set_from_png(int slot, void *buffer, size_t size, uTCHAR *file) { (void)slot; (void)buffer; (void)size; (void)file; }
void *gui_overlay_slot_preview_get(int slot) { (void)slot; return (NULL); }
void *gui_wdgdlgheadereditor_get_ptr(void) { return (NULL); }
void gui_wdgdlgheadereditor_read_header(void) {}
void *gui_wdgdlgsettings_get_ptr(void) { return (NULL); }
void gui_wdgdlgsettings_input_update_joy_combo(void) {}
void *gui_wdgdlgjsc_get_ptr(void) { return (NULL); }
void gui_wdgdlgjsc_emit_update_joy_combo(void) {}
void *gui_wdgdlgkeyboard_get_ptr(void) { return (NULL); }
void *gui_wdgdlglog_get_ptr(void) { return (NULL); }
void gui_js_joyval_icon_desc(int index, DBWORD input, void *icon, void *desc) { (void)index; (void)input; (void)icon; (void)desc; }
void *gui_dlgdebugger_get_ptr(void) { return (NULL); }
void gui_dlgdebugger_click_step(void) {}
void gui_external_control_windows_show(void) {}
void gui_vs_system_update_dialog(void) {}
void gui_vs_system_insert_coin(void) {}
void gui_detach_barcode_change_rom(void) {}
void gui_unsupported_hardware(void) {}
void gui_nes_keyboard(void) {}
void gui_nes_keyboard_paste_event(void) {}
void gui_nes_keyboard_frame_finished(void) {}
void gui_wdgopengl_make_current(void) {}
unsigned int gui_wdgopengl_framebuffer_id(void) { return (0); }
void gui_screen_info(void) {}
uint32_t gui_color(BYTE a, BYTE r, BYTE g, BYTE b) { return (((uint32_t)a << 24) | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b); }
BYTE gui_load_lut(void *l, const uTCHAR *path) { (void)l; (void)path; return (EXIT_ERROR); }
void gui_save_screenshot(int w, int h, int stride, char *buffer, BYTE flip) { (void)w; (void)h; (void)stride; (void)buffer; (void)flip; }
void gui_save_slot_preview_to_png(int slot, void **dst, size_t *size) { (void)slot; if (dst) { *dst = NULL; } if (size) { *size = 0; } }
int gui_screen_id(void) { return (0); }
int gui_win_id(void) { return (0); }
BYTE gui_monitor_enum_monitors(void) { return (EXIT_OK); }
void gui_monitor_set_res(void *monitor_info, void *mode_info) { (void)monitor_info; (void)mode_info; }
void gui_monitor_get_current_x_y(void *monitor_info, int *x, int *y) { (void)monitor_info; if (x) { *x = 0; } if (y) { *y = 0; } }
