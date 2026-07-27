// gucOS MicroPython port — the /bin/micropython (and /bin/python) driver.
//
// Started life as upstream's ports/minimal/main.c (REPL only, argv ignored).
// todos/0117 R1 turned it into a real script runner: the command line is
// honoured, sys.argv is populated, exceptions set the exit status, and the
// POSIX hooks (mp_import_stat; mp_lexer_new_from_file via MICROPY_READER_POSIX
// in py/lexer.c) resolve against the OS filesystem. The argument grammar and
// the do_* helpers follow upstream's ports/unix/main.c.
//
// The stdin path is deliberately identical to the file path — that is what
// makes the vendored upstream test corpus (tests/run.py's `micropython` and
// `micropython-upstream` categories, which pipe a script in) exercise the
// SAME binary that gets seeded into the image.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

#include "py/builtin.h"
#include "py/compile.h"
#include "py/runtime.h"
#include "py/repl.h"
#include "py/gc.h"
#include "py/mperrno.h"
#include "py/objlist.h"
#include "py/stream.h"
#include "py/stackctrl.h"
#include "shared/runtime/pyexec.h"
#include "genhdr/mpversion.h"

// Spilled-locals builds (--gc-spill-locals) have much larger frames; the
// default single 64KB stack page overflows inside the VM on any non-trivial
// script. (Was only in the test main before R1 unified the two.)
__minstack(1048576);

#define EXIT_OK             (0)
#define EXIT_EXCEPTION      (1)
#define EXIT_USAGE          (2)

static char *stack_top;
#if MICROPY_ENABLE_GC
static char heap[MICROPY_HEAP_SIZE];
#endif

#if MICROPY_PY_SYS_STDFILES
// The printer uncaught tracebacks go to. Upstream's unix port does the same
// (ports/unix/mpconfigport.h defines MICROPY_ERROR_PRINTER to this); a CLI
// that writes its errors to stdout corrupts `python foo.py > out`.
extern struct _mp_dummy_t mp_sys_stderr_obj;
const mp_print_t mp_stderr_print = {&mp_sys_stderr_obj, mp_stream_write_adaptor};
#endif

// Turn an uncaught exception into a process exit status, printing it unless it
// is a SystemExit carrying one. Shared by the script, -c, stdin and -m paths
// (R2 split it out of execute_lexer so `-m` reports failures identically).
static int report_uncaught(mp_obj_t exc) {
    if (mp_obj_is_subclass_fast(MP_OBJ_FROM_PTR(mp_obj_get_type(exc)),
                                MP_OBJ_FROM_PTR(&mp_type_SystemExit))) {
        // SystemExit carries the status: None -> 0, int -> its value,
        // anything else -> print it and exit 1 (CPython's rule).
        mp_obj_t val = mp_obj_exception_get_value(exc);
        if (val == mp_const_none) {
            return EXIT_OK;
        }
        if (mp_obj_is_int(val)) {
            return (int)mp_obj_int_get_truncated(val);
        }
        mp_obj_print_helper(MICROPY_ERROR_PRINTER, val, PRINT_STR);
        mp_print_str(MICROPY_ERROR_PRINTER, "\n");
        return EXIT_EXCEPTION;
    }
    mp_obj_print_exception(MICROPY_ERROR_PRINTER, exc);
    return EXIT_EXCEPTION;
}

#if MICROPY_ENABLE_COMPILER

// Compile and run one chunk of source. Returns a process exit status.
// `is_repl` only controls whether a bare top-level expression auto-prints.
static int execute_lexer(mp_lexer_t *lex, mp_parse_input_kind_t input_kind, bool is_repl) {
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        qstr source_name = lex->source_name;
        #if MICROPY_MODULE___FILE__
        if (input_kind == MP_PARSE_FILE_INPUT) {
            mp_store_global(MP_QSTR___file__, MP_OBJ_NEW_QSTR(source_name));
        }
        #endif
        mp_parse_tree_t parse_tree = mp_parse(lex, input_kind);
        mp_obj_t module_fun = mp_compile(&parse_tree, source_name, is_repl);
        mp_call_function_0(module_fun);
        mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_EXCEPTIONS);
        nlr_pop();
        return EXIT_OK;
    }

    // Uncaught exception.
    mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_CLEAR_EXCEPTIONS);
    return report_uncaught(MP_OBJ_FROM_PTR(nlr.ret_val));
}

