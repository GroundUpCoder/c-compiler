#include <stdio.h>
#include <sys/utsname.h>

int main(void) {
    struct utsname u;
    int r = uname(&u);
    printf("r=%d\n", r);
    printf("sys=%s node=%s rel=%s ver=%s mach=%s\n",
           u.sysname, u.nodename, u.release, u.version, u.machine);
    printf("null=%d\n", uname((struct utsname *)0));
    return 0;
}
