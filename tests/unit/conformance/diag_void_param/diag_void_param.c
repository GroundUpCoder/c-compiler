// BUG: a named `void` parameter (`int f(void x)`) and `void` alongside
// other parameters (`int g(void, int)`) were silently accepted — the
// parameter got a 0-size type and calls miscompiled. Bug-hunt G22
// (todos/0227). NB `f(void)` and a typedef'd void as the sole unnamed
// parameter stay accepted (the zero-parameter form, as in clang/gcc).
// C11: 6.7.6.3p10 (constraint) — the special case of an unnamed
// parameter of type void must be the ONLY item in the list.
// EXPECT: compile error (exit 1).
int f(void x) { return 0; }
int g(void, int b);

int main(void) {
    return f(0);
}
