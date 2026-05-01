#include <stdio.h>
#include <string.h>

int main() {
    int a, b;
    float f;
    double d;
    char s[64];
    char c;
    int n;

    /* Basic integer parsing */
    a = -1; b = -1;
    int r = sscanf("42 17", "%d %d", &a, &b);
    printf("int: r=%d a=%d b=%d\n", r, a, b);

    /* Hex */
    a = -1;
    r = sscanf("0xff", "%x", &a);
    printf("hex: r=%d a=%d\n", r, a);

    /* Octal */
    a = -1;
    r = sscanf("077", "%o", &a);
    printf("oct: r=%d a=%d\n", r, a);

    /* %i auto-detect: decimal */
    a = -1;
    r = sscanf("99", "%i", &a);
    printf("%%i dec: r=%d a=%d\n", r, a);

    /* %i auto-detect: hex */
    a = -1;
    r = sscanf("0x1A", "%i", &a);
    printf("%%i hex: r=%d a=%d\n", r, a);

    /* %i auto-detect: octal */
    a = -1;
    r = sscanf("010", "%i", &a);
    printf("%%i oct: r=%d a=%d\n", r, a);

    /* String */
    memset(s, 0, sizeof(s));
    r = sscanf("hello world", "%s", s);
    printf("str: r=%d s='%s'\n", r, s);

    /* Float (no length = float) */
    f = 0.0f;
    r = sscanf("3.14", "%f", &f);
    printf("float: r=%d f=%.2f\n", r, (double)f);

    /* Double (%lf) */
    d = 0.0;
    r = sscanf("2.718", "%lf", &d);
    printf("double: r=%d d=%.3f\n", r, d);

    /* %c (single char, no whitespace skip) */
    c = 0;
    r = sscanf("A", "%c", &c);
    printf("char: r=%d c='%c'\n", r, c);

    /* %n (store consumed count) */
    a = -1; n = -1;
    r = sscanf("123 abc", "%d%n", &a, &n);
    printf("%%n: r=%d a=%d n=%d\n", r, a, n);

    /* %% literal percent */
    a = -1;
    r = sscanf("100%done", "%d%%done", &a);
    printf("%%%%: r=%d a=%d\n", r, a);

    /* Width limit */
    a = -1;
    r = sscanf("12345", "%3d", &a);
    printf("width: r=%d a=%d\n", r, a);

    /* * suppression */
    a = -1;
    r = sscanf("10 20", "%*d %d", &a);
    printf("suppress: r=%d a=%d\n", r, a);

    /* Negative integer */
    a = -1;
    r = sscanf("-42", "%d", &a);
    printf("neg: r=%d a=%d\n", r, a);

    /* Multiple types in one call */
    a = -1;
    memset(s, 0, sizeof(s));
    f = 0.0f;
    r = sscanf("7 hello 1.5", "%d %s %f", &a, s, &f);
    printf("multi: r=%d a=%d s='%s' f=%.1f\n", r, a, s, (double)f);

    /* Empty input returns EOF (-1) */
    r = sscanf("", "%d", &a);
    printf("empty: r=%d\n", r);

    /* Unsigned */
    unsigned int u = 0;
    r = sscanf("4000000000", "%u", &u);
    printf("unsigned: r=%d u=%u\n", r, u);

    return 0;
}
