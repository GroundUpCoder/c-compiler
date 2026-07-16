// BUG: a ## paste whose concatenation doesn't form ONE valid
// preprocessing token (`a ## ++` -> "x++") silently took the FIRST lexed
// token and DROPPED the rest — `P(x);` compiled as plain `x;` and the
// increment vanished. Bug-hunt G22 (todos/0227).
// C11: 6.10.3.3p3 — the result of ## shall be a valid preprocessing
// token (UB otherwise; clang/gcc diagnose "pasting formed ...").
// EXPECT: compile error (exit 1).
#define P(a) a ## ++

int main(void) {
    int x = 0;
    P(x);
    return x;
}
