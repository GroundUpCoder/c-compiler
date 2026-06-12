#include <stdio.h>

/*
 * Brace elision tests — C99 §6.7.8p20:
 * "If the aggregate or union contains elements or members that are
 * aggregates or unions, these rules apply recursively to the
 * subaggregates or contained unions. If the initializer of a
 * subaggregate or contained union begins with a left brace, that
 * initializer and its matching right brace initialize the elements
 * or members of the subaggregate or contained union. Otherwise,
 * only enough initializers from the list are taken to account for
 * the elements or members of the subaggregate or first member of
 * the contained union; any remaining initializers are left to
 * initialize the next element or member of the aggregate of which
 * the current subaggregate or contained union is a part."
 *
 * In plain English: you can omit inner braces, and the compiler
 * will "flatten" the values into nested aggregates automatically.
 * This exercises normalizeInitList's descent/elision logic.
 */

static int fail = 0;
#define CHECK(cond, msg, got, exp) do { \
	if (!(cond)) { printf("FAIL %s (got %d, expected %d)\n", msg, (int)(got), (int)(exp)); fail = 1; } \
} while(0)

/* ── type definitions ──────────────────────────────────────────── */

struct Inner { int x; int y; };
struct Outer { struct Inner a; int b; };

struct Deep3 { int a; int b; int c; };
struct Deep2 { struct Deep3 inner; int d; };
struct Deep1 { struct Deep2 middle; int e; };

struct MixArray { int n; int vals[3]; };

struct TwoAgg { struct Inner a; struct Inner b; };

/* ── file-scope ────────────────────────────────────────────────── */

/* Brace-elided struct:  {1, 2} fills Inner, 3 goes to b */
struct Outer g1 = {1, 2, 3};

/* Fully braced for comparison */
struct Outer g2 = {{10, 20}, 30};

/* Triple-nested: brace-elided all the way down */
struct Deep1 g3 = {1, 2, 3, 4, 5};

/* Array+struct mix: brace elision into array member */
struct MixArray g4 = {3, 10, 20, 30};

/* Two-aggregate: brace-elided fills first aggregate */
struct TwoAgg g5 = {1, 2, 3, 4};

/* ── local ─────────────────────────────────────────────────────── */

int main() {
	/*
	 * Case 1: basic brace elision — Outer { Inner.a, Inner.b, b }
	 */
	{
		CHECK(g1.a.x == 1,  "g1.a.x", g1.a.x, 1);
		CHECK(g1.a.y == 2,  "g1.a.y", g1.a.y, 2);
		CHECK(g1.b   == 3,  "g1.b",   g1.b,   3);
	}

	/*
	 * Case 2: explicit braces (control)
	 */
	{
		CHECK(g2.a.x == 10, "g2.a.x", g2.a.x, 10);
		CHECK(g2.a.y == 20, "g2.a.y", g2.a.y, 20);
		CHECK(g2.b   == 30, "g2.b",   g2.b,   30);
	}

	/*
	 * Case 3: triple-nested brace elision
	 * Deep1 { Deep2 { Deep3 {a,b,c}, d }, e }
	 * → g3 = {1, 2, 3, 4, 5}
	 * fills: a=1, b=2, c=3, d=4, e=5
	 */
	{
		CHECK(g3.middle.inner.a == 1, "g3.a", g3.middle.inner.a, 1);
		CHECK(g3.middle.inner.b == 2, "g3.b", g3.middle.inner.b, 2);
		CHECK(g3.middle.inner.c == 3, "g3.c", g3.middle.inner.c, 3);
		CHECK(g3.middle.d        == 4, "g3.d", g3.middle.d,        4);
		CHECK(g3.e               == 5, "g3.e", g3.e,               5);
	}

	/*
	 * Case 4: struct with embedded array, brace elision into array
	 * MixArray {n, vals[3]} = {3, 10, 20, 30}
	 */
	{
		CHECK(g4.n        == 3,  "g4.n",       g4.n,        3);
		CHECK(g4.vals[0]  == 10, "g4.vals[0]", g4.vals[0], 10);
		CHECK(g4.vals[1]  == 20, "g4.vals[1]", g4.vals[1], 20);
		CHECK(g4.vals[2]  == 30, "g4.vals[2]", g4.vals[2], 30);
	}

	/*
	 * Case 5: two aggregates in one struct, brace-elided
	 * TwoAgg { Inner {x,y}, Inner {x,y} } = {1, 2, 3, 4}
	 * Fills: a.x=1, a.y=2, b.x=3, b.y=4
	 */
	{
		CHECK(g5.a.x == 1, "g5.a.x", g5.a.x, 1);
		CHECK(g5.a.y == 2, "g5.a.y", g5.a.y, 2);
		CHECK(g5.b.x == 3, "g5.b.x", g5.b.x, 3);
		CHECK(g5.b.y == 4, "g5.b.y", g5.b.y, 4);
	}

	/*
	 * Case 6: partial brace-elided (not enough for all fields)
	 * TwoAgg = {1, 2} → fills a.x=1, a.y=2, b.x=0, b.y=0
	 */
	{
		struct TwoAgg local = {1, 2};
		CHECK(local.a.x == 1, "local.a.x", local.a.x, 1);
		CHECK(local.a.y == 2, "local.a.y", local.a.y, 2);
		CHECK(local.b.x == 0, "local.b.x", local.b.x, 0);
		CHECK(local.b.y == 0, "local.b.y", local.b.y, 0);
	}

	/*
	 * Case 7: local with braces that stop brace elision
	 * Outer local = {{1, 2}, 3} — explicit inner brace stops elision
	 */
	{
		struct Outer local = {{5, 6}, 7};
		CHECK(local.a.x == 5, "stopped.x", local.a.x, 5);
		CHECK(local.a.y == 6, "stopped.y", local.a.y, 6);
		CHECK(local.b   == 7, "stopped.b", local.b,   7);
	}

	/*
	 * Case 8: array of structs, brace-elided into both
	 * struct Inner arr[2] = {1, 2, 3, 4}
	 */
	{
		struct Inner arr[2] = {1, 2, 3, 4};
		CHECK(arr[0].x == 1, "arr[0].x", arr[0].x, 1);
		CHECK(arr[0].y == 2, "arr[0].y", arr[0].y, 2);
		CHECK(arr[1].x == 3, "arr[1].x", arr[1].x, 3);
		CHECK(arr[1].y == 4, "arr[1].y", arr[1].y, 4);
	}

	/*
	 * Case 9: struct with array, partial elision
	 * MixArray = {5} → n=5, vals all zero
	 */
	{
		struct MixArray local = {5};
		CHECK(local.n       == 5, "part.n",      local.n,       5);
		CHECK(local.vals[0] == 0, "part.vals[0]",local.vals[0], 0);
	}

	if (fail) return 1;
	printf("OK\n");
	return 0;
}
