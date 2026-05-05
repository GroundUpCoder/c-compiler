#include <stdio.h>

// __ref_cast       — trap on null (matches WASM `ref.cast`, the strict form)
// __ref_cast_null  — null passes through (matches WASM `ref.cast null`)
__struct Foo { int x; };

int main(void) {
  __struct Foo *p = __new(__struct Foo *, 99);
  __eqref e_real = p;

  // Strict cast on a real value: succeeds.
  __struct Foo *r1 = __ref_cast(__struct Foo *, e_real);
  printf("strict cast real: %d\n", r1->x);

  // Nullable cast on a real value: also succeeds.
  __struct Foo *r2 = __ref_cast_null(__struct Foo *, e_real);
  printf("nullable cast real: %d\n", r2->x);

  // Nullable cast on null: passes through unchanged.
  __eqref e_null = 0;
  __struct Foo *r3 = __ref_cast_null(__struct Foo *, e_null);
  printf("nullable cast null: %s\n", r3 ? "set" : "null");

  return 0;
}