static int do_str(const char *src, size_t len, qstr source_name,
                  mp_parse_input_kind_t input_kind) {
    nlr_buf_t nlr;
    mp_lexer_t *lex;
    // Lexer construction itself allocates and can raise.
    if (nlr_push(&nlr) == 0) {
        lex = mp_lexer_new_from_str_len(source_name, src, len, 0);
        nlr_pop();
    } else {
        mp_obj_print_exception(MICROPY_ERROR_PRINTER, MP_OBJ_FROM_PTR(nlr.ret_val));
        return EXIT_EXCEPTION;
    }
    return execute_lexer(lex, input_kind, false);
}

static int do_file(const char *path) {
    nlr_buf_t nlr;
    mp_lexer_t *lex;
    // A missing/unreadable file raises OSError out of the lexer constructor,
    // which must be reported (and exit non-zero), not crash the process.
    if (nlr_push(&nlr) == 0) {
        lex = mp_lexer_new_from_file(qstr_from_str(path));
        nlr_pop();
    } else {
        mp_obj_print_exception(MICROPY_ERROR_PRINTER, MP_OBJ_FROM_PTR(nlr.ret_val));
        return EXIT_EXCEPTION;
    }
    return execute_lexer(lex, MP_PARSE_FILE_INPUT, false);
}

// Read all of stdin and run it as one script — `micropython < foo.py` and
// `cat foo.py | micropython`.
#define STDIN_CHUNK (4096)

static int do_stdin(void) {
    vstr_t vstr;
    vstr_init(&vstr, STDIN_CHUNK);
    for (;;) {
        char *p = vstr_add_len(&vstr, STDIN_CHUNK);
        ssize_t n = read(STDIN_FILENO, p, STDIN_CHUNK);
        if (n <= 0) {
            vstr_cut_tail_bytes(&vstr, STDIN_CHUNK);
            break;
        }
        vstr_cut_tail_bytes(&vstr, STDIN_CHUNK - (size_t)n);
    }
    int ret = do_str(vstr.buf, vstr.len, MP_QSTR__lt_stdin_gt_, MP_PARSE_FILE_INPUT);
    vstr_clear(&vstr);
    return ret;
}

#endif // MICROPY_ENABLE_COMPILER

// --- sys.path (todos/0117 R2) ---------------------------------------------
//
// R1 left sys.path at MicroPython's default `["", ".frozen"]`, which meant a
// script could only import its siblings when it happened to be run from its
// own directory, and there was nowhere at all to install a module.
//
// The policy is four entries, in this order:
//
//   [0] the SCRIPT'S DIRECTORY, or "" (cwd) for -c / -m / stdin / the REPL.
//       CPython's rule. It is entry 0 and it is REPLACED, not appended, so a
//       script's siblings always win — that is what makes a two-file program
//       work no matter where it is run from.
//   [1] ".frozen"                  — frozen modules (upstream's own entry).
//   [2] SITE_DIR_LOCAL             — the writable site dir. Where a user or an
//                                    admin drops a .py module for every script
//                                    on the system to see.
//   [3] <dir of the real binary>/lib — the package's own bundled modules.
//
// Two choices worth defending:
//
// * /usr/local/lib/micropython, not /usr/lib/micropython. /usr is a SEALED,
//   read-only volume on this OS (todos/0040) — nothing can ever be installed
//   there at runtime, so a site dir under it would be permanently empty. The
//   OS's writable admin territory is /usr/local (a baked symlink to
//   /var/local), which is also why PATH is /usr/local/bin:/bin. This entry is
//   the exact analogue of /usr/local/bin.
//
// * The writable site dir comes BEFORE the package's own lib. CPython orders
//   stdlib before site-packages, so this deliberately diverges — but it agrees
//   with every other layered lookup in gucOS (PATH, /etc/menu over
//   /usr/share/menu, the cfgstore overlay in os/cfgstore.h): the writable
//   layer wins. A user reasoning about "where does my module go" reaches for
//   the PATH analogy long before the CPython one.
//
// * The package lib dir is derived from the BINARY's location, not hardcoded.
//   micropython is a gucman package, so it lives at /opt/micropython when
//   installed and /usr/opt/micropython on a --packages=all bake, reached
//   through a /usr/local/bin or /usr/bin symlink either way. Chasing argv[0]'s
//   trailing symlinks is the same trick user32.c's res_chase uses to find an
//   app's .res sidecar, and for the same reason.
//
// Entries are added unconditionally, even when the directory does not exist: a
// missed stat per top-level import is nothing, and `python -c 'import sys;
// print(sys.path)'` is how a user finds out where to put a module. A path that
// silently omits the answer is worse than one with a dead entry in it.

