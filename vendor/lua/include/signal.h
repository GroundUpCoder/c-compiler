#pragma once

typedef int sig_atomic_t;

#define SIG_DFL ((void (*)(int))0)
#define SIG_IGN ((void (*)(int))1)
#define SIG_ERR ((void (*)(int))-1)

#define SIGINT  2
#define SIGTERM 15
#define SIGABRT 6

static void (*signal(int sig, void (*handler)(int)))(int) {
    (void)sig;
    (void)handler;
    return SIG_DFL;
}
