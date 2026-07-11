/* c-compiler puNES frontend: replacement for gui/qt.h (the Qt seam).
   Declares the _gui globals + the gui_ and log_ function seam the core
   calls into; implementations live in vendor/punes/frontend/. GPLv3. */
#ifndef PUNES_SHIM_QT_H_
#define PUNES_SHIM_QT_H_
#include <sys/time.h>
#include <strings.h>   /* puNES core calls strcasecmp/strncasecmp bare */
/* Mirror the real gui/qt.h include cascade (minus the Windows win.h) so the
   core sees the same declarations it does upstream. */
#include "common.h"
#include "emu.h"
#include "uncompress.h"
#include "jstick.h"
#include "input.h"
#define EXTERNC
typedef struct _gui {
#if defined (_WIN32)
	DWORD version_os;
	double frequency;
	uint64_t counter_start;
#else
	struct timeval counterStart;
#endif
	uTCHAR last_open_path[LENGTH_FILE_NAME_MAX];
	uTCHAR last_open_patch_path[LENGTH_FILE_NAME_MAX];

	//int8_t cpu_cores;

	uint8_t start;
	uint8_t in_update;
	uint8_t capture_input;

	// lost focus pause
	uint8_t main_win_lfp;

	int dlg_rc;
	int dlg_tabWidget_kbd_joy_index[PORT_MAX];
} _gui;
typedef struct _gui_mouse {
	int x;
	int y;
	uint8_t left;
	uint8_t right;

	uint8_t hidden;

	double timer;
} _gui_mouse;
typedef struct _external_windows {
	uint8_t vs_system;
	uint8_t detach_barcode;
} _external_windows;

