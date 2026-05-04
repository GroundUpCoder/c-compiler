# c-compiler

Single-file C-to-WebAssembly compiler.

**compiler.js** (~16K lines) — JavaScript, runs on Node.js.

A frozen C++20 port (**compiler.cc**) is preserved in `old/` along with its own test runner and unit tests. The two compilers produce identical output for all unit tests (verified by equiv tests in `old/`).

There are two ways to run the compiled programs:

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

Both compilers accept JSON project files as positional arguments. Each vendor project uses `lib.json` (for libraries) or `bin.json` (for executables). A project file expands inline as if its `compilerArgs`, `sources`, and `dataFiles` were passed directly at that position:

```bash
# These are equivalent:
node compiler.js vendor/doom/bin.json -o doom.html
node compiler.js -Ivendor/doom/Nuked-OPL3 vendor/doom/src/*.c ... --opfs-file vendor/doom/data/doom1.wad:/doom1.wad -o doom.html

# Project files mix freely with explicit args:
node compiler.js -DFOO vendor/lua/bin.json extra.c -o out.wasm
```

### Project file format

```json
{
  "type": "lib",
  "name": "mylib",
  "description": "Optional description",
  "includes": ["src"],
  "compilerArgs": ["-DNDEBUG"],
  "sources": ["src/util.c", "src/core.c"]
}
```

Libraries (`"type": "lib"`) cannot be compiled directly — they must be referenced via `deps` from a binary project. Binary projects omit `type` or set it to `"bin"`. All paths are resolved relative to the JSON file's directory. `dataFiles` maps local files to virtual filesystem paths (used for HTML output via OPFS).

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

## WebAssembly GC types

The compiler supports Wasm GC heap-allocated structs and arrays managed by the engine's garbage collector. These live on the GC heap (not linear memory) and can be passed to/from JavaScript without serialization.

### Preferred syntax

A GC struct **value** is a reference to a heap-allocated object. To match C's pointer idioms (and stay friendly to clang IDE tooling), **always spell GC struct refs with `*`** and access fields with `->`:

```c
__struct Point { int x; int y; };

__struct Point *p = __new(__struct Point *, 3, 7);
p->x = 99;
printf("%d\n", p->x);
```

For GC arrays, **never** add `*` — arrays don't have a "pointer to" idiom in C, and the compiler rejects `__array(T) *`:

```c
__array(int) arr = __new(__array(int), 5);    // OK
arr[0] = 42;
__array_len(arr);
```

The same `*` convention applies to type-args of every intrinsic that can take an array — `__new`, `__new_array`, `__ref_test`, `__ref_cast`, `__ref_null`. (Exception: `__extends(__struct Foo)` stays bare because it names a parent class, never an array.) This means the IDE shim for `__new` doesn't need to differentiate struct vs array (both `__struct Foo *` and `__array(int)` cast cleanly from `0`):

| Allocation | Always write |
|---|---|
| Struct | `__new(__struct Foo *, args...)` |
| Array (default-init) | `__new(__array(T), n)` |
| Array (filled) | `__new(__array(T), n, val)` |
| Array (literal values) | `__new_array(T, v1, v2, ...)` |

The bare form (`__struct Foo` and `.`) also works — both spellings produce the same WASM type — but the `*`/`->` form is the documented preferred style.

### `__struct`

```c
__struct Node {
    int v;
    __struct Node *next;       // recursive ref — '*' form
    __array(int) children;     // array — no '*'
};

__struct Animal { int id; };
__struct Dog {
    __extends(__struct Animal);
    int id;       // must repeat parent's fields, in order, same names + types
    int paws;
};
```

Single inheritance via `__extends`. All `__struct` types are emitted as open for subtyping. Structurally identical types unify across translation units; mutually-recursive types share a rec group.

### `__array(T)`

GC-managed arrays with a fixed element type and runtime length:

```c
__array(int) scores = __new(__array(int), 100);  // 100 zero-initialized
scores[0] = 42;
int len = __array_len(scores);

__array(int) vals = __new_array(int, 1, 2, 3, 4, 5);  // literal element list
__array(int) ones = __new(__array(int), 5, 1);        // 5 elements, all = 1
```

When the element type is a GC struct, spell *that* with `*` too:

```c
__array(__struct Point *) pts = __new_array(__struct Point *,
    __new(__struct Point *, 1, 2),
    __new(__struct Point *, 3, 4));
pts[0]->x;
```

Bulk operations: `__array_fill(arr, off, val, n)` and `__array_copy(dst, dstOff, src, srcOff, n)`.

### Reference intrinsics

| Intrinsic | Description |
|-----------|-------------|
| `__ref_is_null(ref)` | Null check (`ref.is_null`) |
| `__ref_eq(a, b)` | Reference identity (`ref.eq`) |
| `__ref_null(__struct Foo *)` | Typed null reference |
| `__ref_test(__struct Foo *, ref)` | Runtime type test (`ref.test`) |
| `__ref_cast(__struct Foo *, ref)` | Downcast (`ref.cast`, traps on failure) |

