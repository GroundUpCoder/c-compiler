#include <stdio.h>

int main(void) {
    unsigned int a = 42;
    const unsigned int b = 100;
    unsigned long c = 200;
    unsigned short d = 300;
    unsigned char e = 65;
    signed char f = -1;
    unsigned long long g = 999;

    printf("%u %u %lu %u %u %d %llu\n", a, b, c, d, e, f, g);
    return 0;
}
