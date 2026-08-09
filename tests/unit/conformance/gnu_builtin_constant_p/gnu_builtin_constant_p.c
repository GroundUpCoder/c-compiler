// BUG: __builtin_constant_p was rejected (undeclared identifier) — GNU
// builtin probed by real-world ports. Folds at compile time via the
// existing ConstEval: 1 when the operand is a constant expression
// (integer or floating), 0 otherwise (conservative — gcc docs permit
// returning 0 for any argument). The operand is NOT evaluated (x++
// must not run). The result is itself an integer constant expression
// (usable in a static array size). #587.
// EXPECT: matches clang -O0 output exactly.
#include <stdio.h>

enum { E = 7 };
int g = 3;
static int arr[__builtin_constant_p(4) + 1];

int main(void) {
    int x = 0;
    int local = 5;
    printf("%d %d %d %d\n",
        __builtin_constant_p(42),
        __builtin_constant_p(1 + 2 * 3),
        __builtin_constant_p(E),
        __builtin_constant_p(sizeof(int)));
    printf("%d %d %d\n",
        __builtin_constant_p(g),
        __builtin_constant_p(local),
        __builtin_constant_p(g + 1));
    printf("%d %d\n", __builtin_constant_p(x++), x);
    double d = 2.0;
    printf("%d %d\n", __builtin_constant_p(1.5), __builtin_constant_p(d));
    printf("%d\n", (int)(sizeof arr / sizeof arr[0]));
    return 0;
}
