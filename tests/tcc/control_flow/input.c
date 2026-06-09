int classify(int v) {
  switch (v) {
    case 0: return 10;
    case 1: return 11;
    case 2: return 12;
    case 5: return 15;
    case 100: return 110;
    default: return -1;
  }
}
int collatz(int n) {
  int steps = 0;
  while (n != 1) {
    if (n & 1) n = 3 * n + 1; else n >>= 1;
    steps++;
    if (steps > 1000) goto overflow;
  }
  return steps;
overflow:
  return -1;
}
int duff(char *to, const char *from, int count) {
  int n = (count + 7) / 8;
  switch (count % 8) {
    case 0: do { *to++ = *from++;
    case 7:      *to++ = *from++;
    case 6:      *to++ = *from++;
    case 5:      *to++ = *from++;
    case 4:      *to++ = *from++;
    case 3:      *to++ = *from++;
    case 2:      *to++ = *from++;
    case 1:      *to++ = *from++;
            } while (--n > 0);
  }
  return count;
}
