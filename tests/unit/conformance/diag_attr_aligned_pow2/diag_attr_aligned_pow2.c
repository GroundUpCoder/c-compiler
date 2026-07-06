// BUG: __attribute__((aligned(N))) never validated N. A non-power-of-2 now
//      matters for correctness: over-aligned frames mask the frame base with
//      -N, which is only a valid alignment mask for powers of 2.
// C11: n/a (GCC extension); GCC diagnoses "requested alignment is not a
//      positive power of 2"
// EXPECT: compile error (exit 1).
static int x __attribute__((aligned(24))) = 1;
int main(void) { return x - 1; }
