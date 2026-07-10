/* vfork_spawn.c — the vfork-on-__spawn shim (design: wasm_port.h and
 * vendor/busybox/README.md; decision trail: todos/OS.md "__spawn is the
 * native primitive").
 *
 * The "child" is the parent process in journaling mode: fd ops and pgroup
 * calls accumulate into a __spawn_spec instead of executing; exec*()
 * issues the spawn and longjmps back to the patched vfork site with the
 * real pid; _exit() longjmps back with a synthetic pid whose status
 * waitpid() serves from a small table. hush's NOMMU code already assumes
 * the child ran in its memory and restores state afterwards.
 */
#define PV_NO_INTERCEPT 1
#include "libbb.h"

#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>   /* the bare-exec emulation reaps its child */
#include <termios.h>
#include <unistd.h>

struct pv_state_t pv_state;

/* ---- synthetic children ----
 * A vfork child that _exit()s without exec'ing never became a process; we
 * hand hush a fake pid and serve its wait status locally. Pids from a
 * range the kernel will never mint (kernel pids count up from 1). */
#define PV_SYNTH_BASE 0x40000000
#define PV_MAX_SYNTH  16
static struct { int pid; int status; int live; } pv_synth[PV_MAX_SYNTH];
static int pv_synth_seq;

static int pv_synth_add(int exitcode)
{
    int i;
    for (i = 0; i < PV_MAX_SYNTH; i++) {
        if (!pv_synth[i].live) {
            pv_synth[i].live = 1;
            pv_synth[i].pid = PV_SYNTH_BASE + (pv_synth_seq++ & 0xffffff);
            pv_synth[i].status = (exitcode & 0xff) << 8;   /* W_EXITCODE */
            return pv_synth[i].pid;
        }
    }
    /* Table full: report as an immediately-reaped success; should not
     * happen (hush waits for pipe members promptly). */
    return PV_SYNTH_BASE + (pv_synth_seq++ & 0xffffff);
}

pid_t pv_waitpid(pid_t pid, int *status, int options)
{
    int i;
    for (i = 0; i < PV_MAX_SYNTH; i++) {
        if (pv_synth[i].live && (pid == -1 || pid == pv_synth[i].pid)) {
            pv_synth[i].live = 0;
            if (status) *status = pv_synth[i].status;
            return pv_synth[i].pid;
        }
    }
    if (pid >= PV_SYNTH_BASE) { errno = ECHILD; return -1; }  /* stale synth */
    return waitpid(pid, status, options);
}

/* ---- journaling mode ---- */

void pv_child_begin(void)
{
    int i;
    for (i = 0; i < pv_state.n_open_paths; i++) free(pv_state.open_paths[i]);
    pv_state.in_child = 1;
    pv_state.n_acts = 0;
    pv_state.spawn_flags = 0;
    pv_state.spawn_pgid = 0;
    pv_state.n_parent_close = 0;
    pv_state.tc_fd = -1;
    pv_state.n_open_paths = 0;
}

static struct __fd_action *pv_act(void)
{
    if (pv_state.n_acts >= PV_MAX_ACTIONS) return NULL;   /* drop, like ulimit */
    return &pv_state.acts[pv_state.n_acts++];
}

int pv_close(int fd)
{
    struct __fd_action *a;
    if (!pv_state.in_child) return close(fd);
    a = pv_act();
    if (a) { a->op = 2; a->fd = fd; a->arg = 0; a->path = 0; a->mode = 0; }
    return 0;
}

int pv_dup2(int oldfd, int newfd)
{
    struct __fd_action *a;
    if (!pv_state.in_child) return dup2(oldfd, newfd);
    a = pv_act();
    if (a) { a->op = 0; a->fd = newfd; a->arg = oldfd; a->path = 0; a->mode = 0; }
    return newfd;
}

/* Redirect opens really open (in the parent) so errors surface exactly
 * where hush expects them; the fd is inherited by the child, the journal
 * carries the dup2/close dance, and the parent closes its copy after the
 * spawn. */
int pv_open3(const char *path, int flags, int mode)
{
    int fd = open(path, flags, mode);
    if (pv_state.in_child && fd >= 0 &&
        pv_state.n_parent_close < PV_MAX_ACTIONS) {
        pv_state.parent_close[pv_state.n_parent_close++] = fd;
    }
    return fd;
}
int pv_open2(const char *path, int flags) { return pv_open3(path, flags, 0); }

pid_t pv_getpid(void)
{
    /* In the child, "my pid" means the pid the spawn hasn't produced yet.
     * The only consumer is the pgroup dance (pgrp = getpid(); setpgid(0,
     * pgrp); tcsetpgrp(fd, pgrp)), and the sentinel makes those journal
     * as "own pid" (spec.pgid 0) / "the spawned pid" respectively. */
    if (pv_state.in_child) return PV_PID_SENTINEL;
    return getpid();
}

int pv_setpgid(pid_t pid, pid_t pgid)
{
    if (!pv_state.in_child) {
        /* Parent-side setpgid: nothing in the hush build reaches this
         * (interactive setup uses getpgrp()); fail loudly if it appears. */
        errno = ENOSYS;
        return -1;
    }
    (void)pid;                                    /* always 0 = self at these sites */
    pv_state.spawn_flags |= 1;                    /* POSIX_SPAWN_SETPGROUP */
    pv_state.spawn_pgid = (pgid == PV_PID_SENTINEL) ? 0 : pgid;
    return 0;
}