### Boolean / null sugar

Refs can be used in boolean / null contexts as sugar for the explicit intrinsics:

| Sugar | Equivalent |
|---|---|
| `if (ref)`, `while (ref)`, `ref ? a : b` | `if (!__ref_is_null(ref))` etc |
| `!ref` | `__ref_is_null(ref)` |
| `ref == 0`, `ref == NULL` | `__ref_is_null(ref)` |
| `ref1 == ref2` | `__ref_eq(ref1, ref2)` (identity) |
| `__struct Foo *p = NULL;` | `= __ref_null(__struct Foo *)` |

Both forms are valid; pick per IDE-friendliness vs source readability.

### Universal `__eqref` + `__cast`

`__eqref` is the GC-universe supertype of all reference types (struct, array, boxed primitives) — analogous to `void *` for the GC heap. `__cast(TargetType, expr)` is the universal conversion intrinsic that dispatches based on the source/target type combo:

```c
__eqref store = __cast(__eqref, 42);          // box int — auto-allocs an internal box struct
int v = __cast(int, store);                   // unbox

__struct Point *p = __new(__struct Point *, 7, 11);
__eqref ep = __cast(__eqref, p);              // upcast (no-op)
__struct Point *p2 = __cast(__struct Point *, ep);  // downcast (ref.cast, traps on mismatch)

// Discriminated union
if (__ref_test(__struct Point *, store)) { ... }
else if (__ref_test(__struct Color *, store)) { ... }
```

Supported `__cast(target, source)` combos: prim ↔ prim (numeric), prim ↔ `__eqref` (box/unbox), GC ref ↔ `__eqref` (subtype upcast / ref.cast downcast), GC ref → GC ref (downcast/sidecast), GC ref ↔ externref (extern bridges).

`==` works directly between two `__eqref` values (identity comparison via `ref.eq`).

### Extern bridge

GC refs cross the JS/Wasm boundary via `__eqref` + the extern conversions:

| Intrinsic | Description |
|---|---|
| `__ref_as_extern(ref)` | GC ref → externref (`extern.convert_any`) |
| `__ref_as_eq(ext)` | externref → eqref (`any.convert_extern` + `ref.cast eq`; traps if not eq-compatible) |

### Auto + GC

C23 `auto` pairs naturally with GC types — the type spelling stays on the right of the `=`:

```c
auto p = __new(__struct Point *, 7, 11);
auto arr = __new_array(int, 1, 2, 3);
for (auto cur = head; cur; cur = cur->next) printf("%d\n", cur->v);
```

### Constraints

- No `&` on GC refs (no address)
- No embedding in C structs/unions
- No `sizeof` on ref types
- No casts to/from integers (use `__ref_*` intrinsics)
- `__array(T) *` is rejected — arrays don't take the `*` sugar
- `__new(__struct Foo, ...)` works but the preferred form is `__new(__struct Foo *, ...)`

For the full GC design doc see [todos/WASM_GC.md](todos/WASM_GC.md).

## Vendored projects

The compiler is tested against real-world C projects:

- **Lua 5.5.0** — Full interpreter, compiles and passes the official test suite
- **DOOM** — doomgeneric port with Nuked-OPL3 music synthesis, runs in the browser
- **Snake** — Terminal-based snake game using termios raw mode, ANSI escape codes, and `select()` for input handling

### Building vendored projects

```bash
# Lua interpreter
node compiler.js vendor/lua/bin.json -o lua.wasm
node host.js lua.wasm

# DOOM (HTML with embedded WAD)
node compiler.js vendor/doom/bin.json -o doom.html

# FreeType text rendering demo
node compiler.js vendor/freetype/demo/bin.json -o freetype-demo.js
node freetype-demo.js

# Snake (terminal game)
node compiler.js vendor/snake/main.c -o snake.html
node compiler.js vendor/snake/main.c -o snake.wasm && node host.js snake.wasm
```

### Serving HTML output

```bash
node serve.js [dir] [port]   # defaults: build/, 8080
```

`serve.js` adds COOP/COEP headers needed for `SharedArrayBuffer` (used by audio). Any HTTP server works for rendering, but without those headers DOOM runs silently.

## Tests

```bash
python3 tests/run.py                                  # Unit tests (default)
python3 tests/run.py --all                             # Everything
python3 tests/run.py --types=unit,extra                # Multiple categories
python3 tests/run.py --types=lua                       # Lua test suite
python3 tests/run.py --filter=struct                   # Filter by name
```

Test categories:
- **unit** — Core C language features and standard library (compile + run, check stdout)
- **extra** — Additional compile + run tests
- **lua** — Compile the Lua VM and run the official Lua test suite

The frozen C++ compiler snapshot in `old/` has its own test runner with equiv tests:

```bash
python3 old/tests/run.py                              # Unit tests, JS compiler
python3 old/tests/run.py --all                         # Unit (both compilers) + equiv + sourcemap
python3 old/tests/run.py --types=equiv --compiler=all  # JS vs C++ equivalence
```
