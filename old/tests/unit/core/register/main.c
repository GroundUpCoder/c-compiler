#include <stdio.h>

int sum(register int a, register int b) {
    return a + b;
}

int main() {
    register int x = 10;
    register int y = 20;
    printf("%d\n", sum(x, y));

    register char c = 'A';
    printf("%c\n", c);

    register int i;
    int total = 0;
    for (i = 0; i < 5; i++) {
        total += i;
    }
    printf("%d\n", total);
    return 0;
}
