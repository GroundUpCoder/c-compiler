/* cmdalt.c — /usr/bin/cmdalt, the command-alternatives dispatcher
 * (todos/0338; design `todos/COMMAND-ALTERNATIVES.md`).
 *
 * A MULTICALL binary in the busybox/coreutils idiom this tree already uses.
 * Mode is chosen by basename(argv[0]):
 *
 *   cmdalt        the admin CLI  — list / which / set / reset
 *   anything else DISPATCH mode  — the key is that basename; every argument
 *                                  is forwarded VERBATIM to the
 *                                  implementation the cmdalt store names
 *
 * Keeping the CLI under its own name is what makes the mechanism safe:
 * because the dispatcher's flags only exist as `cmdalt`, `python --help`,
 * `python --version` and `python -c ...` can never be intercepted. Nothing
 * here is python-shaped — adding a second dispatched name is one `link`
 * line in os/image.json plus one store line, and no C change at all.
 *
 * There is no exec on this platform (execve returns -1), so the canonical
 * estate answer applies — vendor/busybox/port/vfork_spawn.c's pv_execve:
 * spawn the image (fds/cwd/pgroup inherit), then BE a shell around it —
 * wait, forward the signals a lingering parent must forward, and exit with
 * the child's status so scripts cannot tell the difference.
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "cmdalt.h"

/* ============================ dispatch mode ============================= */

static pid_t g_child = -1;

/* SIGTERM/SIGHUP: a direct `kill <dispatcher-pid>` must not orphan the
 * child. Double delivery (the tty already signalled the whole pgroup) is
 * harmless for signals the child does not survive. SIGINT/SIGQUIT are
 * IGNORED instead — the pgroup already delivered them, and with the default
 * disposition a ^C at a REPL that HANDLES SIGINT would kill the dispatcher
 * and orphan the still-running child. SIGTSTP/SIGCONT keep the default so
 * the shell's job control sees the job stop and resume with its pgroup.
 * SIGKILL is uncatchable: `kill -9` on the dispatcher leaves the child
 * running — an accepted limitation, unfixable without exec. */
static void ca_forward(int sig) {
    if (g_child > 0) kill(g_child, sig);
}

/* ---- the candidate set, for the not-installed diagnostics ---- */

struct ca_cands {
    char have[CA_STORE_MAX];    /* candidates whose program is installed */
    char first[CA_VAL_MAX];     /* ...the first of them */
    size_t k;
    int n_have;
    int n_all;
};

static int ca_cand_cb(const char *key, const char *value, void *u) {
    struct ca_cands *c = (struct ca_cands *)u;
    char prog[CA_PATH_MAX];
    (void)key;
    c->n_all++;
    ca_prog(value, prog, sizeof prog);
    if (!prog[0] || access(prog, 0 /* F_OK */) != 0) return 0;
    if (!c->n_have) snprintf(c->first, sizeof c->first, "%s", value);
    c->n_have++;
    if (c->k + strlen(value) + 3 < sizeof c->have)
        c->k += (size_t)snprintf(c->have + c->k, sizeof c->have - c->k,
                                 "%s%s", c->k ? ", " : "", value);
    return 0;
}

/* The §2 error: name what to do, never silently fall back to another
 * candidate (a script written for one dialect must not quietly run under
 * another). Exit status is 127 in every arm — POSIX "command not found",
 * which is also what a missing #! interpreter would give the script. */
static void ca_report_missing(const char *key, const char *text, const ca_res *r) {
    if (r->status == CA_NOKEY) {
        fprintf(stderr, "%s: no %s implementation is configured\n", key, key);
        fprintf(stderr, "       set one:  cmdalt set %s <program>\n", key);
        return;
    }
    struct ca_cands c;
    memset(&c, 0, sizeof c);
    ca_candidates(text, key, ca_cand_cb, &c);
    if (!c.n_have) {
        char pkg[CA_VAL_MAX];
        ca_word0(r->value, pkg, sizeof pkg);
        fprintf(stderr, "%s: no %s implementation is installed\n", key, key);
        /* A BARE first word names a package by convention (the baked
         * suggestion `python<TAB>python-clang` is exactly that), so the hint
         * is actionable. A path is the user's own pick — say what is
         * missing rather than invent a package name for it. */
        if (strchr(pkg, '/'))
            fprintf(stderr, "       %s: no such program\n", pkg);
        else
            fprintf(stderr, "       install one:  gucman install %s\n", pkg);
        return;
    }
    fprintf(stderr, "%s: '%s' is not installed\n", key, r->value);
    fprintf(stderr, "       available: %s\n", c.have);
    fprintf(stderr, "       switch with:  cmdalt set %s %s\n", key, c.first);
    fprintf(stderr, "                     (or Control Panel > Default Programs)\n");
}

