// 1. Indirect expansion: macro -> macro -> header
#define REAL_IO <stdio.h>
#define IO_HDR REAL_IO
#include IO_HDR

// 2. Function-like macro producing angle-bracket path
#define MAKE_ANGLE(name) <name.h>
#include MAKE_ANGLE(stdlib)

// 3. Stringify to produce a string include
#define STR(x) #x
#define MAKE_STR(x) STR(x)
#include MAKE_STR(string.h)

// 4. #undef + redefine between includes
#define HDR <stddef.h>
#include HDR
#undef HDR

// 5. Redefine to a local header (string path via macro)
#define HDR "helper.h"
#include HDR

// 6. Token pasting to build the header name
#define PASTE(a, b) a ## b
#define PASTED_HDR <PASTE(std, int).h>
#include PASTED_HDR

// 7. Conditional selection of computed include
#define USE_LIMITS
#ifdef USE_LIMITS
  #define COND_HDR <limits.h>
#else
  #define COND_HDR <stddef.h>
#endif
#include COND_HDR

// 8. Normal include mixed in to verify no interference
#include <stdarg.h>

int main() {
  // stdio.h (indirect)
  printf("io ok\n");

  // stdlib.h (function-like macro)
  void *p = malloc(16);

  // string.h (stringify)
  char buf[32];
  strcpy(buf, "str");
  strcat(buf, " ok");
  printf("%s\n", buf);

  // stddef.h (undef/redefine)
  size_t sz = sizeof(int);
  printf("size_t ok %d\n", (int)sz);

  // sub/helper.h (local subdir computed include)
  printf("helper %d\n", HELPER_VAL);

  // stdint.h (token paste)
  int32_t x = INT32_MAX;
  printf("int32 %d\n", (int)(x > 0));

  // limits.h (conditional)
  printf("char_bit %d\n", CHAR_BIT);

  if (p) {
    memcpy(p, "malloc ok", 10);
    printf("%s\n", (char *)p);
    free(p);
  }
  return 0;
}
