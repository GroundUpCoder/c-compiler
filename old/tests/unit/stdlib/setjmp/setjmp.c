#include <stdio.h>
#include <setjmp.h>

// ============================
// Test 1: Pattern A basic
// ============================
void test_pattern_a(void) {
    jmp_buf buf;
    printf("pattern A: ");
    if (setjmp(buf) == 0) {
        printf("try ");
        longjmp(buf, 1);
        printf("SHOULD NOT PRINT ");
    } else {
        printf("catch\n");
    }
}

// ============================
// Test 2: Pattern B basic
// ============================
void test_pattern_b(void) {
    jmp_buf buf;
    printf("pattern B: ");
    if (setjmp(buf)) {
        printf("catch\n");
        return;
    }
    printf("try ");
    longjmp(buf, 1);
    printf("SHOULD NOT PRINT\n");
}

// ============================
// Test 3: longjmp across function calls
// ============================
jmp_buf escape;

void might_fail(int should_fail) {
    if (should_fail) {
        printf("about to longjmp with value 42\n");
        longjmp(escape, 42);
    }
    printf("did not fail\n");
}

void test_cross_function(void) {
    printf("cross-function: ");
    if (setjmp(escape) == 0) {
        might_fail(1);
        printf("SHOULD NOT PRINT ");
    } else {
        printf("caught\n");
    }
}

// ============================
// Test 4: normal path (no longjmp)
// ============================
void test_no_longjmp(void) {
    printf("no longjmp: ");
    if (setjmp(escape) == 0) {
        might_fail(0);
        printf("done\n");
    } else {
        printf("SHOULD NOT PRINT\n");
    }
}

// ============================
// Test 5: longjmp value (pattern A)
// ============================
void test_longjmp_value(void) {
    jmp_buf buf;
    printf("value test: ");
    if (setjmp(buf) == 0) {
        longjmp(buf, 99);
    } else {
        printf("caught longjmp\n");
    }
}

// ============================
// Test 6: nested setjmp — inner catches first
// ============================
jmp_buf outer_buf;

void throw_inner(void) {
    jmp_buf inner_buf;
    if (setjmp(inner_buf) == 0) {
        printf("inner try ");
        longjmp(inner_buf, 1);
        printf("SHOULD NOT PRINT ");
    } else {
        printf("inner catch ");
    }
}

void test_nested_setjmp(void) {
    printf("nested: ");
    if (setjmp(outer_buf) == 0) {
        throw_inner();
        printf("outer continues\n");
    } else {
        printf("SHOULD NOT PRINT\n");
    }
}

// ============================
// Test 7: nested setjmp — inner doesn't catch, outer does
// ============================
void throw_to_outer(void) {
    longjmp(outer_buf, 1);
}

void test_nested_outer_catch(void) {
    printf("nested outer catch: ");
    if (setjmp(outer_buf) == 0) {
        throw_to_outer();
        printf("SHOULD NOT PRINT ");
    } else {
        printf("outer caught\n");
    }
}

// ============================
// Test 8: multiple setjmps in same function
// ============================
void test_multiple_setjmps(void) {
    jmp_buf buf1, buf2;
    printf("multi setjmp: ");

    if (setjmp(buf1) == 0) {
        if (setjmp(buf2) == 0) {
            printf("both try ");
            longjmp(buf2, 1);
            printf("SHOULD NOT PRINT ");
        } else {
            printf("inner catch ");
        }
        printf("after inner ");
        longjmp(buf1, 1);
        printf("SHOULD NOT PRINT ");
    } else {
        printf("outer catch\n");
    }
}

// ============================
// Test 9: longjmp through multiple call frames
// ============================
jmp_buf deep_buf;

void deep3(void) {
    printf("deep3 ");
    longjmp(deep_buf, 1);
}

void deep2(void) {
    printf("deep2 ");
    deep3();
}

void deep1(void) {
    printf("deep1 ");
    deep2();
}

void test_deep_longjmp(void) {
    printf("deep: ");
    if (setjmp(deep_buf) == 0) {
        deep1();
        printf("SHOULD NOT PRINT ");
    } else {
        printf("caught\n");
    }
}

