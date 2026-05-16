# Quake

The original Quake (1996) software-rendered single-player engine, ported
to compile under our C-to-WASM compiler.

- **Source**: https://github.com/id-Software/Quake (WinQuake subset)
- **License**: GPL v2 (see `gnu.txt`)
- **Renderer**: software (no OpenGL); 320×200 8-bit palette framebuffer

## Status

Compiles cleanly (~1.3 MB of WASM, 67 .c files, with `--allow-old-c`).
With `data/id1/pak0.pak` mounted, the engine **fully boots and plays
the attract-mode demos**:

```
$ cd vendor/quake/data
$ node --experimental-wasm-exnref ../../../host.js /tmp/quake.wasm
Host_Init
Added packfile ./id1/pak0.pak (339 files)
Playing shareware version.
Console initialized.
8.0 megabyte heap
========Quake Initialized=========
execing quake.rc / default.cfg
3 demo(s) in loop
Playing demo from demo1.dem.
the Necropolis
You got the shells
You got the Rocket Launcher
...
```

Three real game maps load (E1M3 Necropolis, E1M4 Grisly Grotto,
E1M6 Door to Chthon), 89 models, item pickups simulate correctly,
demo playback runs the player AI. Headless — the software renderer
is writing to `vid_buffer[]` in `vid_null.c`, which is never flushed
to a display. The platform layer (`vid_sdl.c` / `sys_sdl.c` / `in_sdl.c`) is now in
place, and `tests/browser/` contains a Playwright runner that boots
the engine in headless Chromium and screenshots the canvas. After
~3 seconds of real time, the test sees 252,428 of 256,000 pixels as
non-black (98.6%) — the classic Quake 1.09 boot console renders
correctly. See `tests/browser/README.md` for how to run it.

## Layout

- `src/` — Quake C sources + headers, copied from WinQuake/
- `data/id1/pak0.pak` — shareware game data (id Software, redistributable)
- `data/SHAREWARE-LICENSE.txt` — id's end-user license for the shareware data
- `data/LICENSE-INFO.txt` — id's license info notice
- `data/PROVENANCE.md` — where the data came from, SHA-256, license quote
- `gnu.txt` — id's GPL-2.0 license text (covers the engine source only)

The engine source (`src/`) and the data (`data/`) are under **different
licenses**. The source is GPL-2.0 (covered by `gnu.txt`); the data is
id Software's proprietary shareware content, freely redistributable
under the terms in `data/SHAREWARE-LICENSE.txt`. See `data/PROVENANCE.md`
for the full license quote.

## Excluded from upstream

A first commit imported a curated subset; everything not listed in
`Makefile.linuxi386`'s `SQUAKE_OBJS` was dropped, plus a few more:

- All `.s` files (DOS x86 assembly). `quakedef.h` defines `id386=0` on
  non-`__i386__` targets and the C fallbacks in `nonintel.c` / the
  various `d_*.c`/`r_*.c` files take over.
- All `gl_*.c` (GL renderer)
- All platform variants except the `*_null.c` stubs:
  `sys_dos.c`, `sys_linux.c`, `sys_sun.c`, `sys_win.c`, `sys_wind.c`,
  `vid_win.c`, `vid_x.c`, `vid_dos.c`, `vid_svgalib.c`, `vid_sunx*.c`,
  `vid_vga.c`, `vid_ext.c`,
  `in_dos.c`, `in_sun.c`, `in_win.c`,
  `snd_dma.c`, `snd_mem.c`, `snd_mix.c`,
  `snd_dos.c`, `snd_gus.c`, `snd_linux.c`, `snd_next.c`, `snd_sun.c`,
  `snd_win.c`,
  `cd_audio.c`, `cd_linux.c`, `cd_win.c`,
  `net_dgrm.c`, `net_udp.c`, `net_bsd.c`, `net_bw.c`, `net_comx.c`,
  `net_dos.c`, `net_ipx.c`, `net_mp.c`, `net_ser.c`, `net_win.c`,
  `net_wins.c`, `net_wipx.c`, `net_wso.c`
- `QW/`, `qw-qc/`, batch files, `readme.txt`

## Modifications from upstream

All in-place edits are tagged `// PATCH:` in the source so they're
easy to grep. Files fall into three buckets:

- **Added** (new files for this port, written from scratch):
  `vid_sdl.c`, `sys_sdl.c`, `in_sdl.c` — see "Added files" below.
- **Changed** (upstream files with `// PATCH:` edits):
  `chase.c`, `net.h`, `net_main.c`, `quakedef.h` — see "Changed files".
- **Removed** (upstream files dropped or superseded):
  `sys_null.c`, `vid_null.c`, `in_null.c` (replaced by the SDL versions
  above); the various other upstream platform variants were never
  imported in the first place (see "Excluded from upstream" earlier).

## Added files

### `vid_sdl.c`

