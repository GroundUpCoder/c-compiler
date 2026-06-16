#include <stdio.h>
#include <sys/statvfs.h>

int main(void) {
    struct statvfs s;
    int r = statvfs("/", &s);
    printf("r=%d bsize=%lu frsize=%lu namemax=%lu\n",
           r, s.f_bsize, s.f_frsize, s.f_namemax);
    printf("blocks=%llu bfree=%llu bavail=%llu\n",
           s.f_blocks, s.f_bfree, s.f_bavail);
    printf("files=%llu ffree=%llu\n", s.f_files, s.f_ffree);
    printf("fr=%d\n", fstatvfs(0, &s));
    printf("null=%d\n", statvfs("/", (struct statvfs *)0));
    return 0;
}
