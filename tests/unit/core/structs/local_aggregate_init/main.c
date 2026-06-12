#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

/*
 * Scalar brace-initialization tests — C99 §6.7.8p11 allows a scalar
 * initializer to be enclosed in braces:  `int x = {0}`.
 *
 * This exercises the parser-level normalization that unwraps `{expr}` to
 * `expr` before codegen sees the initializer.  Previously this crashed
 * with "unhandled expression EInitList" when the scalar took the WASM-local
 * code path (the aggregate-frame-slot path handled EInitList, but scalars
 * routed through emitExpr which had no EInitList case).
 */

/* ── helpers ─────────────────────────────────────────────────────── */

static int checked = 0;

#define CHECK(cond, msg, val, expected) do { \
	checked++; \
	if (!(cond)) printf("FAIL %s: got %d expected %d\n", msg, (int)(val), (int)(expected)); \
} while(0)

/* ── types for typedef-chain and pointer tests ───────────────────── */

typedef unsigned my_uint;
typedef my_uint my_uint2;  /* double typedef chain */

typedef enum {
	MY_ENUM_ZERO = 0,
	MY_ENUM_ONE  = 1,
	MY_ENUM_TWO  = 2,
} my_enum_t;

struct simple { int a; int b; };

/* ── file-scope scalars (consteval path, not codegen) ────────────── */

static int            g_int         = {42};
static unsigned       g_unsigned    = {100};
static short          g_short       = {-1};
static long long      g_ll          = {0x7FFFFFFFFFFFFFFFLL};
static char           g_char        = {'Z'};
static bool           g_bool        = {true};
static float          g_float       = {3.14f};
static double         g_double      = {2.718};
static my_uint        g_typedef     = {0xDEAD};
static my_uint2       g_typedef2    = {0xBEEF};
static my_enum_t      g_enum        = {MY_ENUM_TWO};
static void          *g_ptr         = {NULL};
static const char    *g_str         = {"hello"};
static uint32_t       g_u32         = {0xCAFEBABE};

/* ── main ────────────────────────────────────────────────────────── */