int pv_tcsetpgrp(int fd, pid_t pgrp)
{
    if (!pv_state.in_child) return tcsetpgrp(fd, pgrp);
    /* "Every child calls tcsetpgrp to avoid the race" — our kernel
     * assigns the pgid atomically at spawn, so ONE deferred call from the
     * parent right after the spawn is race-free. */
    pv_state.tc_fd = fd;
    (void)pgrp;                                   /* sentinel or first-child pid */
    return 0;
}

/* Signal calls in the child would clobber the SHELL's dispositions (a real
 * vfork child has its own); the spawned process starts at SIG_DFL anyway,
 * so journaling mode swallows them. */
sighandler_t pv_signal(int sig, sighandler_t handler)
{
    if (!pv_state.in_child) return signal(sig, handler);
    return SIG_DFL;
}
int pv_sigaction(int sig, const struct sigaction *act, struct sigaction *old)
{
    if (!pv_state.in_child) return sigaction(sig, act, old);
    if (old) memset(old, 0, sizeof(*old));
    return 0;
}
int pv_sigprocmask(int how, const sigset_t *set, sigset_t *old)
{
    if (!pv_state.in_child) return sigprocmask(how, set, old);
    if (old) *old = 0;
    return 0;
}

/* ---- exec: the journal becomes one __spawn ---- */

static void pv_parent_cleanup(void)
{
    int i;
    for (i = 0; i < pv_state.n_parent_close; i++) close(pv_state.parent_close[i]);
    pv_state.n_parent_close = 0;
}

int pv_execve(const char *path, char *const argv[], char *const envp[])
{
    struct __spawn_spec spec;
    char abs[1024];
    int pid;

    /* The kernel loads images by absolute path (spawn specs don't carry
     * a cwd for the LOOKUP, only for the child): resolve ./a.out here. */
    if (path[0] != '/') {
        char cwd[900];
        if (getcwd(cwd, sizeof cwd) &&
            strlen(cwd) + 1 + strlen(path) + 1 <= sizeof abs) {
            sprintf(abs, "%s/%s", strcmp(cwd, "/") == 0 ? "" : cwd, path);
            path = abs;
        }
    }

    spec.path = path;
    spec.argv = argv;
    spec.envp = envp;          /* hush passes environ or a built env */
    spec.cwd = 0;              /* inherit */
    spec.trace = -1;           /* no __SPAWN_TRACE — field ignored (0046) */

    if (!pv_state.in_child) {
        /* Bare exec, outside any vfork child (env's BB_EXECVP, tar's
         * re-exec'd helpers under an exec-only applet): there is no real
         * exec on this platform, so emulate the observable behavior —
         * spawn the image with an EMPTY journal (fds/cwd/pgroup inherit)
         * and become a shell around it: wait, then exit with its status.
         * The lingering parent is invisible to scripts (todos/0035). */
        int status = 0;
        spec.actions = 0;
        spec.n_actions = 0;
        spec.flags = 0;
        spec.pgid = 0;
        pid = __spawn(&spec);
        if (pid < 0) return -1;             /* errno from the spawn */
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
            continue;
        if (WIFSIGNALED(status)) _exit(128 + WTERMSIG(status));
        _exit(WIFEXITED(status) ? WEXITSTATUS(status) : 127);
    }

    spec.actions = pv_state.acts;
    spec.n_actions = pv_state.n_acts;
    spec.flags = (unsigned)pv_state.spawn_flags;
    spec.pgid = pv_state.spawn_pgid;
    pid = __spawn(&spec);
    if (pid < 0) return -1;    /* child code falls to its exec-failure path */

    if (pv_state.tc_fd >= 0) tcsetpgrp(pv_state.tc_fd, pid);
    pv_parent_cleanup();
    pv_state.in_child = 0;
    pv_state.child_pid = pid;
    longjmp(pv_state.jmp, 1);
    return -1;                 /* unreachable */
}

int pv_execv(const char *path, char *const argv[])
{
    return pv_execve(path, argv, environ);
}

int pv_execvp(const char *file, char *const argv[])
{
    char cand[1024];
    const char *path;
    size_t flen;

    if (strchr(file, '/')) return pv_execve(file, argv, environ);
    path = getenv("PATH");
    if (!path || !*path) path = "/bin:/usr/bin";
    flen = strlen(file);
    while (*path) {
        const char *colon = strchr(path, ':');
        size_t dlen = colon ? (size_t)(colon - path) : strlen(path);
        if (dlen + 1 + flen + 1 <= sizeof(cand)) {
            memcpy(cand, path, dlen);
            cand[dlen] = '/';
            strcpy(cand + dlen + 1, file);
            if (access(cand, F_OK) == 0) return pv_execve(cand, argv, environ);
        }
        if (!colon) break;
        path = colon + 1;
    }
    /* Nothing found: try as-is so the error is ENOENT from the spawn. */
    return pv_execve(file, argv, environ);
}

void pv_exit(int status)
{
    if (pv_state.in_child) {
        /* A child that never exec'd (var=x | cmd, redirect-only, failed
         * redirect): undo the journal and report a synthetic child. */
        pv_parent_cleanup();
        pv_state.in_child = 0;
        pv_state.child_pid = pv_synth_add(status);
        longjmp(pv_state.jmp, 1);
    }
    _exit(status);
}
