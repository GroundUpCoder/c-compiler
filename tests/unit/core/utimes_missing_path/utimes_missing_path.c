// Regression: utimes() must fail (return -1) for a nonexistent path, like
// POSIX. The libc stub used to unconditionally return 0, which broke any
// caller that uses utimes() to probe existence — notably libgit2's object
// database, whose "freshen" step treats a successful touch() as "object
// already present" and so silently skipped every object write.
//
// utimes() here is a no-op for the actual timestamps (there is no host API to
// set mtime), but it must still report existence faithfully: 0 for a path that
// exists, -1 for one that does not.
#include <stdio.h>
#include <sys/time.h>

int main(void) {
	struct timeval tv[2] = { { 1700000000, 0 }, { 1700000000, 0 } };

	/* root always exists -> success (no-op on the times) */
	printf("exists: %d\n", utimes("/", tv));

	/* clearly nonexistent -> failure */
	printf("missing: %d\n", utimes("/no_such_path_3f9a2c/nope", tv));

	return 0;
}
