# WASM Disassembler

Interactive browser-based tool for compiling C to WebAssembly and inspecting the
generated binary. Bundles the project's C-to-WASM compiler (`compiler.js`) and a
WASM build of the `vendor/disw/` disassembler into a single self-contained HTML
file that works offline with no server required.

## Screenshot

```
┌─────────────────────────────────────────────────────────────┐
│  WASM Disassembler          Ready  [Compile & Disassemble]  │
├─────────────────────────────┬───────────────────────────────┤
│  C Source                   │  Disassembly                  │
│                             │                               │
│  int factorial(int n) {     │  ▶ Module (version 1)         │
│      if (n <= 1) return 1;  │  ▶ Exports  (3 entries)       │
│      return n * factorial(  │  ▶ Code     (3 functions)     │
│          n - 1);            │    ▶ factorial (i32) → i32    │
│  }                          │    ▶ fibonacci (i32) → i32    │
│                             │    ▶ main () → i32            │
│  int main(void) { ... }    │                               │
└─────────────────────────────┴───────────────────────────────┘
```

## Building

```sh
python3 tools/disasm/build.py
```

This will:

1. Compile `vendor/disw/` to `tools/disasm/disw.wasm` using `compiler.js`
   (with `-g` for debug names)
2. Read `compiler.js`, strip the shebang, and escape `</script>` for safe
   inline embedding
3. Base64-encode `disw.wasm`
4. Inject both into `page.html`, producing `index.html` (~620 KB)

The generated `index.html` is gitignored. Only `page.html` (the template) and
`build.py` are tracked.

## Usage

Open `index.html` directly in a browser (`file://` works fine) or serve it:

```sh
open tools/disasm/index.html          # macOS
xdg-open tools/disasm/index.html      # Linux
```

1. Edit C code in the left pane
2. Press **Compile & Disassemble** or **Ctrl+Enter** (Cmd+Enter on macOS)
3. Browse the disassembly in the right pane

### Settings

Click the gear icon in the toolbar to open the settings modal:

- **Disable local slot reuse** — each C variable gets its own WASM local
  index instead of sharing slots across block scopes. Makes the disassembly
  easier to follow since each local maps to exactly one variable name.
- **GC unused sections** — remove unreferenced functions and data from the
  output.

Settings take effect on the next compile.

### Layout toggle

Click the grid button in the toolbar to switch between **side-by-side** and
**stacked** layouts. Stacked mode is useful on narrow screens or mobile devices.
On viewports under 768px the layout automatically stacks.

### Disassembly output

All sections start **collapsed**. Expand what you need:

- **Module** header — WASM version and section table (offsets, sizes, counts)
- **Imports** — imported functions/globals with module and name
- **Exports** — exported symbols and their indices
- **Globals** — global variables with type, mutability, and names
- **Code** — all functions grouped together; expand individual functions to see:
  - Parameter listing with types, indices, and names from source
  - Local variable listing with types, indices, and names (comma-joined
    when multiple variables share a slot due to block-scope reuse)
  - Full instruction listing with hex offsets, nesting depth, and operands
  - `local.get`/`local.set`/`local.tee` instructions show the variable
    name in angle brackets (e.g., `local.get 0 <n>`)

### Syntax coloring

Instructions are color-coded by category:

| Category   | Color  | Examples                                    |
|------------|--------|---------------------------------------------|
| Control    | Red    | `block`, `loop`, `if`, `br`, `return`       |
| Call       | Blue   | `call`, `call_indirect`                     |
| Memory     | Green  | `i32.load`, `i32.store`, `memory.grow`      |
| Local      | Teal   | `local.get`, `local.set`, `local.tee`       |
| Global     | Yellow | `global.get`, `global.set`                  |
| Const      | Orange | `i32.const`, `f64.const`                    |
| Other      | Purple | everything else (`i32.add`, `drop`, etc.)   |

Named references (function names from the names section) appear in a muted
color next to call targets and other indices.

## Architecture

```
tools/disasm/
├── build.py       Build script — compiles disw + bundles everything
├── page.html      HTML/CSS/JS template with two placeholders:
│                    /* __COMPILER_JS__ */      ← compiler.js source
│                    '__DISW_WASM_BASE64__'     ← disw.wasm as base64
├── index.html     Generated output (gitignored)
└── README.md      This file
```

### How it works

The page embeds two key components inline:

1. **compiler.js** — the full C-to-WASM compiler, exposed as
   `self.CompilerJS`. The browser compilation pipeline is:
   `parseAllUnits()` → `linkTranslationUnits()` → `generateCode()` with
   `emitNames: true` for debug info.

2. **disw.wasm** — the disassembler itself, compiled from C to WASM by
   the same compiler. It runs via a minimal in-browser WASM host that
   provides: `printf`/`vsnprintf` (full format string implementation),
   an in-memory filesystem for piping WASM bytes to disw's stdin, and
   `argv` setup to pass the `-J` flag for JSON output.

The data flow on each compile:

```
C source  →  compiler.js (parseAllUnits → link → generateCode)
          →  .wasm bytes
          →  written to in-memory FS as /dev/stdin
          →  disw.wasm runs with argv ["/disw", "-J", "/dev/stdin"]
          →  JSON captured from stdout
          →  parsed and rendered as interactive HTML
```

### JSON output format (`-J`)

The disassembler's `-J` flag (added for this tool) produces structured JSON:

```json
{
  "version": 1,
  "sections": [{"name": "Type", "offset": 10, "size": 7, "count": 2}],
  "types": [{"index": 0, "signature": "(i32) -> i32"}],
  "imports": [{"module": "env", "name": "log", "kind": "func", "type_index": 0}],
  "functions": [{"index": 0, "type_index": 0}],
  "tables": [],
  "memories": [{"initial": 2, "max": null}],
  "globals": [{"index": 0, "val_type": "i32", "mutable": true, "name": "__sp"}],
  "exports": [{"name": "main", "kind": "func", "index": 1}],
  "start": null,
  "code": [{
    "index": 1,
    "name": "factorial",
    "signature": "(i32) -> i32",
    "params": [{"type": "i32", "index": 0, "name": "n"}],
    "body_size": 42,
    "locals": [{"type": "i32", "index": 1, "name": "result"}],
    "instructions": [
      {"offset": 100, "depth": 1, "text": "local.get 0 <n>"},
      {"offset": 102, "depth": 1, "text": "i32.const 1"},
      {"offset": 104, "depth": 1, "text": "i32.le_s"}
    ]
  }]
}
```

## Dependencies

- **Node.js** — required at build time to run `compiler.js`
- **Python 3** — required at build time for `build.py`
- **No runtime dependencies** — the generated HTML is fully self-contained
