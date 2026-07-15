// BUG: an enumerator whose value expression failed const-eval silently
// fell back to the running enum counter — a miscompile, not even an
// accepts-invalid. Now it diagnoses. (todos/0207; the short-circuit half
// of that item is pinned by consteval_shortcircuit.)
// C11: 6.7.2.2p2 (constraint) — the expression shall be an integer
// constant expression.
// EXPECT: compile error (exit 1).
int x;
enum { BAD = x + 1 };
int main(void) { return BAD; }
