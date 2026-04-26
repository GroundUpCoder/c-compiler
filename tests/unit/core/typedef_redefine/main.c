#include <stdio.h>

// C11 6.7p3: typedef redefinition with compatible type is allowed
typedef int myint;
typedef int myint;  // same type — OK

typedef unsigned long size_t2;
typedef unsigned long size_t2;  // same type — OK

typedef int *intptr;
typedef int *intptr;  // same pointer type — OK

struct S { int x; };
typedef struct S S;
typedef struct S S;  // same struct type — OK

int main(void) {
    myint a = 42;
    size_t2 b = 100;
    intptr p = &a;
    S s;
    s.x = 7;
    printf("%d %lu %d %d\n", a, b, *p, s.x);
    return 0;
}
