// Bug: file-scope compound literal used as a *value* initializer for scalar
// globals silently zero-initializes. ConstEval::evaluate() for
// COMPOUND_LITERAL only handles array-to-pointer decay, not scalar value
// extraction. For REGISTER globals, eval returns nullopt → zero-init with
// warning. For MEMORY globals (address-taken), same issue.
//
// Root cause: ConstEval::evaluate() case ExprKind::COMPOUND_LITERAL returns
// std::nullopt for non-array types instead of looking through the init list
// to extract the scalar value.

#include <stdio.h>

int gi = (int){42};
float gf = (float){3.14f};
long gl = (long){999};
char gc = (char){'A'};

// Also verify address-taken scalars (MEMORY path) have the same issue
int gi2 = (int){77};
int *gi2_addr = &gi2;  // forces gi2 to MEMORY alloc class

int main(void) {
    printf("%d\n", gi);
    printf("%.2f\n", gf);
    printf("%ld\n", gl);
    printf("%c\n", gc);
    printf("%d\n", *gi2_addr);
    return 0;
}
