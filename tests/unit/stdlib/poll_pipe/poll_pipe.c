#include <stdio.h>
#include <unistd.h>
#include <poll.h>

int main(void) {
    int fds[2];
    if (pipe(fds) != 0) { printf("pipe failed\n"); return 1; }

    /* empty set, zero timeout -> returns immediately with 0 */
    printf("empty=%d\n", poll((struct pollfd *)0, 0, 0));

    /* write end is writable */
    struct pollfd pw = { fds[1], POLLOUT, 0 };
    int rw = poll(&pw, 1, 0);
    printf("wr n=%d out=%d\n", rw, (pw.revents & POLLOUT) != 0);

    /* read end not yet readable (pipe empty, write end open) */
    struct pollfd pr = { fds[0], POLLIN, 0 };
    int r0 = poll(&pr, 1, 0);
    printf("rd_before n=%d in=%d\n", r0, (pr.revents & POLLIN) != 0);

    /* after a write, read end becomes readable */
    write(fds[1], "x", 1);
    pr.revents = 0;
    int r1 = poll(&pr, 1, 0);
    printf("rd_after n=%d in=%d\n", r1, (pr.revents & POLLIN) != 0);

    /* negative fd is ignored */
    struct pollfd pn = { -1, POLLIN, 0 };
    printf("negfd n=%d rev=%d\n", poll(&pn, 1, 0), pn.revents);
    return 0;
}
