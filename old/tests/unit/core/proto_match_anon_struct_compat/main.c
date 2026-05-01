#include "shared.h"
#include <stdio.h>

int main(void) {
    Vec3 a = make_vec3(1, 2, 3);
    Vec3 b = make_vec3(4, 5, 6);
    printf("%d\n", (int)vec3_dot(a, b));
    return 0;
}
