/* Signal registration + synchronous self-delivery (Phase 1). No async delivery
   exists, but sigaction/signal must record dispositions, raise() must run the
   handler synchronously, SIGKILL/SIGSTOP must be uncatchable, and the sigset /
   sigprocmask surface must work — so handler-using code compiles and behaves. */
#include <signal.h>
#include <stdio.h>
#include <errno.h>

static volatile int hits = 0;
static void onsig(int s) { hits += s; }

int main(void) {
    /* signal() returns the previous handler; default is SIG_DFL. */
    __sighandler_t prev = signal(SIGUSR1, onsig);
    printf("prev_dfl:%d\n", prev == SIG_DFL);

    /* raise() delivers to the handler synchronously. SIGUSR1 = 10. */
    raise(SIGUSR1);
    raise(SIGUSR1);
    printf("hits:%d\n", hits);

    /* installing again returns OUR handler as the previous. */
    __sighandler_t p2 = signal(SIGUSR1, SIG_IGN);
    printf("prev_is_handler:%d\n", p2 == onsig);

    /* SIG_IGN → raise is a no-op. */
    raise(SIGUSR1);
    printf("hits_after_ign:%d\n", hits);

    /* SIGKILL / SIGSTOP cannot be caught → EINVAL. */
    errno = 0;
    __sighandler_t k = signal(SIGKILL, onsig);
    printf("kill_einval:%d\n", k == SIG_ERR && errno == EINVAL);

    /* sigaction round-trips the disposition. */
    struct sigaction sa, old;
    sa.sa_handler = onsig; sa.sa_flags = 0; sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR2, &sa, NULL);
    sigaction(SIGUSR2, NULL, &old);
    printf("sigaction_old:%d\n", old.sa_handler == onsig);

    /* sigset ops + sigprocmask. */
    sigset_t set, oldset;
    sigemptyset(&set); sigaddset(&set, SIGUSR1);
    printf("member:%d\n", sigismember(&set, SIGUSR1));
    sigprocmask(SIG_BLOCK, &set, &oldset);
    sigset_t cur; sigprocmask(SIG_BLOCK, NULL, &cur);
    printf("blocked:%d\n", sigismember(&cur, SIGUSR1));

    /* a default-disposition ignore signal raised is a no-op (SIGCHLD). */
    raise(SIGCHLD);
    printf("after_chld:%d\n", hits);
    return 0;
}
