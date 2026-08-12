# Lua 5.5.0

Unmodified upstream sources from https://www.lua.org/ftp/lua-5.5.0.tar.gz

- **Version**: 5.5.0
- **Released**: 2025-04-11
- **License**: MIT (see src/lua.h)
- **SHA256**: `57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d`

The compiler's embedded `signal.h` stub and cross-case goto support handle
the two issues that previously required Lua source modifications.

`luac.c` (the standalone bytecode compiler) is excluded — it contains a
duplicate `main()` and is not needed for the interpreter.

## Patches (#663 — the linkable source library)

Sources were vendored verbatim until #663 promoted the tree to a srclib
(`lib.json` + a `srclib` block in `packages/lua.json`, so the in-OS cc links
the interpreter from a bare `#include <lua.h>`). Two files carry gucOS
additions; everything else is byte-identical upstream:

| File | Change |
|---|---|
| `src/lua.h` | `__require_source` block appended after the copyright notice (source-lib design §4.2 — the set must equal `lib.json` sources; `LUA_NO_REQUIRE_SOURCES` suppresses). |
| `src/luaconf.h` | `LUA_USE_C89` pinned in-header (guarded `#if !defined`). It is ABI-visible (`LUA_C89_NUMBERS` → 32-bit `lua_Integer`), so the library TUs, the shell, and a flagless in-OS consumer must all see it; it replaced the old `-DLUA_USE_C89` in `bin.json`. |

Build shape: `bin.json` (the shell) is `deps: ["lib.json"]` + `src/lua.c`;
`lib.json` owns the 32 library TUs, `includes` and the `srcRoots {lua: src}`
namespace that path-identity-dedups the require block in project builds.
