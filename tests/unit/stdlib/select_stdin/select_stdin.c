#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/time.h>
#include <unistd.h>

int main(void) {
    fd_set rfds;
    struct timeval tv;
    int ret;

    /* First select: timeout with no data yet (50ms timeout) */
    FD_ZERO(&rfds);
    FD_SET(STDIN_FILENO, &rfds);
    tv.tv_sec = 0;
    tv.tv_usec = 50000;
    ret = select(STDIN_FILENO + 1, &rfds, 0, 0, &tv);
    printf("select_before_data: %d\n", ret);
    printf("stdin_set_before: %d\n", FD_ISSET(STDIN_FILENO, &rfds) ? 1 : 0);

    /* Second select: data should arrive at 0.2s, we wait up to 2s */
    FD_ZERO(&rfds);
    FD_SET(STDIN_FILENO, &rfds);
    tv.tv_sec = 2;
    tv.tv_usec = 0;
    ret = select(STDIN_FILENO + 1, &rfds, 0, 0, &tv);
    printf("select_with_data: %d\n", ret);
    printf("stdin_set_after: %d\n", FD_ISSET(STDIN_FILENO, &rfds) ? 1 : 0);

    /* Read the data */
    char buf[64];
    int n = read(STDIN_FILENO, buf, sizeof(buf) - 1);
    buf[n] = 0;
    printf("read: %s", buf);

    return 0;
}
