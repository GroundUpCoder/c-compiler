// BUG: sizeof applied to an incomplete type (forward-declared struct,
// extern unsized array, deref of a pointer to incomplete) silently
// evaluated to 0 — array sizes and memcpy lengths computed from it were
// silently wrong. Bug-hunt G21 (todos/0227).
// C11: 6.5.3.4p1 (constraint) — sizeof shall not be applied to an
// expression or type of incomplete type. (void/function are the GNU
// exception, tested green in sizeof_void_func.)
// EXPECT: compile error (exit 1).
struct Fwd;
extern int unsized[];

int f(struct Fwd *p) { return (int)sizeof(*p); }

int main(void) {
    int a = (int)sizeof(struct Fwd);
    int b = (int)sizeof(unsized);
    return a + b;
}
