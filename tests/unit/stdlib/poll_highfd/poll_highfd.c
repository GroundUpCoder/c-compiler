/* Regression for #637: poll() must not index its fd_set out of bounds for an
 * fd >= FD_SETSIZE (64). Before the fix, FD_SET(fd)/FD_ISSET(fd) with fd>=64
 * wrote and read past the 8-byte stack-local fd_set (sizeof(unsigned long)==4,
 * two words), corrupting poll()'s frame and returning garbage revents. The fix
 * bounds-checks the FD_* macros and reports POLLNVAL for such an fd.
 *
 * The high-fd line is FIRST and load-bearing: it asserts nval=1, a value the
 * pre-fix ISSET loop cannot produce for a POLLIN request (it can only OR in
 * POLLIN/POLLOUT/POLLPRI, never POLLNVAL=0x20), so this fails at base. */
#include <stdio.h>
#include <unistd.h>
#include <poll.h>

int main(void) {
    /* --- load-bearing: an fd well past FD_SETSIZE(64), never opened --- */
    struct pollfd hi = { 1000, POLLIN, 0 };
    int nhi = poll(&hi, 1, 0);
    printf("highfd n=%d nval=%d other=%d\n",
           nhi,
           (hi.revents & POLLNVAL) != 0,
           (hi.revents & ~POLLNVAL) != 0);

    /* fd exactly at the boundary (first out-of-range word) */
    struct pollfd edge = { 64, POLLIN | POLLOUT, 0 };
    int nedge = poll(&edge, 1, 0);
    printf("edge n=%d nval=%d other=%d\n",
           nedge,
           (edge.revents & POLLNVAL) != 0,
           (edge.revents & ~POLLNVAL) != 0);

    /* --- positive control: the same program on low fds still works --- */
    int fds[2];
    if (pipe(fds) != 0) { printf("pipe failed\n"); return 1; }
    write(fds[1], "x", 1);
    struct pollfd lo = { fds[0], POLLIN, 0 };
    int nlo = poll(&lo, 1, 0);
    printf("lowfd n=%d in=%d\n", nlo, (lo.revents & POLLIN) != 0);

    /* highest in-range fd must never be treated as invalid: mix it with an
     * out-of-range fd in ONE call and confirm both are classified right. */
    struct pollfd mix[2] = { { 63, POLLIN, 0 }, { 200, POLLIN, 0 } };
    int nmix = poll(mix, 2, 0);
    printf("mix n=%d f63_nval=%d f200_nval=%d\n",
           nmix,
           (mix[0].revents & POLLNVAL) != 0,
           (mix[1].revents & POLLNVAL) != 0);

    /* negative fd stays ignored (existing contract) */
    struct pollfd neg = { -1, POLLIN, 0 };
    printf("negfd n=%d rev=%d\n", poll(&neg, 1, 0), neg.revents);
    return 0;
}
