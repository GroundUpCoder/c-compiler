#include <stdint.h>

// options to control how MicroPython is built

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
#define MICROPY_PY_DESCRIPTORS            (1)
#define MICROPY_PY_DELATTR_SETATTR        (1)
#define MICROPY_PY_GENERATOR_PEND_THROW   (1)
#define MICROPY_PY_ASSIGN_EXPR            (1)
#define MICROPY_CPYTHON_COMPAT            (1)
#define MICROPY_PY_BUILTINS_NEXT2         (1)
#define MICROPY_COMP_RETURN_IF_EXPR       (1)
#define MICROPY_COMP_MODULE_CONST         (1)
#define MICROPY_PY_FSTRINGS               (1)
#define MICROPY_PY_ASYNC_AWAIT            (1)
#define MICROPY_PY_BUILTINS_COMPILE       (1)
#define MICROPY_PY_BUILTINS_EVAL_EXEC     (1)
#define MICROPY_PY_BUILTINS_DICT_FROMKEYS (1)
#define MICROPY_PY_BUILTINS_HASH          (1)
#define MICROPY_PY_BUILTINS_STR_COUNT     (1)
#define MICROPY_PY_BUILTINS_STR_OP_MODULO (1)
#define MICROPY_LONGINT_IMPL              (MICROPY_LONGINT_IMPL_MPZ)
#define MICROPY_MULTIPLE_INHERITANCE      (1)
#define MICROPY_PY_ATTRTUPLE              (1)
#define MICROPY_PY_BUILTINS_POW3          (1)
#define MICROPY_PY_BUILTINS_STR_CENTER    (1)
#define MICROPY_PY_ALL_SPECIAL_METHODS    (1)
#define MICROPY_PY_REVERSE_SPECIAL_METHODS (1)
#define MICROPY_CAN_OVERRIDE_BUILTINS     (1)
#define MICROPY_PY_BUILTINS_NOTIMPLEMENTED (1)
#define MICROPY_PY_SYS_MAXSIZE            (1)
#define MICROPY_BUILTIN_METHOD_CHECK_SELF_ARG (1)
#define MICROPY_WARNINGS                  (1)
#define MICROPY_PY_BUILTINS_STR_PARTITION (1)
#define MICROPY_PY_BUILTINS_STR_SPLITLINES (1)
#define MICROPY_PY_BUILTINS_BYTEARRAY     (1)
#define MICROPY_PY_COLLECTIONS_DEQUE      (1)
#define MICROPY_PY_BUILTINS_MEMORYVIEW    (1)

#define MICROPY_PY_STR_BYTES_CMP_WARN    (1)
#define MICROPY_FULL_CHECKS              (1)

// --- todos/0117 R1: script runner + file I/O -------------------------------
// Everything below needs the qstr pool / module table / root-pointer list
// regenerated. `node tools/mkmpgenhdr.js` does that (and `--check` is a test),
// so the old "only enable what doesn't need QSTR regeneration" ceiling that
// this block used to sit under is gone.
#define MICROPY_PY_BUILTINS_OPEN          (1)   // open() -> file.c
#define MICROPY_PY_IO                     (1)   // the io module + StringIO/BytesIO
#define MICROPY_PY_IO_IOBASE              (1)   // io.IOBase, for Python-defined streams
#define MICROPY_PY_SYS_STDFILES           (1)   // sys.stdin/stdout/stderr as file objects
#define MICROPY_PY_SYS_STDIO_BUFFER       (1)   // ...and their .buffer binary twins
#define MICROPY_READER_POSIX              (1)   // py/reader.c + py/lexer.c's file lexer
#define MICROPY_PY_SYS_EXIT               (1)   // sys.exit(status) — a CLI needs it
#define MICROPY_MODULE___FILE__           (1)   // __file__ in an executed script
#define MICROPY_ENABLE_SOURCE_LINE        (1)   // line numbers in tracebacks
#define MICROPY_ENABLE_FINALISER          (1)   // so a dropped file object closes its fd
#define MICROPY_PY_FUNCTION_ATTRS         (1)   // func.__name__/__globals__ — compile()'s
                                                // result is only useful with them
#define MICROPY_PYEXEC_ENABLE_EXIT_CODE_HANDLING (1)   // real REPL exit statuses

// Uncaught tracebacks go to stderr, not stdout (upstream ports/unix does the
// same). mp_stderr_print is defined in main.c.
extern const struct _mp_print_t mp_stderr_print;
#define MICROPY_ERROR_PRINTER             (&mp_stderr_print)

// You can disable the built-in MicroPython compiler by setting the following
// config option to 0.  If you do this then you won't get a REPL prompt, but you
// will still be able to execute pre-compiled scripts, compiled with mpy-cross.
#define MICROPY_ENABLE_COMPILER     (1)

#define MICROPY_QSTR_EXTRA_POOL           mp_qstr_frozen_const_pool
#define MICROPY_ENABLE_GC                 (1)
#define MICROPY_HELPER_REPL               (1)
#define MICROPY_MODULE_FROZEN_MPY         (1)
#define MICROPY_ENABLE_EXTERNAL_IMPORT    (1)

#define MICROPY_FLOAT_IMPL                (MICROPY_FLOAT_IMPL_DOUBLE)
#define MICROPY_PY_MATH                   (1)

// Still off: no object set for it, and no consumer (todos/0117 R2 owns the
// stdlib-breadth decision — os/json/time/re/struct/array/gc — pending the
// todos/0313 CPython probe).
#define MICROPY_PY_UCTYPES                (0)

#define MICROPY_ALLOC_PATH_MAX            (256)

// Use the minimum headroom in the chunk allocator for parse nodes.
#define MICROPY_ALLOC_PARSE_CHUNK_INIT    (16)

// sys module features.
#define MICROPY_PY_SYS_MODULES            (0)   // R2
#define MICROPY_PY_SYS_PATH               (1)
#define MICROPY_PY_SYS_ARGV               (1)

// type definitions for the specific machine

typedef long mp_off_t;

// We need to provide a declaration/definition of alloca()
#include <alloca.h>

#define MICROPY_HW_BOARD_NAME "gucOS"
#define MICROPY_HW_MCU_NAME "wasm32"

#if defined(__linux__) || defined(__APPLE__)
#define MICROPY_MIN_USE_STDOUT (1)
#define MICROPY_HEAP_SIZE      (25600) // heap size 25 kilobytes
#endif

#ifdef __wasm__
#define MICROPY_MIN_USE_STDOUT (1)
// 32 MB (todos/0117 R1). The old 256 KB was a REPL-toy number: a 640x480
// list-of-lists is ~900 KB, i.e. 3.5x the whole heap, and one float64
// temporary of that shape is 7.4 MB. Sized for scripts that hold real data.
// GC-pause cost measured in logs/2026-07-27/0117-micropython-script-runner.md.
#define MICROPY_HEAP_SIZE      (33554432) // heap size 32 megabytes
#endif

#ifdef __thumb__
#define MICROPY_MIN_USE_CORTEX_CPU (1)
#define MICROPY_MIN_USE_STM32_MCU (1)
#define MICROPY_HEAP_SIZE      (2048) // heap size 2 kilobytes
#endif

#define MP_WEAK
#define MP_STATE_PORT MP_STATE_VM
