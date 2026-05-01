#include <stdio.h>

int classify(int x) {
    switch (x) {
    case 0 ... 9:
        return 0;
    case 10 ... 19:
        return 1;
    case 100:
        return 2;
    default:
        return -1;
    }
}

int main(void) {
    printf("%d\n", classify(0));
    printf("%d\n", classify(5));
    printf("%d\n", classify(9));
    printf("%d\n", classify(10));
    printf("%d\n", classify(15));
    printf("%d\n", classify(100));
    printf("%d\n", classify(50));
    return 0;
}
