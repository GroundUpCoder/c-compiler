/* #785 proposed guest witness. Prepared source only; not compiled or run.
 * No filesystem creation/mutation. Owner-side harness supplies the oracle.
 * path FILE...: stat/lstat/open/fstat/dup/read identity observations.
 * inherit FILE: real posix_spawn DUP2 promotion, then child fstat(0).
 */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
extern char **environ;
static void row(const char *op, const char *path, const struct stat *s) {
    printf("IDENTITY785 %s %s %u %u %u %u\n", op, path,
           (unsigned)s->st_dev, (unsigned)s->st_ino,
           (unsigned)s->st_mode, (unsigned)s->st_rdev);
}
static int same(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int fail(const char *op, const char *path) {
    fprintf(stderr, "IDENTITY785 ERROR %s %s errno=%d\n", op, path, errno);
    return 1;
}
int main(int argc, char **argv) {
    struct stat st, fdst, lst;
    if (argc < 3) return 2;
    if (!strcmp(argv[1], "fd0")) {
        if (stat(argv[2], &st) || fstat(0, &fdst)) return fail("fd0", argv[2]);
        row("child-path", argv[2], &st); row("child-fd0", argv[2], &fdst);
        return same(&st, &fdst) ? 0 : 1;
    }
    if (!strcmp(argv[1], "inherit")) {
        int fd = open(argv[2], O_RDONLY), status = 0, err;
        pid_t pid;
        posix_spawn_file_actions_t actions;
        char *args[] = { argv[0], "fd0", argv[2], 0 };
        if (fd < 0) return fail("parent-open", argv[2]);
        if (fstat(fd, &fdst)) return fail("parent-fstat", argv[2]);
        row("parent-fd", argv[2], &fdst);
        err = posix_spawn_file_actions_init(&actions);
        if (!err) err = posix_spawn_file_actions_adddup2(&actions, fd, 0);
        if (err) return 1;
        err = posix_spawn(&pid, argv[0], &actions, 0, args, environ);
        posix_spawn_file_actions_destroy(&actions); close(fd);
        if (err) { errno = err; return fail("spawn", argv[2]); }
        if (waitpid(pid, &status, 0) != pid) return fail("wait", argv[2]);
        return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 1;
    }
    if (strcmp(argv[1], "path")) return 2;
    for (int i = 2; i < argc; i++) {
        int fd, copy;
        unsigned char byte = 0;
        if (stat(argv[i], &st) || lstat(argv[i], &lst)) return fail("path", argv[i]);
        row("stat", argv[i], &st); row("lstat", argv[i], &lst);
        fd = open(argv[i], O_RDONLY);
        if (fd < 0 || fstat(fd, &fdst)) return fail("open-fstat", argv[i]);
        row("fstat", argv[i], &fdst);
        if (!same(&st, &fdst)) return 1;
        copy = dup(fd);
        if (copy < 0 || fstat(copy, &fdst)) return fail("dup-fstat", argv[i]);
        row("dup-fstat", argv[i], &fdst);
        if (!same(&st, &fdst)) return 1;
        int n = read(copy, &byte, 1);
        if (n < 0) return fail("read", argv[i]);
        printf("IDENTITY785 DATA %s %d %u\n", argv[i], n, (unsigned)byte);
        close(copy); close(fd);
    }
    return 0;
}
