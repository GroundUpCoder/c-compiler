#include <stdio.h>

void copy(int *restrict dst, const int *restrict src, int n) {
    for (int i = 0; i < n; i++) {
        dst[i] = src[i];
    }
}

int main(void) {
    int a[] = {1, 2, 3};
    int b[3];
    copy(b, a, 3);
    printf("%d %d %d\n", b[0], b[1], b[2]);
    return 0;
}
