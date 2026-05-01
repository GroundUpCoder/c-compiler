#include <stdio.h>

struct Point {
    int x;
    int y;
};

void print_point(struct Point *p) {
    printf("(%d, %d)\n", p->x, p->y);
}

int main() {
    // 1. Scalar compound literal
    int a = (int){42};
    printf("%d\n", a);

    // 2. Struct compound literal
    struct Point p = (struct Point){10, 20};
    printf("(%d, %d)\n", p.x, p.y);

    // 3. Struct with designators
    struct Point q = (struct Point){.y = 60, .x = 50};
    printf("(%d, %d)\n", q.x, q.y);

    // 4. Array compound literal
    int *arr = (int[]){100, 200, 300};
    printf("%d %d %d\n", arr[0], arr[1], arr[2]);

    // 5. Address-of compound literal
    int *ptr = &(int){99};
    printf("%d\n", *ptr);

    // 6. As function argument
    print_point(&(struct Point){30, 40});

    // 7. String compound literal
    char *s = (char[]){"hello"};
    printf("%s\n", s);

    // 8. Compound literal in loop (re-initialization each iteration)
    for (int i = 0; i < 3; i++) {
        int *v = &(int){i * 10};
        printf("%d\n", *v);
    }

    // 9. Member access on compound literal
    int mx = (struct Point){70, 80}.x;
    int my = (struct Point){70, 80}.y;
    printf("(%d, %d)\n", mx, my);

    return 0;
}
