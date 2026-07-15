// BUG: `_Alignas(N)` with N > 8 is rejected even for STATIC storage, where an
//      over-aligned object in the data section is trivially representable.
//      compiler.js caps _Alignas at 8 regardless of storage class
//      ("exceeds maximum supported alignment of 8"); clang accepts it.
// C11: 6.7.5 (_Alignas), 6.2.8 (alignment). A static's alignment is a link-time
//      data-section property, not a stack constraint.
// EXPECT: `_Alignas(32) char g[4];` compiles and g is 32-byte aligned -> 1.
//      compiler.js: rejects at compile time (rejects-valid).
// KNOWN-BUG: todos/0194 (pinned xfail; the _Alignas cap ignores storage class.
//      Companion defect: statement-position __attribute__((aligned)) on a local
//      fails to parse — see the todo body).
#include <stdio.h>
#include <stdint.h>
_Alignas(32) char g[4];
int main(void) {
  printf("%d\n", (int)((uintptr_t)&g % 32 == 0));
  return 0;
}
