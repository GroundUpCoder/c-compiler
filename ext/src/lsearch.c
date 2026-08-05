#include <search.h>
#include <string.h>

/* Local modification: upstream indexes the table through a pointer to a
   variable-length array type, `char (*p)[width]`, which this compiler
   rejects (no VLA support). Plain byte arithmetic computes the identical
   addresses; behaviour is unchanged. */

void *lsearch(const void *key, void *base, size_t *nelp, size_t width,
	int (*compar)(const void *, const void *))
{
	char *p = base;
	size_t n = *nelp;
	size_t i;

	for (i = 0; i < n; i++)
		if (compar(key, p + i*width) == 0)
			return p + i*width;
	*nelp = n+1;
	return memcpy(p + n*width, key, width);
}

void *lfind(const void *key, const void *base, size_t *nelp,
	size_t width, int (*compar)(const void *, const void *))
{
	char *p = (void *)base;
	size_t n = *nelp;
	size_t i;

	for (i = 0; i < n; i++)
		if (compar(key, p + i*width) == 0)
			return p + i*width;
	return 0;
}
