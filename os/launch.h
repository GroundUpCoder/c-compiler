/* launch.h — the ONE desktop spawn primitive, in ONE place (CD2 dedup).
 *
 * Header-only by design: the image manifest's `c` entries are single-source
 * compiles, so this is static functions shared by textual inclusion (the
 * openwith.h precedent) — wm.c (Start menu / desktop / context menus) and
 * os/win32/fileman.c (Open + associations) include this and must stay
 * behaviorally identical through it. Launch POLICY stays with the callers:
 * activate() (MRU recents, openwith resolution, directories-open-in-fileman,
 * todos/0066) lives in wm.c and fileman keeps its in-place flavor — only the
 * low-level spawn mechanism is shared here.
 *
 * The canonical desktop environment is exposed as macros so no caller
 * re-types the literals: PATH puts /usr/local/bin first (todos/0040 —
 * user-installed binaries deliberately win over system ones), HOME is /root.
 * term.c reuses the strings for its pty session leader's env (a superset
 * adding TERM); its spawn shape (file actions, posix_spawnp) — like
 * protoshell/open/strace's env-inheriting spawns — is legitimately different
 * and deliberately NOT folded into spawn_path.
 */
#ifndef LAUNCH_H
#define LAUNCH_H

#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define LAUNCH_ENV_PATH "PATH=/usr/local/bin:/bin"
#define LAUNCH_ENV_HOME "HOME=/root"

/* Spawn an app the desktop way: own pgroup, canonical PATH/HOME env, cwd
 * inherited from the caller (/root for the wm — doom finds its WAD by cwd).
 * Children get the caller's std fds (the kernel gives parentless services
 * the system std OFDs, and spawn inherits them), so startup printf's land
 * on the console. Success bumps the caller's kid counter for its reap
 * loop; failure logs "<who>: spawn <path>: <err>" to stderr. */
static void spawn_path(const char *path, char *const argv[],
                       int *nkids, const char *who) {
    static char *const envp[] = { LAUNCH_ENV_PATH, LAUNCH_ENV_HOME, 0 };
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);           /* 0 = child's own pid */
    pid_t pid;
    int rc = posix_spawn(&pid, path, 0, &at, (char *const *)argv, envp);
    if (rc == 0) (*nkids)++;
    else fprintf(stderr, "%s: spawn %s: %s\n", who, path, strerror(rc));
    posix_spawnattr_destroy(&at);
}

/* Desktop launchers never block in wait: children are polled off the
 * caller's tick against its own counter. (Only ppid-0 processes auto-reap;
 * these children would zombie otherwise. If the launcher dies first,
 * orphans reparent to pid 1, which reaps.) */
static void reap_kids(int *nkids) {
    int st;
    while (*nkids > 0 && waitpid(-1, &st, WNOHANG) > 0) (*nkids)--;
}

#endif
