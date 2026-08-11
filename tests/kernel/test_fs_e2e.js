#!/usr/bin/env node
// 0009 end-to-end: the brokered filesystem (KERNEL.md fd/data-plane
// amendment). Real C processes over ONE kernel-owned BlockFS prove the
// wins the amendment claimed:
//   - spawned processes SHARE a filesystem (Phase-1 private-fs retires)
//   - an inherited fd shares its open file description — parent writes,
//     child writes, parent writes again: offsets interleave POSIX-style
//   - posix_spawn fd_actions work (OPEN redirect of child stdout to a file)
//   - unlink-while-open holds ACROSS processes (ghost read via inherited fd)
//   - per-process cwd (child chdir doesn't move the parent)
//   - SIGKILL leaks nothing: the kernel owns the descriptions, so the
//     hog's unlinked-open file is reclaimed — fsck proves the store clean
//   - tty reads arrive via deferred RPCs (brokered mode has no stdin ring)
//   - TIOCGWINSZ sees tty.resize() over the brokered fs (todos/0011: the
//     ioctl guard read _stdinSab — never set in brokered mode — so every
//     brokered process saw 80x24 forever; vi was the first to notice)
//   - fsync/fdatasync work on brokered fds (todos/0036: the env's inline
//     fsync used the BlockFS-private store handle, crashing the worker —
//     sqlite3's journal fsync was the first caller)
//   - fds carry their access mode (todos/0376): write() on an O_RDONLY fd
//     used to SILENTLY MUTATE the file, read() on an O_WRONLY fd disclosed
//     it — EBADF both, in the FS_OPEN arm and the spawn fd-action OPEN arm
//     (the two kernel _makeOfd('file') sites)
//   - open(O_RDONLY|O_TRUNC) truncates (#641): POSIX leaves it undefined,
//     Linux and Darwin both truncate, so gucOS does — and the brokered
//     backend must answer exactly as in-process BlockFS does. The fd is
//     still not write-capable; the truncate is not write access.
//
// Run: node tests/kernel/test_fs_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const { fsck } = require(path.join(ROOT, 'tests/blockfs/fsck_v4.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const INIT_C = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <signal.h>
#include <dirent.h>
#include <sys/ioctl.h>
#include <errno.h>

static pid_t run(const char *what, posix_spawn_file_actions_t *fa) {
    char *argv[] = { "child", (char *)what, 0 };
    pid_t pid;
    int e = posix_spawn(&pid, "/bin/child", fa, 0, argv, 0);
    if (e) { printf("spawn %s failed %d\\n", what, e); exit(99); }
    return pid;
}