#define SITE_DIR_LOCAL "/usr/local/lib/micropython"
#define PKG_LIB_SUBDIR "/lib"

// Follow the trailing-component symlink chain, in place. Directory symlinks
// (/bin -> /usr/bin) resolve during the kernel's path walk; only the final
// component needs chasing. The hop cap breaks cycles.
static void chase_links(char *p, size_t cap) {
    for (int hop = 0; hop < 8; hop++) {
        char tgt[256];
        ssize_t n = readlink(p, tgt, sizeof tgt - 1);
        if (n <= 0) {
            return;                     // not a symlink: done
        }
        tgt[n] = '\0';
        if (tgt[0] == '/') {
            snprintf(p, cap, "%s", tgt);
        } else {
            char joined[512];
            const char *slash = strrchr(p, '/');
            snprintf(joined, sizeof joined, "%.*s/%s",
                     slash ? (int)(slash - p) : 1, slash ? p : ".", tgt);
            snprintf(p, cap, "%s", joined);
        }
    }
}

// Write the directory holding the real executable into `out`. Returns false if
// argv[0] gives us nothing to work with (spawned with an empty argv[0], say).
static bool exe_dir(const char *argv0, char *out, size_t cap) {
    if (argv0 == NULL || argv0[0] == '\0') {
        return false;
    }
    char real[256];
    if (strchr(argv0, '/') != NULL) {
        snprintf(real, sizeof real, "%s", argv0);
    } else {
        // A bare name means PATH resolution happened in the spawner and was
        // not written back into argv[0]; redo it.
        const char *pathenv = getenv("PATH");
        if (pathenv == NULL) {
            pathenv = "/usr/local/bin:/bin";
        }
        bool found = false;
        while (*pathenv != '\0' && !found) {
            const char *end = strchr(pathenv, ':');
            size_t seglen = end ? (size_t)(end - pathenv) : strlen(pathenv);
            if (seglen > 0) {
                snprintf(real, sizeof real, "%.*s/%s", (int)seglen, pathenv, argv0);
                struct stat st;
                found = stat(real, &st) == 0 && S_ISREG(st.st_mode);
            }
            pathenv = end ? end + 1 : pathenv + seglen;
        }
        if (!found) {
            return false;
        }
    }
    chase_links(real, sizeof real);
    char *slash = strrchr(real, '/');
    if (slash == NULL) {
        return false;
    }
    // Keep the root's slash: dirname("/x") is "/", not "".
    size_t dlen = slash == real ? 1 : (size_t)(slash - real);
    if (dlen + 1 > cap) {
        return false;
    }
    memcpy(out, real, dlen);
    out[dlen] = '\0';
    return true;
}

#if MICROPY_PY_SYS_PATH
static void setup_sys_path(const char *argv0) {
    // mp_init already built ["", ".frozen"]; append the site dirs to it rather
    // than rebuilding, so the frozen entry keeps upstream's position.
    mp_obj_list_append(mp_sys_path, mp_obj_new_str_from_cstr(SITE_DIR_LOCAL));
    char dir[256];
    if (exe_dir(argv0, dir, sizeof dir)) {
        size_t dlen = strlen(dir);
        if (dlen + sizeof(PKG_LIB_SUBDIR) <= sizeof dir) {
            memcpy(dir + dlen, PKG_LIB_SUBDIR, sizeof(PKG_LIB_SUBDIR));
            mp_obj_list_append(mp_sys_path, mp_obj_new_str_from_cstr(dir));
        }
    }
}

