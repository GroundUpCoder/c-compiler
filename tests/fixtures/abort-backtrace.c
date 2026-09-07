#include <assert.h>
#include <stdlib.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void handled(int sig) { printf("handled %d\n", sig); fflush(stdout); }
__attribute__((noinline)) static void depth3(const char *mode) {
    if (!strcmp(mode, "assert")) assert(0 && "expected assertion"); /* ASSERT_SITE */
    if (!strcmp(mode, "exit")) exit(134);
    abort(); /* ABORT_SITE */
}
__attribute__((noinline)) static void depth2(const char *mode) { depth3(mode); }
__attribute__((noinline)) static void depth1(const char *mode) { depth2(mode); }
int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "abort";
    if (!strcmp(mode, "handled")) signal(SIGABRT, handled);
    if (!strcmp(mode, "closed")) close(2);
    depth1(mode);
    return 0;
}
