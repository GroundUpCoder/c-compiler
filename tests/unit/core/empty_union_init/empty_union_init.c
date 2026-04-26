#include <stdio.h>

union U {
    int i;
    int j[4];
};

int main(void) {
    union U t = {};
    int i;
    for (i = 0; i < 4; i++) {
        printf("%d\n", t.j[i]);
    }
    return 0;
}
