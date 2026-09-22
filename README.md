# c-compiler

A C-to-WebAssembly compiler in one JavaScript file, with a runtime for Node.js
and browsers. The repository also contains **gucOS**, an almost-POSIX browser OS
built around the compiler: a shell, persistent filesystem, desktop, window
manager, and tools for developing C/SDL3 games inside the OS.

I occasionally post videos about this project at
[youtube.com/@groundupcoder](https://www.youtube.com/@groundupcoder) — design
decisions, problems I've hit, and parts of the implementation I find interesting.
This repo isn't structured as a tutorial; it's the actual code I'm writing as I go.

## Start here

Use **Node.js 25+**, or **Node.js 24 with `--experimental-wasm-jspi`** when
running compiled programs. The compiler and console runtime need no npm install
or native build. See [Node compatibility](docs/NODE_VERSIONS.md) for the measured
version matrix and cross-compiling on older Node releases.

From the repository root:

```sh
node compiler.js vendor/hello/main.c -o hello.wasm
node host.js hello.wasm
# Hello world
```

On Node 24, the run command is:

```sh
node --experimental-wasm-jspi host.js hello.wasm
```

`compiler.js` contains the compiler, builtin headers, and C library sources.
`host.js` supplies the host operations that the compiled program imports.
The emitted modules use this project's C ABI; they are **not WASI binaries**.

## Choose how to run

| Output / environment | How it runs | Files and graphics |
|---|---|---|
| `.wasm` + `host.js` | Node runs a separate Wasm module | Host filesystem; supply assets separately. Optional native SDL3/WebGPU addon. |
| `.js` | Node runs an embedded Wasm module and runtime | Can bundle assets; native graphics libraries remain external. |
| `.html` | Browser runs an embedded Wasm module and runtime | BlockFS on OPFS; can bundle assets. Browser graphics/audio backends. |
| gucOS | Browser desktop or headless Node boot | Kernel-managed processes and filesystems, packages, windows, and in-OS `cc`. |

### Native SDL3 and WebGPU on Node

Build the optional addon once, then compile and run Doom:

```sh
node native/build.js
node compiler.js vendor/doom/bin.json -o doom.wasm
node host.js doom.wasm -iwad vendor/doom/data/doom1.wad
```

The default `--sdl=auto` loads the addon when available. Pass `--sdl=native` to
`host.js` to require it, or `--sdl=null` for explicit headless simulation.
Without the addon, console programs still work; SDL device initialization and
WebGPU adapter requests report unavailable.

The addon uses SDL3 and wgpu-native, and needs a C compiler, CMake, and downloaded
dependencies to build. macOS arm64 has been exercised; macOS x64 and Linux
arm64/x64 build targets are provided but unverified here. Windows builds are
not implemented. It implements this compiler's SDL3/WebGPU surface, not the
entire upstream APIs. Device availability still depends on the host.
See [native setup, distribution, and tests](native/README.md).

### Standalone Node scripts

```sh
node compiler.js vendor/hello/main.c -o hello.js
node hello.js

# Bundle Doom's WAD with the runtime and Wasm:
node compiler.js vendor/doom/bin.json -o doom.js
node doom.js
```

Generated `.js` files need no separate `host.js`. When assets are embedded, the
script extracts them to a temporary directory, runs with that directory as its
working directory, and removes it on exit. Files written there, including game
saves, are temporary too. Use raw `.wasm` plus separately supplied assets when
you want control over the working directory and persistent files.

For generated scripts, select `--sdl=auto|native|null` **at compile time**.
Copy the optional native libraries alongside the script using the layout in
[native/README.md](native/README.md) when distributing graphical programs.

### Browser pages

```sh
node compiler.js vendor/doom/bin.json -o doom.html
node serve.js doom.html
# Open the URL printed by the server.
```

HTML output embeds the Wasm, runtime, project data, and terminal widget when
available. Serve it over localhost or HTTPS. Browser capabilities determine
which programs run: Wasm GC is required, GPU rendering needs WebGPU, and audio
uses SharedArrayBuffer and a user gesture. `serve.js` supplies the COOP/COEP
headers needed for cross-origin isolation. The browser runtime includes paths
that do not require JSPI; the Node requirement above is not a blanket browser
requirement.

`node serve.js [directory-or-file] [port]` defaults to `build/` and port `8080`.
Serving an individual HTML file avoids the OS image preparation done when
serving the repository root.

## What is supported

The compiler advertises C11, with earlier-C compatibility options and selected
newer-C, GNU, and custom Wasm extensions. It is under active development, not a
claim of complete C or POSIX conformance. Variable-length arrays, complex
arithmetic, C atomics, and C threads are explicitly unsupported. It does not
compile C++ or Objective-C.

The bundled library includes common C headers, allocation and string functions,
formatted I/O, files, math, time, terminal control, and I/O multiplexing. Host
capabilities differ: gucOS provides the process/kernel services; a standalone
`host.js` invocation does not boot that kernel.

- **SDL3:** windows, surfaces, 2D rendering, textures, events, audio streams,
  and additional helpers. See the [API index](os/doc/sdl-api-index.md) and
  [SDL3 scope](docs/SDL3.md). This is a subset, not SDL2 compatibility.
- **WebGPU:** C bindings through `webgpu.h`, rendering and compute, and the
  SDL window/surface bridge. Use `wgpuSetMainLoopCallback` to drive asynchronous
  GPU completions. See [WebGPU architecture](docs/WEBGPU.md).
- **Game loops:** SDL callback applications use `SDL_MAIN_USE_CALLBACKS`.
  gucOS GPU presentation requires a yielding callback loop; its explicit
  software renderer supports blocking loops. See [SDL on gucOS](os/doc/sdl-gucos.md).
- **Wasm extensions:** GC structs/arrays, opaque host references, custom
  imports, and host callbacks. These extend C; they are not portable C syntax.

For example, GC struct values use the reference form `__struct Point *`, while
allocation and cast/test type arguments use the heap form `__struct Point`:

```c
#include <stdio.h>

__struct Point { int x; int y; };

int main(void) {
    __struct Point *p = __new(__struct Point, 3, 7);
    __array(int) values = __array_of(int, 10, 20, 30);
    printf("%d %d\n", p->x, values[1]);
    return 0;
}
```

See [Wasm GC](docs/WASM_GC.md), [reference types](docs/EXTERNREF.md), and
[callback ABI](docs/CALLBACKS.md) for the full syntax and constraints.

## Building projects

One invocation compiles and links all sources into a module. There is no
GCC-style object-file/archive workflow. JSON project inputs expand dependencies,
include paths, compiler options, sources, assets, and embedded run arguments:

```sh
node compiler.js vendor/lua/bin.json -o lua.wasm
node host.js lua.wasm -e 'print(1 + 2)'
node compiler.js -DMY_FEATURE app/bin.json extra.c -o app.wasm
```

A binary project can look like this (paths are relative to the JSON file):

```json
{
  "type": "bin",
  "name": "game",
  "deps": ["../vendor/zlib/lib.json"],
  "includes": ["include"],
  "compilerArgs": ["-DNDEBUG"],
  "sources": ["main.c", "game.c"],
  "dataFiles": {"data/level.dat": "/level.dat"},
  "runArgs": ["level.dat"]
}
```

`type` defaults to `bin`. A `"type": "lib"` project must be included through
`deps`, rather than compiled directly. Shared dependencies are included once.
`srcRoots` can map source namespaces to directories for `__require_source`.

`dataFiles` and `runArgs` are embedded in **`.js` and `.html` output only**.
For raw `.wasm`, supply files through the runtime filesystem and pass arguments
after the Wasm path. The CLI still checks that project data files exist while
expanding the project, even for `.wasm` output.

### Useful compiler options

Run `node compiler.js --help` for the command-line overview.

| Option | Purpose |
|---|---|
| `-o FILE` | Output `.wasm`, `.js`, or `.html`; default `a.wasm` |
| `-Ipath`, `-DNAME[=value]` | Include search path and preprocessor definitions |
| `-g`, `-g1`, `-g2` | Function names/source locations; `-g2` also embeds source text |
| `-fno-inline` | Disable inlining, independently of debug metadata |
| `--trap-null-dereference` | Opt-in null-access diagnostics |
| `--gc-sections` | Remove unreachable functions |
| `--require-source FILE`, `--srcroot NS=DIR` | Add a source or register a source namespace |
| `--opfs-file SRC:DEST`, `--run-arg ARG` | Bundle an asset or argument in `.js`/`.html` output |
| `--sdl=auto\|native\|null` | Backend selection for generated Node `.js` output |
| `--no-xterm` | Omit the terminal widget from HTML output |
| `--allow-old-c` | Enable legacy declaration compatibility options |
| `--no-wasm-validate` | Cross-compile without the local engine's Wasm validation |
| `-a lex\|parse\|link\|cfg\|print\|compile` | Select a compiler action |
| `--time-report`, `-v` | Compilation timings and verbose diagnostics |

Unsupported flags are errors: `-O2`, `-Wall`, `-c`, `-std=...`, and `-l...` are
not implemented. The in-OS `cc` frontend has a smaller CLI and does not accept
these host JSON projects; see [the in-OS toolchain guide](os/doc/toolchain.md).

## gucOS

```sh
node serve.js .
# Open the printed /os/os.html URL.

# Or boot the same OS headlessly, with its tty on stdio:
echo 'ls / | cat' | node os/boot.js
```

The browser desktop requires WebGPU in a worker and cross-origin isolation.
The dev server prepares a system image when needed, so the first start can take
time. Headless boot does not open native SDL windows: it uses kernel surfaces,
with optional GPU readback through the separate npm Dawn (`webgpu`) tier.
Headless boot is silent by design.

The OS includes BusyBox hush and coreutils, pipes, job control, terminals,
a desktop/window manager, Notepad, and the `cc` compiler. BlockFS provides a
persistent writable root and a sealed read-only `/usr`; `/usr/local` routes to
writable storage. Process creation uses `posix_spawn`, not faithful `fork/exec`.
The kernel and its processes run in separate workers.

Packages are managed by `gucman`. `os/image.json` is the authority for the base
image and default packages; `packages/` holds package definitions. Development
boots normally fold optional packages into the image. `serve.js --minimal .`
serves the minimal-image shape, where optional applications are installed from
the separately built package repository. If a sibling `gucos-packages` checkout
is discovered, the server checks package-index coverage; `--no-extra-packages`
explicitly selects only this repository's definitions.

Start with the [in-OS developer guide](os/doc/README.md) for writing, building,
debugging, and packaging programs. [OS architecture](docs/OS.md),
[kernel](docs/KERNEL.md), [window manager](docs/WM.md), and
[networking](docs/NETWORK.md) describe the implementation and its boundaries.
The current primary goal is [C/SDL3 game development inside gucOS](docs/GAMEDEV-EPIC.md),
including the gcode agent workflow.

## Repository map

| Path | Role |
|---|---|
| `compiler.js` | Compiler, builtin headers/libc, source linking, output packaging |
| `host.js` | Per-program runtime, host adapters, BlockFS/MountFS, graphics/audio |
| `kernel.js` | Process control, kernel-owned files, IPC, tty, surfaces, and input |
| `native/` | Optional standalone Node SDL3/wgpu-native addon |
| `os/` | gucOS boot frontends, userland, window manager, and image manifest |
| `packages/` | Optional application/library package definitions |
| `vendor/` | Ported third-party sources and assets, with per-project licenses |
| `tests/` | Compiler, runtime, filesystem, native, and OS/browser validation |
| `tools/` | Image/package builders, diagnostics, and maintenance tools |
| `docs/`, `logs/` | Designs and reference docs; engineering history |
| `old/` | Frozen experiments, including the C++ compiler and Objective-C snapshot |

Vendored projects include Doom, Quake, Game Boy emulators, Lua, MicroPython,
SQLite, QuickJS, TinyEMU, NetSurf, and libraries such as zlib, libpng, FreeType,
and Cairo. Presence under `vendor/` does not imply complete upstream support
or inclusion in every OS image; consult the port's README and project/package
definitions. Optional `*-clang` packages use a separate sibling toolchain.

QuickJS can be built and run with
`node compiler.js vendor/quickjs/bin.json -o qjs.wasm` and
`node host.js qjs.wasm -e 'console.log(1 + 1)'`.
The [self-hosting experiment](old/self-host/) is archived; its historical
bootstrap results are not a current-tree equivalence guarantee. Likewise,
`old/compiler.cc` is a frozen C++ port, not a second maintained compiler.
Rust/WASI and self-service (`ss`) execution support are retired; C's Wasm
GC/reference extensions remain supported.

## Tests and development

`tests/run.js` is the unified dispatcher and the authority for which suites a
diff needs. Start small and use the mapped gate for changes:

```sh
node tests/run.js --list
node tests/run.js unit
node tests/run.js --diff --dry-run
node tests/run.js --diff
node tests/run.js smoke
node tests/run.js full
```

`smoke` is a subset; `full` is the unfiltered ship gate and refuses filtered or
resumed runs. Results and scope are recorded under `build/test-run/`. A source
or documentation inspection is not evidence that the full gate passed.

Python-backed suites use the interpreter pinned by `.python-version`; prepare
it with `uv venv`. Browser suites require the pinned packages and Chromium:

```sh
pnpm --dir tests/browser install --frozen-lockfile
pnpm --dir tests/browser exec playwright install chromium
```

The root npm `webgpu` dependency is for the optional headless gucOS GPU tier;
it is separate from the native addon above. Native integration checks are also
available directly:

```sh
node tests/native/run.js               # explicitly reports absent optional tiers
node tests/native/sdl.js               # requires the native build
node tests/native/webgpu.js            # requires native WebGPU; real offscreen GPU
node tests/native/webgpu.js --surfaces # window/surface lifecycle
```

Read [CLAUDE.md](CLAUDE.md) for repository rules, prerequisites, test gates,
and ticket workflow; it applies to all contributors and agents despite its
filename. [The documentation index](docs/README.md) separates current guides,
design proposals, and historical records.

## Contributing and license

Bug reports and questions are welcome. Please discuss non-trivial contributions
in an issue first; see [CONTRIBUTING.md](CONTRIBUTING.md).

The project is licensed under [Apache License 2.0](LICENSE). Vendored projects
and redistributed native dependencies retain their own licenses.
