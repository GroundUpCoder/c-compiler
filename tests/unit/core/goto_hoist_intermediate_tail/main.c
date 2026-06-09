/* Regression: hoisting a cross-block label must not skip trailing
 * statements in intermediate compounds. The goto normalizer moved the
 * label + its tail to the LCA but jumped straight past statements that
 * followed the labeled construct inside an intermediate block — they
 * run on every original path. Found via tcc's parse_number(), where
 * the pattern silently broke all float constants and initializers.
 * The normalizer must bail and let irreducible lowering handle it. */
#include <stdio.h>

int f(int t) {
  int r = 0;
  if (t) goto inner;
  r += 1;
  {
    if (1) {
      r += 10;
    inner:
      r += 100;
    }
    r += 1000; /* trailing statement in intermediate block */
  }
  return r;
}

/* The tcc parse_number shape: label inside nested ifs, entered both by
 * forward goto and by natural fall-through, with buffer writes after. */
static char buf[16];
static int tok;
void parse(const char *p) {
  int ch, t;
  char *q = buf;
  tok = -1;
  t = *p++;
  ch = *p++;
  *q++ = t;
  if (t == '.') goto frac;
  while (ch >= '0' && ch <= '9') { *q++ = ch; ch = *p++; }
  if (ch == '.') {
    {
      if (ch == '.') {
        *q++ = ch;
        ch = *p++;
      frac:
        while (ch >= '0' && ch <= '9') { *q++ = ch; ch = *p++; }
      }
      *q = 0;
      tok = 11;
    }
  }
}

int main(void) {
  printf("%d %d\n", f(0), f(1));
  parse("0.5"); printf("%d %s\n", tok, buf);
  parse(".5");  printf("%d %s\n", tok, buf);
  parse("12");  printf("%d\n", tok);
  return 0;
}
