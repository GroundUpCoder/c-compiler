// stat() must fully populate struct stat — not just the leading fields. This
// checks the tail that used to be left as uninitialized stack garbage: the
// POSIX-2008 nanosecond timespecs (which must mirror the scalar seconds),
// st_uid/st_gid (single-user: 0), st_blksize, and st_blocks (512B units).
#include <stdio.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
	const char *p = "/tmp/cc_stat_fields.bin";
	FILE *f = fopen(p, "w");
	if (!f) { printf("create FAIL\n"); return 1; }
	for (int i = 0; i < 1000; i++) fputc('x', f);   /* 1000 bytes */
	fclose(f);

	struct timeval tv[2] = { { 1000000000, 0 }, { 1700000000, 0 } };
	utimes(p, tv);

	struct stat st;
	if (stat(p, &st) != 0) { printf("stat FAIL\n"); return 1; }

	printf("size=%ld\n", (long)st.st_size);
	printf("mtime=%ld\n", (long)st.st_mtime);
	printf("mtim.tv_sec=%ld\n", (long)st.st_mtim.tv_sec);
	printf("mtim.tv_nsec=%ld\n", (long)st.st_mtim.tv_nsec);
	printf("atim.tv_sec=%ld\n", (long)st.st_atim.tv_sec);
	printf("uid=%u gid=%u\n", st.st_uid, st.st_gid);
	printf("blksize=%ld\n", (long)st.st_blksize);
	printf("blocks=%ld\n", (long)st.st_blocks);

	remove(p);
	return 0;
}
