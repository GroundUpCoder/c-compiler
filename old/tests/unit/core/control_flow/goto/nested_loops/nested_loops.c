#include <stdio.h>

// Two loop labels open simultaneously — inner loop uses a sub-block
// so its loop label and forward label are in a nested compound
void test_nested_loop_labels() {
  long i = 0;
  long j;
  long sum = 0;
outer:
  if (i >= 3) goto done;
  j = 0;
  {
  inner:
    if (j >= i + 1) goto next;
    sum = sum + 1;
    j++;
    goto inner;
  next:
  }
  i++;
  goto outer;
done:
  // sum = 1 + 2 + 3 = 6
  printf("nested: sum=%ld\n", sum);
}

// Three loop label levels, each in its own sub-block
void test_three_levels() {
  long a = 0;
  long b;
  long c;
  long count = 0;
level1:
  if (a >= 2) goto end;
  b = 0;
  {
  level2:
    if (b >= 2) goto next1;
    c = 0;
    {
    level3:
      if (c >= 2) goto next2;
      count++;
      c++;
      goto level3;
    next2:
    }
    b++;
    goto level2;
  next1:
  }
  a++;
  goto level1;
end:
  // 2 * 2 * 2 = 8
  printf("three: count=%ld\n", count);
}

// Inner loop closed by its own forward label while outer stays open
void test_inner_closed_first() {
  long i = 0;
  long total = 0;
repeat:
  if (i >= 4) goto finish;
  {
    long j = 0;
  add:
    if (j >= i) goto add_done;
    total = total + 1;
    j++;
    goto add;
  add_done:
  }
  i++;
  goto repeat;
finish:
  // 0 + 1 + 2 + 3 = 6
  printf("inner_closed: total=%ld\n", total);
}

int main() {
  test_nested_loop_labels();
  test_three_levels();
  test_inner_closed_first();
  return 0;
}
