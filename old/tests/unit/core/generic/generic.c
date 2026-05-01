#include <stdio.h>

#define type_name(x) _Generic((x), \
    int: "int", \
    long: "long", \
    float: "float", \
    double: "double", \
    char *: "char *", \
    default: "other")

int addi(int a, int b) { return a + b; }
double addd(double a, double b) { return a + b; }

int main(void) {
    int i = 0;
    long l = 0;
    float f = 0;
    double d = 0;
    char *s = "hello";
    short sh = 0;

    // Basic type dispatch
    printf("%s\n", type_name(i));
    printf("%s\n", type_name(l));
    printf("%s\n", type_name(f));
    printf("%s\n", type_name(d));
    printf("%s\n", type_name(s));
    printf("%s\n", type_name(sh));   // hits default

    // _Generic in expression context
    int result = _Generic(i, int: 42, double: 99);
    printf("%d\n", result);

    // _Generic selecting a function then calling it (postfix '(' after _Generic)
    // This is what tgmath.h depends on — would break if _Generic were
    // parsed somewhere that skips postfixExpression handling
    int call_result = _Generic(i, int: addi, double: addd)(10, 20);
    printf("%d\n", call_result);

    double dcall = _Generic(d, int: addi, double: addd)(1.5, 2.5);
    printf("%.1f\n", dcall);

    // _Generic result used with other postfix: subscript
    int arr[] = {10, 20, 30};
    double darr[] = {1.1, 2.2, 3.3};
    int sub = _Generic(i, int: arr, double: darr)[2];
    printf("%d\n", sub);

    // _Generic as argument to another call
    printf("%s\n", _Generic(f, float: "is-float", default: "not-float"));

    // Nested _Generic
    printf("%s\n", _Generic(
        _Generic(i, int: 1.0f, double: 2.0),
        float: "inner-was-float",
        double: "inner-was-double",
        default: "inner-was-other"
    ));

    // _Generic with sizeof result type verification
    printf("sizeof=%d\n", (int)sizeof(_Generic(f, float: f, double: d)));
    printf("sizeof=%d\n", (int)sizeof(_Generic(d, float: f, double: d)));

    return 0;
}
