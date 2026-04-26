# c-compiler

Single-file C-to-WebAssembly compilers. Two implementations:

1. **compiler.js** (14K lines) — JavaScript, runs on Node.js
2. **compiler.cc** (19K lines) — C++20

Both compile C code to WASM. There are two ways to run the output:

### WASM files (`.wasm`) — run with Node.js

Compile to a `.wasm` file and run it with **host.js**, the WASM runtime that provides libc and filesystem support:

```bash
node compiler.js hello.c -o hello.wasm
node host.js hello.wasm
```

### HTML files (`.html`) — run in a browser

Compile to a self-contained `.html` file with everything embedded (WASM binary, runtime, data files). Runs in a browser with full SDL, graphics, and audio support:

```bash
node compiler.js hello.c -o hello.html

# With embedded data files (accessible via fopen in C)
node compiler.js game.c --opfs-file data/level.dat:/level.dat -o game.html
```

### Other flags

```bash
# Old C compatibility (K&R functions, implicit int, implicit function declarations)
node compiler.js legacy.c --allow-old-c -o legacy.wasm
```

### Compiler flags

| Flag | Description |
|------|-------------|
| `-o <file>` | Output file (`.wasm` or `.html`) |
| `-D<name>[=val]` | Define preprocessor macro |
| `-I<path>` | Add include search path |
| `-a <action>` | Stop at stage: `lex`, `parse`, `link`, `compile` |
| `--opfs-file <src:dest>` | Embed file in HTML output |
| `--run-arg <arg>` | Pass argument to program's argv |
| `--gc-sections` | Remove unused code sections |
| `--allow-old-c` | Enable all legacy C compatibility flags |
| `--time-report` | Print compilation timing breakdown |

## Vendored projects

The compiler is tested against real-world C projects:

- **Lua 5.5.0** — Full interpreter, compiles and passes the official test suite
- **DOOM** — doomgeneric port with Nuked-OPL3 music synthesis, runs in the browser

### Building DOOM

```bash
node compiler.js vendor/doom/src/*.c vendor/doom/Nuked-OPL3/*.c \
  -Ivendor/doom/Nuked-OPL3 \
  --opfs-file vendor/doom/data/doom1.wad:/doom1.wad \
  -o build/doom.html
```

The output is a single HTML file (~7MB) with everything embedded. Serve with the included server:

```bash
node serve.js
# Open http://localhost:8080/doom.html
```

`serve.js` adds COOP/COEP headers needed for audio (`SharedArrayBuffer`). Any HTTP server works for rendering, but without those headers DOOM runs silently. `serve.js` takes optional args: `node serve.js [dir] [port]` (defaults: `build/`, `8080`).

## Tests

```bash
python3 tests/run.py                                 # Unit tests, JS compiler (default)
python3 tests/run.py --all                           # Everything, both compilers
python3 tests/run.py --types=unit,extra              # Multiple categories
python3 tests/run.py --types=equiv --compiler=all   # JS vs C++ equivalence
python3 tests/run.py --types=lua                     # Lua test suite
python3 tests/run.py --compiler=cc                   # Use C++ compiler
python3 tests/run.py --filter=struct                 # Filter by name
```

Test categories:
- **unit** — Core C language features (compile + run, check stdout)
- **extra** — Additional compile + run tests
- **equiv** — Verify JS and C++ compilers produce identical output
- **lua** — Compile the Lua VM and run the official Lua test suite
