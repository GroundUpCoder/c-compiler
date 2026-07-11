/* protoshell — pid 1 of the reference OS page until the real shell port
 * lands (todos/0005). Deliberately small: read a line, run it, wait.
 *
 * What it does have, because the kernel underneath makes it cheap:
 *   - builtins: cd, pwd, ls, cat, echo, help, exit (enough to poke around
 *     before coreutils exist)
 *   - external commands from /bin (bare names) or by path; `cc hello.c &&
 *     ./a.out` works end to end via /bin/cc -> the kernel's __compile hook
 *   - `&&` chaining and trailing `&` background jobs
 *   - foreground process-group handoff: children spawn into their own
 *     pgroup and get the tty (tcsetpgrp), so Ctrl-C/Ctrl-Z hit the job,
 *     not the shell; stops and signal deaths are reported like a shell
 *
 * What it doesn't: pipes-in-syntax, redirection, quoting, variables, job
 * table. That's the busybox port's business.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <dirent.h>
#include <termios.h>   /* tcsetpgrp lives here in this libc */

#define MAXARGS 32
#define MAXNAMES 256

static int last_status = 0;

/* ---- builtins ---- */

static int namecmp(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static int bi_ls(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : ".";
    DIR *d = opendir(path);
    if (!d) { fprintf(stderr, "ls: %s: %s\n", path, strerror(errno)); return 1; }
    static char *names[MAXNAMES];
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)) && n < MAXNAMES) {
        if (de->d_name[0] == '.') continue;
        names[n++] = strdup(de->d_name);
    }
    closedir(d);
    qsort(names, n, sizeof names[0], namecmp);   /* deterministic output */
    for (int i = 0; i < n; i++) { puts(names[i]); free(names[i]); }
    return 0;
}

static int bi_cat(int argc, char **argv) {
    char buf[4096];
    if (argc < 2) {                              /* cat: stdin -> stdout */
        ssize_t n;
        while ((n = read(0, buf, sizeof buf)) > 0) fwrite(buf, 1, (size_t)n, stdout);
        return 0;
    }
    for (int i = 1; i < argc; i++) {
        FILE *f = fopen(argv[i], "r");
        if (!f) { fprintf(stderr, "cat: %s: %s\n", argv[i], strerror(errno)); return 1; }
        size_t n;
        while ((n = fread(buf, 1, sizeof buf, f)) > 0) fwrite(buf, 1, n, stdout);
        fclose(f);
    }
    return 0;
}

static int bi_echo(int argc, char **argv) {
    for (int i = 1; i < argc; i++) printf("%s%s", i > 1 ? " " : "", argv[i]);
    putchar('\n');
    return 0;
}

static int bi_cd(int argc, char **argv) {
    const char *to = argc > 1 ? argv[1] : getenv("HOME");
    if (!to) to = "/root";
    if (chdir(to) != 0) { fprintf(stderr, "cd: %s: %s\n", to, strerror(errno)); return 1; }
    return 0;
}

static int bi_pwd(void) {
    char cwd[512];
    if (!getcwd(cwd, sizeof cwd)) return 1;
    puts(cwd);
    return 0;
}

static int bi_help(void) {
    puts("protoshell builtins: cd pwd ls cat echo help exit");
    puts("anything else runs from /bin (or by path); '&&' chains; trailing '&' backgrounds");
    return 0;
}

/* ---- external commands ---- */

static void report_status(pid_t pid, int st) {
    if (WIFSIGNALED(st))
        fprintf(stderr, "[%d] terminated by signal %d\n", (int)pid, WTERMSIG(st));
    else if (WIFSTOPPED(st))
        fprintf(stderr, "[%d] stopped by signal %d\n", (int)pid, WSTOPSIG(st));
}

