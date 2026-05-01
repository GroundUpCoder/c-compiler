#include <stdio.h>

typedef struct Node { int key; int val; } Node;

Node *addr_of_subscript(Node *nodes, unsigned long long idx) {
    return &nodes[idx];
}

int rvalue_subscript(int *arr, long long idx) {
    return arr[idx];
}

int *ptr_add(int *p, long long offset) {
    return p + offset;
}

int *ptr_add_assign(int *p, long long offset) {
    p += offset;
    return p;
}

int *ptr_sub_assign(int *end, long long offset) {
    end -= offset;
    return end;
}

int main(void) {
    Node nodes[8] = {{0,10},{1,20},{2,30},{3,40},{4,50},{5,60},{6,70},{7,80}};
    int arr[8] = {100, 200, 300, 400, 500, 600, 700, 800};

    Node *n = addr_of_subscript(nodes, 3ULL);
    printf("addr_of_subscript: %d\n", n->val);

    int v = rvalue_subscript(arr, 2LL);
    printf("rvalue_subscript: %d\n", v);

    int *p = ptr_add(arr, 4LL);
    printf("ptr_add: %d\n", *p);

    int *q = ptr_add_assign(arr, 5LL);
    printf("ptr_add_assign: %d\n", *q);

    int *r = ptr_sub_assign(arr + 7, 2LL);
    printf("ptr_sub_assign: %d\n", *r);

    unsigned long long ui = 100ULL;
    unsigned int lsizenode = 3;
    unsigned int sizenode = 1u << lsizenode;
    unsigned long long idx = ui % ((sizenode - 1u) | 1u);
    Node *result = &nodes[idx];
    printf("hashmod: %d\n", result->val);

    printf("PASS\n");
    return 0;
}
