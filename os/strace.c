/* strace (todos/0046) — per-pid syscall-RPC trace.
 *
 * Usage: strace [-f] [-o FILE] CMD [ARGS...]
 *
 * The kernel brokers every syscall of every process, so tracing is pure
 * formatting: __spawn's spec carries a `trace` field naming a pipe write
 * end, and the kernel appends one decoded line per RPC of the child
 * (opcode name, args, result — kernel.js's OP table is the decode table)
 * then closes the pipe at teardown. This program is only the plumbing
 * around that: make the pipe, spawn pre-traced, copy trace bytes to
 * stderr (or -o FILE), propagate the child's exit status. -f traces
 * descendants too (lines get a [pid N] prefix).
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

static void usage(void) {
    fprintf(stderr, "usage: strace [-f] [-o FILE] CMD [ARGS...]\n");
    exit(2);
}

/* execvp-style $PATH resolution (posix_spawnp's rules — the kernel loads
 * images by absolute path, so `strace cat ...` must resolve here). */
static const char *resolve(const char *file, char *buf, unsigned long cap) {
    if (strchr(file, '/')) return file;
    const char *path = getenv("PATH");
    if (!path || !*path) path = "/usr/local/bin:/bin";
    unsigned long flen = strlen(file);
    while (*path) {
        const char *colon = strchr(path, ':');
        unsigned long dlen = colon ? (unsigned long)(colon - path) : strlen(path);
        if (dlen + 1 + flen + 1 <= cap) {
            unsigned long k = 0;
            if (dlen == 0) { buf[k++] = '.'; }
            else { memcpy(buf, path, dlen); k = dlen; }
            buf[k++] = '/';
            strcpy(&buf[k], file);
            if (access(buf, 0 /* F_OK */) == 0) return buf;
        }
        if (!colon) break;
        path = colon + 1;
    }
    return file;   /* unfound: spawn the name as-is, report the ENOENT */
}

int main(int argc, char **argv) {
    int follow = 0;
    int outfd = 2;
    int i = 1;
    for (; i < argc; i++) {
        if (strcmp(argv[i], "-f") == 0) { follow = 1; }
        else if (strcmp(argv[i], "-o") == 0) {
            if (++i >= argc) usage();
            outfd = open(argv[i], O_WRONLY | O_CREAT | O_TRUNC, 0644);
            if (outfd < 0) {
                fprintf(stderr, "strace: %s: %s\n", argv[i], strerror(errno));
                return 1;
            }
        }
        else if (strcmp(argv[i], "--") == 0) { i++; break; }
        else if (argv[i][0] == '-') usage();
        else break;
    }
    if (i >= argc) usage();

    int p[2];
    if (pipe(p) < 0) {
        fprintf(stderr, "strace: pipe: %s\n", strerror(errno));
        return 1;
    }

    char pathbuf[1024];
    const char *prog = resolve(argv[i], pathbuf, sizeof pathbuf);

    /* The pipe fds are the tracer's: the child must not inherit them (a
     * child holding the write end would defer the tracer's EOF forever). */
    struct __fd_action acts[2];
    acts[0].op = 2; acts[0].fd = p[0]; acts[0].arg = 0; acts[0].path = 0; acts[0].mode = 0;
    acts[1].op = 2; acts[1].fd = p[1]; acts[1].arg = 0; acts[1].path = 0; acts[1].mode = 0;

    struct __spawn_spec spec;
    spec.path = prog;
    spec.argv = &argv[i];
    spec.envp = 0;             /* inherit */
    spec.cwd = 0;              /* inherit */
    spec.actions = acts;
    spec.n_actions = 2;
    spec.flags = __SPAWN_TRACE | (follow ? __SPAWN_TRACE_CHILDREN : 0u);
    spec.pgid = 0;
    spec.trace = p[1];

    int pid = __spawn(&spec);
    if (pid < 0) {
        fprintf(stderr, "strace: %s: %s\n", prog, strerror(errno));
        return 127;
    }
    close(p[1]);               /* the kernel holds its own write-end ref */

    /* Copy trace lines until the kernel closes the pipe at child teardown.
     * A persistent output error stops the copy but still drains to EOF so
     * the child never wedges against a full trace pipe. */
    char buf[4096];
    int writable = 1;
    for (;;) {
        int n = read(p[0], buf, sizeof buf);
        if (n == 0) break;
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int off = 0;
        while (writable && off < n) {
            int w = write(outfd, buf + off, n - off);
            if (w < 0) {
                if (errno == EINTR) continue;
                writable = 0;
                break;
            }
            off += w;
        }
    }
    close(p[0]);

    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
        continue;
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