static int run_external(char **argv, int background) {
    char path[512];
    if (strchr(argv[0], '/')) {
        if (argv[0][0] == '/') {
            snprintf(path, sizeof path, "%s", argv[0]);
        } else {                                 /* spawn paths must be absolute */
            char cwd[400];
            if (!getcwd(cwd, sizeof cwd)) cwd[0] = 0;
            snprintf(path, sizeof path, "%s/%s", strcmp(cwd, "/") == 0 ? "" : cwd, argv[0]);
        }
    } else {
        snprintf(path, sizeof path, "/bin/%s", argv[0]);
    }
    if (access(path, F_OK) != 0) {
        fprintf(stderr, "sh: %s: command not found\n", argv[0]);
        return 127;
    }

    /* Own pgroup, so the tty can make it THE foreground job. */
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);           /* 0 = child's own pid */

    pid_t pid;
    int e = posix_spawn(&pid, path, 0, &at, argv, 0 /* inherit env */);
    posix_spawnattr_destroy(&at);
    if (e != 0) {
        fprintf(stderr, "sh: %s: %s\n", argv[0], strerror(e));
        return 127;
    }
    if (background) {
        fprintf(stderr, "[%d] %s &\n", (int)pid, argv[0]);
        return 0;
    }

    tcsetpgrp(0, pid);                           /* hand the tty to the job */
    int st = 0;
    pid_t r;
    while ((r = waitpid(pid, &st, WUNTRACED)) < 0 && errno == EINTR) {}
    tcsetpgrp(0, getpid());                      /* take it back (pid 1: pgid==pid) */
    if (r < 0) return 1;
    report_status(pid, st);
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    if (WIFSTOPPED(st)) return 148;              /* 128+SIGTSTP, shell convention */
    return 128 + WTERMSIG(st);
}

/* ---- line handling ---- */

static int run_command(char *cmd) {
    char *argv[MAXARGS];
    int argc = 0;
    for (char *t = strtok(cmd, " \t"); t && argc < MAXARGS - 1; t = strtok(NULL, " \t"))
        argv[argc++] = t;
    argv[argc] = 0;
    if (argc == 0) return last_status;

    int background = 0;
    if (strcmp(argv[argc - 1], "&") == 0) { background = 1; argv[--argc] = 0; }
    if (argc == 0) return last_status;

    if (strcmp(argv[0], "exit") == 0) exit(argc > 1 ? atoi(argv[1]) : last_status);
    if (strcmp(argv[0], "cd") == 0) return bi_cd(argc, argv);
    if (strcmp(argv[0], "pwd") == 0) return bi_pwd();
    if (strcmp(argv[0], "ls") == 0) return bi_ls(argc, argv);
    if (strcmp(argv[0], "cat") == 0) return bi_cat(argc, argv);
    if (strcmp(argv[0], "echo") == 0) return bi_echo(argc, argv);
    if (strcmp(argv[0], "help") == 0) return bi_help();
    return run_external(argv, background);
}

static void run_line(char *line) {
    /* `a && b && c` — stop at the first failure. No other operators. */
    char *rest = line;
    while (rest) {
        char *amp = strstr(rest, "&&");
        char *cmd = rest;
        if (amp) { *amp = 0; rest = amp + 2; } else { rest = 0; }
        last_status = run_command(cmd);
        if (last_status != 0) break;
    }
}

int main(void) {
    /* The shell itself shrugs off the tty control chars; the foreground job
     * (its own pgroup, holding the tty via tcsetpgrp) receives them. */
    signal(SIGINT, SIG_IGN);
    signal(SIGQUIT, SIG_IGN);
    signal(SIGTSTP, SIG_IGN);

    const char *home = getenv("HOME");
    if (chdir(home ? home : "/root") != 0) chdir("/");

    fprintf(stderr, "gucOS protoshell (help for builtins; the real shell is todos/0005)\n");

    char line[1024];
    for (;;) {
        fprintf(stderr, "# ");                   /* prompt on stderr, like bash -i */
        fflush(stderr);
        if (!fgets(line, sizeof line, stdin)) {
            if (errno == EINTR) { clearerr(stdin); continue; }
            break;                               /* EOF: exit with the last status */
        }
        line[strcspn(line, "\n")] = 0;
        run_line(line);
    }
    fprintf(stderr, "\n");
    return last_status;
}
