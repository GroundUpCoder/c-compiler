#include <stdio.h>

unsigned int a = (unsigned)-1;
unsigned int b = (unsigned)-1 / 2;
unsigned int c = 0xFFFFFFFF;
unsigned int d = 0x80000000U >> 1;

int main(void) {
    printf("%u %u %u %u\n", a, b, c, d);
    return 0;
}