// CPython puts the script's own directory at sys.path[0]. Replace, don't
// insert: entry 0 is the "" that mp_init put there for exactly this slot.
static void sys_path_set_script_dir(const char *script) {
    char real[256];
    if (realpath(script, real) == NULL) {
        return;     // do_file will report the open failure properly
    }
    char *slash = strrchr(real, '/');
    if (slash == NULL) {
        return;
    }
    size_t dlen = slash == real ? 1 : (size_t)(slash - real);
    mp_obj_list_store(mp_sys_path, MP_OBJ_NEW_SMALL_INT(0),
                      mp_obj_new_str(real, dlen));
}
#else
#define setup_sys_path(argv0) ((void)0)
#define sys_path_set_script_dir(script) ((void)0)
#endif

// --- -m MODULE ------------------------------------------------------------
//
// Runs a module found on sys.path as __main__, and falls back to a package's
// __main__.py — CPython's semantics, over MicroPython's own mechanism: the
// sentinel `fromtuple == mp_const_false` makes __import__ set the imported
// module's __name__ to "__main__" and return the LEAF rather than the
// top-level package. That is what MICROPY_MODULE_OVERRIDE_MAIN_IMPORT is for;
// the shape below follows upstream's ports/unix/main.c.
#if MICROPY_MODULE_OVERRIDE_MAIN_IMPORT
static int do_module(const char *mod_name) {
    mp_obj_t import_args[4];
    import_args[0] = mp_obj_new_str_from_cstr(mod_name);
    import_args[1] = import_args[2] = mp_const_none;
    import_args[3] = mp_const_false;

    // Must survive the setjmp/longjmp NLR frame, hence static (upstream carries
    // the same note — a plain local can be clobbered).
    static bool subpkg_tried;
    subpkg_tried = false;

reimport:;
    nlr_buf_t nlr;
    mp_obj_t mod;
    if (nlr_push(&nlr) == 0) {
        mod = mp_builtin___import__(MP_ARRAY_SIZE(import_args), import_args);
        mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_EXCEPTIONS);
        nlr_pop();
    } else {
        mp_handle_pending(MP_HANDLE_PENDING_CALLBACKS_AND_CLEAR_EXCEPTIONS);
        return report_uncaught(MP_OBJ_FROM_PTR(nlr.ret_val));
    }

    // A package rather than a module: retry as "<pkg>.__main__".
    mp_obj_t dest[2];
    mp_load_method_protected(mod, MP_QSTR___path__, dest, true);
    if (dest[0] != MP_OBJ_NULL && !subpkg_tried) {
        subpkg_tried = true;
        vstr_t vstr;
        size_t len = strlen(mod_name);
        vstr_init(&vstr, len + sizeof(".__main__"));
        vstr_add_strn(&vstr, mod_name, len);
        vstr_add_strn(&vstr, ".__main__", sizeof(".__main__") - 1);
        import_args[0] = mp_obj_new_str_from_vstr(&vstr);
        goto reimport;
    }
    return EXIT_OK;
}
#endif

// argv[start..argc) become sys.argv, omitting index `skip` (-1 for none —
// only `-c` uses it, to keep the command body out of the list).
#if MICROPY_PY_SYS_ARGV
static void set_sys_argv(char **argv, int argc, int start, int skip) {
    for (int i = start; i < argc; i++) {
        if (i == skip) {
            continue;
        }
        mp_obj_list_append(mp_sys_argv, mp_obj_new_str_from_cstr(argv[i]));
    }
}
#else
#define set_sys_argv(argv, argc, start, skip) ((void)0)
#endif

static void print_usage(void) {
    printf(
        "usage: micropython [option] [-c cmd | -m mod | file | -] [arg]...\n"
        "options:\n"
        "  -c cmd  : program passed in as a string\n"
        "  -m mod  : run a module on sys.path as __main__\n"
        "  -h      : print this help message and exit\n"
        "  -V      : print the MicroPython version and exit\n"
        "  -       : read the program from stdin\n"
        "With no file and a tty on stdin, an interactive REPL is started.\n");
}

