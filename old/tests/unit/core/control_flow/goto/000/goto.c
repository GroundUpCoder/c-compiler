#include <stdio.h>

void test_forward_goto() {
  printf("before\n");
  goto skip;
  printf("SHOULD NOT PRINT\n");
skip:
  printf("after\n");
}

void test_forward_goto_from_loop() {
  long i;
  long j;
  for (i = 0; i < 10; i++) {
    for (j = 0; j < 10; j++) {
      if (i == 2 && j == 3) {
        goto done;
      }
    }
  }
done:
  printf("i=%ld j=%ld\n", i, j);
}

void test_multiple_forward_gotos() {
  long x = 0;
  if (x) {
    goto end;
  }
  x = 42;
  goto end;
  x = 99;
end:
  printf("x=%ld\n", x);
}

void test_backward_goto_loop() {
  long count = 0;
again:
  if (count >= 3) {
    goto finish;
  }
  count++;
  goto again;
finish:
  printf("count=%ld\n", count);
}

void test_backward_goto_sum() {
  long sum = 0;
  long n = 1;
top:
  if (n > 5) {
    goto out;
  }
  sum = sum + n;
  n++;
  goto top;
out:
  printf("sum=%ld\n", sum);
}

void test_backward_goto_nested() {
  // backward goto from inside a nested if
  long val = 0;
  long step = 0;
repeat:
  if (step >= 4) {
    goto exit;
  }
  if (step % 2 == 0) {
    val = val + 10;
  } else {
    val = val + 1;
  }
  step++;
  goto repeat;
exit:
  printf("val=%ld\n", val);
}

int main() {
  test_forward_goto();
  test_forward_goto_from_loop();
  test_multiple_forward_gotos();
  test_backward_goto_loop();
  test_backward_goto_sum();
  test_backward_goto_nested();
  return 0;
}
