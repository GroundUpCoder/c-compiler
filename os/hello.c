/* Seeded into /root/hello.c so the canonical smoke test works on first
 * boot:  cc hello.c && ./a.out  */
#include <stdio.h>

int main(void) {
    printf("hello, wasm world\n");
    return 0;
}
