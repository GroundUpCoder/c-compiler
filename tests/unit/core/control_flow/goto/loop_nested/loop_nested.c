#include <stdio.h>

// Backward goto from deeply nested blocks
void test_deep_nesting() {
  long result = 0;
  long i = 0;
start:
  if (i >= 3) goto end;
  {
    {
      {
        result = result + (i + 1) * 10;
        i++;
        goto start;
      }
    }
  }
end:
  printf("deep: %ld\n", result);
}

// Backward goto with for loop inside the loop body
void test_loop_with_for() {
  long total = 0;
  long round = 0;
again:
  if (round >= 3) goto done;
  long j;
  for (j = 0; j < round + 1; j++) {
    total = total + 1;
  }
  round++;
  goto again;
done:
  printf("loop_with_for: %ld\n", total);
}

// Backward goto simulating do-while
void test_do_while_sim() {
  long n = 10;
body:
  n = n - 3;
  if (n > 0) goto body;
  printf("do_while_sim: %ld\n", n);
}

int main() {
  test_deep_nesting();
  test_loop_with_for();
  test_do_while_sim();
  return 0;
}
