// BUG: an enumeration constant not representable as int (0x80000000) is silently wrapped to a negative value.
// C11: 6.7.2.2p2 -- the expression defining an enumeration constant shall have a value representable as an int (constraint).
// EXPECT: compiler exits 1 with a diagnostic (clang: error under -pedantic-errors, "C23 extension" otherwise).
enum { BIG = 0x80000000 };
int main(void) { return 0; }
