// Cross-width boxing/unboxing: all integer and float types share
// two box types (__Box_i64, __Box_f64), so cross-width round-trips work.
#include <stdio.h>

void print_eqref_int(__eqref e) { printf("%d\n", __cast(int, e)); }
void print_eqref_ll(__eqref e)  { printf("%lld\n", __cast(long long, e)); }
void print_eqref_d(__eqref e)   { printf("%.2f\n", __cast(double, e)); }
void print_eqref_f(__eqref e)   { printf("%.2f\n", (double)__cast(float, e)); }

int main(void) {
    // --- Integer cross-width ---

    // box char, unbox as int
    char c = 'A';
    __eqref ec = c;
    print_eqref_int(ec);

    // box short, unbox as int
    short s = -1234;
    __eqref es = s;
    print_eqref_int(es);

    // box int, unbox as long long
    int i = 42;
    __eqref ei = i;
    print_eqref_ll(ei);

    // box long long, unbox as int (narrowing)
    long long ll = 99LL;
    __eqref ell = ll;
    print_eqref_int(ell);

    // box unsigned char, unbox as int
    unsigned char uc = 255;
    __eqref euc = uc;
    print_eqref_int(euc);

    // box int, unbox as char (narrowing)
    __eqref e200 = 200;
    printf("%d\n", (int)__cast(char, e200));

    // --- Float cross-width ---

    // box float, unbox as double
    float f = 3.14f;
    __eqref ef = f;
    print_eqref_d(ef);

    // box double, unbox as float (narrowing)
    double d = 2.718;
    __eqref ed = d;
    print_eqref_f(ed);

    // --- Implicit boxing in function args ---
    print_eqref_int(42);
    print_eqref_ll(42);
    print_eqref_d(3.14);
    print_eqref_f(3.14);

    // --- Implicit boxing in return ---
    // (already tested elsewhere, but verify it still works)
    __eqref ret = 777;
    printf("%d\n", __cast(int, ret));

    return 0;
}
