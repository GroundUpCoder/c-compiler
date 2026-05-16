/*
 * vid_sdl.c — SDL video driver for the C-to-WASM Quake port.
 *
 * Written from scratch for this port (not imported from upstream).
 * Replaces upstream's vid_null.c / vid_svgalib.c / vid_win.c.
 *
 * Quake's software renderer writes 8-bit palette indices into
 * vid_buffer[]. Each frame VID_Update is called; we translate each
 * byte through a 256-entry RGBA LUT (kept in sync via VID_SetPalette)
 * and write the result into the SDL window's RGBA32 surface, then
 * SDL_UpdateWindowSurface to flush to the canvas/display.
 *
 * Resolution is 320×200 native. The browser canvas can be CSS-scaled
 * to whatever; the bitmap stays 320×200 so we don't waste cycles on a
 * software 2× blit. In headless Node, SDL is the null stub so all
 * these calls are no-ops — Quake still runs, frames just go nowhere.
 */
#include "quakedef.h"
#include "d_local.h"

#include <SDL.h>

viddef_t	vid;				// global video state

#define	BASEWIDTH	320
#define	BASEHEIGHT	200

byte	vid_buffer[BASEWIDTH*BASEHEIGHT];
short	zbuffer[BASEWIDTH*BASEHEIGHT];
byte	surfcache[256*1024];

unsigned short	d_8to16table[256];
unsigned	d_8to24table[256];

static SDL_Window  *sdl_window;
static SDL_Surface *sdl_surface;
// 256-entry RGBA32 lookup table, in the byte order ImageData expects:
// byte 0=R, byte 1=G, byte 2=B, byte 3=A. As a little-endian Uint32:
// (A<<24)|(B<<16)|(G<<8)|R.
static Uint32 sdl_palette[256];

void VID_SetPalette (unsigned char *palette)
{
	int i;
	for (i = 0; i < 256; i++)
	{
		Uint32 r = palette[i*3 + 0];
		Uint32 g = palette[i*3 + 1];
		Uint32 b = palette[i*3 + 2];
		sdl_palette[i] = r | (g << 8) | (b << 16) | (255u << 24);
		// d_8to24table is used by other parts of the engine (lighting,
		// console glow, etc.) — Quake expects 0xAABBGGRR layout in it
		// because that's what the OpenGL upload paths assumed.
		d_8to24table[i] = (Uint32)sdl_palette[i];
	}
	// Set the fully transparent slot Quake uses for sprite alpha.
	((byte *)&d_8to24table[255])[3] = 0;
}

void VID_ShiftPalette (unsigned char *palette)
{
	// Quake calls this for damage/pickup/quad-damage tints. Easiest:
	// rebuild the LUT — VID_SetPalette is cheap (256 iterations).
	VID_SetPalette(palette);
}

void VID_Init (unsigned char *palette)
{
	vid.maxwarpwidth = vid.width = vid.conwidth = BASEWIDTH;
	vid.maxwarpheight = vid.height = vid.conheight = BASEHEIGHT;
	vid.aspect = 1.0;
	vid.numpages = 1;
	vid.colormap = host_colormap;
	vid.fullbright = 256 - LittleLong (*((int *)vid.colormap + 2048));
	vid.buffer = vid.conbuffer = vid_buffer;
	vid.rowbytes = vid.conrowbytes = BASEWIDTH;

	d_pzbuffer = zbuffer;
	D_InitCaches (surfcache, sizeof(surfcache));

	// SDL_Init may have been called already by another subsystem (sound).
	// SDL is idempotent on its own init flags, so just call it.
	SDL_Init(SDL_INIT_VIDEO);
	sdl_window = SDL_CreateWindow("Quake",
		SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
		BASEWIDTH, BASEHEIGHT,
		SDL_WINDOW_SHOWN);
	if (sdl_window)
		sdl_surface = SDL_GetWindowSurface(sdl_window);

	// Seed the palette LUT from the supplied palette so the first frame
	// shows something sensible even if VID_SetPalette isn't called again.
	VID_SetPalette(palette);
}

void VID_Shutdown (void)
{
	if (sdl_window) {
		SDL_DestroyWindow(sdl_window);
		sdl_window = NULL;
		sdl_surface = NULL;
	}
}

void VID_Update (vrect_t *rects)
{
	// rects is a list of dirty rectangles. For simplicity and because
	// 320×200×4 = 256 KB is tiny, we always blit the whole framebuffer
	// — rect tracking would buy us nothing on modern hardware.
	(void)rects;
	if (!sdl_surface) return;

	byte    *src = vid_buffer;
	Uint32  *dst = (Uint32 *)sdl_surface->pixels;
	int      n = BASEWIDTH * BASEHEIGHT;
	int      i;
	for (i = 0; i < n; i++)
		dst[i] = sdl_palette[src[i]];

	SDL_UpdateWindowSurface(sdl_window);
}

/*
 * D_BeginDirectRect / D_EndDirectRect are used by Quake to draw the
 * pause icon, save/load disk icons etc. directly onto the screen
 * outside the normal pipeline. Stubbing is fine — the worst case is
 * the icons don't show.
 */
void D_BeginDirectRect (int x, int y, byte *pbitmap, int width, int height)
{
	(void)x; (void)y; (void)pbitmap; (void)width; (void)height;
}

void D_EndDirectRect (int x, int y, int width, int height)
{
	(void)x; (void)y; (void)width; (void)height;
}
