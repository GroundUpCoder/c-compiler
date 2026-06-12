#include <stdio.h>

/*
 * Union designated initialization — C99 §6.7.8p19:
 * "The initialization shall occur in initializer list order, each
 * initializer provided for a particular subobject overriding any
 * previously listed initializer for the same subobject. All
 * subobjects that are not initialized explicitly shall be
 * initialized implicitly the same as objects that have static
 * storage duration."
 *
 * And for unions specifically: if no designator, the first member
 * is initialized. A designator selects a different member.
 */

static int fail = 0;
#define CHECK(cond, msg, got, exp) do { \
	if (!(cond)) { printf("FAIL %s (got %d, expected %d)\n", msg, (int)(got), (int)(exp)); fail = 1; } \
} while(0)
#define CHECKF(cond, msg, got, exp) do { \
	if (!(cond)) { printf("FAIL %s (got %.1f, expected %.1f)\n", msg, (float)(got), (float)(exp)); fail = 1; } \
} while(0)

/* ── simple union ──────────────────────────────────────────────── */

union Simple {
	int i;
	float f;
	char c;
};

/* ── union with aggregate members ───────────────────────────────── */

struct Pt { int x; int y; };
struct Color { unsigned char r, g, b, a; };

union Tagged {
	struct Pt point;
	struct Color color;
	int raw[4];
};

/* ── union inside struct ────────────────────────────────────────── */

struct Container {
	int kind;
	union {
		int int_val;
		float float_val;
	};
};

/* ── file-scope union inits ─────────────────────────────────────── */

union Simple g1 = {42};                    /* first member (i=42) */
union Simple g2 = { .f = 3.14f };         /* designated to float */
union Simple g3 = { .c = 'Z' };           /* designated to char */
union Tagged g4 = { .point = {10, 20} };  /* designated to struct */
union Tagged g5 = { .raw = {1, 2, 3} };   /* designated to array */
union Tagged g6 = { .color = {255, 0, 0, 255} }; /* designated, partial */
struct Container g7 = { .kind = 1, .float_val = 2.5f };

/* ── main ──────────────────────────────────────────────────────── */

int main() {
	/*
	 * Case 1: union first-member default init
	 */
	CHECK(g1.i == 42, "first member", g1.i, 42);

	/*
	 * Case 2: designated to float member
	 */
	CHECKF(g2.f == 3.14f, "designated float", g2.f, 3.14f);

	/*
	 * Case 3: designated to char member
	 */
	CHECK(g3.c == 'Z', "designated char", g3.c, 'Z');

	/*
	 * Case 4: designated to struct member with brace-elided inner
	 */
	CHECK(g4.point.x == 10, "tagged pt.x", g4.point.x, 10);
	CHECK(g4.point.y == 20, "tagged pt.y", g4.point.y, 20);

	/*
	 * Case 5: designated to array member
	 */
	CHECK(g5.raw[0] == 1, "tagged raw[0]", g5.raw[0], 1);
	CHECK(g5.raw[1] == 2, "tagged raw[1]", g5.raw[1], 2);
	CHECK(g5.raw[2] == 3, "tagged raw[2]", g5.raw[2], 3);
	CHECK(g5.raw[3] == 0, "tagged raw[3]", g5.raw[3], 0); /* implicit zero */

	/*
	 * Case 6: designated to struct with partial inner init
	 */
	CHECK(g6.color.r == 255, "color.r", g6.color.r, 255);
	CHECK(g6.color.g == 0,   "color.g", g6.color.g, 0);
	CHECK(g6.color.b == 0,   "color.b", g6.color.b, 0);
	CHECK(g6.color.a == 255, "color.a", g6.color.a, 255);

	/*
	 * Case 7: union in struct, designated
	 */
	CHECK(g7.kind == 1, "container.kind", g7.kind, 1);
	CHECKF(g7.float_val == 2.5f, "container.float", g7.float_val, 2.5f);

	/*
	 * Case 8: local union designated init
	 */
	{
		union Simple a = { .i = 99 };
		union Simple b = { .f = 1.5f };
		CHECK(a.i == 99, "local.i", a.i, 99);
		CHECKF(b.f == 1.5f, "local.f", b.f, 1.5f);
	}

	/*
	 * Case 9: local union, second member via designator
	 */
	{
		union Tagged t = { .point = {.x = 7, .y = 8} };
		CHECK(t.point.x == 7, "local tagged x", t.point.x, 7);
		CHECK(t.point.y == 8, "local tagged y", t.point.y, 8);
	}

	if (fail) return 1;
	printf("OK\n");
	return 0;
}
