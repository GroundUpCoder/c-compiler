#include <stdio.h>
#include <guc.h>

__externref g_ref;

__externref make_null(void) {
  return __ref_null(__externref);
}

int is_null(__externref r) {
  return __ref_is_null(r);
}

void test_null(void) {
  printf("=== null ===\n");
  __externref r;  // auto-null
  printf("%d\n", __ref_is_null(r));     // 1
  printf("%d\n", !__ref_is_null(r));    // 0
  printf("%d\n", is_null(r));           // 1
}

void test_global(void) {
  printf("=== global ===\n");
  printf("%d\n", __ref_is_null(g_ref)); // 1 (initialized to null)
}

void test_interop(void) {
  printf("=== interop ===\n");
  __externref s = __jsstr("hello");
  printf("%d\n", !__ref_is_null(s));    // 1

  __externref s2 = __jsstr2("world!", 5);
  printf("%d\n", !__ref_is_null(s2));   // 1

  __externref g = __jsglobal();
  printf("%d\n", !__ref_is_null(g));    // 1

  __jslog(s);
  __jslog(s2);
}

void test_param_return(void) {
  printf("=== param/return ===\n");
  __externref n = make_null();
  printf("%d\n", __ref_is_null(n));     // 1
  printf("%d\n", is_null(n));           // 1
}

void test_if_cond(void) {
  printf("=== if cond ===\n");
  __externref r;  // auto-null
  if (!__ref_is_null(r)) {
    printf("truthy\n");
  } else {
    printf("falsy\n"); // falsy
  }

  __externref s = __jsstr("x");
  if (!__ref_is_null(s)) {
    printf("truthy\n"); // truthy
  } else {
    printf("falsy\n");
  }
}

int main(void) {
  test_null();
  test_global();
  test_interop();
  test_param_return();
  test_if_cond();
  return 0;
}
