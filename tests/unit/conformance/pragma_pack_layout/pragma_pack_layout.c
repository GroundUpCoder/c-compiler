// BUG: `#pragma pack(N)` / `push` / `pop` are silently ignored (compiler.js
//      "Other pragmas silently ignored"). __attribute__((packed)) IS honored,
//      but #pragma pack drops on the floor with no warning, so the struct
//      silently gets default alignment.
// C11: 6.10.6 (pragmas) + the universal MSVC/gcc/clang #pragma pack extension.
// EXPECT: pack(1) -> sizeof(struct P) 5; pack(2) -> sizeof(struct Q) 6.
//      compiler.js: 8 and 8 (default alignment; no diagnostic).
// KNOWN-BUG: todos/0191 (pinned xfail; root cause ~compiler.js:2084. Latent
//      silent-miscompile for binary-format / MMIO / savestate code).
#include <stdio.h>
#pragma pack(1)
struct P { char c; int i; };   // clang: 5
#pragma pack(2)
struct Q { char c; int i; };   // clang: 6
#pragma pack()
int main(void) {
  printf("%d %d\n", (int)sizeof(struct P), (int)sizeof(struct Q));
  return 0;
}
