#include <stdio.h>
typedef enum { A, B, C } E;
typedef struct { E e; int x; } S;
S s;
int main() {
    s.e = B;
    s.x = 42;
    printf("%d %d\n", s.e, s.x);
    return 0;
}