int main(int argc, char **argv) {
    int stack_dummy;
    stack_top = (char *)&stack_dummy;

    #if MICROPY_ENABLE_GC
    gc_init(heap, heap + sizeof(heap));
    #endif
    mp_init();
    setup_sys_path(argc > 0 ? argv[0] : NULL);

    #if !MICROPY_ENABLE_COMPILER
    pyexec_frozen_module("frozentest.py", false);
    mp_deinit();
    return EXIT_OK;
    #else

    // --- parse the command line ---------------------------------------
    // Everything after the script name (or after `-c cmd`) belongs to the
    // program, not to us — same as CPython/upstream-unix.
    const char *run_file = NULL;   // script path, or "-" for stdin
    const char *run_cmd = NULL;    // -c body
    const char *run_mod = NULL;    // -m module name
    int arg0 = argc;               // index in argv of sys.argv[0]
    int a = 1;
    for (; a < argc; a++) {
        const char *s = argv[a];
        if (s[0] != '-' || s[1] == '\0') {
            // A bare "-" means stdin; anything else is the script path.
            run_file = s;
            arg0 = a;
            break;
        }
        if (!strcmp(s, "-h") || !strcmp(s, "--help")) {
            print_usage();
            mp_deinit();
            return EXIT_OK;
        }
        if (!strcmp(s, "-V") || !strcmp(s, "--version")) {
            printf(MICROPY_BANNER_NAME_AND_VERSION "; " MICROPY_BANNER_MACHINE "\n");
            mp_deinit();
            return EXIT_OK;
        }
        if (!strcmp(s, "-c")) {
            if (a + 1 >= argc) {
                fprintf(stderr, "micropython: -c needs an argument\n");
                mp_deinit();
                return EXIT_USAGE;
            }
            run_cmd = argv[a + 1];
            arg0 = a;   // sys.argv[0] is "-c", per CPython
            a += 1;
            break;
        }
        #if MICROPY_MODULE_OVERRIDE_MAIN_IMPORT
        if (!strcmp(s, "-m")) {
            if (a + 1 >= argc) {
                fprintf(stderr, "micropython: -m needs an argument\n");
                mp_deinit();
                return EXIT_USAGE;
            }
            run_mod = argv[a + 1];
            arg0 = a + 1;   // CPython: sys.argv[0] is the module, then its args
            a += 1;
            break;
        }
        #endif
        // Unknown option. Refuse loudly rather than silently treating it as a
        // filename.
        fprintf(stderr, "micropython: unknown option %s\n", s);
        print_usage();
        mp_deinit();
        return EXIT_USAGE;
    }

    int ret;
    if (run_mod != NULL) {
        #if MICROPY_MODULE_OVERRIDE_MAIN_IMPORT
        // sys.path[0] stays "" (cwd) for -m, as CPython does.
        set_sys_argv(argv, argc, arg0, -1);
        ret = do_module(run_mod);
        #else
        ret = EXIT_USAGE;
        #endif
    } else if (run_cmd != NULL) {
        // CPython: sys.argv == ["-c", <program args>...] — the command BODY is
        // argv[arg0 + 1] and is deliberately not in the list.
        set_sys_argv(argv, argc, arg0, arg0 + 1);
        ret = do_str(run_cmd, strlen(run_cmd), MP_QSTR__lt_string_gt_, MP_PARSE_FILE_INPUT);
    } else if (run_file != NULL && strcmp(run_file, "-") != 0) {
        set_sys_argv(argv, argc, arg0, -1);  // [<script>, <program args>...]
        sys_path_set_script_dir(run_file);
        ret = do_file(run_file);
    } else if (run_file != NULL) {
        set_sys_argv(argv, argc, arg0, -1);  // ["-", <program args>...]
        ret = do_stdin();
    } else if (isatty(STDIN_FILENO)) {
        #if MICROPY_PY_SYS_ARGV
        mp_obj_list_append(mp_sys_argv, MP_OBJ_NEW_QSTR(MP_QSTR_));
        #endif
        #if MICROPY_REPL_EVENT_DRIVEN
        pyexec_event_repl_init();
        for (;;) {
            int c = mp_hal_stdin_rx_chr();
            if (pyexec_event_repl_process_char(c)) {
                break;
            }
        }
        ret = EXIT_OK;
        #else
        pyexec_friendly_repl();
        ret = EXIT_OK;
        #endif
    } else {
        #if MICROPY_PY_SYS_ARGV
        mp_obj_list_append(mp_sys_argv, MP_OBJ_NEW_QSTR(MP_QSTR_));
        #endif
        ret = do_stdin();
    }

    mp_deinit();
    return ret;
    #endif // MICROPY_ENABLE_COMPILER
}

