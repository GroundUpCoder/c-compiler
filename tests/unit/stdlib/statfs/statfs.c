#include <stdio.h>
#include <sys/statfs.h>

int main(void) {
    struct statfs s;
    int r = statfs("/", &s);
    printf("r=%d bsize=%ld frsize=%ld namelen=%ld\n",
           r, s.f_bsize, s.f_frsize, s.f_namelen);
    printf("blocks=%llu bfree=%llu\n", s.f_blocks, s.f_bfree);
    printf("fr=%d null=%d\n", fstatfs(0, &s), statfs("/", (struct statfs *)0));
    return 0;
}
