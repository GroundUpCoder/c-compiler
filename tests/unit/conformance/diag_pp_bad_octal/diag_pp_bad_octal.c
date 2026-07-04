// BUG: `#if 08` is accepted silently (compiler exits 0) — 08 is a valid
//      pp-number token but not a valid integer constant.
// C11: 6.4.4.1 — octal-constant digits are 0..7, so 08 cannot be converted
//      to an integer constant as 6.10.1p4 requires; a diagnostic is required
//      (5.1.1.3). (Native clang: "invalid digit '8' in octal constant".)
// EXPECT: the compiler must diagnose the invalid octal constant and exit
//         nonzero.
#if 08
#endif
int main(void) { return 0; }
