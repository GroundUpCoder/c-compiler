#include <stdio.h>

struct T { int a; };
extern struct T *ptr;
extern int *iptr;

struct Wrap { struct T *f; };
struct Two { int pad; struct T *f; int *g; };
struct Nest { struct Two inner; struct T *tail; };

/* Self-referential static initializer (the same class at file scope): the
 * identifier is in scope inside its own initializer (6.2.1p7) and &empty is
 * an address constant (6.6p9). NetSurf urldb.c needed a forward-decl
 * workaround for this. */
struct SN { int v; struct SN *l, *r; };
static struct SN empty = { 5, &empty, &empty };

int main(void)
{
	/* positional */
	struct Wrap w = { ptr };
	/* designated */
	struct Wrap wd = { .f = ptr };
	/* non-first member + mixed pointer types */
	struct Two t = { 1, ptr, iptr };
	/* nested aggregate */
	struct Nest n = { { 2, ptr, iptr }, ptr };
	/* array of pointers */
	struct T *arr[3] = { ptr, 0, ptr };
	/* compound literal */
	struct Wrap cl = *(&(struct Wrap){ ptr });
	/* assignment form (was already correct — must stay correct) */
	struct Wrap wa;
	wa.f = ptr;

	printf("%d %d %d %d %d %d %d %d %d\n",
	       w.f->a, wd.f->a, t.f->a, *t.g,
	       n.inner.f->a, *n.inner.g, n.tail->a,
	       arr[0]->a + arr[2]->a, cl.f->a + wa.f->a);
	printf("%d %d %d\n", empty.v, empty.l->v, empty.r->l->v);
	return 0;
}
