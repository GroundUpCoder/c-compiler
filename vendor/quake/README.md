# Quake

The original Quake (1996) software-rendered single-player engine, ported
to compile under our C-to-WASM compiler.

- **Source**: https://github.com/id-Software/Quake (WinQuake subset)
- **License**: GPL v2 (see `gnu.txt`)
- **Renderer**: software (no OpenGL); 320×200 8-bit palette framebuffer

## Status

Compiles cleanly (~1.3 MB of WASM, 67 .c files, with `--allow-old-c`).
At runtime: `Host_Init` completes, the engine correctly detects no
game data, prints "Playing shareware version", then exits via
`Sys_Error: W_LoadWadFile: couldn't load gfx.wad`. From here on, every
remaining failure is **runtime plumbing** (mount `id1/pak0.pak`,
write a real `sys_wasm.c`/`vid_wasm.c`, framebuffer→canvas), not
compiler or libc work.

## Layout

- `src/` — Quake C sources + headers, copied from WinQuake/
- `gnu.txt` — id's GPL-2.0 license text (copied verbatim)

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

All edits are tagged `// PATCH:` in the source so they're easy to grep.
Five files differ from the byte-for-byte upstream import.

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

### `sys_null.c`

Three changes:

1. Added `qboolean isDedicated;`. `quakedef.h:324` declares it
   `extern`, and every real platform driver (`sys_linux.c`, `sys_win.c`,
   etc.) provides the definition — the null driver upstream is
   incomplete and won't link without it.
2. Changed `void main(int, char **)` to `int main(int, char **)` with
   an unreachable `return 0;` at the end. The `void main` form is
   non-standard (C89/C99 §5.1.2.2.1 requires `int`); gcc accepts it
   with `-Wmain-return-type` warning, our compiler is stricter.
3. Added `__minstack(2 * 1024 * 1024);` directive. `COM_LoadPackFile`
   puts a `dpackfile_t info[2048]` (128 KB) on the stack, and several
   other Quake functions allocate similarly chunky locals. Our default
   WASM stack is one 64 KB page; without this, the local array
   silently underflows into linear-memory zero and the next libc call
   (typically `fopen`) traps with "memory access out of bounds." 2 MB
   is generous headroom that mirrors a modern Unix default stack.

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
