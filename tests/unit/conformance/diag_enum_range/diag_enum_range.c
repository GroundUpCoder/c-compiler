// BUG: enumerator values outside 32 bits were silently wrapped.
// C11: 6.7.2.2p2 wants int-representable values; this project follows the
// gcc/clang extension giving (INT_MAX, UINT_MAX] values type unsigned int
// (see parse_enum_uint_ext) -- but a value that does not fit 32 bits at
// all must be diagnosed, not wrapped.
// EXPECT: compile error (exit 1).
enum { HUGE_E = 0x1FFFFFFFFll };
int main(void) { return 0; }
