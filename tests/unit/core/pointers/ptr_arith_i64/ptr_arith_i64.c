#include <stdio.h>

int main(void) {
    char t[] = "012345678";
    char *data = t;
    unsigned long long r = 4;
    unsigned a = 5;
    unsigned long long b = 12;

    *(unsigned *)(data + r) += a - b;

    printf("data = \"%s\"\n", data);
    return 0;
}