int main(void) {
    int st; pid_t pid; char line[128]; FILE *f;

    /* 1: brokered tty read (no ring — a deferred kernel RPC) */
    printf("R1\\n");
    if (!fgets(line, sizeof line, stdin)) return 1;
    line[strcspn(line, "\\n")] = 0;
    printf("tty=[%s]\\n", line);

    /* 2: shared fs + POSIX shared offset on an inherited fd */
    int fd = open("/log.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    printf("logfd=%d\\n", fd);
    write(fd, "AAA", 3);
    pid = run("appender", 0);          /* child writes BBB on the inherited fd */
    waitpid(pid, &st, 0);
    write(fd, "CCC", 3);
    close(fd);
    f = fopen("/log.txt", "r");
    if (!fgets(line, sizeof line, f)) line[0] = 0;
    fclose(f);
    printf("log=[%s]\\n", line);

    /* 3: fd_action OPEN redirect: child stdout -> /out.txt */
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 1, "/out.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    pid = run("redirected", &fa);
    posix_spawn_file_actions_destroy(&fa);
    waitpid(pid, &st, 0);
    f = fopen("/out.txt", "r");
    if (!fgets(line, sizeof line, f)) line[0] = 0;
    line[strcspn(line, "\\n")] = 0;
    fclose(f);
    printf("redir=[%s] code=%d\\n", line, WEXITSTATUS(st));

    /* 4: unlink-while-open ACROSS processes */
    fd = open("/doomed", O_RDWR | O_CREAT | O_TRUNC, 0644);
    write(fd, "X", 1);
    unlink("/doomed");
    pid = run("ghostread", 0);         /* reads the inherited unlinked fd */
    waitpid(pid, &st, 0);
    struct stat sb;
    printf("ghost=%d gone=%d\\n", WEXITSTATUS(st), stat("/doomed", &sb) != 0);
    close(fd);

    /* 5: per-process cwd */
    mkdir("/sub", 0755);
    pid = run("chdirwrite", 0);
    waitpid(pid, &st, 0);
    f = fopen("/sub/rel.txt", "r");
    if (!f || !fgets(line, sizeof line, f)) line[0] = 0;
    if (f) fclose(f);
    char cwd[64];
    getcwd(cwd, sizeof cwd);
    printf("sub=[%s] childcwd=%d mycwd=[%s]\\n", line, WEXITSTATUS(st), cwd);

    /* 6: directory listing through the broker */
    DIR *d = opendir("/");
    int names = 0;
    struct dirent *de;
    while ((de = readdir(d))) if (de->d_name[0] != '.') names++;
    closedir(d);
    printf("rootentries=%d\\n", names);   /* log.txt out.txt sub */

    /* 7: SIGKILL a hog holding an unlinked-open file — nothing may leak */
    pid = run("hog", 0);
    usleep(300000);                    /* hog opens+unlinks, then sleeps */
    kill(pid, SIGKILL);
    waitpid(pid, &st, 0);
    printf("hogkilled=%d\\n", WIFSIGNALED(st) && WTERMSIG(st) == SIGKILL);

    /* 8: TIOCGWINSZ over the brokered fs — the winsize words live in the
       tty SAB header even though brokered stdin has no ring */
    printf("R8\\n");
    if (!fgets(line, sizeof line, stdin)) return 1;   /* driver resizes first */
    struct winsize ws;
    ioctl(0, TIOCGWINSZ, &ws);
    printf("ws=%dx%d\\n", ws.ws_col, ws.ws_row);

    /* 9: fsync/fdatasync on a brokered fd (regression: toWasmEnv's inline
       fsync reached for the BlockFS-private store handle, which RemoteFS
       doesn't have — the TypeError killed the worker, so any program that
       fsync'd a file died SIGSEGV; sqlite's journal was the first). Also
       exercise the non-file kinds: fsync(tty fd) must be a harmless 0. */
    fd = open("/sync.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, "S", 1);
    printf("fsync=%d fdatasync=%d ttyfsync=%d badfsync=%d\\n",
           fsync(fd), fdatasync(fd), fsync(1), fsync(77) == 0 ? 1 : 0);
    close(fd);

    /* 10: access-mode enforcement (todos/0376): the fd carries flags &
       O_ACCMODE from open(). write() on O_RDONLY is EBADF and must leave
       the bytes untouched (the corruption half); read() on O_WRONLY is
       EBADF (the disclosure half); the right directions still flow. */
    fd = open("/mode.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, "SAFE", 4);
    close(fd);
    int rofd = open("/mode.txt", O_RDONLY);
    errno = 0;
    int mw = write(rofd, "EVIL", 4);
    int mwe = errno == EBADF;
    char mb[8]; memset(mb, 0, sizeof mb);
    int mr = read(rofd, mb, 4);        /* read on the O_RDONLY fd still works */
    close(rofd);
    printf("romode w=%d e=%d r=%d body=[%s]\\n", mw, mwe, mr, mb);
    int wofd = open("/mode.txt", O_WRONLY);
    errno = 0;
    int mr2 = read(wofd, mb, 4);
    int mre = errno == EBADF;
    int mw2 = write(wofd, "GOOD", 4);  /* write on the O_WRONLY fd still works */
    close(wofd);
    printf("womode r=%d e=%d w=%d\\n", mr2, mre, mw2);

    /* the spawn fd-action OPEN records the mode too (the kernel's second
       _makeOfd('file') site): child fd 4 is O_RDONLY, its write refused */
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 4, "/mode.txt", O_RDONLY, 0);
    pid = run("modewrite", &fa);
    posix_spawn_file_actions_destroy(&fa);
    waitpid(pid, &st, 0);
    f = fopen("/mode.txt", "r");
    if (!f || !fgets(line, sizeof line, f)) line[0] = 0;
    if (f) fclose(f);
    printf("modechild=%d body=[%s]\\n", WEXITSTATUS(st), line);

    /* 11 (#641): open(O_RDONLY|O_TRUNC) over the BROKERED path. POSIX
       leaves this undefined; Linux truncates and so does Darwin (both
       measured), so gucOS truncates — and the two backends must not
       disagree, so this is the kernel-side twin of the BlockFS case in
       tests/blockfs/test_posix.js. The truncate is NOT write access: the
       kernel OFD still carries accmode 0, so write() on the fd is EBADF
       (todos/0376) and the file stays empty. */
    fd = open("/otrunc.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, "HELLO WORLD", 11);
    close(fd);
    struct stat tb; stat("/otrunc.txt", &tb);
    errno = 0;
    int tfd = open("/otrunc.txt", O_RDONLY | O_TRUNC);
    int terr = errno;
    struct stat ta; memset(&ta, 0, sizeof ta);
    if (tfd >= 0) fstat(tfd, &ta);
    char tbuf[8]; memset(tbuf, 0, sizeof tbuf);
    int tr = tfd >= 0 ? read(tfd, tbuf, 4) : -1;
    errno = 0;
    int tw = tfd >= 0 ? write(tfd, "EVIL", 4) : -1;
    int twe = errno == EBADF;
    if (tfd >= 0) close(tfd);
    struct stat tp; stat("/otrunc.txt", &tp);
    printf("otrunc pre=%d ok=%d err=%d fsize=%d rd=%d wr=%d we=%d post=%d\\n",
           (int)tb.st_size, tfd >= 0, terr, (int)ta.st_size, tr, tw, twe,
           (int)tp.st_size);

    printf("done\\n");
    return 42;
}
`;

const CHILD_C = `
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
int main(int argc, char **argv) {
    const char *what = argc > 1 ? argv[1] : "";
    if (!strcmp(what, "appender")) {
        write(3, "BBB", 3);            /* inherited fd 3: /log.txt, shared offset */
        return 0;
    }
    if (!strcmp(what, "redirected")) {
        printf("REDIR pid=%d\\n", (int)getpid());
        return 7;
    }
    if (!strcmp(what, "ghostread")) {
        char c = 0;
        lseek(3, 0, SEEK_SET);         /* inherited fd 3: the unlinked file */
        read(3, &c, 1);
        return c == 'X' ? 9 : 1;
    }
    if (!strcmp(what, "chdirwrite")) {
        if (chdir("/sub") != 0) return 1;
        char cwd[64];
        getcwd(cwd, sizeof cwd);
        FILE *f = fopen("rel.txt", "w");   /* relative: lands in /sub */
        if (!f) return 2;
        fputs("rel", f);
        fclose(f);
        return strcmp(cwd, "/sub") == 0 ? 5 : 3;
    }
    if (!strcmp(what, "modewrite")) {
        /* fd 4 arrived via a spawn fd-action OPEN with O_RDONLY (todos/0376):
           writing it must be EBADF; reading it must still work. */
        errno = 0;
        int wn = write(4, "EVIL", 4);
        if (!(wn == -1 && errno == EBADF)) return 13;
        char b[4];
        return read(4, b, 4) == 4 ? 11 : 12;
    }
    if (!strcmp(what, "hog")) {
        int fd = open("/hogfile", O_RDWR | O_CREAT, 0644);
        write(fd, "leakbait", 8);
        unlink("/hogfile");
        sleep(100);                    /* killed here, fd still open */
        return 0;
    }
    return 64;
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-fs-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compile('init', INIT_C)],
  ['/bin/child', compile('child', CHILD_C)],
]);

// ---- boot with a kernel-owned BlockFS ----
const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);