static int ca_dispatch(const char *key, int argc, char **argv) {
    char text[CA_STORE_MAX];
    ca_res r;
    ca_load(text, sizeof text);     /* a load error already said so, loudly */
    ca_resolve(text, key, &r);
    if (r.status != CA_OK) {
        ca_report_missing(key, text, &r);
        return 127;
    }
    /* Self-dispatch guard: EVERY dispatch link resolves to the one cmdalt
     * inode, so this single check kills `cmdalt set foo foo` and every
     * longer cycle at its first hop. */
    if (ca_same_file(r.prog, CA_DISPATCH)) {
        fprintf(stderr, "%s: '%s' is the command dispatcher itself — refusing "
                        "(that would be a fork bomb)\n", key, r.value);
        fprintf(stderr, "       pick a real implementation:  cmdalt set %s <program>\n", key);
        return 127;
    }

    int extra = argc > 1 ? argc - 1 : 0;
    int cap = 16 + extra + 1;       /* <=16 prefix words + our args + NULL */
    char **av = (char **)malloc((size_t)cap * sizeof *av);
    if (!av) {
        fprintf(stderr, "%s: out of memory\n", key);
        return 127;
    }
    char buf[CA_VAL_MAX];
    int n = cfg_split_argv(r.value, av, cap, extra, buf, sizeof buf);
    if (n <= 0) {
        fprintf(stderr, "%s: empty implementation command\n", key);
        free(av);
        return 127;
    }
    for (int i = 1; i < argc; i++) av[n++] = argv[i];
    av[n] = 0;

    signal(SIGINT, SIG_IGN);
    signal(SIGQUIT, SIG_IGN);
    signal(SIGTERM, ca_forward);
    signal(SIGHUP, ca_forward);

    pid_t pid;
    int rc = posix_spawn(&pid, r.prog, 0, 0, av, 0);
    free(av);
    if (rc != 0) {
        fprintf(stderr, "%s: %s: %s\n", key, r.prog, strerror(rc ? rc : errno));
        return 127;
    }
    g_child = pid;

    /* Signal delivery is cooperative (KERNEL.md): a dispatcher parked in
     * waitpid claims pending signals at the RPC safe point, so the EINTR
     * loop is mandatory rather than defensive. */
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            fprintf(stderr, "%s: waitpid: %s\n", key, strerror(errno));
            return 127;
        }
    }
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 127;
}

/* ============================== admin CLI ============================== */

static int ca_usage(void) {
    fprintf(stderr,
        "usage: cmdalt list                 every dispatched command name\n"
        "       cmdalt which NAME           the program NAME really runs\n"
        "       cmdalt set NAME CMD [ARG…]  pick NAME's implementation\n"
        "       cmdalt reset NAME           drop the pick, revert to the default\n");
    return 2;
}

/* One `list` row: the effective value, then the candidates when there is
 * more than one, then the PATH-shadow warning when PATH does not reach the
 * dispatch link (the failure mode no build gate can catch). */
static int ca_list_cb(const char *key, const char *value, void *u) {
    const char *text = (const char *)u;
    ca_res r;
    (void)value;
    ca_resolve(text, key, &r);
    printf("%-12s -> %s%s\n", key, r.value,
           r.status == CA_OK ? "" : "   (not installed)");
    struct ca_cands c;
    memset(&c, 0, sizeof c);
    int n = ca_candidates(text, key, ca_cand_cb, &c);
    if (n > 1) printf("             available: %s\n", c.n_have ? c.have : "(none)");
    char shadow[CA_PATH_MAX];
    if (ca_shadow(key, shadow, sizeof shadow)) {
        char msg[CA_PATH_MAX * 2];
        ca_shadow_text(key, shadow, CA_SEP_CLI, msg, sizeof msg);
        printf("             warning: %s\n", msg);
    }
    return 0;
}

