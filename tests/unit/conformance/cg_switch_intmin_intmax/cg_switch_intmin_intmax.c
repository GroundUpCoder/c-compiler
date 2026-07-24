// BUG: a `switch` whose case values include INT_MIN/INT_MAX crashed the
//      compiler ("brTable entry targets a label that is not on the active
//      control stack") — the dense-jump-table lowering overflowed computing
//      the case-value range. Found in NetSurf desktop/scrollbar.c
//      (SCROLL_TOP = INT_MIN).
// C11: 6.8.4.2 — any integer constant expression is a valid case value.
// EXPECT: clang-verified output below.
#include <limits.h>
#include <stdio.h>

static int f(int c)
{
	switch (c) {
	case INT_MIN:     return 1;
	case INT_MIN + 1: return 2;
	case INT_MAX - 1: return 3;
	case INT_MAX:     return 4;
	case 0:           return 5;
	default:          return 0;
	}
}

/* unsigned twin: full-range case values through the same lowering */
static int g(unsigned c)
{
	switch (c) {
	case 0u:          return 1;
	case UINT_MAX:    return 2;
	case UINT_MAX-1u: return 3;
	default:          return 0;
	}
}

/* a dense switch that SHOULD still get a jump table, near the extremes */
static int h(int c)
{
	switch (c) {
	case INT_MAX - 4: return 1;
	case INT_MAX - 3: return 2;
	case INT_MAX - 2: return 3;
	case INT_MAX - 1: return 4;
	case INT_MAX:     return 5;
	default:          return 0;
	}
}

int main(void)
{
	printf("%d %d %d %d %d %d\n",
	       f(INT_MIN), f(INT_MIN + 1), f(INT_MAX - 1), f(INT_MAX),
	       f(0), f(5));
	printf("%d %d %d %d\n", g(0u), g(UINT_MAX), g(UINT_MAX - 1u), g(7u));
	printf("%d %d %d %d\n",
	       h(INT_MAX - 4), h(INT_MAX - 1), h(INT_MAX), h(42));
	return 0;
}
