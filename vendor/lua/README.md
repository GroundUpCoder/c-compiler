# Lua 5.5.0

Unmodified upstream sources from https://www.lua.org/ftp/lua-5.5.0.tar.gz

- **Version**: 5.5.0
- **Released**: 2025-04-11
- **License**: MIT (see src/lua.h)
- **SHA256**: `57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d`

Sources are vendored verbatim — no patches applied. The compiler's embedded
`signal.h` stub and cross-case goto support handle the two issues that
previously required Lua source modifications.

`luac.c` (the standalone bytecode compiler) is excluded — it contains a
duplicate `main()` and is not needed for the interpreter.
