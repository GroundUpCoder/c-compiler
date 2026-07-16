// BUG: `#elif` appearing after `#else` in the same conditional was
//      accepted and evaluated (the ifStack frame carried no saw-#else
//      flag), silently re-opening a closed conditional.
// C11: 6.10.1 — the if-section grammar places every elif-group BEFORE
//      the else-group; clang/gcc diagnose "#elif after #else" (even
//      inside a skipped enclosing group).
// EXPECT: a compile-time diagnostic.
#if 0
int x = 1;
#else
int x = 2;
#elif 1
int x = 3;
#endif
int main(void) { return 0; }
