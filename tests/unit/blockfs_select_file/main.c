/* A regular file is always ready for both read and write in select(). */
#include <stdio.h>
#include <sys/select.h>
#include <sys/time.h>

int main(void) {
    FILE *f = fopen("/sel.txt", "w+");
    if (!f) { printf("FAIL: fopen\n"); return 1; }
    fwrite("hi", 1, 2, f);
    fflush(f);
    int fd = fileno(f);

    fd_set rfds, wfds;
    struct timeval tv;
    FD_ZERO(&rfds); FD_ZERO(&wfds);
    FD_SET(fd, &rfds);
    FD_SET(fd, &wfds);
    tv.tv_sec = 1; tv.tv_usec = 0;
    int ret = select(fd + 1, &rfds, &wfds, 0, &tv);
    printf("ret: %d\n", ret);
    printf("read_ready: %d\n", FD_ISSET(fd, &rfds) ? 1 : 0);
    printf("write_ready: %d\n", FD_ISSET(fd, &wfds) ? 1 : 0);

    fclose(f);
    return 0;
}
