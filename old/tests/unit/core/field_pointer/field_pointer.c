/* Take address of struct field, modify through pointer */
#include <stdio.h>

void set_via_ptr(int *p, int val) { *p = val; }

int main(void) {
    struct { int x; int y; int z; } s = { 1, 2, 3 };

    int *py = &s.y;
    *py = 99;
    if (s.y != 99) { printf("FAIL: modify via &s.y\n"); return 1; }
    if (s.x != 1 || s.z != 3) { printf("FAIL: other fields changed\n"); return 1; }

    set_via_ptr(&s.z, 42);
    if (s.z != 42) { printf("FAIL: modify via function(&s.z)\n"); return 1; }

    /* Array of structs, pointer to field */
    struct { int a; int b; } arr[3] = { {10,20}, {30,40}, {50,60} };
    int *p = &arr[1].b;
    *p = 999;
    if (arr[1].b != 999) { printf("FAIL: &arr[1].b\n"); return 1; }
    if (arr[0].b != 20 && arr[2].b != 60) { printf("FAIL: other elements changed\n"); return 1; }

    printf("PASS\n");
    return 0;
}
