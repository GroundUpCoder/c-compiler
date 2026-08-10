# gucOS platform context

You are working inside gucOS, a small POSIX-like OS where every program is a
WebAssembly module built by the in-OS C compiler. Facts you cannot guess:

- The C compiler is `cc`. There are NO prebuilt libraries: no `-l` flags, no
  `.a` or `.so` files. Name every project source file on the command line
  (`cc main.c helper.c -o prog`) — `#include`-ing a header never links its
  implementation. Known system libraries (SDL, libpng, zlib, freetype) pull
  their own sources automatically via the compiler's `__require_source`
  mechanism when you include their headers.
- `cc` understands only `-o OUT`, `-IDIR`, `-DNAME[=VAL]` and `-g`. Every
  other flag (`-Wall`, `-O2`, `-c`, `-std=…`, `-l…`) is silently IGNORED —
  no error, no effect. There is no separate compile/link step: one `cc`
  command takes all the .c files and writes the runnable output (default
  `./a.out`, so `cc hello.c && ./a.out` works). Headers live under
  `/usr/include` (and `/usr/local/include`).
- `<SDL.h>` is a documented SUBSET of SDL3, not stock SDL3. The headers in
  `/usr/include` are the authoritative API surface — when unsure whether a
  function exists, read the header, don't assume stock SDL3. Read
  `/usr/share/doc/sdl-gucos.md` before writing SDL code.
- SDL3 graphics: a classic blocking main loop that presents GPU frames is
  refused at the second present (fatal, exit 69). Either write the program
  with `SDL_MAIN_USE_CALLBACKS` (SDL_AppInit/SDL_AppIterate/SDL_AppEvent/
  SDL_AppQuit, no main()), or run an unmodified blocking-loop program with
  `SDL_RENDER_DRIVER=software`. Details: `/usr/share/doc/sdl-gucos.md`.
- Commonly-missing SDL symbols: `SDL_Log` and `SDL_snprintf` do NOT exist —
  log with `printf`/`fprintf(stderr, ...)` and format with `snprintf`, from
  `<stdio.h>`. The `SDLK_a`…`SDLK_z` letter-key constants do NOT exist:
  `event.key.key` is the modifier-applied ASCII character, so compare a
  char literal (`event.key.key == 'r'`; Shift gives `'R'`). Physical keys
  are `SDL_SCANCODE_A`…`SDL_SCANCODE_Z` on `event.key.scancode`.
- Math functions (`sqrtf`, `fabsf`, `floorf`, `sinf`, …) need
  `#include <math.h>` — the header links the implementation automatically,
  like the other system headers. Without the include the compile fails
  with an "Undeclared identifier" error.
- `/usr` is read-only (writes fail EROFS); `/usr/local` is writable. Put
  installed binaries in `/usr/local/bin`.
- To run a windowed program and keep working, background it with its output
  in a file: `./game >/tmp/game.log 2>&1 &`. The bash tool returns as soon
  as the shell finishes; if background processes keep running you get a
  note that their further output is not captured — read the log file for
  runtime errors instead. Stop the program with `pkill NAME` (or close its
  window). A long FOREGROUND command is different: it is killed at the
  tool's time cap.
- `wmctl` observes and drives windows without pixels: `wmctl list` shows
  open windows (first column = SID, the window id), `wmctl wait win TITLE`
  blocks until a window with that title exists, `wmctl tree` dumps a
  win32 app's widgets, `wmctl shot SID FILE` screenshots a window
  (`wmctl shot screen FILE` the whole screen). Use it to verify a GUI
  program actually opened a window.
- Never run `find /` or `grep -r /`: the full-tree walk is catastrophically
  slow and cannot be interrupted. Search a specific directory instead.
