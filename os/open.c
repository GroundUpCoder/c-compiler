/* open.c — /bin/open, the terminal-context opener (todos/0072).
 *
 * `open FILE` launches FILE the activate() way (todos/0066), but with the
 * TERMINAL default: a runnable file (wasm magic / #! script, through
 * symlinks) spawns directly; anything else resolves through the openwith
 * associations (openwith.h — extension map first, then default.term, vi
 * in the baked store). The child inherits the environment, fds and
 * process group — a tty program runs in the foreground like any shell
 * command — and open waits, exiting with the child's status.
 *
 * `open --set KEY CMD...` is the minimal association editor: KEY is an
 * extension (`gb`) or `default.gui` / `default.term`; the write lands in
 * $HOME/.config/openwith with the effective table carried forward.
 */
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include "openwith.h"

static int usage(void) {
    fprintf(stderr,
        "usage: open FILE              launch FILE with its associated program\n"
        "       open --set KEY CMD...  set an association (KEY = extension,\n"
        "                              default.gui or default.term)\n");
    return 2;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--set") == 0) {
        if (argc < 4) return usage();
        char cmd[OW_CMD_MAX] = "";
        size_t k = 0;
        for (int i = 3; i < argc; i++)
            k += (size_t)snprintf(cmd + k, sizeof cmd - k, "%s%s", i > 3 ? " " : "", argv[i]);
        if (k >= sizeof cmd || ow_set(argv[2], cmd) != 0) {
            fprintf(stderr, "open: cannot write the association\n");
            return 1;
        }
        return 0;
    }
    if (argc != 2 || argv[1][0] == '-') return usage();

    const char *path = argv[1];
    struct stat st;
    if (stat(path, &st) != 0) {
        fprintf(stderr, "open: %s: no such file\n", path);
        return 1;
    }
    pid_t pid;
    int rc;
    if (S_ISREG(st.st_mode) && ow_is_runnable(path)) {
        const char *name = strrchr(path, '/');
        char *av[2] = { (char *)(name ? name + 1 : path), 0 };
        rc = posix_spawn(&pid, path, 0, 0, av, 0);
    } else {
        char cmd[OW_CMD_MAX], buf[512], prog[300];
        char *av[10];
        ow_resolve(path, 0 /* terminal context */, cmd, sizeof cmd);
        if (ow_build(cmd, path, av, 10, buf, sizeof buf, prog, sizeof prog) <= 0) {
            fprintf(stderr, "open: empty association command\n");
            return 1;
        }
        rc = posix_spawn(&pid, prog, 0, 0, av, 0);
    }
    if (rc != 0) {
        fprintf(stderr, "open: %s: spawn failed\n", path);
        return 1;
    }
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