#if MICROPY_ENABLE_GC
void gc_collect(void) {
    // WARNING: This gc_collect implementation doesn't try to get root
    // pointers from CPU registers, and thus may function incorrectly.
    void *dummy;
    gc_collect_start();
    gc_collect_root(&dummy, ((mp_uint_t)stack_top - (mp_uint_t)&dummy) / sizeof(mp_uint_t));
    gc_collect_end();
}
#endif

// mp_lexer_new_from_file is supplied by py/lexer.c over py/reader.c's POSIX
// reader (MICROPY_READER_POSIX) — the port only owns the stat half.
mp_import_stat_t mp_import_stat(const char *path) {
    struct stat st;
    if (stat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode)) {
            return MP_IMPORT_STAT_DIR;
        } else if (S_ISREG(st.st_mode)) {
            return MP_IMPORT_STAT_FILE;
        }
    }
    return MP_IMPORT_STAT_NO_EXIST;
}

void nlr_jump_fail(void *val) {
    while (1) {
        ;
    }
}

void MP_NORETURN __fatal_error(const char *msg) {
    while (1) {
        ;
    }
}

#ifndef NDEBUG
void MP_WEAK __assert_func(const char *file, int line, const char *func, const char *expr) {
    printf("Assertion '%s' failed, at file %s:%d\n", expr, file, line);
    __fatal_error("Assertion failed");
}
#endif

#if MICROPY_MIN_USE_CORTEX_CPU

// this is a minimal IRQ and reset framework for any Cortex-M CPU

extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;

void Reset_Handler(void) __attribute__((naked));
void Reset_Handler(void) {
    // set stack pointer
    __asm volatile ("ldr sp, =_estack");
    // copy .data section from flash to RAM
    for (uint32_t *src = &_sidata, *dest = &_sdata; dest < &_edata;) {
        *dest++ = *src++;
    }
    // zero out .bss section
    for (uint32_t *dest = &_sbss; dest < &_ebss;) {
        *dest++ = 0;
    }
    // jump to board initialisation
    void _start(void);
    _start();
}

void Default_Handler(void) {
    for (;;) {
    }
}

const uint32_t isr_vector[] __attribute__((section(".isr_vector"))) = {
    (uint32_t)&_estack,
    (uint32_t)&Reset_Handler,
    (uint32_t)&Default_Handler, // NMI_Handler
    (uint32_t)&Default_Handler, // HardFault_Handler
    (uint32_t)&Default_Handler, // MemManage_Handler
    (uint32_t)&Default_Handler, // BusFault_Handler
    (uint32_t)&Default_Handler, // UsageFault_Handler
    0,
    0,
    0,
    0,
    (uint32_t)&Default_Handler, // SVC_Handler
    (uint32_t)&Default_Handler, // DebugMon_Handler
    0,
    (uint32_t)&Default_Handler, // PendSV_Handler
    (uint32_t)&Default_Handler, // SysTick_Handler
};

void _start(void) {
    // when we get here: stack is initialised, bss is clear, data is copied

    // SCB->CCR: enable 8-byte stack alignment for IRQ handlers, in accord with EABI
    *((volatile uint32_t *)0xe000ed14) |= 1 << 9;

    // initialise the cpu and peripherals
    #if MICROPY_MIN_USE_STM32_MCU
    void stm32_init(void);
    stm32_init();
    #endif

    // now that we have a basic system up and running we can call main
    main(0, NULL);

    // we must not return
    for (;;) {
    }
}

#endif

#if MICROPY_MIN_USE_STM32_MCU

// this is minimal set-up code for an STM32 MCU

