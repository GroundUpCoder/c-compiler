#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

int int_cmp(const void *a, const void *b) {
  int ia = *(const int *)a;
  int ib = *(const int *)b;
  if (ia < ib) return -1;
  if (ia > ib) return 1;
  return 0;
}

int main() {
  // abs / labs
  printf("abs(5)=%d\n", abs(5));
  printf("abs(-5)=%d\n", abs(-5));
  printf("abs(0)=%d\n", abs(0));
  printf("labs(100)=%ld\n", labs(100));
  printf("labs(-100)=%ld\n", labs(-100));

  // atoi / atol
  printf("atoi(\"42\")=%d\n", atoi("42"));
  printf("atoi(\"-7\")=%d\n", atoi("-7"));
  printf("atoi(\"  123\")=%d\n", atoi("  123"));
  printf("atoi(\"+99\")=%d\n", atoi("+99"));
  printf("atoi(\"abc\")=%d\n", atoi("abc"));
  printf("atol(\"1000000\")=%ld\n", atol("1000000"));

  // strtol
  char *end;
  printf("strtol(\"123\",10)=%ld\n", strtol("123", &end, 10));
  printf("strtol(\"0xff\",0)=%ld\n", strtol("0xff", &end, 0));
  printf("end=\"%s\"\n", end);
  printf("strtol(\"077\",0)=%ld\n", strtol("077", &end, 0));
  printf("strtol(\"-42\",10)=%ld\n", strtol("-42", &end, 10));
  printf("strtol(\"  +10\",10)=%ld\n", strtol("  +10", &end, 10));
  printf("strtol(\"abc\",0)=%ld\n", strtol("abc", &end, 0));
  printf("end_is_start=%d\n", strcmp(end, "abc") == 0);
  // overflow
  printf("strtol(\"9999999999\",10)=%ld\n", strtol("9999999999", &end, 10));
  printf("strtol(\"-9999999999\",10)=%ld\n", strtol("-9999999999", &end, 10));

  // strtoul
  printf("strtoul(\"255\",10)=%lu\n", strtoul("255", &end, 10));
  printf("strtoul(\"0xAB\",0)=%lu\n", strtoul("0xAB", &end, 0));
  // overflow
  printf("strtoul(\"9999999999\",10)=%lu\n", strtoul("9999999999", &end, 10));

  // strtod / atof
  printf("strtod(\"3.14\")=%.2f\n", strtod("3.14", &end));
  printf("end=\"%s\"\n", end);
  printf("strtod(\"  -2.5e1\")=%.1f\n", strtod("  -2.5e1", &end));
  printf("atof(\"1.5\")=%.1f\n", atof("1.5"));

  // rand / srand
  srand(42);
  int r1 = rand();
  int r2 = rand();
  printf("rand_range=%d\n", r1 >= 0 && r1 <= RAND_MAX);
  printf("rand_range=%d\n", r2 >= 0 && r2 <= RAND_MAX);
  // Same seed produces same sequence
  srand(42);
  printf("reproducible=%d\n", rand() == r1 && rand() == r2);

  // bsearch
  int arr[] = {1, 3, 5, 7, 9, 11};
  int key = 7;
  int *found = (int *)bsearch(&key, arr, 6, sizeof(int), int_cmp);
  printf("bsearch(7)=%d\n", found ? *found : -1);
  key = 4;
  found = (int *)bsearch(&key, arr, 6, sizeof(int), int_cmp);
  printf("bsearch(4)=%d\n", found != NULL);

  // qsort
  int unsorted[] = {5, 2, 8, 1, 9, 3};
  qsort(unsorted, 6, sizeof(int), int_cmp);
  printf("sorted:");
  for (int i = 0; i < 6; i++) printf(" %d", unsorted[i]);
  printf("\n");

  // qsort single element
  int single[] = {42};
  qsort(single, 1, sizeof(int), int_cmp);
  printf("single=%d\n", single[0]);

  // EXIT macros
  printf("EXIT_SUCCESS=%d\n", EXIT_SUCCESS);
  printf("EXIT_FAILURE=%d\n", EXIT_FAILURE);

  return 0;
}