SDL video driver. Creates a 320×200 SDL window, keeps a 256-entry RGBA
LUT in sync with Quake's palette via `VID_SetPalette`/`VID_ShiftPalette`,
and `VID_Update` translates the 8-bit `vid_buffer[]` framebuffer
through the LUT into the window's RGBA32 surface, then calls
`SDL_UpdateWindowSurface` to flush. CSS scales the canvas for display;
the bitmap stays native resolution. Stubs `D_BeginDirectRect` /
`D_EndDirectRect` (the pause/disk icons).

### `sys_sdl.c`

SDL-based system driver. Three concerns:

1. **Time**: `Sys_FloatTime` returns seconds since the first call, via
   `SDL_GetTicks` deltas (replaces the upstream synthetic +0.1s
   stepping).
2. **Main loop**: `main()` calls `Host_Init` then hands control to
   `emscripten_set_main_loop(host_frame_tick, 0, 1)` — which our libc
   routes to `__sdl_set_animation_frame_func`, so the browser drives
   frames via `requestAnimationFrame` and `host_frame_tick` computes
   the dt and calls `Host_Frame`.
3. **File I/O**: the `Sys_File*` block is the same code that was in
   `sys_null.c` (libc-backed fopen/fread/fwrite/fseek). This works
   directly against Node's real `fs` and against the OPFS-mounted
   filesystem in the browser.

Also defines `qboolean isDedicated` and applies `__minstack(2 MB)` so
`COM_LoadPackFile`'s 128 KB stack frame fits.

### `in_sdl.c`

SDL-based input driver. `Sys_SendKeyEvents` drains the SDL event queue
via `SDL_PollEvent`, translates keysyms to Quake's `K_*` codes via
`sdlk_to_quakekey`, and dispatches: keyboard → `Key_Event`, mouse motion
→ accumulated delta consumed by `IN_Move`, mouse buttons → `K_MOUSE1`/2/3,
wheel → `K_MWHEELUP`/`K_MWHEELDOWN`. The mouse-look cvars
(`sensitivity`, `m_pitch`, `m_yaw`, etc.) are defined and registered in
upstream's `cl_main.c`; we just extern them.

## Changed files

### `chase.c`

Added a forward declaration for `SV_RecursiveHullCheck`. id defined the
function in `world.c` but never declared it in any header, so the call
at `chase.c:55` relied on gcc's implicit-int-return rule for undeclared
functions. Our compiler rejects the call (arg types don't match the
real `(hull_t*, int, float, float, vec3_t, vec3_t, trace_t*)` signature)
without a real prototype.

`gl_test.c` has the same issue but is excluded from the software build.

### `net.h`

Tightened `void (*procedure)();` (K&R "unspecified params") to
`void (*procedure)(void *);`.

Upstream is internally inconsistent: the call site `net_main.c:953`
passes `pp->arg` (one arg), but the actual procedures `Slist_Send` /
`Slist_Poll` are defined `(void)` (zero args). On 1996 x86 with
caller-cleanup calling conventions the extra arg is harmless stack
garbage; WASM `call_indirect` is type-strict and the signature
mismatch produces a stack-imbalance error.

### `net_main.c`

To match the new `net.h` pointer type, both `Slist_Send` and
`Slist_Poll` now take `void *unused` (forward decls and definitions).
The bodies never read the parameter.

### `sys_null.c` *(removed; superseded by added `sys_sdl.c`)*

Replaced wholesale by `sys_sdl.c` (see below). The earlier port iterations
kept `sys_null.c` with three patches (adding `qboolean isDedicated`,
changing `void main` → `int main`, adding `__minstack(2 MB)`); those
fixes are now folded into the new file's main entry point and its
`isDedicated` definition, with a more thorough `Sys_FloatTime` based
on `SDL_GetTicks` instead of synthetic 0.1s steps.

### `quakedef.h`

Added one `#define`:

```c
#define vsprintf(buf, fmt, ap) vsnprintf((buf), 0x7FFFFFFF, (fmt), (ap))
```

Our libc deliberately doesn't implement `vsprintf` — it's unbounded
and a known footgun. Quake uses it in ~12 places with fixed-size stack
buffers (commonly `char[1024]`) where the author asserted by hand that
the output fits. The macro redirects to `vsnprintf` with a huge bound,
preserving upstream behavior in practice (the buffers really are big
enough for the format strings used) without leaving an unsafe symbol
in the libc.

## Building

```sh
cd vendor/quake/src
node ../../../compiler.js --allow-old-c -I. -o /tmp/quake.wasm *.c
```

`--allow-old-c` enables implicit-int, K&R-style definitions,
implicit-function-decl, and empty-params — all of which mid-90s id code
relies on heavily.

## Next steps (not yet done)

- Write a `bin.json` for the projects test runner.
- Replace `sys_null.c` with a custom `sys_wasm.c` that:
  - Returns real time (`Sys_FloatTime`)
  - Reads keyboard input from the host
  - Routes Quake's PAK files through OPFS or an `--opfs-file` mount
- Write a `vid_wasm.c` that flushes the 320×200 byte framebuffer to a
  canvas (palette-expand via `d_8to24table`).
- Wire `--opfs-file data/id1/pak0.pak:/id1/pak0.pak` to a shareware
  `pak0.pak` from id's old FTP / Internet Archive.
