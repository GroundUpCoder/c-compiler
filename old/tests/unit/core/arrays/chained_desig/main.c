#include <stdio.h>

struct Pt { int x, y; };

int main() {
    // Array of structs with chained designator
    struct Pt pts[3] = { [1].y = 42 };
    printf("pts: (%d,%d) (%d,%d) (%d,%d)\n",
           pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y);

    // Positional after chained array designator
    int matrix[2][3] = { [0][1] = 5, 6 };
    printf("matrix: %d %d %d / %d %d %d\n",
           matrix[0][0], matrix[0][1], matrix[0][2],
           matrix[1][0], matrix[1][1], matrix[1][2]);

    // Mixed chained and simple
    struct Pt pts2[2] = { [0].x = 1, [1] = {3, 4} };
    printf("pts2: (%d,%d) (%d,%d)\n", pts2[0].x, pts2[0].y, pts2[1].x, pts2[1].y);

    return 0;
}
