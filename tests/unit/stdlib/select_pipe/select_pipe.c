#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/time.h>
#include <unistd.h>

int main(void) {
    int fds[2];
    pipe(fds);

    fd_set rfds;
    struct timeval tv;

    /* Select on read end of empty pipe — should timeout */
    FD_ZERO(&rfds);
    FD_SET(fds[0], &rfds);
    tv.tv_sec = 0;
    tv.tv_usec = 10000;
    int ret = select(fds[0] + 1, &rfds, 0, 0, &tv);
    printf("empty_pipe: %d\n", ret);

    /* Write to pipe */
    write(fds[1], "test", 4);

    /* Select on read end — should be ready immediately */
    FD_ZERO(&rfds);
    FD_SET(fds[0], &rfds);
    tv.tv_sec = 1;
    tv.tv_usec = 0;
    ret = select(fds[0] + 1, &rfds, 0, 0, &tv);
    printf("full_pipe: %d\n", ret);
    printf("pipe_set: %d\n", FD_ISSET(fds[0], &rfds) ? 1 : 0);

    /* Read the data */
    char buf[16];
    int n = read(fds[0], buf, sizeof(buf) - 1);
    buf[n] = 0;
    printf("read: %s\n", buf);

    close(fds[0]);
    close(fds[1]);

    return 0;
}
