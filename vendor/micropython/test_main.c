// Alternate main() for automated testing: reads the entire script from
// stdin, hands it to MicroPython via do_str(), exits. No REPL — output
// is just the script's output, no prompts/echoes.
//
// Includes the same MicroPython runtime stubs as the minimal port's
// main.c (mp_lexer_new_from_file, mp_import_stat, nlr_jump_fail,
// __fatal_error, gc_collect) so this file is self-contained — the
// test build doesn't link main.c.

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "py/builtin.h"
#include "py/compile.h"
#include "py/runtime.h"
#include "py/repl.h"
#include "py/gc.h"
#include "py/mperrno.h"
#include "shared/runtime/pyexec.h"

#define SCRIPT_MAX 65536
static char script[SCRIPT_MAX + 1];

static char *stack_top;
static char heap[MICROPY_HEAP_SIZE];

static void do_str(const char *src, mp_parse_input_kind_t input_kind) {
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        mp_lexer_t *lex = mp_lexer_new_from_str_len(MP_QSTR__lt_stdin_gt_, src, strlen(src), 0);
        qstr source_name = lex->source_name;
        mp_parse_tree_t parse_tree = mp_parse(lex, input_kind);
        mp_obj_t module_fun = mp_compile(&parse_tree, source_name, true);
        mp_call_function_0(module_fun);
        nlr_pop();
    } else {
        mp_obj_print_exception(&mp_plat_print, (mp_obj_t)nlr.ret_val);
    }
}

int main(int argc, char **argv) {
    int stack_dummy;
    stack_top = (char *)&stack_dummy;

    gc_init(heap, heap + sizeof(heap));
    mp_init();

    size_t n = 0;
    int c;
    while (n < SCRIPT_MAX && (c = getchar()) != EOF) {
        script[n++] = (char)c;
    }
    script[n] = '\0';

    do_str(script, MP_PARSE_FILE_INPUT);

    mp_deinit();
    return 0;
}

// --- runtime stubs (same as minimal port's main.c) ---

void gc_collect(void) {
    void *dummy;
    gc_collect_start();
    gc_collect_root(&dummy, ((mp_uint_t)stack_top - (mp_uint_t)&dummy) / sizeof(mp_uint_t));
    gc_collect_end();
}

mp_lexer_t *mp_lexer_new_from_file(qstr filename) {
    mp_raise_OSError(MP_ENOENT);
}

mp_import_stat_t mp_import_stat(const char *path) {
    return MP_IMPORT_STAT_NO_EXIST;
}

void nlr_jump_fail(void *val) {
    while (1) { ; }
}

void MP_NORETURN __fatal_error(const char *msg) {
    while (1) { ; }
}

#ifndef NDEBUG
void __assert_func(const char *file, int line, const char *func, const char *expr) {
    printf("Assertion '%s' failed, at file %s:%d\n", expr, file, line);
    __fatal_error("Assertion failed");
}
#endif
