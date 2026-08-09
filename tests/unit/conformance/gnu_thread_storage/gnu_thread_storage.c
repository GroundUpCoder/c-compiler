// BUG: __thread was rejected — the GNU spelling of _Thread_local, probed
// by real-world ports behind __GNUC__ guards. Pure spelling registration:
// __thread int x; must compile identically to _Thread_local int x;
// (this compiler accepts _Thread_local and treats it as a no-op storage
// class in its single-threaded-per-process world). #587.
// EXPECT: matches clang -O0 output.
#include <stdio.h>

__thread int t1 = 11;
static __thread int t2;

int main(void) {
    static _Thread_local int t3 = 3;
    t2 = t1 + 20;
    t1++;
    printf("%d %d %d\n", t1, t2, t3);
    return 0;
}
