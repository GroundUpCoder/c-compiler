#include <stdio.h>

int x, y;
int same = &x == &x;
int diff = &x == &y;
int neq = &x != &y;

int main(void) {
    printf("%d %d %d\n", same, diff, neq);
    return 0;
}
