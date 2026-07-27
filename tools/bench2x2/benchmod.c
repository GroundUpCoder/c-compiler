// bench-2x2 INSTRUMENTATION ONLY -- never part of the shipped MicroPython.
//
// The vendored gucOS MicroPython port is MICROPY_CONFIG_ROM_LEVEL_MINIMUM and
// vendors no extmod/, so it has NO `time` module, and its port HAL stubs
// mp_hal_ticks_ms() to a literal 0 (vendor/micropython/mphalport.h). There is
// therefore no in-guest clock at all, and GC pause distributions -- the thing
// the 2x2 spec asks for as max + p99 -- cannot be observed from Python.
//
// This module adds exactly one capability: a monotonic microsecond clock, read
// through the SAME libc entry point CPython's time.perf_counter() ends up on
// (clock_gettime(CLOCK_MONOTONIC) -> host.js __clock_ns_hi/lo ->
// performance.now()). Sharing one time base is what makes the CPython vs
// MicroPython column of the table comparable at all.
//
// It deliberately does NOT change the allocator, the GC, or any codegen-
// relevant flag. `gc` is enabled separately in the bench mpconfigport.h and is
// upstream's own module, unmodified.

#include "py/runtime.h"
#include "py/obj.h"

#if MICROPY_PY_BENCH

#include <time.h>

// Monotonic microseconds as a Python int. mp_obj_new_int_from_ull keeps the
// full 64-bit value: a float would start losing microsecond resolution once
// the monotonic clock passes ~2^53 us, and more importantly small differences
// stay exact.
static mp_obj_t bench_now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    unsigned long long us = (unsigned long long)ts.tv_sec * 1000000ull
                          + (unsigned long long)(ts.tv_nsec / 1000);
    return mp_obj_new_int_from_ull(us);
}
static MP_DEFINE_CONST_FUN_OBJ_0(bench_now_us_obj, bench_now_us);

// Nanoseconds, for measuring pauses short enough that a 1us quantum would
// dominate the distribution we are trying to report.
static mp_obj_t bench_now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    unsigned long long ns = (unsigned long long)ts.tv_sec * 1000000000ull
                          + (unsigned long long)ts.tv_nsec;
    return mp_obj_new_int_from_ull(ns);
}
static MP_DEFINE_CONST_FUN_OBJ_0(bench_now_ns_obj, bench_now_ns);

static const mp_rom_map_elem_t mp_module_bench_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_bench) },
    { MP_ROM_QSTR(MP_QSTR_now_us), MP_ROM_PTR(&bench_now_us_obj) },
    { MP_ROM_QSTR(MP_QSTR_now_ns), MP_ROM_PTR(&bench_now_ns_obj) },
};

static MP_DEFINE_CONST_DICT(mp_module_bench_globals, mp_module_bench_globals_table);

const mp_obj_module_t mp_module_bench = {
    .base = { &mp_type_module },
    .globals = (mp_obj_dict_t *)&mp_module_bench_globals,
};

MP_REGISTER_MODULE(MP_QSTR_bench, mp_module_bench);

#endif // MICROPY_PY_BENCH
