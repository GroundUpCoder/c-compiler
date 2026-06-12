#include <stdio.h>
#include <stdint.h>

/*
 * Scalar initialized with brace syntax:  "scalar = {0}"
 * This is valid C99 (section 6.7.8) — the initializer for a scalar
 * may optionally be enclosed in braces.  libgit2 exercises this via
 *   git_hashmap_iter_t iter = GIT_HASHMAP_INIT;  // → uint32_t iter = {0};
 * which previously crashed codegen with "unhandled expression EInitList".
 */

int main() {
	/* C99 §6.7.8p11: scalar may be brace-initialized */
	unsigned x = {0};
	printf("x=%u\n", x);

	int y = {42};
	printf("y=%d\n", y);

	uint32_t z = {0xDEAD};
	printf("z=%u\n", z);

	/* Also valid at file scope, but those go through consteval. */
	/* These local variants exercise the codegen path. */

	return 0;
}
