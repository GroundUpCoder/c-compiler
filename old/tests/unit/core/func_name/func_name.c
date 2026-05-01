#include <stdio.h>
#include <string.h>

void hello(void) {
  printf("%s\n", __func__);
}

void test_function(void) {
  printf("%s\n", __FUNCTION__);
}

int check_sizeof(void) {
  // sizeof(__func__) should be strlen("check_sizeof") + 1 == 13
  return sizeof(__func__);
}

int main(void) {
  printf("%s\n", __func__);
  hello();
  test_function();
  printf("%d\n", check_sizeof());
  return 0;
}
