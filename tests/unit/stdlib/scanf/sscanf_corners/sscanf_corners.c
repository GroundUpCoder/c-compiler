#include <stdio.h>
#include <string.h>

int main() {
    int a, b, r;
    char s[64];
    char c1, c2, c3;
    short h;
    int n;
    float f;
    double d;

    /* === Partial match: first succeeds, second fails === */
    a = -1; b = -1;
    r = sscanf("42 abc", "%d %d", &a, &b);
    printf("partial: r=%d a=%d b=%d\n", r, a, b);

    /* === Input exhaustion mid-format === */
    a = -1; b = -1;
    r = sscanf("42", "%d %d", &a, &b);
    printf("exhaust: r=%d a=%d b=%d\n", r, a, b);

    /* === Whitespace-only input with %d === */
    a = -1;
    r = sscanf("   ", "%d", &a);
    printf("ws_only: r=%d a=%d\n", r, a);

    /* === %c does NOT skip whitespace === */
    c1 = 0;
    r = sscanf(" X", "%c", &c1);
    printf("c_noskip: r=%d c='%c'\n", r, c1);

    /* === %c with width reads multiple chars === */
    char cbuf[4] = {0};
    r = sscanf("ABC", "%3c", cbuf);
    printf("c_width: r=%d c='%c%c%c'\n", r, cbuf[0], cbuf[1], cbuf[2]);

    /* === %c not enough input for width === */
    c1 = 0;
    r = sscanf("AB", "%3c", &c1);
    printf("c_short: r=%d\n", r);

    /* === space before %c DOES skip whitespace === */
    c1 = 0;
    r = sscanf("  X", " %c", &c1);
    printf("sp_c: r=%d c='%c'\n", r, c1);

    /* === %s with width limit === */
    memset(s, 0, sizeof(s));
    r = sscanf("abcdefgh", "%3s", s);
    printf("s_width: r=%d s='%s'\n", r, s);

    /* === %[a-z] scanset with range === */
    memset(s, 0, sizeof(s));
    r = sscanf("helloWORLD", "%[a-z]", s);
    printf("scanset: r=%d s='%s'\n", r, s);

    /* === %[^...] negated scanset === */
    memset(s, 0, sizeof(s));
    r = sscanf("hello world", "%[^ ]", s);
    printf("neg_set: r=%d s='%s'\n", r, s);

    /* === %[] with ] as first char === */
    memset(s, 0, sizeof(s));
    r = sscanf("]]]abc", "%[]]]", s);
    printf("bracket: r=%d s='%s'\n", r, s);

    /* === %[^] with ] as first char in negation === */
    memset(s, 0, sizeof(s));
    r = sscanf("hello]world", "%[^]]", s);
    printf("neg_brk: r=%d s='%s'\n", r, s);

    /* === Scanset with width limit === */
    memset(s, 0, sizeof(s));
    r = sscanf("aaaaaaa", "%3[a]", s);
    printf("set_w: r=%d s='%s'\n", r, s);

    /* === Scanset fails immediately (no match) === */
    a = 99;
    r = sscanf("XYZ", "%[a-z]%d", s, &a);
    printf("set_fail: r=%d a=%d\n", r, a);

    /* === Literal matching in format === */
    a = -1;
    r = sscanf("val=42", "val=%d", &a);
    printf("literal: r=%d a=%d\n", r, a);

    /* === Literal match failure === */
    a = -1;
    r = sscanf("vol=42", "val=%d", &a);
    printf("lit_fail: r=%d a=%d\n", r, a);

    /* === Format whitespace matches multiple types === */
    a = -1; b = -1;
    r = sscanf("1\t\n  2", "%d %d", &a, &b);
    printf("ws_types: r=%d a=%d b=%d\n", r, a, b);

    /* === %n does not count as a match === */
    a = -1; n = -1;
    r = sscanf("hello", "%s%n", s, &n);
    printf("n_count: r=%d n=%d\n", r, n);

    /* === %n at start (before any conversion) === */
    n = -1;
    r = sscanf("42", "%n%d", &n, &a);
    printf("n_start: r=%d n=%d a=%d\n", r, n, a);

    /* === Multiple %n track position === */
    a = -1; b = -1;
    int n1 = -1, n2 = -1;
    r = sscanf("12 34", "%d%n %d%n", &a, &n1, &b, &n2);
    printf("n_multi: r=%d a=%d n1=%d b=%d n2=%d\n", r, a, n1, b, n2);

    /* === Suppression does not count as match === */
    a = -1;
    r = sscanf("10 20 30", "%*d %*d %d", &a);
    printf("supp2: r=%d a=%d\n", r, a);

    /* === %hd writes to short === */
    h = -1;
    r = sscanf("300", "%hd", &h);
    printf("hd: r=%d h=%d\n", r, (int)h);

    /* === %hd overflow wraps === */
    h = -1;
    r = sscanf("40000", "%hd", &h);
    printf("hd_ovf: r=%d h=%d\n", r, (int)h);

    /* === %x without 0x prefix === */
    a = -1;
    r = sscanf("ff", "%x", &a);
    printf("x_bare: r=%d a=%d\n", r, a);

    /* === %x with 0X (uppercase) prefix === */
    a = -1;
    r = sscanf("0XAB", "%x", &a);
    printf("x_upper: r=%d a=%d\n", r, a);

    /* === %d on "0" === */
    a = -1;
    r = sscanf("0", "%d", &a);
    printf("d_zero: r=%d a=%d\n", r, a);

    /* === %i on "0" (octal base, still zero) === */
    a = -1;
    r = sscanf("0", "%i", &a);
    printf("i_zero: r=%d a=%d\n", r, a);

    /* === %d with leading + === */
    a = -1;
    r = sscanf("+7", "%d", &a);
    printf("d_plus: r=%d a=%d\n", r, a);

    /* === Scientific notation float === */
    d = 0.0;
    r = sscanf("1.5e3", "%lf", &d);
    printf("sci: r=%d d=%.1f\n", r, d);

    /* === Leading-dot float === */
    f = 0.0f;
    r = sscanf(".25", "%f", &f);
    printf("dotf: r=%d f=%.2f\n", r, (double)f);

    /* === Negative float === */
    d = 0.0;
    r = sscanf("-0.5e1", "%lf", &d);
    printf("negf: r=%d d=%.1f\n", r, d);

    /* === %d with width stops at width === */
    a = -1; b = -1;
    r = sscanf("12345", "%2d%3d", &a, &b);
    printf("dw_pair: r=%d a=%d b=%d\n", r, a, b);

    /* === Only literal format, no conversions === */
    r = sscanf("abc", "abc");
    printf("no_conv: r=%d\n", r);

    /* === Only literal format, mismatch === */
    r = sscanf("abd", "abc");
    printf("no_conv2: r=%d\n", r);

    /* === %% when input has no % === */
    a = -1;
    r = sscanf("100done", "%d%%", &a);
    printf("pct_fail: r=%d a=%d\n", r, a);

    /* === Multiple scansets back to back === */
    char s1[32], s2[32];
    memset(s1, 0, sizeof(s1));
    memset(s2, 0, sizeof(s2));
    r = sscanf("abc123", "%[a-z]%[0-9]", s1, s2);
    printf("set2: r=%d s1='%s' s2='%s'\n", r, s1, s2);

    /* === Scanset with hyphen at end (literal -) === */
    memset(s, 0, sizeof(s));
    r = sscanf("a-b-c", "%[a-c-]", s);
    printf("set_hyp: r=%d s='%s'\n", r, s);

    /* === %o negative === */
    a = -1;
    r = sscanf("-17", "%o", &a);
    printf("o_neg: r=%d a=%d\n", r, a);

    return 0;
}
