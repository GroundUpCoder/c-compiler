/* Float constant parsing exercised tcc's parse_number, which compiler.js
 * miscompiled via the goto-normalizer (float_frac_parse label hoist). */
double d1 = 0.5;
double d2 = .25;
double d3 = 1e3;
double d4 = 12.5e-2;
float f1 = 0.5f;
float f2 = 3.14159f;
/* no long double constants: tcc can't cross-compile them when the
   host long double differs from i386's 80-bit format */
double hexf = 0x1.8p1;
double arith(double a, double b) { return (a + b) * (a - b) / b; }
float fmix(float x) { return x * 2.0f + 0.5f; }
int cmp(double a, double b) { return a < b ? -1 : (a > b ? 1 : 0); }
