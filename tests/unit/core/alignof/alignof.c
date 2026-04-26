#include <stdio.h>
#include <stdalign.h>

struct S {
    char c;
    int x;
};

struct Packed {
    char a;
    char b;
};

struct WithDouble {
    char c;
    double d;
};

int main(void) {
    // Basic type alignments
    printf("char: %lu\n", (unsigned long)_Alignof(char));
    printf("short: %lu\n", (unsigned long)_Alignof(short));
    printf("int: %lu\n", (unsigned long)_Alignof(int));
    printf("long: %lu\n", (unsigned long)_Alignof(long));
    printf("long long: %lu\n", (unsigned long)_Alignof(long long));
    printf("float: %lu\n", (unsigned long)_Alignof(float));
    printf("double: %lu\n", (unsigned long)_Alignof(double));

    // Pointer alignment
    printf("ptr: %lu\n", (unsigned long)_Alignof(int *));

    // Struct alignment (max of members)
    printf("S: %lu\n", (unsigned long)_Alignof(struct S));
    printf("Packed: %lu\n", (unsigned long)_Alignof(struct Packed));
    printf("WithDouble: %lu\n", (unsigned long)_Alignof(struct WithDouble));

    // Expression form (GNU extension)
    int x;
    printf("expr: %lu\n", (unsigned long)_Alignof(x));

    // stdalign.h macro
    printf("alignof: %lu\n", (unsigned long)alignof(int));

    // Use in constant expression (array size)
    char arr[_Alignof(int)];
    printf("arr size: %lu\n", (unsigned long)sizeof(arr));

    return 0;
}
