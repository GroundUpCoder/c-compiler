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

// --- todos/0117 R2: the curated stdlib -------------------------------------
// Two groups. This first group costs NOTHING but a define: every .c file is
// already in bin.json and was being compiled to an empty translation unit,
// because MICROPY_CONFIG_ROM_LEVEL_MINIMUM gates them at CORE/EXTRA. Before
// R2 the real built-in set was math/io/sys/builtins and nothing else — not
// even `struct` or `collections`, which the R2 plan had assumed shipped.
#define MICROPY_PY_ARRAY                  (1)   // py/modarray.c
#define MICROPY_PY_ARRAY_SLICE_ASSIGN     (1)
#define MICROPY_PY_COLLECTIONS            (1)   // py/modcollections.c — namedtuple
#define MICROPY_PY_COLLECTIONS_ORDEREDDICT (1)
#define MICROPY_PY_COLLECTIONS_NAMEDTUPLE__ASDICT (1)
#define MICROPY_PY_COLLECTIONS_DEQUE_ITER (1)   // DEQUE itself is on above
#define MICROPY_PY_COLLECTIONS_DEQUE_SUBSCR (1)
#define MICROPY_PY_STRUCT                 (1)   // py/modstruct.c
#define MICROPY_PY_ERRNO                  (1)   // py/moderrno.c
#define MICROPY_PY_GC                     (1)   // py/modgc.c
#define MICROPY_PY_MICROPYTHON            (1)   // py/modmicropython.c
#define MICROPY_PY_MICROPYTHON_MEM_INFO   (1)   // mem_info/qstr_info — the only
                                                // way to see heap use from Python
#define MICROPY_PY_CMATH                  (1)   // py/modcmath.c (float impl is double)

// The second group is newly vendored from upstream extmod/ + lib/ (see
// vendor/micropython/README.md's patch table for what each one cost).
#define MICROPY_PY_JSON                   (1)   // extmod/modjson.c
#define MICROPY_PY_JSON_SEPARATORS        (1)   // dumps(separators=...)
#define MICROPY_PY_RE                     (1)   // extmod/modre.c + lib/re1.5
#define MICROPY_PY_RE_SUB                 (1)
#define MICROPY_PY_RE_MATCH_GROUPS        (1)
#define MICROPY_PY_RE_MATCH_SPAN_START_END (1)
#define MICROPY_PY_RE_DEBUG               (0)   // drops lib/re1.5/dumpcode.c
#define MICROPY_PY_TIME                   (1)   // extmod/modtime.c + shared/timeutils
#define MICROPY_PY_TIME_GMTIME_LOCALTIME_MKTIME (1)
#define MICROPY_PY_TIME_TIME_TIME_NS      (1)
#define MICROPY_PY_TIME_INCLUDEFILE       "portmodtime.c"
#define MICROPY_PY_RANDOM                 (1)   // extmod/modrandom.c
#define MICROPY_PY_RANDOM_EXTRA_FUNCS     (1)   // randrange/choice/uniform/...
#define MICROPY_PY_RANDOM_SEED_INIT_FUNC  (mp_hal_time_ns() & 0xffffffff)
#define MICROPY_PY_BINASCII               (1)   // extmod/modbinascii.c
#define MICROPY_PY_HEAPQ                  (1)   // extmod/modheapq.c
#define MICROPY_PY_PLATFORM               (1)   // extmod/modplatform.c
#define MICROPY_PY_OS                     (1)   // extmod/modos.c + portmodos.c
#define MICROPY_PY_OS_INCLUDEFILE         "portmodos.c"
#define MICROPY_PY_OS_UNAME               (1)
#define MICROPY_PY_OS_URANDOM             (1)   // /dev/urandom via mp_hal_get_random
#define MICROPY_PY_OS_SYSTEM              (1)   // libc system() -> posix_spawn /bin/sh
#define MICROPY_PY_OS_ERRNO               (1)
#define MICROPY_PY_OS_GETENV_PUTENV_UNSETENV (1)
// Port-local flag, NOT upstream's: the POSIX filesystem surface + os.path that
// portmodos.c supplies in place of upstream's #if MICROPY_VFS block.
#define MICROPY_PY_OS_POSIX_FS            (1)
// os.sync() stays OFF. Upstream's body only syncs FatFS volumes, so with no
// VFS it is an unconditional no-op — a function that silently promises
// durability it does not deliver is worse than a missing one. Durability here
// is the kernel's FS_FSYNC (file objects' .flush()), landed in todos/0036.
#define MICROPY_PY_OS_SYNC                (0)

// Epoch and timestamp width. MicroPython defaults to a 2000 epoch with
// 32-bit timestamps (embedded heritage); a dialect that wants to look like
// Python needs time.time() to agree with CPython and with the rest of the OS,
// and needs to survive 2038.
#define MICROPY_EPOCH_IS_1970             (1)
#define MICROPY_TIME_SUPPORT_Y2100_AND_BEYOND (1)
#define MICROPY_TIME_SUPPORT_Y1969_AND_BEFORE (1)

// A built-in module can carry submodules in its globals (`import os.path`,
// `from os.path import join`) — os.path is a real submodule, not a shim.
#define MICROPY_MODULE_BUILTIN_SUBPACKAGES (1)

// `python -m mod`: __import__ sets the imported module's __name__ to
// "__main__" and returns the leaf rather than the top-level package. R1
// refused -m outright because there was no module-execution path; there is
// one now, so refusing it would just be a missing feature.
#define MICROPY_MODULE_OVERRIDE_MAIN_IMPORT (1)

// sys.modules: the import cache. Without it every `import foo` re-executes
// foo.py, so two modules importing a third get two copies of its state —
// which is a correctness bug the moment more than one file is involved.
#define MICROPY_PY_SYS_MODULES            (1)

// Still off. uctypes is a MicroPython-specific FFI-ish struct layout module
// with no CPython counterpart; the dialect's job is to look like Python, and
// a script that uses it cannot run anywhere else.
#define MICROPY_PY_UCTYPES                (0)

#define MICROPY_ALLOC_PATH_MAX            (256)

// Use the minimum headroom in the chunk allocator for parse nodes.
#define MICROPY_ALLOC_PARSE_CHUNK_INIT    (16)

// sys module features.
// (MICROPY_PY_SYS_MODULES is set in the R2 block above.)
#define MICROPY_PY_SYS_PATH               (1)
#define MICROPY_PY_SYS_ARGV               (1)

// type definitions for the specific machine

typedef long mp_off_t;

// We need to provide a declaration/definition of alloca()
#include <alloca.h>

#define MICROPY_HW_BOARD_NAME "gucOS"
#define MICROPY_HW_MCU_NAME "wasm32"

// sys.platform / os.uname().sysname / platform.platform(). "gucos" rather than
// "linux": scripts branch on this, and claiming to be Linux would make them
// reach for things (/proc layouts, fork, subprocess) this OS does not have.
#define MICROPY_PY_SYS_PLATFORM "gucos"

// platform.platform() / .machine() / .libc_ver(). wasm32 matches none of
// modplatform.h's detection chains, so without these it renders the empty
// string in every field ("MicroPython-1.28.0---with-"). The header carries
// #ifndef guards for exactly this (see its patch-table row).
#define MICROPY_PLATFORM_ARCH             "wasm32"
#define MICROPY_PLATFORM_SYSTEM           "gucOS"
#define MICROPY_PLATFORM_LIBC_LIB         "guclibc"   // compiler.js's built-in libc
#define MICROPY_PLATFORM_LIBC_VER         ""

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
