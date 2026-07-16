// BUG: a second `#else` at the same conditional level was accepted
//      (same missing saw-#else flag as the #elif-after-#else defect).
// C11: 6.10.1 — the if-section grammar allows at most one else-group;
//      clang/gcc diagnose "#else after #else".
// EXPECT: a compile-time diagnostic.
#if 0
int x = 1;
#else
int x = 2;
#else
int x = 3;
#endif
int main(void) { return 0; }
