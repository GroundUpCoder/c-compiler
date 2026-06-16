#include <stdio.h>
#include <grp.h>

int main(void) {
    struct group *g = getgrgid(0);
    printf("byid: %s gid=%d\n", g ? g->gr_name : "(null)", g ? (int)g->gr_gid : -1);
    printf("byid_nonroot=%d\n", getgrgid(1000) == NULL);
    struct group *n = getgrnam("root");
    printf("byname: %s\n", n ? n->gr_name : "(null)");
    printf("byname_missing=%d\n", getgrnam("nobody") == NULL);
    printf("mem_empty=%d\n", g->gr_mem[0] == NULL);
    return 0;
}
