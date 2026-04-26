#include <stdio.h>

unsigned int a = ~0U;
unsigned int b = ~1U;
int c = ~0;
int d = ~0xFF;

int main(void) {
    printf("%u %u %d %d\n", a, b, c, d);
    return 0;
}
