/* launch.h — the ONE desktop spawn primitive AND launch-policy ladder, in
 * ONE place (CD2 dedup: the spawn primitive landed as todos/0239, the
 * shared activate() ladder as todos/0240).
 *
 * Header-only by design: the image manifest's `c` entries are single-source
 * compiles, so this is static functions shared by textual inclusion (the
 * openwith.h precedent) — wm.c (Start menu / desktop / context menus) and
 * os/win32/fileman.c (Open + associations) include this and must stay
 * behaviorally identical through it. The GENUINELY per-caller policies —
 * what a directory does (wm spawns a fileman, fileman navigates in place),
 * whether a direct launch pushes the MRU recents (wm only), what a failed
 * stat means (wm no-ops on a dangling desktop link, fileman still opens
 * the association) — stay with the callers as launch_activate() hooks.
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
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include "openwith.h"   /* the association resolver under the policy ladder */

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

/* ---- the launch POLICY ladder (todos/0240) ---- */

/* Open `path` through a resolved association command (`cmd path`,
 * todos/0072): ow_build splits the command and appends the path as one
 * argument, then the desktop spawn. Shared by the launch_activate tail and
 * the Edit flows (wm's desktop Edit, fileman's Edit + "Open with" picker). */
static void launch_assoc(const char *cmd, const char *path,
                         int *nkids, const char *who) {
    char buf[512], prog[300];
    char *argv[10];
    if (ow_build(cmd, path, argv, 10, buf, sizeof buf, prog, sizeof prog) > 0)
        spawn_path(prog, argv, nkids, who);
}

/* One "activate a path" (todos/0066), the ladder shared by wm.c's
 * activate() (Start menu / desktop grid) and fileman's open_selected():
 * anything runnable after symlink resolution — ow_is_runnable peeks
 * through links, so a menu link to a binary still spawns via the link
 * path — runs directly under its basename (launchers are ordinary
 * #!/bin/sh scripts); anything else opens through the openwith
 * associations in the GUI context (todos/0072).
 *
 * The genuinely per-caller policies are parameters, not flattened:
 *   - `st` is the CALLER's stat of `path`, NULL if it failed. Failure
 *     policy differs — wm returns before calling (a gone/dangling desktop
 *     link is a no-op), fileman lets a dangling row fall through to the
 *     association tail — and passing it in keeps one stat per activation.
 *   - `on_dir` (nullable): what a directory does. wm passes its
 *     spawn-a-fileman hook (todos/0185); fileman navigates in place
 *     BEFORE calling (its listing already knows the row is a dir) and
 *     passes NULL, so a stale-listing dir falls to the association tail
 *     exactly as before.
 *   - `on_launch` (nullable): fires just before a direct spawn — wm's MRU
 *     recents push (sm_record_recent, todos/0098); fileman pushes none. */
static void launch_activate(const char *path, const struct stat *st,
                            void (*on_dir)(const char *),
                            void (*on_launch)(const char *),
                            int *nkids, const char *who) {
    if (st && S_ISDIR(st->st_mode) && on_dir) { on_dir(path); return; }
    if (st && S_ISREG(st->st_mode) && ow_is_runnable(path)) {
        const char *name = strrchr(path, '/');
        name = name ? name + 1 : path;
        char *argv[2] = { (char *)name, 0 };
        if (on_launch) on_launch(path);
        spawn_path(path, argv, nkids, who);
        return;
    }
    char cmd[OW_CMD_MAX];
    ow_resolve(path, 1 /* GUI context */, cmd, sizeof cmd);
    launch_assoc(cmd, path, nkids, who);
}

#endif
