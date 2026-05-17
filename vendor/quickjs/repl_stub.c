// Stub for the precompiled REPL bytecode.
//
// Normally `qjsc` (the QuickJS AOT compiler, qjsc.c) compiles repl.js to a
// C array `qjsc_repl[]` and the qjs binary links against that. We don't
// build qjsc yet, so this stub provides an empty bytecode buffer to let
// the REPL link. The interactive REPL won't work until we generate the
// real bytecode, but `qjs -e '1+1'` and module loading paths don't need it.
#include <stdint.h>

const uint8_t qjsc_repl[] = { 0 };
const uint32_t qjsc_repl_size = 0;
