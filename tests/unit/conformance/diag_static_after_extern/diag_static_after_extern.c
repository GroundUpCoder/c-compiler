// BUG: `extern int y;` (or plain `int y;`) followed by `static int y = 4;`
// was silently accepted — the same identifier declared with external THEN
// internal linkage. The reverse order (static first, extern after) is the
// legal C11 6.2.2p4 inheritance, guarded in G12/0219 and untouched here.
// Bug-hunt G22 (todos/0227).
// C11: 6.2.2p7 — an identifier appearing with both internal and external
// linkage in one TU is undefined; clang/gcc reject ("static declaration
// of 'y' follows non-static declaration").
// EXPECT: compile error (exit 1).
extern int y;
static int y = 4;

int main(void) {
    return y;
}
