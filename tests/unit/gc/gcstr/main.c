// __gcstr("...") — string literals as imported externref constants
// (js-string importedStringConstants, module "#"). todos/0041.
#include <stdio.h>
#include <guc.h>

// File-scope init: global.get of the immutable import is a wasm constant
// expression. Works for nullable AND non-nullable ref globals — __gcstr is
// __refextern's only valid global initializer.
__externref g_ext = __gcstr("file-scope");
__refextern g_ref = __gcstr("nonnull");
const __externref g_const = __gcstr("qualified");

static __externref pick(int which) {   // static → inline candidate
  return which ? __gcstr("yes") : __gcstr("no");
}

int main(void) {
  __externref a = __gcstr("hello");
  __externref b = __gcstr("hel" "lo");     // adjacent-literal concatenation
  printf("len a: %d\n", __wjs_length(a));
  printf("a equals b: %d\n", __wjs_equals(a, b));
  printf("a equals g: %d\n", __wjs_equals(a, g_ext));

  // js-string ops over the constants
  __refextern c = __wjs_concat(a, __gcstr(" world"));
  printf("len concat: %d\n", __wjs_length(c));
  printf("charCodeAt(5): %d\n", __wjs_charCodeAt(c, 5));
  printf("compare: %d\n", __wjs_compare(__gcstr("abc"), __gcstr("abd")));

  // Copy back into linear memory
  char buf[32]; int w;
  __jsstr_read(c, buf, sizeof buf, &w);
  printf("read back: %s (%d bytes)\n", buf, w);

  // File-scope values
  printf("g_ext len: %d\n", __wjs_length(g_ext));
  printf("g_ref len: %d\n", __wjs_length(g_ref));
  printf("g_const len: %d\n", __wjs_length(g_const));

  // Static local init
  static __externref s = __gcstr("static-local");
  printf("static len: %d\n", __wjs_length(s));

  // Friendly macro
  printf("macro len: %d\n", __wjs_length(GCSTR("via-macro")));

  // Inlined call sites
  printf("pick lens: %d %d\n", __wjs_length(pick(1)), __wjs_length(pick(0)));

  // Embedded NUL and non-ASCII survive (UTF-16 code-unit lengths)
  printf("nul len: %d\n", __wjs_length(__gcstr("a\0b")));
  printf("utf8 len: %d\n", __wjs_length(__gcstr("héllo→")));

  // Mixing with the runtime conversion path: same content, equal strings
  printf("jss equals: %d\n", __wjs_equals(__jss("hello"), a));

  return 0;
}
