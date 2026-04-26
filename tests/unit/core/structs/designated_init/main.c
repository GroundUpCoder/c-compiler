#include <stdio.h>

struct Point {
    int x;
    int y;
    int z;
};

union Val {
    int i;
    float f;
};

// Global designated init
struct Point g1 = {.x = 10, .y = 20, .z = 30};

// Global out-of-order
struct Point g2 = {.z = 300, .x = 100, .y = 200};

// Global partial (unspecified fields should be 0)
struct Point g3 = {.y = 42};

// Global union designator (non-first member)
union Val g4 = {.f = 3.14f};

// Global union designator (first member)
union Val g5 = {.i = 99};

int main() {
    // Local designated init
    struct Point p1 = {.x = 1, .y = 2, .z = 3};
    printf("p1: %d %d %d\n", p1.x, p1.y, p1.z);

    // Local out-of-order
    struct Point p2 = {.z = 33, .x = 11, .y = 22};
    printf("p2: %d %d %d\n", p2.x, p2.y, p2.z);

    // Partial: unspecified fields should be 0
    struct Point p3 = {.y = 55};
    printf("p3: %d %d %d\n", p3.x, p3.y, p3.z);

    // Mixed positional + designated
    struct Point p4 = {1, .z = 3};
    printf("p4: %d %d %d\n", p4.x, p4.y, p4.z);

    // Local union designator (non-first member)
    union Val v1 = {.f = 2.5f};
    printf("v1.f: %.1f\n", (double)v1.f);

    // Local union designator (first member)
    union Val v2 = {.i = 77};
    printf("v2.i: %d\n", v2.i);

    // Globals
    printf("g1: %d %d %d\n", g1.x, g1.y, g1.z);
    printf("g2: %d %d %d\n", g2.x, g2.y, g2.z);
    printf("g3: %d %d %d\n", g3.x, g3.y, g3.z);
    printf("g4.f: %.2f\n", (double)g4.f);
    printf("g5.i: %d\n", g5.i);

    return 0;
}
