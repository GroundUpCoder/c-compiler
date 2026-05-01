#include <stdio.h>
#include <signal.h>

void test_types(void) {
    sig_atomic_t x = 42;
    printf("sig_atomic_t: %d\n", x);

    volatile sig_atomic_t v = 1;
    v = 0;
    printf("volatile sig_atomic_t: %d\n", v);
}

void test_constants(void) {
    printf("SIGABRT=%d\n", SIGABRT);
    printf("SIGFPE=%d\n", SIGFPE);
    printf("SIGILL=%d\n", SIGILL);
    printf("SIGINT=%d\n", SIGINT);
    printf("SIGSEGV=%d\n", SIGSEGV);
    printf("SIGTERM=%d\n", SIGTERM);
}

void test_handler_constants(void) {
    __sighandler_t dfl = SIG_DFL;
    __sighandler_t ign = SIG_IGN;
    __sighandler_t err = SIG_ERR;
    printf("SIG_DFL!=SIG_IGN: %d\n", dfl != ign);
    printf("SIG_DFL!=SIG_ERR: %d\n", dfl != err);
    printf("SIG_IGN!=SIG_ERR: %d\n", ign != err);
}

void dummy_handler(int sig) {
    (void)sig;
}

void test_signal_func(void) {
    __sighandler_t prev = signal(SIGINT, dummy_handler);
    printf("signal returns SIG_DFL: %d\n", prev == SIG_DFL);

    prev = signal(SIGTERM, SIG_IGN);
    printf("signal returns SIG_DFL again: %d\n", prev == SIG_DFL);
}

void test_raise(void) {
    int result = raise(SIGINT);
    printf("raise returns 0: %d\n", result == 0);
}

void test_multiple_includes(void) {
    printf("pragma once works: 1\n");
}

int main(void) {
    test_types();
    test_constants();
    test_handler_constants();
    test_signal_func();
    test_raise();
    test_multiple_includes();
    return 0;
}
