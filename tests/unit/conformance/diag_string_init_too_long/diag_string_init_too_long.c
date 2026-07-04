// BUG: a string literal initializer longer than the char array is accepted, overflowing into adjacent data.
// C11: 6.7.9p14 + p2 -- characters of the literal initialize the array; only the terminating NUL may be dropped when the array is exactly full. "abcdef" has 6 non-NUL chars > 2 -> constraint violation.
// EXPECT: compiler exits 1 with a diagnostic. (Exact-fit `char s[2] = "ab"` is legal and must NOT error -- verified to already work today, so no separate test.)
char s[2] = "abcdef";
int main(void) { return 0; }
