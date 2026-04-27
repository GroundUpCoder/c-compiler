# c-compiler

Single-file C-to-WebAssembly compilers. Two implementations:

1. **compiler.js** (~14K lines) — JavaScript, runs on Node.js
2. **compiler.cc** (~19K lines) — C++20

Both compile C code to WASM and produce identical output. There are two ways to run the compiled programs:

### WASM files (`.wasm`) — run with Node.js

Compile to a `.wasm` file and run it with **host.js**, the WASM runtime that provides libc, filesystem, and terminal support:

```bash
node compiler.js hello.c -o hello.wasm
node host.js hello.wasm
```

### HTML files (`.html`) — run in a browser

Compile to a self-contained `.html` file with everything embedded (WASM binary, runtime, xterm.js terminal, data files). Runs in any modern browser with support for graphics (SDL/canvas), audio (SharedArrayBuffer), and interactive terminal programs:

```bash
node compiler.js hello.c -o hello.html
```

## Project files

Both compilers accept `project.json` files as positional arguments. A project.json expands inline as if its `compilerArgs`, `sources`, and `dataFiles` were passed directly at that position:

```bash
# These are equivalent:
node compiler.js vendor/doom/project.json -o doom.html
node compiler.js -Ivendor/doom/Nuked-OPL3 vendor/doom/src/*.c ... --opfs-file vendor/doom/data/doom1.wad:/doom1.wad -o doom.html

# Project files mix freely with explicit args:
node compiler.js -DFOO vendor/lua/project.json extra.c -o out.wasm
```

### project.json format

```json
{
  "name": "myproject",
  "description": "Optional description",
  "compilerArgs": ["-Isrc", "-DNDEBUG"],
  "sources": ["src/main.c", "src/util.c"],
  "dataFiles": {
    "data/level.dat": "/level.dat"
  }
}
```

All paths are resolved relative to the JSON file's directory. `name` and `description` are purely informational. `dataFiles` maps local files to virtual filesystem paths (used for HTML output via OPFS).

## Compiler flags

| Flag | Description |
|------|-------------|
| `-o <file>` | Output file (`.wasm` or `.html`) |
| `-D<name>[=val]` | Define preprocessor macro |
| `-I<path>` | Add include search path |
| `-a <action>` | Stop at stage: `lex`, `parse`, `link`, `compile` |
| `--opfs-file <src:dest>` | Embed data file in HTML output (accessible via `fopen`) |
| `--run-arg <arg>` | Pass argument to program's `argv` |
| `--gc-sections` | Remove unused code sections |
| `--no-undefined` | Error on undefined symbols |
| `--require-source <file>` | Require a source file to be present |
| `--allow-old-c` | Enable all legacy C compatibility flags |
| `--allow-implicit-int` | Allow implicit int in declarations |
| `--allow-empty-params` | Allow empty parameter lists |
| `--allow-knr-definitions` | Allow K&R-style function definitions |
| `--allow-implicit-function-decl` | Allow implicit function declarations |
| `--allow-undefined` | Allow undefined symbols |
| `--no-xterm` | Disable xterm.js terminal in HTML output |
| `--time-report` | Print compilation timing breakdown |
| `-W<name>` | Enable warning (`pointer-decay`, `circular-dependency`) |

## Standard library support

The compiler provides a built-in standard library with headers including:

- **Core**: `stdio.h`, `stdlib.h`, `string.h`, `math.h`, `stdint.h`, `stdbool.h`, `stdarg.h`, `stddef.h`, `ctype.h`, `assert.h`, `errno.h`, `limits.h`, `float.h`
- **Memory/strings**: `malloc`, `free`, `realloc`, `memcpy`, `memset`, `strlen`, `strcmp`, `sprintf`, `snprintf`, `printf`, `fprintf`
- **Files**: `fopen`, `fclose`, `fread`, `fwrite`, `fseek`, `ftell`
- **Time**: `time.h`, `clock()`, `time()`, `usleep()`, `nanosleep()`
- **Terminal**: `termios.h` (`tcgetattr`, `tcsetattr`, `cfmakeraw`), `sys/ioctl.h` (`ioctl`, `TIOCGWINSZ`)
- **I/O multiplexing**: `sys/select.h` (`select`, `FD_SET`, `FD_CLR`, `FD_ISSET`, `FD_ZERO`)
- **Graphics/Audio**: SDL2 subset (video, events, audio)

Terminal and timing primitives use JSPI (WebAssembly JavaScript Promise Integration) for async operations on both Node.js and browser backends.

## Vendored projects

The compiler is tested against real-world C projects:

- **Lua 5.5.0** — Full interpreter, compiles and passes the official test suite
- **DOOM** — doomgeneric port with Nuked-OPL3 music synthesis, runs in the browser
- **Snake** — Terminal-based snake game using termios raw mode, ANSI escape codes, and `select()` for input handling

### Building vendored projects

```bash
# Lua interpreter
node compiler.js vendor/lua/project.json -o lua.wasm
node host.js lua.wasm

# DOOM (HTML with embedded WAD)
node compiler.js vendor/doom/project.json -o doom.html

# Snake (terminal game)
node compiler.js vendor/terminal-snake/src/snake.c -o snake.html
node compiler.js vendor/terminal-snake/src/snake.c -o snake.wasm && node host.js snake.wasm
```

### Serving HTML output

```bash
node serve.js [dir] [port]   # defaults: build/, 8080
```

`serve.js` adds COOP/COEP headers needed for `SharedArrayBuffer` (used by audio). Any HTTP server works for rendering, but without those headers DOOM runs silently.

## Tests

```bash
python3 tests/run.py                                  # Unit tests, JS compiler (default)
python3 tests/run.py --all                             # Everything, both compilers
python3 tests/run.py --types=unit,extra                # Multiple categories
python3 tests/run.py --types=equiv --compiler=all      # JS vs C++ equivalence
python3 tests/run.py --types=lua                       # Lua test suite
python3 tests/run.py --compiler=cc                     # Use C++ compiler
python3 tests/run.py --filter=struct                   # Filter by name
```

Test categories:
- **unit** — Core C language features and standard library (compile + run, check stdout)
- **extra** — Additional compile + run tests
- **equiv** — Verify JS and C++ compilers produce identical output
- **lua** — Compile the Lua VM and run the official Lua test suite
