#include <stdio.h>

/* An object-like macro that expands to a function-like macro's NAME must apply
   that macro to the argument list that follows — even when the invocation is
   itself nested inside another macro's replacement list (preprocessor rescan).
   Regression for the musl/TRE `#define tre_bt_mem_alloc tre_mem_alloc` pattern,
   used inside the BT_STACK_PUSH macro. */

int add(int a, int b) { return a + b; }

#define g(a, b)  add(a, b)
#define h        g            /* object-like -> function-like macro name */
#define CALL(x)  h(x, 3)      /* nested: h(...) appears in another macro body */
#define VIA_OBJ  h(10, 20)    /* object-like macro whose body calls h(...) */

int main(void) {
    printf("%d\n", h(2, 3));   /* direct use: 5 */
    printf("%d\n", CALL(40));  /* nested in function-like macro: 43 */
    printf("%d\n", VIA_OBJ);   /* nested in object-like macro: 30 */
    return 0;
}
