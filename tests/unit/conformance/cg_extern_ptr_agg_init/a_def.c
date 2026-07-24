// BUG: an extern pointer-typed object referenced in a LOCAL aggregate
//      initializer stored the object's ADDRESS instead of its value
//      (`struct Wrap w = { ptr };` behaved like `w.f = &ptr`), while the
//      plain-assignment form `w.f = ptr;` was correct. Found by the NetSurf
//      592-TU link (monkey gui tables + redraw ctx) — silent wrong-code.
// C11: 6.7.9p11 — an initializer for a scalar member is converted as by
//      simple assignment; the initializer expression `ptr` is an lvalue that
//      undergoes lvalue conversion (6.3.2.1p2) to the pointer VALUE.
// EXPECT: clang-verified output below.
struct T { int a; };
static struct T real = { 42 };
struct T *ptr = &real;
int plain = 7;
int *iptr = &plain;
