// BUG: a negative array size (`int a[-1]`) was silently accepted and
// produced a negative-size type (negative sizeof, broken layout math
// downstream). Bug-hunt G22 (todos/0227).
// C11: 6.7.6.2p1 (constraint) — the size expression shall be greater
// than zero. (Explicit [0] stays accepted — the GNU zero-length array.)
// EXPECT: compile error (exit 1).
int g[-1];

int f(int p[2][-3]) { return p[0][0]; }

int main(void) {
    int a[-1];
    return sizeof(a) + sizeof(g);
}
