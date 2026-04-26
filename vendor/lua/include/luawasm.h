#pragma once

/*
** WASM-specific Lua configuration.
** setjmp/longjmp are lowered to WASM exceptions by the compiler.
*/

#include <stdio.h>

/* Avoid signal.h dependency in lstate.h */
#define l_signalT int
