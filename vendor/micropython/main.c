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
    mp_obj_t exc = MP_OBJ_FROM_PTR(nlr.ret_val);
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
        "usage: micropython [option] [-c cmd | file | -] [arg]...\n"
        "options:\n"
        "  -c cmd  : program passed in as a string\n"
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
        // Unknown option. Refuse loudly rather than silently treating it as
        // a filename — `-m` in particular is a real feature this port does
        // not have yet (module import lands in todos/0117 R2).
        fprintf(stderr, "micropython: unknown option %s\n", s);
        print_usage();
        mp_deinit();
        return EXIT_USAGE;
    }

    int ret;
    if (run_cmd != NULL) {
        // CPython: sys.argv == ["-c", <program args>...] — the command BODY is
        // argv[arg0 + 1] and is deliberately not in the list.
        set_sys_argv(argv, argc, arg0, arg0 + 1);
        ret = do_str(run_cmd, strlen(run_cmd), MP_QSTR__lt_string_gt_, MP_PARSE_FILE_INPUT);
    } else if (run_file != NULL && strcmp(run_file, "-") != 0) {
        set_sys_argv(argv, argc, arg0, -1);  // [<script>, <program args>...]
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