static int ca_cmd_list(void) {
    char text[CA_STORE_MAX];
    ca_load(text, sizeof text);
    if (cfg_keys(text, ca_list_cb, text) == 0)
        printf("no dispatched command names are configured\n");
    return 0;
}

static int ca_cmd_which(const char *key) {
    char text[CA_STORE_MAX], shadow[CA_PATH_MAX];
    ca_res r;
    ca_load(text, sizeof text);
    ca_resolve(text, key, &r);
    /* Report what REALLY runs: an earlier PATH entry beats the dispatch
     * link, so the shadow is the honest answer — with the fix named. */
    if (ca_shadow(key, shadow, sizeof shadow)) {
        char msg[CA_PATH_MAX * 2];
        printf("%s\n", shadow);
        ca_shadow_text(key, shadow, CA_SEP_CLI, msg, sizeof msg);
        fprintf(stderr, "cmdalt: %s\n", msg);
        fprintf(stderr, "cmdalt: the %s setting names '%s'\n", key, r.value);
        return 0;
    }
    if (r.status != CA_OK) {
        ca_report_missing(key, text, &r);
        return 1;
    }
    printf("%s\n", r.prog);
    return 0;
}

/* After a successful write, say so when the pick CANNOT take effect. This
 * is the one moment the confused user is guaranteed to be standing at: the
 * `which`/`list` markers only help someone who already suspects the
 * problem, but the entry point into this bug is a switch that appears to do
 * nothing (CHECK-0338, 2026-07-28). */
static void ca_after_set(const char *key) {
    char shadow[CA_PATH_MAX];
    if (ca_shadow(key, shadow, sizeof shadow)) {
        char msg[CA_PATH_MAX * 2];
        ca_shadow_text(key, shadow, CA_SEP_CLI, msg, sizeof msg);
        fprintf(stderr, "cmdalt: warning: %s\n", msg);
    }
    char text[CA_STORE_MAX];
    ca_res r;
    ca_load(text, sizeof text);
    ca_resolve(text, key, &r);
    if (r.status == CA_MISSING)
        fprintf(stderr, "cmdalt: note: '%s' is not installed yet\n", r.prog);
}

static int ca_cmd_set(const char *key, int argc, char **argv) {
    char value[CA_VAL_MAX] = "";
    size_t k = 0;
    for (int i = 3; i < argc; i++)
        k += (size_t)snprintf(value + k, sizeof value - k, "%s%s",
                              i > 3 ? " " : "", argv[i]);
    if (k >= sizeof value) {
        fprintf(stderr, "cmdalt: command too long\n");
        return 1;
    }
    if (ca_set(key, value) != 0) {
        fprintf(stderr, "cmdalt: cannot write the setting: %s\n", strerror(errno));
        return 1;
    }
    ca_after_set(key);
    return 0;
}

static int ca_cmd_reset(const char *key) {
    if (ca_reset(key) != 0) {
        fprintf(stderr, "cmdalt: cannot write the setting: %s\n", strerror(errno));
        return 1;
    }
    ca_after_set(key);
    return 0;
}

static int ca_admin(int argc, char **argv) {
    if (argc < 2) return ca_usage();
    if (strcmp(argv[1], "list") == 0 && argc == 2) return ca_cmd_list();
    if (strcmp(argv[1], "which") == 0 && argc == 3) return ca_cmd_which(argv[2]);
    if (strcmp(argv[1], "set") == 0 && argc >= 4) return ca_cmd_set(argv[2], argc, argv);
    if (strcmp(argv[1], "reset") == 0 && argc == 3) return ca_cmd_reset(argv[2]);
    return ca_usage();
}

/* ================================ main ================================= */

int main(int argc, char **argv) {
    const char *a0 = (argc > 0 && argv[0]) ? argv[0] : "";
    const char *base = strrchr(a0, '/');
    base = base ? base + 1 : a0;
    if (!*base) {
        /* No key to resolve, and no CLI to fall back to. */
        fprintf(stderr, "cmdalt: empty argv[0] — no command name to dispatch\n");
        return 127;
    }
    if (strcmp(base, "cmdalt") == 0) return ca_admin(argc, argv);
    return ca_dispatch(base, argc, argv);
}
