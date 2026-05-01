#include <stdio.h>

// File-scope compound literals have static storage duration

// Array compound literal
int *arr = (int[]){10, 20, 30};

// Struct compound literal
struct Point { int x, y; };
struct Point *p = &(struct Point){3, 4};

// Scalar compound literal
int *scalar_ptr = &(int){42};

// Nested struct with array
struct Data {
    int id;
    int values[3];
};
struct Data *d = &(struct Data){99, {1, 2, 3}};

// String compound literal
char *str = (char[]){"hello"};

int main(void) {
    printf("%d %d %d\n", arr[0], arr[1], arr[2]);
    printf("%d %d\n", p->x, p->y);
    printf("%d\n", *scalar_ptr);
    printf("%d %d %d %d\n", d->id, d->values[0], d->values[1], d->values[2]);
    printf("%s\n", str);
    return 0;
}
