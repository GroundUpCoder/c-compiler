#include <stdio.h>

// Loop label followed by forward label in the same compound
void test_loop_then_forward() {
  long i = 0;
top:
  if (i >= 3) goto done;
  i++;
  goto top;
done:
  printf("loop_then_forward: %ld\n", i);
}

// Multiple loop labels in sequence, each followed by its own forward label
void test_two_loops() {
  long a = 0;
loop1:
  if (a >= 2) goto end1;
  a++;
  goto loop1;
end1:

  long b = 0;
loop2:
  if (b >= 3) goto end2;
  b++;
  goto loop2;
end2:
  printf("two_loops: a=%ld b=%ld\n", a, b);
}

// Forward label, then a loop label (interleaved)
void test_forward_then_loop() {
  long x = 1;
  if (x) goto skip;
  x = 999;
skip:

  long count = 0;
again:
  if (count >= 4) goto out;
  count++;
  goto again;
out:
  printf("forward_then_loop: x=%ld count=%ld\n", x, count);
}

int main() {
  test_loop_then_forward();
  test_two_loops();
  test_forward_then_loop();
  return 0;
}
