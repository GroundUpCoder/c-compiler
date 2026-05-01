#include <stdio.h>
#include <emscripten.h>

/* Test that EMSCRIPTEN_KEEPALIVE is defined and expands to nothing */
EMSCRIPTEN_KEEPALIVE void my_exported_func(void) {}

/* Test that emscripten_async_call and emscripten_random are declared */
void (*async_call_ptr)(void (*)(void *), void *, int) = emscripten_async_call;
float (*random_ptr)(void) = emscripten_random;

int main(void) {
    /* Verify the function pointers are non-null (they should be, as they're real functions) */
    printf("async_call_ptr: %s\n", async_call_ptr ? "ok" : "null");
    printf("random_ptr: %s\n", random_ptr ? "ok" : "null");
    printf("EMSCRIPTEN_KEEPALIVE works\n");
    return 0;
}
