/* wasm_port.h — the busybox-on-wasm port layer (todos/0005).
 *
 * Included from the bottom of libbb.h (port patch), so every busybox TU
 * sees it after all libc + libbb declarations. Two jobs:
 *
 * 1. Small glibc-isms our libc doesn't carry (mempcpy, sigisemptyset).
 *
 * 2. THE VFORK-ON-__SPAWN SHIM. This platform has no fork and no vfork
 *    (see todos/OS.md, decided) — but it has a CreateProcess-class
 *    __spawn with declarative fd_actions. hush's NOMMU discipline makes
 *    every vfork child a straight line of journalable operations:
 *    fd moves (dup2/close/open), setpgid/tcsetpgrp, signal tweaks, then
 *    execve-or-_exit — and hush already restores its globals after the
 *    child ran in shared memory (that's what vfork means on NOMMU).
 *    So the "child" simply RUNS IN THE PARENT: the vfork call sites are
 *    patched (see README) into
 *
 *        if (setjmp(pv_state.jmp) == 0) { pv_child_begin(); <child code> }
 *        pid = pv_state.child_pid;    // parent resumes here via longjmp
 *
 *    and while pv_state.in_child is set, the macros below journal fd ops
 *    into a file_actions list instead of executing them. exec*() builds a
 *    __spawn spec from the journal and longjmps back with the real pid;
 *    _exit() (a child that never execs: `var=x | cmd`, failed redirects)
 *    longjmps back with a SYNTHETIC pid whose status waitpid() serves
 *    later. Setjmp use deliberately sticks to the `if (setjmp(x) == 0)`
 *    form this compiler's lowering supports.
 */
#ifndef BB_WASM_PORT_H
#define BB_WASM_PORT_H 1

#include <setjmp.h>
#include <string.h>
#include <stdlib.h>
#include <strings.h>   /* strcasecmp lives here, not in string.h */
#include <signal.h>
#include <getopt.h>    /* this libc splits getopt out of unistd.h */
#include <alloca.h>

#include <wchar.h>     /* mbstate_t for unicode.c (glibc leaks it around) */

/* ---- glibc-isms not covered by libbb/platform.c's fallbacks ---- */
static ALWAYS_INLINE char *strndup(const char *s, size_t n)
{
    size_t len = strlen(s);
    char *d;
    if (len > n) len = n;
    d = (char *)malloc(len + 1);
    if (d) { memcpy(d, s, len); d[len] = 0; }
    return d;
}
/* Single-user, single-session system: everything is session 1, uid/gid 0,
 * and "changing" effective ids is a successful no-op (test.c drops privs
 * around access checks; there are none to drop). */
static ALWAYS_INLINE pid_t getsid(pid_t pid) { (void)pid; return 1; }
static ALWAYS_INLINE int setegid(gid_t g) { (void)g; return 0; }
static ALWAYS_INLINE int seteuid(uid_t u) { (void)u; return 0; }

static ALWAYS_INLINE int sigisemptyset(const sigset_t *s)
{
    return *s == 0;   /* our sigset_t is a plain bitmask word */
}
#define setpgrp() setpgid(0, 0)
/* umask: was shimmed here as a value that round-tripped but did nothing —
 * "the fs layer has no notion of a process umask". The libc has a REAL one
 * now (todos/0382 gap 1) which open/mkdir actually apply, so the shim is
 * both a duplicate definition and a lie. hush's `umask` builtin now takes
 * effect on files its children create. */

/* ---- the vfork-on-__spawn shim (port/vfork_spawn.c) ---- */
#define PV_MAX_ACTIONS 32
/* getpid() inside a journaling "child" returns this: the pid of the
 * not-yet-spawned process. Its only consumers are the pgroup calls, which
 * translate it to "own pid" (spawn spec pgid 0) / "the spawned pid". */
#define PV_PID_SENTINEL 0x7ead

struct pv_state_t {
    jmp_buf jmp;
    volatile int in_child;      /* journaling mode is ON */
    volatile int child_pid;     /* set before longjmp back to the call site */
    /* journal */
    struct __fd_action acts[PV_MAX_ACTIONS];
    int n_acts;
    int spawn_flags;            /* bit0 = SETPGROUP */
    int spawn_pgid;
    int parent_close[PV_MAX_ACTIONS]; /* fds the parent opened for the child */
    int n_parent_close;
    int tc_fd;                  /* deferred tcsetpgrp(fd, <child>): -1 = none */
    char *open_paths[PV_MAX_ACTIONS]; /* strdup'ed redirect targets */
    int n_open_paths;
};
extern struct pv_state_t pv_state;

void pv_child_begin(void);              /* enter journaling mode */
int  pv_close(int fd);
int  pv_dup2(int oldfd, int newfd);
int  pv_open3(const char *path, int flags, int mode);
int  pv_open2(const char *path, int flags);
pid_t pv_getpid(void);
int  pv_setpgid(pid_t pid, pid_t pgid);
int  pv_tcsetpgrp(int fd, pid_t pgrp);
int  pv_execve(const char *path, char *const argv[], char *const envp[]);
int  pv_execv(const char *path, char *const argv[]);
int  pv_execvp(const char *file, char *const argv[]);
void pv_exit(int status) NORETURN;
pid_t pv_waitpid(pid_t pid, int *status, int options);
sighandler_t pv_signal(int sig, sighandler_t handler);
int  pv_sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int  pv_sigprocmask(int how, const sigset_t *set, sigset_t *old);

/* Call-site interception. vfork_spawn.c defines PV_NO_INTERCEPT and calls
 * the real functions; everything else journals while in_child. (exec* and
 * waitpid are intercepted unconditionally — they check the flag inside.) */
#ifndef PV_NO_INTERCEPT
#define close(fd)                 pv_close(fd)
#define dup2(o, n)                pv_dup2(o, n)
#define getpid()                  pv_getpid()
#define setpgid(p, g)             pv_setpgid(p, g)
#define tcsetpgrp(f, g)           pv_tcsetpgrp(f, g)
#define execve(p, a, e)           pv_execve(p, a, e)
#define execv(p, a)               pv_execv(p, a)
#define execvp(f, a)              pv_execvp(f, a)
#define _exit(s)                  pv_exit(s)
#define waitpid(p, s, o)          pv_waitpid(p, s, o)
#define signal(s, h)              pv_signal(s, h)
#define sigaction(s, a, o)        pv_sigaction(s, a, o)
#define sigprocmask(h, s, o)      pv_sigprocmask(h, s, o)
/* open is variadic; route both arities */
#define open(...)                 PV_OPEN_PICK(__VA_ARGS__, pv_open3, pv_open2)(__VA_ARGS__)
#define PV_OPEN_PICK(a, b, c, f, ...) f
#endif
/* (Since todos/0035 BOTH binaries link vfork_spawn.c — the coreutils
 * multicall gained the spawn-capable applets (find -exec, xargs, awk,
 * tar, env-exec), so the former PV_NO_INTERCEPT always-fail execvp stub
 * is gone. PV_NO_INTERCEPT remains only for the port's own TUs, which
 * need the real functions.) */

#endif /* BB_WASM_PORT_H */
