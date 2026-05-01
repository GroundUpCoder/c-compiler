/* Recursive tree with enum discriminator and union payload */
#include <stdio.h>

enum NodeKind { NK_LEAF, NK_ADD, NK_MUL };

struct TreeNode {
    enum NodeKind kind;
    union {
        int leaf_val;
        struct { struct TreeNode *left; struct TreeNode *right; } bin;
    } u;
};

int eval(struct TreeNode *n) {
    switch (n->kind) {
        case NK_LEAF: return n->u.leaf_val;
        case NK_ADD: return eval(n->u.bin.left) + eval(n->u.bin.right);
        case NK_MUL: return eval(n->u.bin.left) * eval(n->u.bin.right);
    }
    return 0;
}

int main(void) {
    /* (3 + 4) * 5 = 35 */
    struct TreeNode n3 = { NK_LEAF, { .leaf_val = 3 } };
    struct TreeNode n4 = { NK_LEAF, { .leaf_val = 4 } };
    struct TreeNode n5 = { NK_LEAF, { .leaf_val = 5 } };
    struct TreeNode add_n = { NK_ADD, { .bin = { &n3, &n4 } } };
    struct TreeNode mul_n = { NK_MUL, { .bin = { &add_n, &n5 } } };
    if (eval(&mul_n) != 35) { printf("FAIL: (3+4)*5\n"); return 1; }

    /* 2 * (3 + (4 * 5)) = 2 * 23 = 46 */
    struct TreeNode n2 = { NK_LEAF, { .leaf_val = 2 } };
    struct TreeNode mul45 = { NK_MUL, { .bin = { &n4, &n5 } } };
    struct TreeNode add345 = { NK_ADD, { .bin = { &n3, &mul45 } } };
    struct TreeNode root = { NK_MUL, { .bin = { &n2, &add345 } } };
    if (eval(&root) != 46) { printf("FAIL: 2*(3+(4*5))\n"); return 1; }

    printf("PASS\n");
    return 0;
}