// ============================
// Test 10: pattern B with return in catch
// ============================
void test_pattern_b_return(void) {
    jmp_buf buf;
    printf("pattern B return: ");
    if (setjmp(buf)) {
        printf("catch\n");
        return;
    }
    printf("try ");
    longjmp(buf, 1);
}

// ============================
// Test 11: setjmp(buf) != 0 pattern
// ============================
void test_ne_pattern(void) {
    jmp_buf buf;
    printf("ne pattern: ");
    if (setjmp(buf) != 0) {
        printf("catch\n");
        return;
    }
    printf("try ");
    longjmp(buf, 1);
}

// ============================
// Test 12: longjmp with value forwarding through struct
// ============================
typedef struct {
    jmp_buf buf;
    int error_code;
} error_handler;

void risky_operation(error_handler *handler) {
    handler->error_code = 42;
    longjmp(handler->buf, 1);
}

void test_struct_jmpbuf(void) {
    error_handler handler;
    handler.error_code = 0;
    printf("struct jmpbuf: ");
    if (setjmp(handler.buf) == 0) {
        risky_operation(&handler);
        printf("SHOULD NOT PRINT ");
    } else {
        printf("error=%d\n", handler.error_code);
    }
}

// ============================
// Test 13: setjmp in a loop — multiple iterations
// ============================
void throw_if(jmp_buf buf, int cond) {
    if (cond) longjmp(buf, 1);
}

void test_setjmp_in_loop(void) {
    printf("loop: ");
    int caught_count = 0;
    for (int i = 0; i < 3; i++) {
        jmp_buf buf;
        if (setjmp(buf) == 0) {
            throw_if(buf, 1);
        } else {
            caught_count++;
        }
    }
    printf("caught %d times\n", caught_count);
}

// ============================
// Test 14: Lua-style chained handlers — same setjmp call site
// active in multiple stack frames, longjmp to a specific one
// ============================
typedef struct handler {
    struct handler *previous;
    jmp_buf buf;
    int status;
} handler;

handler *current_handler;

void throw_to_current(int errcode) {
    current_handler->status = errcode;
    longjmp(current_handler->buf, 1);
}

void throw_to_base(int errcode) {
    // Walk to outermost handler (like luaD_throwbaselevel)
    while (current_handler->previous != NULL)
        current_handler = current_handler->previous;
    current_handler->status = errcode;
    longjmp(current_handler->buf, 1);
}

int run_protected(void (*f)(void *), void *ud) {
    handler h;
    h.status = 0;
    h.previous = current_handler;
    current_handler = &h;
    if (setjmp(h.buf) == 0) {
        f(ud);
    }
    current_handler = h.previous;
    return h.status;
}

void inner_throw(void *ud) {
    (void)ud;
    throw_to_current(42);
}

void middle_func(void *ud) {
    (void)ud;
    int st = run_protected(inner_throw, NULL);
    printf("inner=%d ", st);
    // Now throw to our own handler
    throw_to_current(99);
}

void test_chained_handlers(void) {
    printf("chained: ");
    current_handler = NULL;
    int st = run_protected(middle_func, NULL);
    printf("outer=%d\n", st);
}

// ============================
// Test 15: throw-to-base skipping intermediate handlers
// Same setjmp call site in 3 nested stack frames, longjmp to outermost
// ============================
void deep_throw_to_base(void *ud) {
    (void)ud;
    // This should unwind past all intermediate handlers to the outermost
    throw_to_base(77);
}

void wrap_deep(void *ud) {
    (void)ud;
    int st = run_protected(deep_throw_to_base, NULL);
    // Should NOT reach here — throw_to_base should skip us
    printf("SHOULD NOT PRINT st=%d ", st);
}

void test_throw_to_base(void) {
    printf("throw-to-base: ");
    current_handler = NULL;
    int st = run_protected(wrap_deep, NULL);
    printf("base=%d\n", st);
}

int main(void) {
    test_pattern_a();
    test_pattern_b();
    test_cross_function();
    test_no_longjmp();
    test_longjmp_value();
    test_nested_setjmp();
    test_nested_outer_catch();
    test_multiple_setjmps();
    test_deep_longjmp();
    test_pattern_b_return();
    test_ne_pattern();
    test_struct_jmpbuf();
    test_setjmp_in_loop();
    test_chained_handlers();
    test_throw_to_base();
    return 0;
}
