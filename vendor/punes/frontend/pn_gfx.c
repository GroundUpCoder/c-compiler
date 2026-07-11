/*
 *  c-compiler puNES frontend (GPLv3): the video seam.
 *
 *  puNES's real gfx layer (video/gfx.c + the Qt/OpenGL backends) owns window
 *  creation, the scaler/shader pipeline and palette application. We don't use
 *  any of it: the emulation core renders palette indices into
 *  nes[].p.ppu_screen, and our SDL3 main() reads that buffer directly and maps
 *  it through an RGB NES palette. So the whole gfx surface the core calls is
 *  reduced to book-keeping + no-ops here; the `_gfx gfx` global exists only for
 *  the handful of fields the core reads (w/h/frame.in_draw/…).
 */

#include <string.h>
#include "video/gfx.h"
#include "video/gfx_thread.h"
#include "common.h"

/* gfx_monitor.h pulls X11 on __unix__, which we don't have; declare the four
   monitor entry points locally instead of including it. */
BYTE gfx_monitor_restore_res(void);
BYTE gfx_monitor_set_res(int w, int h, BYTE adaptive_rrate, BYTE change_rom_mode);
void gfx_monitor_init(void);
void gfx_monitor_quit(void);

_gfx gfx;

BYTE gfx_init(void) {
	memset(&gfx, 0x00, sizeof(gfx));
	gfx.w[CURRENT] = SCR_COLUMNS;
	gfx.h[CURRENT] = SCR_ROWS;
	gfx.device_pixel_ratio = 1.0;
	return (EXIT_OK);
}
void gfx_quit(void) {}
void gfx_reset(void) {}
void gfx_set_screen(BYTE scale, DBWORD filter, DBWORD shader, BYTE fullscreen,
	BYTE palette, BYTE force_scale, BYTE force_palette) {
	(void)scale; (void)filter; (void)shader; (void)fullscreen;
	(void)palette; (void)force_scale; (void)force_palette;
}
void gfx_draw_screen(BYTE nidx) { (void)nidx; }
BYTE gfx_palette_init(void) { return (EXIT_OK); }
void gfx_cursor_init(void) {}
void gfx_cursor_set(void) {}
void gfx_ppu_thread_lock(void) {}
void gfx_ppu_thread_unlock(void) {}
void gfx_thread_pause(void) {}
void gfx_thread_continue(void) {}

/* monitor / fullscreen-resolution machinery — unused headless */
void gfx_monitor_init(void) {}
void gfx_monitor_quit(void) {}
BYTE gfx_monitor_restore_res(void) { return (EXIT_OK); }
BYTE gfx_monitor_set_res(int w, int h, BYTE adaptive_rrate, BYTE change_rom_mode) {
	(void)w; (void)h; (void)adaptive_rrate; (void)change_rom_mode;
	return (EXIT_OK);
}
