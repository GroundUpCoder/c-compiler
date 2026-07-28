// BUG: sizeof on a bit-field member was silently accepted (returned the
// declared type's size) instead of being diagnosed (todos/0367 sweep).
// C11: 6.5.3.4p1 (constraint) — the sizeof operator shall not be applied to
// an expression that designates a bit-field member.
// EXPECT: compile error (exit 1).
struct S { unsigned u20 : 20; };
int main(void) {
  struct S t;
  return (int)sizeof(t.u20);
}
