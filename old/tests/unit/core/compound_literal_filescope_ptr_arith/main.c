// Bug: pointer arithmetic on a decayed file-scope compound literal array
// uses elemSize=1 (byte arithmetic) instead of elemSize=sizeof(element).
//
// Root cause: ConstEval binary ADD/SUB for addresses does:
//   Type leftType = bin->left.getType();
//   i32 elemSize = leftType.isPointer() ? getSizeOf(leftType.getPointee()) : 1;
// When the compound literal has array type (e.g. int[3]), the expression type
// may not be recognized as a pointer by isPointer(), falling through to
// elemSize=1. The array-to-pointer decay isn't properly reflected in the
// type that ConstEval sees during address arithmetic.

#include <stdio.h>

// Simple: array + offset
int *p1 = (int[]){10, 20, 30} + 1;

// Chained: array + offset - offset
int *p2 = (int[]){10, 20, 30, 40, 50} + 3 - 1;

int main(void) {
    printf("%d\n", *p1);
    printf("%d\n", *p2);
    return 0;
}
