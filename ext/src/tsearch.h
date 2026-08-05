#include <search.h>

/* Local modification (same shim as tre.h): this build emits no
   symbol-visibility attributes, so musl's `hidden` marker is neutralized. */
#ifndef hidden
#define hidden
#endif

/* AVL tree height < 1.44*log2(nodes+2)-0.3, MAXH is a safe upper bound.  */
#define MAXH (sizeof(void*)*8*3/2)

struct node {
	const void *key;
	void *a[2];
	int h;
};

hidden int __tsearch_balance(void **);
