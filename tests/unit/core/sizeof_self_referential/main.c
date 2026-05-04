#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int x; int y; } Point;

typedef struct Node {
    int value;
    struct Node *next;
} Node;

int main() {
    // 1. sizeof(*var) in own initializer — the classic malloc pattern
    Point *p = (Point *)malloc(sizeof(*p));
    p->x = 10;
    p->y = 20;
    printf("%d %d\n", p->x, p->y);
    free(p);

    // 2. sizeof(*var) with a linked list node
    Node *n = (Node *)malloc(sizeof(*n));
    n->value = 42;
    n->next = 0;
    printf("%d\n", n->value);
    free(n);

    // 3. calloc pattern with sizeof(*var)
    Point *arr = (Point *)calloc(3, sizeof(*arr));
    arr[0].x = 1; arr[1].x = 2; arr[2].x = 3;
    printf("%d %d %d\n", arr[0].x, arr[1].x, arr[2].x);
    free(arr);

    // 4. Variable used in non-sizeof expression in own initializer (self-init)
    int a = 0;
    int b = (a = 5, a + 1);
    printf("%d\n", b);

    // 5. sizeof(var) (not pointer deref) in own initializer
    char buf[64];
    int sz = sizeof(buf);
    printf("%d\n", sz);

    // 6. Multiple declarators — second uses first, first uses sizeof(*self)
    Point *q = (Point *)malloc(sizeof(*q)), *r = q;
    q->x = 99;
    printf("%d\n", r->x);
    free(q);

    // 7. Nested sizeof in own initializer
    int **pp = (int **)malloc(sizeof(*pp));
    *pp = (int *)malloc(sizeof(**pp));
    **pp = 77;
    printf("%d\n", **pp);
    free(*pp);
    free(pp);

    return 0;
}
