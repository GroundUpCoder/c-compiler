#include <stdio.h>
#include <stdbool.h>

/* continue in do-while must jump to the condition check, not restart the body. */

void test_continue_false_condition(void) {
  printf("=== continue with false condition ===\n");
  int x = 0;
  do {
    x++;
    if (x == 1) continue;
    x += 100;
  } while (0);
  printf("x=%d\n", x); /* 1: body runs once, continue goes to condition, condition is false, exits */
}

void test_continue_counting(void) {
  printf("=== continue skips rest of body ===\n");
  int total = 0;
  int i = 0;
  do {
    i++;
    if (i % 2 == 0) {
      total += i;
      continue;
    }
    total += i * 10;
  } while (i < 6);
  printf("total=%d\n", total); /* 10+2+30+4+50+6=102 */
}

void test_continue_variable_condition(void) {
  printf("=== continue re-checks condition ===\n");
  bool flag = true;
  int count = 0;
  do {
    count++;
    if (count < 3) continue;
    flag = false;
  } while (flag);
  printf("count=%d\n", count); /* 3: loops while flag is true, sets flag=false when count reaches 3 */
}

void test_nested_continue(void) {
  printf("=== nested do-while continue ===\n");
  int outer = 0;
  int inner_total = 0;
  do {
    outer++;
    int j = 0;
    do {
      j++;
      if (j == 2) continue; /* affects inner loop only */
      inner_total += j;
    } while (j < 3);
    /* inner_total += 1 + 3 = 4 each outer iteration (j=2 skipped) */
  } while (outer < 3);
  printf("outer=%d inner_total=%d\n", outer, inner_total); /* 3, 12 */
}

void test_continue_then_break(void) {
  printf("=== continue and break in same do-while ===\n");
  int sum = 0;
  int i = 0;
  do {
    i++;
    if (i > 5) break;
    if (i % 2 == 0) continue;
    sum += i;
  } while (i < 10);
  printf("sum=%d\n", sum); /* 1+3+5=9 */
}

int main(void) {
  test_continue_false_condition();
  test_continue_counting();
  test_continue_variable_condition();
  test_nested_continue();
  test_continue_then_break();
  return 0;
}
