#include <stdio.h>
#include <stdlib.h>

// Not null-terminated — no '\0' anywhere
unsigned char buf[10];

int main() {
  // Fill buffer with "3.14" followed by non-numeric junk, no null
  buf[0] = '3';
  buf[1] = '.';
  buf[2] = '1';
  buf[3] = '4';
  buf[4] = 'x';
  buf[5] = 'y';
  buf[6] = 'z';
  buf[7] = 0xFF;
  buf[8] = 0xFE;
  buf[9] = 0xAB;

  char *end;
  double v = strtod((const char *)buf, &end);
  printf("val=%.2f\n", v);
  printf("consumed=%d\n", (int)(end - (char *)buf));

  // Integer-only, no dot, no null
  buf[0] = ' ';
  buf[1] = '4';
  buf[2] = '2';
  buf[3] = '!';
  v = strtod((const char *)buf, &end);
  printf("val=%.1f\n", v);
  printf("consumed=%d\n", (int)(end - (char *)buf));

  // Negative with exponent, no null
  buf[0] = '-';
  buf[1] = '1';
  buf[2] = 'e';
  buf[3] = '2';
  buf[4] = '#';
  v = strtod((const char *)buf, &end);
  printf("val=%.1f\n", v);
  printf("consumed=%d\n", (int)(end - (char *)buf));

  // No valid number at all, no null
  buf[0] = 'a';
  buf[1] = 'b';
  buf[2] = 'c';
  v = strtod((const char *)buf, &end);
  printf("val=%.1f\n", v);
  printf("end_is_start=%d\n", end == (char *)buf);

  // Dot-leading float, no null
  buf[0] = '.';
  buf[1] = '5';
  buf[2] = '!';
  v = strtod((const char *)buf, &end);
  printf("val=%.1f\n", v);
  printf("consumed=%d\n", (int)(end - (char *)buf));

  // atof on null-terminated string (sanity)
  printf("atof=%.2f\n", atof("2.72"));

  return 0;
}
