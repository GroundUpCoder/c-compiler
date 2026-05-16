/*
 * sys_sdl.c — SDL-based system driver for the C-to-WASM Quake port.
 *
 * Written from scratch for this port (not imported from upstream).
 * Replaces upstream's sys_null.c / sys_linux.c / sys_win.c.
 *
 * Three things this provides:
 *   1. Real time via SDL_GetTicks (Sys_FloatTime returns seconds since
 *      first call).
 *   2. main() that boots Quake then hands control to the browser's
 *      requestAnimationFrame loop via emscripten_set_main_loop, which
 *      our libc routes through __sdl_set_animation_frame_func.
 *   3. The exact file I/O block from sys_null.c, byte-for-byte
 *      (fopen/fread/fwrite/fseek/ftell). Quake's PAK files are loaded
 *      through these; the libc backs onto real fs in Node and on the
 *      pre-mounted browser FS in the browser host.
 *
 * Sys_SendKeyEvents lives in in_sdl.c (it pumps the SDL event queue
 * into Quake's Key_Event callbacks), which keeps the input concern
 * out of this file.
 */
#include "quakedef.h"
#include "errno.h"

#include <SDL.h>
#include <emscripten.h>

qboolean isDedicated;

// Pre-allocated heap for Quake. main() points parms.membase here.
// Stays > MINIMUM_MEMORY (5.5 MB) so Host_Init doesn't bail.
#define QUAKE_MEMSIZE  (8 * 1024 * 1024)

// COM_LoadPackFile uses a `dpackfile_t info[2048]` local — 128 KB on
// the stack. Default WASM stack is 64 KB; bump it. (See README's
// "Modifications from upstream" / -Wlarge-stack-frame for the story.)
__minstack(2 * 1024 * 1024);

/*
===============================================================================
FILE IO  (verbatim from upstream sys_null.c — nothing target-specific)
===============================================================================
*/

#define MAX_HANDLES             10
FILE    *sys_handles[MAX_HANDLES];

int findhandle (void)
{
	int i;
	for (i = 1; i < MAX_HANDLES; i++)
		if (!sys_handles[i])
			return i;
	Sys_Error ("out of handles");
	return -1;
}

int filelength (FILE *f)
{
	int pos, end;
	pos = ftell (f);
	fseek (f, 0, SEEK_END);
	end = ftell (f);
	fseek (f, pos, SEEK_SET);
	return end;
}

int Sys_FileOpenRead (char *path, int *hndl)
{
	FILE *f;
	int   i = findhandle ();
	f = fopen(path, "rb");
	if (!f) { *hndl = -1; return -1; }
	sys_handles[i] = f;
	*hndl = i;
	return filelength(f);
}

int Sys_FileOpenWrite (char *path)
{
	FILE *f;
	int   i = findhandle ();
	f = fopen(path, "wb");
	if (!f) Sys_Error ("Error opening %s: %s", path, strerror(errno));
	sys_handles[i] = f;
	return i;
}

void Sys_FileClose (int handle)
{
	fclose (sys_handles[handle]);
	sys_handles[handle] = NULL;
}

void Sys_FileSeek (int handle, int position)
{
	fseek (sys_handles[handle], position, SEEK_SET);
}

int Sys_FileRead (int handle, void *dest, int count)
{
	return fread (dest, 1, count, sys_handles[handle]);
}

int Sys_FileWrite (int handle, void *data, int count)
{
	return fwrite (data, 1, count, sys_handles[handle]);
}

int Sys_FileTime (char *path)
{
	FILE *f = fopen(path, "rb");
	if (f) { fclose(f); return 1; }
	return -1;
}

void Sys_mkdir (char *path) { (void)path; }

/*
===============================================================================
SYSTEM IO
===============================================================================
*/

void Sys_MakeCodeWriteable (unsigned long startaddr, unsigned long length)
{
	(void)startaddr; (void)length;
}

void Sys_Error (char *error, ...)
{
	va_list argptr;
	printf ("Sys_Error: ");
	va_start (argptr, error);
	vprintf (error, argptr);
	va_end (argptr);
	printf ("\n");
	exit (1);
}

void Sys_Printf (char *fmt, ...)
{
	va_list argptr;
	va_start (argptr, fmt);
	vprintf (fmt, argptr);
	va_end (argptr);
}

void Sys_Quit (void)
{
	exit (0);
}

// SDL_GetTicks returns milliseconds since SDL_Init. We subtract the
// value captured the first time Sys_FloatTime is called so the result
// starts near 0 (Quake uses absolute time deltas, but starting at 0
// avoids float-precision drift in long sessions).
double Sys_FloatTime (void)
{
	static int initialized = 0;
	static unsigned int t0;
	unsigned int now = SDL_GetTicks();
	if (!initialized) { t0 = now; initialized = 1; }
	return (double)(now - t0) / 1000.0;
}

char *Sys_ConsoleInput (void) { return NULL; }

void Sys_Sleep (void) {}

void Sys_HighFPPrecision (void) {}
void Sys_LowFPPrecision (void) {}

/*
===============================================================================
MAIN LOOP — single-frame tick driven by the browser's requestAnimationFrame
===============================================================================
*/

// Set during main(); reused by host_frame_tick to compute dt.
static double last_frame_time;

static void host_frame_tick (void)
{
	double now = Sys_FloatTime ();
	double dt  = now - last_frame_time;
	last_frame_time = now;

	// Clamp dt to avoid huge time jumps after tab-backgrounding etc.
	// Quake's physics behave badly with dt > ~0.2s.
	if (dt < 0.0) dt = 0.0;
	if (dt > 0.2) dt = 0.2;

	Host_Frame ((float)dt);
}

int main (int argc, char **argv)
{
	static quakeparms_t parms;

	parms.memsize = QUAKE_MEMSIZE;
	parms.membase = malloc (parms.memsize);
	parms.basedir = ".";

	COM_InitArgv (argc, argv);
	parms.argc = com_argc;
	parms.argv = com_argv;

	Sys_Printf ("Host_Init\n");
	Host_Init (&parms);

	// Hand control to the rAF-driven main loop. Returns immediately;
	// the loop runs forever (or until Sys_Quit calls exit()).
	last_frame_time = Sys_FloatTime ();
	emscripten_set_main_loop (host_frame_tick, 0, 1);

	return 0;
}
