static char buffer[1024];
static const char *names[] = { "alpha", "beta", "gamma", 0 };
static int counter;
const char *pick(int i) { return names[i & 3]; }
int strfill(void) {
  int n = 0;
  for (const char **p = names; *p; p++)
    for (const char *q = *p; *q; q++) buffer[n++] = *q;
  counter++;
  return n;
}
int strlen2(const char *s) { int n = 0; while (*s++) n++; return n; }
char esc[] = "tab\there\nnewline \x41 \101 end";
