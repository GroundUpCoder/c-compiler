// BUG: ticket #127 codegen control — parameter conversion across the chain's
// prototype is applied identically with and without the unprototyped first
// declaration: f(1) converts 1 -> 1.0 and prints 10, like the control g.
#include <stdio.h>
static int f();
static int f(double x);
static int f(double x) { return (int)(x * 10); }
static int g(double x);
static int g(double x) { return (int)(x * 10); }
int main(void) { printf("%d\n", f(1)); printf("%d\n", g(1)); return 0; }