extern _gui gui;
extern _gui_mouse gmouse;
extern _external_windows ext_win;
extern double (*gui_get_ms)(void);
EXTERNC BYTE gui_init(int *argc, char **argv);
EXTERNC void gui_quit(void);
EXTERNC BYTE gui_control_instance(void);
EXTERNC BYTE gui_create(void);
EXTERNC void gui_start(void);
EXTERNC void gui_set_dark_theme(void);
EXTERNC void gui_set_light_theme(void);
EXTERNC size_t gui_utf8_to_utchar(char *input, uTCHAR **output, size_t max_size);
EXTERNC const uTCHAR *gui_home_folder(void);
EXTERNC const uTCHAR *gui_application_folder(void);
EXTERNC const uTCHAR *gui_config_folder(void);
EXTERNC const uTCHAR *gui_data_folder(void);
EXTERNC const uTCHAR *gui_temp_folder(void);
EXTERNC const uTCHAR *gui_extract_base(const uTCHAR *path);
EXTERNC double gui_device_pixel_ratio(void);
EXTERNC void gui_set_window_size(void);
EXTERNC void gui_state_save_slot_set(BYTE slot, BYTE on_video);
EXTERNC void gui_state_save_slot_set_tooltip(BYTE slot);
EXTERNC void gui_update(void);
EXTERNC void gui_update_gps_settings(void);
EXTERNC void gui_update_status_bar(void);
EXTERNC void gui_update_ntsc_widgets(void);
EXTERNC void gui_update_apu_channels_widgets(void);
EXTERNC void gui_update_recording_widgets(void);
EXTERNC void gui_update_ppu_hacks_lag_frames(void);
EXTERNC void gui_update_fds_menu(void);
EXTERNC void gui_update_tape_menu(void);
EXTERNC void gui_update_recording_tab(void);
EXTERNC void gui_egds_set_fps(void);
EXTERNC void gui_egds_stop_unnecessary(void);
EXTERNC void gui_egds_start_pause(void);
EXTERNC void gui_egds_stop_pause(void);
EXTERNC void gui_egds_start_rwnd(void);
EXTERNC void gui_egds_stop_rwnd(void);
EXTERNC void gui_fullscreen(void);
EXTERNC void gui_dipswitch_dialog(void);
EXTERNC int gui_uncompress_selection_dialog(_uncompress_archive *archive, BYTE type);
EXTERNC void gui_control_pause_bck(WORD event);
EXTERNC void gui_active_window(void);
EXTERNC void gui_set_focus(void);
EXTERNC void *gui_objcheat_get_ptr(void);
EXTERNC void gui_objcheat_init(void);
EXTERNC void gui_objcheat_read_game_cheats(void);
EXTERNC void gui_cursor_init(void);
EXTERNC void gui_cursor_set(void);
EXTERNC void gui_cursor_hide(BYTE hide);
EXTERNC void gui_control_visible_cursor(void);
EXTERNC void *gui_wdgdlgmainwindow_get_ptr(void);
EXTERNC void gui_wdgdlgmainwindow_coords(int *x, int *y, BYTE border);
EXTERNC void gui_wdgdlgmainwindow_before_set_res(void);
EXTERNC void *gui_wdgrewind_get_ptr(void);
EXTERNC void gui_wdgrewind_play(void);
EXTERNC void gui_emit_cmdlinehelp(BYTE type);
EXTERNC void gui_emit_et_reset(BYTE type);
EXTERNC void gui_emit_et_gg_reset(void);
EXTERNC void gui_emit_et_vs_reset(void);
EXTERNC void gui_emit_et_external_control_windows_show(void);
EXTERNC void gui_max_speed_start(void);
EXTERNC void gui_max_speed_stop(void);
EXTERNC void gui_nsf_author_note_open(const uTCHAR *string);
EXTERNC void gui_nsf_author_note_close(void);
EXTERNC void gui_toggle_audio(void);
EXTERNC void gui_decode_all_input_events(void);
EXTERNC void gui_screen_update(void);
EXTERNC void *gui_wdgoverlayui_get_ptr(void);
EXTERNC void gui_overlay_update(void);
EXTERNC BYTE gui_overlay_is_updated(void);
EXTERNC void gui_overlay_enable_save_slot(BYTE mode);
EXTERNC void gui_overlay_set_size(int w, int h);
EXTERNC void gui_overlay_info_init(void);
EXTERNC void gui_overlay_info_emulator(void);
EXTERNC void gui_overlay_info_append_subtitle(uTCHAR *msg);
EXTERNC void gui_overlay_info_append_msg_precompiled(int index, void *arg1);
EXTERNC void gui_overlay_info_append_msg_precompiled_with_alignment(BYTE alignment, int index, void *arg1);
EXTERNC void gui_overlay_blit(void);
EXTERNC void gui_overlay_slot_preview_set_from_ppu_screen(int slot, void *buffer, uTCHAR *file);
EXTERNC void gui_overlay_slot_preview_set_from_png(int slot, void *buffer, size_t size, uTCHAR *file);
EXTERNC void *gui_overlay_slot_preview_get(int slot);
EXTERNC void *gui_wdgdlgheadereditor_get_ptr(void);
EXTERNC void gui_wdgdlgheadereditor_read_header(void);
EXTERNC void *gui_wdgdlgsettings_get_ptr(void);
EXTERNC void gui_wdgdlgsettings_input_update_joy_combo(void);
EXTERNC void *gui_wdgdlgjsc_get_ptr(void);
EXTERNC void gui_wdgdlgjsc_emit_update_joy_combo(void);
EXTERNC void *gui_wdgdlgkeyboard_get_ptr(void);
EXTERNC void *gui_wdgdlglog_get_ptr(void);
EXTERNC void gui_js_joyval_icon_desc(int index, DBWORD input, void *icon, void *desc);
EXTERNC void *gui_dlgdebugger_get_ptr(void);
EXTERNC void gui_dlgdebugger_click_step(void);
EXTERNC void gui_external_control_windows_show(void);
EXTERNC void gui_vs_system_update_dialog(void);
EXTERNC void gui_vs_system_insert_coin(void);
EXTERNC void gui_detach_barcode_change_rom(void);
EXTERNC void gui_unsupported_hardware(void);
EXTERNC void gui_nes_keyboard(void);
EXTERNC void gui_nes_keyboard_paste_event(void);
EXTERNC void gui_nes_keyboard_frame_finished(void);
EXTERNC void gui_wdgopengl_make_current(void);
EXTERNC unsigned int gui_wdgopengl_framebuffer_id(void);
EXTERNC void gui_screen_info(void);
EXTERNC uint32_t gui_color(BYTE a, BYTE r, BYTE g, BYTE b);
EXTERNC BYTE gui_load_lut(void *l, const uTCHAR *path);
EXTERNC void gui_save_screenshot(int w, int h, int stride, char *buffer, BYTE flip);
EXTERNC void gui_save_slot_preview_to_png(int slot, void **dst, size_t *size);
EXTERNC void gui_utf_dirname(uTCHAR *path, uTCHAR *dst, size_t len);
EXTERNC void gui_utf_basename(uTCHAR *path, uTCHAR *dst, size_t len);
EXTERNC int gui_utf_strcasecmp(uTCHAR *s0, uTCHAR *s1);
EXTERNC unsigned int gui_hardware_concurrency(void);
EXTERNC void gui_sleep(double ms);
EXTERNC char *gui_dup_wchar_to_utf8(uTCHAR *w);
EXTERNC int gui_screen_id(void);
EXTERNC int gui_win_id(void);
EXTERNC BYTE gui_monitor_enum_monitors(void);
EXTERNC void gui_monitor_set_res(void *monitor_info, void *mode_info);
EXTERNC void gui_monitor_get_current_x_y(void *monitor_info, int *x, int *y);
EXTERNC void gui_warning(const uTCHAR *txt);
EXTERNC void gui_critical(const uTCHAR *txt);
EXTERNC void log_info(const uTCHAR *txt, ...);
EXTERNC void log_info_open(const uTCHAR *txt, ...);
EXTERNC void log_info_box(const uTCHAR *txt, ...);
EXTERNC void log_info_box_open(const uTCHAR *txt, ...);
EXTERNC void log_warning(const uTCHAR *txt, ...);
EXTERNC void log_warning_open(const uTCHAR *txt, ...);
EXTERNC void log_warning_box(const uTCHAR *txt, ...);
EXTERNC void log_warning_box_open(const uTCHAR *txt, ...);
EXTERNC void log_error(const uTCHAR *txt, ...);
EXTERNC void log_error_open(const uTCHAR *txt, ...);
EXTERNC void log_error_box(const uTCHAR *txt, ...);
EXTERNC void log_error_box_open(const uTCHAR *txt, ...);
EXTERNC void log_close(const uTCHAR *txt, ...);
EXTERNC void log_close_box(const uTCHAR *txt, ...);
EXTERNC void log_append(const uTCHAR *txt, ...);
EXTERNC void log_newline(void);
#endif