int main() {
	/*
	 * Section 1 — basic scalar types, local (codegen path)
	 */
	{
		int            x = {42};
		unsigned       u = {99};
		short          s = {-7};
		long long      l = {1LL << 40};
		char           c = {'A'};
		bool           b = {true};
		float          f = {1.5f};
		double         d = {2.25};

		CHECK(x == 42,       "int",            x, 42);
		CHECK(u == 99,       "unsigned",       u, 99);
		CHECK(s == -7,       "short",          s, -7);
		CHECK((l >> 40) == 1,"long long",      (int)(l >> 40), 1);
		CHECK(c == 'A',      "char",           c, 'A');
		CHECK(b == true,     "bool",           b, true);
		CHECK(f == 1.5f,     "float",          (int)(f*10), 15);
		CHECK(d == 2.25,     "double",         (int)(d*100), 225);
	}

	/*
	 * Section 2 — typedef chains (the libgit2 GIT_HASHMAP_INIT pattern)
	 */
	{
		my_uint     t1 = {0x1111};
		my_uint2    t2 = {0x2222};
		my_enum_t   t3 = {MY_ENUM_ONE};
		uint32_t    t4 = {0xDEADBEEF};
		uint16_t    t5 = {0xABCD};
		uint8_t     t6 = {0xFF};

		CHECK(t1 == 0x1111,     "my_uint",      t1, 0x1111);
		CHECK(t2 == 0x2222,     "my_uint2",     t2, 0x2222);
		CHECK(t3 == MY_ENUM_ONE,"my_enum_t",    t3, MY_ENUM_ONE);
		CHECK(t4 == 0xDEADBEEF, "uint32_t",     (unsigned)t4, 0xDEADBEEF);
		CHECK(t5 == 0xABCD,     "uint16_t",     t5, 0xABCD);
		CHECK(t6 == 0xFF,       "uint8_t",      t6, 0xFF);
	}

	/*
	 * Section 3 — expressions inside braces
	 */
	{
		int a = {1 + 2};
		int b = {3 * 4};
		int c = {(1 << 5) | 1};
		int d = {sizeof(int)};

		CHECK(a == 3,  "expr add",     a, 3);
		CHECK(b == 12, "expr mul",     b, 12);
		CHECK(c == 33, "expr shift",   c, 33);
		CHECK(d == 4,  "expr sizeof",  d, 4);
	}

	/*
	 * Section 4 — pointer and string initializers
	 */
	{
		void       *p1 = {NULL};
		int        *p2 = {NULL};
		const char *p3 = {"world"};
		void       *p4 = {(void*)0x1000};

		CHECK(p1 == NULL,    "void* null",     p1 == NULL, 1);
		CHECK(p2 == NULL,    "int* null",      p2 == NULL, 1);
		CHECK(p3[0] == 'w',  "const char*",    p3[0], 'w');
		CHECK(p4 != NULL,    "void* non-null", p4 != NULL, 1);
	}

	/*
	 * Section 5 — zero-init of scalar via {0}
	 */
	{
		int       z1 = {0};
		unsigned  z2 = {0};
		void     *z3 = {0};
		uint64_t  z4 = {0};

		CHECK(z1 == 0, "int zero",    z1, 0);
		CHECK(z2 == 0, "uint zero",   z2, 0);
		CHECK(z3 == NULL, "ptr zero", z3 == NULL, 1);
		CHECK(z4 == 0, "u64 zero",    (int)z4, 0);
	}

	/*
	 * Section 6 — globals (consteval path)
	 */
	{
		CHECK(g_int      == 42,            "global int",      g_int, 42);
		CHECK(g_unsigned == 100,           "global unsigned", g_unsigned, 100);
		CHECK(g_short    == (short)-1,     "global short",    g_short, -1);
		CHECK(g_char     == 'Z',           "global char",     g_char, 'Z');
		CHECK(g_bool     == true,          "global bool",     g_bool, true);
		CHECK(g_typedef  == 0xDEAD,        "global typedef",  g_typedef, 0xDEAD);
		CHECK(g_typedef2 == 0xBEEF,        "global typedef2", g_typedef2, 0xBEEF);
		CHECK(g_enum     == MY_ENUM_TWO,   "global enum",     g_enum, MY_ENUM_TWO);
		CHECK(g_ptr      == NULL,          "global ptr",      g_ptr == NULL, 1);
		CHECK(g_str[0]   == 'h',           "global str",      g_str[0], 'h');
		CHECK(g_u32      == 0xCAFEBABE,    "global u32",      (unsigned)g_u32, 0xCAFEBABE);
	}

	/*
	 * Section 7 — regression: aggregate inits still work
	 */
	{
		/* Local array with brace init */
		int arr[4] = {10, 20, 30, 40};
		CHECK(arr[0] == 10, "array[0]", arr[0], 10);
		CHECK(arr[3] == 40, "array[3]", arr[3], 40);

		/* Local struct with brace init */
		struct simple s = {77, 88};
		CHECK(s.a == 77, "struct.a", s.a, 77);
		CHECK(s.b == 88, "struct.b", s.b, 88);

		/* Unsized array */
		int unsized[] = {1, 2, 3};
		CHECK(unsized[2] == 3, "unsized[2]", unsized[2], 3);

		/* Nested: struct with scalar member initialized in braces */
		struct simple sn = { {0}, 99 };
		CHECK(sn.a == 0,  "nested scalar 0", sn.a, 0);
		CHECK(sn.b == 99, "nested scalar 1", sn.b, 99);
	}

	/*
	 * Section 8 — static locals (const-init path)
	 */
	{
		static int s1 = {111};
		static unsigned s2 = {222};
		static void *s3 = {NULL};

		CHECK(s1 == 111,  "static int",  s1, 111);
		CHECK(s2 == 222,  "static uint", s2, 222);
		CHECK(s3 == NULL, "static ptr",  s3 == NULL, 1);
	}

	/*
	 * Section 9 — volatile / const qualified scalars
	 */
	{
		volatile int    v1 = {99};
		const int       c1 = {100};
		const volatile int cv1 = {101};

		CHECK(v1  == 99,  "volatile",     v1, 99);
		CHECK(c1  == 100, "const",        c1, 100);
		CHECK(cv1 == 101, "const vol",    cv1, 101);
	}

	/*
	 * Section 10 — minimum / maximum edge values
	 */
	{
		int          imin = {0x80000000u};  /* INT_MIN as unsigned literal */
		unsigned     umax = {0xFFFFFFFFu};
		short        smin = {(short)0x8000};
		unsigned short usmax = {0xFFFF};

		CHECK(imin  == (int)0x80000000u, "int min",    imin < 0, 1);
		CHECK(umax  == 0xFFFFFFFFu,      "uint max",   umax, 0xFFFFFFFFu);
		CHECK(smin  == (short)0x8000,    "short min",  smin < 0, 1);
		CHECK(usmax == 0xFFFF,           "ushort max", usmax, 0xFFFF);
	}

	printf("checked %d assertions\n", checked);
	return 0;
}
