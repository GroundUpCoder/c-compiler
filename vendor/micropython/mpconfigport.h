#include <stdint.h>

// options to control how MicroPython is built

// MINIMUM. Higher levels (CORE/BASIC/EXTRA/FULL) currently trigger
// runtime memory access errors in MicroPython that we haven't debugged
// — could be a codegen issue in our compiler or a config interaction.
#define MICROPY_CONFIG_ROM_LEVEL (MICROPY_CONFIG_ROM_LEVEL_MINIMUM)

// Selectively enable common features beyond MINIMUM.
#define MICROPY_PY_BUILTINS_SET           (1)
#define MICROPY_PY_BUILTINS_SLICE         (1)
#define MICROPY_PY_BUILTINS_MIN_MAX       (1)
#define MICROPY_PY_BUILTINS_ENUMERATE     (1)
#define MICROPY_PY_BUILTINS_FILTER        (1)
#define MICROPY_PY_BUILTINS_MAP           (1)
#define MICROPY_PY_BUILTINS_REVERSED      (1)
#define MICROPY_PY_BUILTINS_FROZENSET     (1)
#define MICROPY_PY_BUILTINS_PROPERTY      (1)
#define MICROPY_PY_BUILTINS_ROUND_INT     (1)
#define MICROPY_PY_BUILTINS_BYTES_HEX     (1)
#define MICROPY_PY_BUILTINS_RANGE_BINOP   (1)
#define MICROPY_PY_BUILTINS_RANGE_ATTRS   (1)
// #define MICROPY_PY_DESCRIPTORS            (1) -- triggers compiler codegen bug
#define MICROPY_PY_DELATTR_SETATTR        (1)
#define MICROPY_PY_GENERATOR_PEND_THROW   (1)
#define MICROPY_PY_ASSIGN_EXPR            (1)
#define MICROPY_CPYTHON_COMPAT            (1)
#define MICROPY_PY_BUILTINS_NEXT2         (1)
#define MICROPY_COMP_RETURN_IF_EXPR       (1)
#define MICROPY_COMP_MODULE_CONST         (1)

// You can disable the built-in MicroPython compiler by setting the following
// config option to 0.  If you do this then you won't get a REPL prompt, but you
// will still be able to execute pre-compiled scripts, compiled with mpy-cross.
#define MICROPY_ENABLE_COMPILER     (1)

#define MICROPY_QSTR_EXTRA_POOL           mp_qstr_frozen_const_pool
#define MICROPY_ENABLE_GC                 (1)
#define MICROPY_HELPER_REPL               (1)
#define MICROPY_MODULE_FROZEN_MPY         (1)
#define MICROPY_ENABLE_EXTERNAL_IMPORT    (1)

// Float (32-bit) + math builtins. Without this, `10/3` raises TypeError
// because true-divide for ints requires a float result. We use single-
// precision (not double) because the compiler can't yet handle the
// 52-bit fraction bit-field in the mp_float_union_t for doubles.
#define MICROPY_FLOAT_IMPL                (MICROPY_FLOAT_IMPL_FLOAT)
#define MICROPY_PY_MATH                   (1)

// Disable features the minimal port doesn't supply objects for.
#define MICROPY_PY_BUILTINS_OPEN          (0)
#define MICROPY_PY_IO                     (0)
#define MICROPY_PY_SYS_STDFILES           (0)
#define MICROPY_PY_UCTYPES                (0)

#define MICROPY_ALLOC_PATH_MAX            (256)

// Use the minimum headroom in the chunk allocator for parse nodes.
#define MICROPY_ALLOC_PARSE_CHUNK_INIT    (16)

// Disable all optional sys module features.
#define MICROPY_PY_SYS_MODULES            (0)
#define MICROPY_PY_SYS_EXIT               (0)
#define MICROPY_PY_SYS_PATH               (0)
#define MICROPY_PY_SYS_ARGV               (0)

// type definitions for the specific machine

typedef long mp_off_t;

// We need to provide a declaration/definition of alloca()
#include <alloca.h>

#define MICROPY_HW_BOARD_NAME "minimal"
#define MICROPY_HW_MCU_NAME "unknown-cpu"

#if defined(__linux__) || defined(__APPLE__)
#define MICROPY_MIN_USE_STDOUT (1)
#define MICROPY_HEAP_SIZE      (25600) // heap size 25 kilobytes
#endif

#ifdef __wasm__
#define MICROPY_MIN_USE_STDOUT (1)
#define MICROPY_HEAP_SIZE      (262144) // heap size 256 kilobytes
#endif

#ifdef __thumb__
#define MICROPY_MIN_USE_CORTEX_CPU (1)
#define MICROPY_MIN_USE_STM32_MCU (1)
#define MICROPY_HEAP_SIZE      (2048) // heap size 2 kilobytes
#endif

#define MP_WEAK
#define MP_STATE_PORT MP_STATE_VM
