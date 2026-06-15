/* Block-FS stdin is synchronous: with no buffered input it is at EOF, which
 * select() reports as readable immediately (a read then returns 0). */
#include <stdio.h>
#include <sys/select.h>
#include <sys/time.h>
#include <unistd.h>

int main(void) {
    fd_set rfds;
    struct timeval tv;
    FD_ZERO(&rfds);
    FD_SET(STDIN_FILENO, &rfds);
    tv.tv_sec = 1; tv.tv_usec = 0;
    int ret = select(STDIN_FILENO + 1, &rfds, 0, 0, &tv);
    printf("ret: %d\n", ret);
    printf("stdin_set: %d\n", FD_ISSET(STDIN_FILENO, &rfds) ? 1 : 0);
    char buf[8];
    int n = read(STDIN_FILENO, buf, sizeof(buf));
    printf("read_n: %d\n", n);
    return 0;
}
