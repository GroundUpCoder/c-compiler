# FreeType + SDL Text Editor Demo

A minimal text editor that uses FreeType for glyph rasterization and SDL for
window management and pixel rendering. Runs in the browser (Canvas) or
natively (via `@kmamal/sdl`). The font is Roboto Mono (shared with `demo/`).

## Building

```bash
# Browser (self-contained HTML, embeds font via dataFiles)
node compiler.js vendor/freetype/sdl-demo/bin.json -o build/freetype-editor.html

# Node.js (requires @kmamal/sdl installed)
node compiler.js vendor/freetype/sdl-demo/bin.json -o build/freetype-editor.js
node --experimental-wasm-exnref build/freetype-editor.js

# Standalone WASM (font path passed as argv)
node compiler.js vendor/freetype/sdl-demo/bin.json -o build/freetype-editor.wasm
node --experimental-wasm-exnref host.js build/freetype-editor.wasm vendor/freetype/demo/robotomono.ttf
```

To serve the HTML output:

```bash
node serve.js build
# Open http://localhost:8080/freetype-editor.html
```

## Project structure

```
bin.json          Project file; uses deps to pull in ../lib.json
main.c            Editor source (~480 lines of C99)
```

The custom FreeType config headers (`ft2build.h`, `myftoption.h`,
`myftmodule.h`) live in `../demo/` and are shared between this demo and the
BMP demo. They configure FreeType for a minimal TrueType-only WASM build by
disabling bytecode hinting, variable fonts, compression, and inline assembly.

`bin.json` lists `../demo` before `../include` in `includes` so that the
custom `ft2build.h` shadows the stock one shipped with FreeType. This is the
standard FreeType integration pattern: consumers provide their own
`ft2build.h` to control which modules and options are compiled in.

## How it works

### Initialization

1. FreeType loads the TTF font and sets pixel size (22px default).
2. SDL creates an 800x600 window and returns an `SDL_Surface` with a raw
   RGBA32 pixel buffer.
3. `__setAnimationFrameFunc()` registers the frame callback, which maps to
   `requestAnimationFrame` in the browser or a polling loop in Node.js.

### Frame loop

Each frame:

1. **Event handling** -- `SDL_PollEvent` drains the keyboard event queue.
   Ctrl and Alt modifier state is tracked manually via SDLK_LCTRL/RCTRL and
   SDLK_LALT/RALT keydown/keyup events (the SDL implementation does not
   populate the `keysym.mod` field).
2. **Rendering** -- The entire text buffer is re-rendered from scratch:
   - Clear to background color.
   - Walk the text buffer, splitting into visual lines via `measure_visual_line()`
     (measures glyph advances until the line exceeds the text area width, or
     hits a newline).
   - For each visual line: render line numbers in the gutter, then render each
     glyph with FreeType's `FT_Render_Glyph` (8-bit grayscale) and alpha-blend
     onto the surface.
   - Track cursor position during the walk, draw a 2px-wide blinking bar.
   - Auto-scroll to keep the cursor visible.
3. **Flip** -- `SDL_UpdateWindowSurface` pushes the pixel buffer to the display.

### Text buffer

A flat `char[8192]` array with `memmove`-based insert/delete. Cursor is an
integer offset into the buffer. Lines are delimited by `\n`. This is simple
and fast enough for a demo but would need a gap buffer or piece table for
large documents.

### Glyph rendering

FreeType rasterizes each glyph to an 8-bit grayscale bitmap. The renderer
alpha-blends each pixel onto the RGBA32 surface:

```
result = background + alpha * (foreground - background) / 255
```

There is no glyph cache -- every glyph is rasterized every frame. For a demo
this is fine; a real editor would cache rendered glyphs in a texture atlas.

## Keyboard shortcuts

### Mouse

| Action        | Effect              |
|---------------|---------------------|
| Left click    | Place cursor        |

### Basic editing

| Key           | Action              |
|---------------|---------------------|
| Printable     | Insert character    |
| Enter         | Insert newline      |
| Backspace     | Delete backward     |
| Delete        | Delete forward      |
| Tab           | Insert 4 spaces     |
| Arrow keys    | Move cursor         |
| Home / End    | Start / end of line |

### Readline shortcuts (Ctrl)

| Shortcut | Action                    |
|----------|---------------------------|
| Ctrl+A   | Beginning of line         |
| Ctrl+E   | End of line               |
| Ctrl+B   | Back one character        |
| Ctrl+F   | Forward one character     |
| Ctrl+P   | Previous line             |
| Ctrl+N   | Next line                 |
| Ctrl+D   | Delete forward            |
| Ctrl+H   | Delete backward           |
| Ctrl+K   | Kill to end of line       |
| Ctrl+U   | Kill to beginning of line |
| Ctrl+W   | Kill word backward        |
| Ctrl+T   | Transpose characters      |

### Word navigation (Alt / Meta)

| Shortcut       | Action              |
|----------------|----------------------|
| Alt+B          | Back one word        |
| Alt+F          | Forward one word     |
| Alt+D          | Kill word forward    |
| Alt+Backspace  | Kill word backward   |

Note: Alt shortcuts may be intercepted by the browser or OS in some
environments. Home/End keys require scancodes that are not mapped in the
browser SDL backend yet, so they only work in the native backend.

## Limitations

- **ASCII only.** SDL keysyms map to ASCII character codes; Unicode input
  would require an `SDL_TEXTINPUT`-style event that the host does not
  currently provide.
- **No selection or clipboard.** There is no visual selection, copy/paste, or
  kill ring. Adding selection would pair naturally with mouse support (drag to
  select) and Shift+arrow keys.
- **No undo/redo.** Each edit mutates the buffer directly with no history.
- **No glyph cache.** Every glyph is re-rasterized every frame. Acceptable
  for a demo, but a real editor would cache bitmaps keyed by glyph index +
  font size.
- **Fixed 8KB text buffer.** The `char[8192]` array and `memmove`-based
  editing are O(n) per edit. A gap buffer or piece table would be needed for
  large documents.
- **No soft-wrap cursor movement.** Up/Down arrow keys navigate by hard lines
  (newlines), not visual lines created by soft wrapping.
