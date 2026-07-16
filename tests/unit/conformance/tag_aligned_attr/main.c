// BUG: struct/union-level __attribute__((aligned(N))) was silently dropped:
//      it landed only on the enclosing DECLARATION's requestedAlignment, so
//      the tag TYPE's _Alignof stayed at the natural alignment and sizeof
//      was not padded up. struct __attribute__((aligned(8))) S { char c; }
//      gave sizeof/_Alignof 1; clang wasm32 says 8/8. Both attribute
//      positions (after the keyword and after the closing brace) affected.
// C11: n/a (GNU extension); semantics match clang/GCC — tag-level aligned
//      raises the type's alignment and pads sizeof up to it.
// EXPECT: numbers verified with clang --target=wasm32
//      -Xclang -fdump-record-layouts; global addresses honour the raised
//      alignment.
#include <stdio.h>
#include <stdint.h>

struct __attribute__((aligned(8))) B1 { char c; };   // 8/8 (leading position)
struct B2 { char c; } __attribute__((aligned(8)));   // 8/8 (trailing position)
struct __attribute__((aligned(16))) B3 { int x; };   // 16/16
union __attribute__((aligned(8))) B4 { char c; };    // 8/8 (union tag)

static struct B1 gb1;
static struct B3 gb3;
static struct B1 arr[3];

int main(void) {
  printf("B1 %d %d\n", (int)sizeof(struct B1), (int)_Alignof(struct B1));
  printf("B2 %d %d\n", (int)sizeof(struct B2), (int)_Alignof(struct B2));
  printf("B3 %d %d\n", (int)sizeof(struct B3), (int)_Alignof(struct B3));
  printf("B4 %d %d\n", (int)sizeof(union B4), (int)_Alignof(union B4));
  printf("addr %d %d\n", (int)((uintptr_t)&gb1 % 8), (int)((uintptr_t)&gb3 % 16));
  printf("arr %d %d\n", (int)sizeof arr, (int)((uintptr_t)&arr[1] - (uintptr_t)&arr[0]));
  return 0;
}