typedef struct {
    volatile uint32_t CR;
    volatile uint32_t PLLCFGR;
    volatile uint32_t CFGR;
    volatile uint32_t CIR;
    uint32_t _1[8];
    volatile uint32_t AHB1ENR;
    volatile uint32_t AHB2ENR;
    volatile uint32_t AHB3ENR;
    uint32_t _2;
    volatile uint32_t APB1ENR;
    volatile uint32_t APB2ENR;
} periph_rcc_t;

typedef struct {
    volatile uint32_t MODER;
    volatile uint32_t OTYPER;
    volatile uint32_t OSPEEDR;
    volatile uint32_t PUPDR;
    volatile uint32_t IDR;
    volatile uint32_t ODR;
    volatile uint16_t BSRRL;
    volatile uint16_t BSRRH;
    volatile uint32_t LCKR;
    volatile uint32_t AFR[2];
} periph_gpio_t;

typedef struct {
    volatile uint32_t SR;
    volatile uint32_t DR;
    volatile uint32_t BRR;
    volatile uint32_t CR1;
} periph_uart_t;

#define USART1 ((periph_uart_t *)0x40011000)
#define GPIOA  ((periph_gpio_t *)0x40020000)
#define GPIOB  ((periph_gpio_t *)0x40020400)
#define RCC    ((periph_rcc_t *)0x40023800)

// simple GPIO interface
#define GPIO_MODE_IN (0)
#define GPIO_MODE_OUT (1)
#define GPIO_MODE_ALT (2)
#define GPIO_PULL_NONE (0)
#define GPIO_PULL_UP (0)
#define GPIO_PULL_DOWN (1)
void gpio_init(periph_gpio_t *gpio, int pin, int mode, int pull, int alt) {
    gpio->MODER = (gpio->MODER & ~(3 << (2 * pin))) | (mode << (2 * pin));
    // OTYPER is left as default push-pull
    // OSPEEDR is left as default low speed
    gpio->PUPDR = (gpio->PUPDR & ~(3 << (2 * pin))) | (pull << (2 * pin));
    gpio->AFR[pin >> 3] = (gpio->AFR[pin >> 3] & ~(15 << (4 * (pin & 7)))) | (alt << (4 * (pin & 7)));
}
#define gpio_get(gpio, pin) ((gpio->IDR >> (pin)) & 1)
#define gpio_set(gpio, pin, value) do { gpio->ODR = (gpio->ODR & ~(1 << (pin))) | (value << pin); } while (0)
#define gpio_low(gpio, pin) do { gpio->BSRRH = (1 << (pin)); } while (0)
#define gpio_high(gpio, pin) do { gpio->BSRRL = (1 << (pin)); } while (0)

void stm32_init(void) {
    // basic MCU config
    RCC->CR |= (uint32_t)0x00000001; // set HSION
    RCC->CFGR = 0x00000000; // reset all
    RCC->CR &= (uint32_t)0xfef6ffff; // reset HSEON, CSSON, PLLON
    RCC->PLLCFGR = 0x24003010; // reset PLLCFGR
    RCC->CR &= (uint32_t)0xfffbffff; // reset HSEBYP
    RCC->CIR = 0x00000000; // disable IRQs

    // leave the clock as-is (internal 16MHz)

    // enable GPIO clocks
    RCC->AHB1ENR |= 0x00000003; // GPIOAEN, GPIOBEN

    // turn on an LED! (on pyboard it's the red one)
    gpio_init(GPIOA, 13, GPIO_MODE_OUT, GPIO_PULL_NONE, 0);
    gpio_high(GPIOA, 13);

    // enable UART1 at 9600 baud (TX=B6, RX=B7)
    gpio_init(GPIOB, 6, GPIO_MODE_ALT, GPIO_PULL_NONE, 7);
    gpio_init(GPIOB, 7, GPIO_MODE_ALT, GPIO_PULL_NONE, 7);
    RCC->APB2ENR |= 0x00000010; // USART1EN
    USART1->BRR = (104 << 4) | 3; // 16MHz/(16*104.1875) = 9598 baud
    USART1->CR1 = 0x0000200c; // USART enable, tx enable, rx enable
}

#endif