let out = '';
const waiters = [];
function pump() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (out.includes(waiters[i].marker)) waiters.splice(i, 1)[0].resolve();
  }
}
const waitFor = (marker) => new Promise((resolve) => { waiters.push({ marker, resolve }); pump(); });

let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); pump(); },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});
const tty = kernel.createTty({ output: () => {} });

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\noutput:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  await waitFor('R1');
  tty.input('brokered!\r');

  await waitFor('R8');
  tty.resize(132, 43);               // the bridge resizes; the ioctl must see it
  tty.input('go\r');

  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 42', ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    'R1',
    'tty=[brokered!]',
    'logfd=3',
    'log=[AAABBBCCC]',                 // THE shared-offset proof
    'redir=[REDIR pid=3] code=7',
    'ghost=9 gone=1',
    'sub=[rel] childcwd=5 mycwd=[/]',
    'rootentries=4',                   // dev (fresh-image default), log.txt, out.txt, sub
    'hogkilled=1',
    'R8',
    'ws=132x43',
    'fsync=0 fdatasync=0 ttyfsync=0 badfsync=0',   // badfsync: kernel says EBADF
    'romode w=-1 e=1 r=4 body=[SAFE]',   // 0376: refused write left the bytes alone
    'womode r=-1 e=1 w=4',
    'modechild=11 body=[GOOD]',          // fd-action O_RDONLY: child write refused
    // #641: O_RDONLY|O_TRUNC succeeds and empties the file (the Linux
    // answer), the fd is still not write-capable (wr=-1 we=1), and the
    // refused write leaves it empty.
    'otrunc pre=11 ok=1 err=0 fsize=0 rd=0 wr=-1 we=1 post=0',
    'done',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }

  // The kernel released every description: nothing open, nothing leaked.
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));
  const problems = fsck(store);
  check('fsck: store clean after SIGKILL (no leaked blocks)',
    problems.length === 0, JSON.stringify(problems));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nbrokered fs e2e: PASS' : `\nbrokered fs e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
