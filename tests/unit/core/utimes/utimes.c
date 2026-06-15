// Faithful utimes()/futimes(): actually set a file's mtime/atime (not a no-op),
// fail with -1 for a missing path, and round-trip through stat(). Backs the
// libc set-times path wired through all three host FS backends.
#include <stdio.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

int main(void) {
	const char *p = "/tmp/cc_utimes_probe.txt";
	FILE *f = fopen(p, "w");
	if (!f) { printf("create FAIL\n"); return 1; }
	fputs("hi", f);
	fclose(f);

	struct timeval tv[2] = { { 1000000000, 0 }, { 1700000000, 0 } };
	printf("utimes: %d\n", utimes(p, tv));          /* 0 */

	struct stat st;
	stat(p, &st);
	printf("mtime: %ld\n", (long)st.st_mtime);      /* 1700000000 */

	printf("missing: %d\n", utimes("/no_such_d3f/x", tv)); /* -1 */

	int fd = open(p, O_RDONLY);
	struct timeval tv2[2] = { { 1000000000, 0 }, { 1600000000, 0 } };
	printf("futimes: %d\n", futimes(fd, tv2));      /* 0 */
	close(fd);
	stat(p, &st);
	printf("mtime2: %ld\n", (long)st.st_mtime);     /* 1600000000 */

	remove(p);
	return 0;
}
