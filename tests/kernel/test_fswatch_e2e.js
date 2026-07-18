#!/usr/bin/env node
// FS_WATCH end-to-end (ticket #75): REAL C programs compiled by compiler.js
// run as worker_threads under the kernel; a watcher process opens path-keyed
// watch fds (os/fswatch.h -> __fs_watch -> kernel FS_WATCH_OPEN) and a
// SECOND process performs the mutations — the events cross the process
// boundary through the kernel's _fsRpc choke point. Proves:
//   - settle-on-close: a write by another process queues FSW_CLOSE_WRITE at
//     the watched path when its fd closes (and NOT FSW_MODIFY — the default
//     mask is the settled set), visible to select() before the drain
//   - FS_WAIT composition: a watcher parked in __wait{watch fd} wakes on
//     the settle — no new blocking mechanism, the 0178 unified WAIT serves
//   - THE HEADLINE: tmp + rename-over (the editor atomic-save pattern that
//     defeats a per-inode inotify watch) lands FSW_CLOSE_WRITE on the
//     watched path, and the watch SURVIVES
//   - EAGAIN contract: a dry watch fd reads -1/EAGAIN, never blocks
//   - FSW_SELF_GONE + re-arm: delete fires, recreate keeps notifying
//   - dir watches: child names on create/delete records; a same-dir rename
//     is ONE FSW_RENAME record carrying both names (no cookie protocol)
//   - zero-write O_TRUNC settle (`echo -n > file`)
//   - overflow: a spam burst drains as a single FSW_OVERFLOW record, then
//     EAGAIN; the writer was never blocked
//   - MODIFY opt-in: FSW_M_ALL sees mid-write events, the default doesn't
//   - loud refusals: reserved flags -> EINVAL, absent path -> ENOENT
//
// Run: node tests/kernel/test_fswatch_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The mutator: every fs op the watcher observes happens in THIS process.
const HELPER_C = `
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    const char *cmd = argv[1];
    if (!strcmp(cmd, "write")) {              /* write PATH DATA: open/write/close */
        int fd = open(argv[2], O_WRONLY | O_CREAT, 0644);
        if (fd < 0) return 3;
        write(fd, argv[3], strlen(argv[3]));
        close(fd);
    } else if (!strcmp(cmd, "delaywrite")) {  /* settle after the watcher parked */
        usleep(300000);
        int fd = open(argv[2], O_WRONLY | O_CREAT, 0644);
        if (fd < 0) return 3;
        write(fd, "delayed", 7);
        close(fd);
    } else if (!strcmp(cmd, "saverename")) {  /* saverename TMP TARGET: the editor atomic save */
        int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) return 3;
        write(fd, "renamed-content", 15);
        close(fd);
        if (rename(argv[2], argv[3]) != 0) return 4;
    } else if (!strcmp(cmd, "unlink")) {
        if (unlink(argv[2]) != 0) return 5;
    } else if (!strcmp(cmd, "rename")) {
        if (rename(argv[2], argv[3]) != 0) return 6;
    } else if (!strcmp(cmd, "trunc")) {       /* zero-write truncate settle */
        int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) return 7;
        close(fd);
    } else if (!strcmp(cmd, "spam")) {        /* spam DIR N: distinct names defeat coalescing */
        int n = atoi(argv[3]);
        char p[128];
        for (int i = 0; i < n; i++) {
            snprintf(p, sizeof p, "%s/spam%d", argv[2], i);
            int fd = open(p, O_WRONLY | O_CREAT, 0644);
            if (fd < 0) return 8;
            write(fd, "x", 1);
            close(fd);
        }
    } else {
        return 9;
    }
    return 0;
}
`;

const APP_C = `
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>
#include "fswatch.h"

__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

extern char **environ;

/* Run the mutator to completion: by the time waitpid returns, every event
 * it caused is queued kernel-side — no sleeps anywhere in this test. */
static int run(const char *a, const char *b, const char *c) {
    char *argv[5];
    int n = 0;
    argv[n++] = (char *)"helper";
    argv[n++] = (char *)a;
    if (b) argv[n++] = (char *)b;
    if (c) argv[n++] = (char *)c;
    argv[n] = 0;
    pid_t pid;
    if (posix_spawn(&pid, "/bin/helper", 0, 0, argv, environ) != 0) return -1;
    int st;
    if (waitpid(pid, &st, 0) != pid) return -1;
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

/* Spawn WITHOUT waiting (the delaywrite leg parks while it runs). */
static pid_t run_bg(const char *a, const char *b) {
    char *argv[4] = { (char *)"helper", (char *)a, (char *)b, 0 };
    pid_t pid;
    if (posix_spawn(&pid, "/bin/helper", 0, 0, argv, environ) != 0) return -1;
    return pid;
}

static int sel_readable(int fd) {          /* select() view, zero timeout */
    fd_set rf;
    struct timeval tv = { 0, 0 };
    FD_ZERO(&rf);
    FD_SET(fd, &rf);
    int r = select(fd + 1, &rf, 0, 0, &tv);
    return r > 0 && FD_ISSET(fd, &rf);
}

int main(void) {
    int wfd, dw, mfd, st;
    unsigned bits;
    char buf[512];

    /* -------- file watch -------- */
    st = run("write", "/f.txt", "one");             /* pre-watch content */
    printf("SETUP helper=%d\\n", st);

    wfd = fsw_open("/f.txt", 0);
    printf("OPEN wfd=%d preread=%d preerr=%d presel=%d\\n", wfd,
           (int)read(wfd, buf, sizeof buf), errno == EAGAIN,
           sel_readable(wfd));

    /* L1: settle-on-close by another process; select sees it pre-drain. */
    st = run("write", "/f.txt", "two");
    bits = 0;
    int sel1 = sel_readable(wfd);
    bits = fsw_drain(wfd);
    printf("L1 helper=%d sel=%d cw=%d mod=%d postsel=%d\\n", st, sel1,
           !!(bits & FSW_BIT(FSW_CLOSE_WRITE)), !!(bits & FSW_BIT(FSW_MODIFY)),
           sel_readable(wfd));

    /* L2: FS_WAIT composition — park, get settled awake by the mutator. */
    pid_t bg = run_bg("delaywrite", "/f.txt");
    int why = __wait(&wfd, 1, 0, 8000);
    bits = fsw_drain(wfd);
    waitpid(bg, &st, 0);
    printf("L2 why=%d cw=%d\\n", why, !!(bits & FSW_BIT(FSW_CLOSE_WRITE)));

    /* L3: THE HEADLINE — tmp + rename-over save onto the watched path. */
    st = run("saverename", "/f.tmp", "/f.txt");
    bits = fsw_drain(wfd);
    printf("L3 helper=%d cw=%d\\n", st, !!(bits & FSW_BIT(FSW_CLOSE_WRITE)));

    /* L4: dry fd is EAGAIN, never a block. */
    errno = 0;
    int r4 = (int)read(wfd, buf, sizeof buf);
    printf("L4 r=%d eagain=%d\\n", r4, errno == EAGAIN);

    /* L5: SELF_GONE on delete; the watch stays ARMED across recreate. */
    st = run("unlink", "/f.txt", 0);
    bits = fsw_drain(wfd);
    int gone = !!(bits & FSW_BIT(FSW_SELF_GONE));
    st = run("write", "/f.txt", "reborn");
    bits = fsw_drain(wfd);
    printf("L5 gone=%d rearmed_cw=%d\\n", gone, !!(bits & FSW_BIT(FSW_CLOSE_WRITE)));

    /* -------- dir watch -------- */
    mkdir("/d", 0755);
    dw = fsw_open("/d", 0);
    printf("DIR dw=%d\\n", dw);

    /* L6: child create carries the NAME. */
    st = run("write", "/d/a.txt", "hello");
    int n6 = (int)read(dw, buf, sizeof buf);
    int saw_create = 0, saw_cw = 0;
    for (int off = 0; off + 4 <= n6;) {
        struct fsw_event *ev = (struct fsw_event *)(buf + off);
        if (ev->type == FSW_CREATE && !strcmp(ev->name, "a.txt")) saw_create = 1;
        if (ev->type == FSW_CLOSE_WRITE && !strcmp(ev->name, "a.txt")) saw_cw = 1;
        off += ev->len;
    }
    printf("L6 n=%d create=%d cw=%d\\n", n6, saw_create, saw_cw);

    /* L7: same-dir rename is ONE record with BOTH names. */
    st = run("rename", "/d/a.txt", "/d/b.txt");
    int n7 = (int)read(dw, buf, sizeof buf);
    int saw_ren = 0;
    for (int off = 0; off + 4 <= n7;) {
        struct fsw_event *ev = (struct fsw_event *)(buf + off);
        if (ev->type == FSW_RENAME && !strcmp(ev->name, "a.txt") &&
            !strcmp(ev->name + 6, "b.txt")) saw_ren = 1;
        off += ev->len;
    }
    printf("L7 n=%d rename=%d\\n", n7, saw_ren);

    /* L8: delete record carries the name. */
    st = run("unlink", "/d/b.txt", 0);
    int n8 = (int)read(dw, buf, sizeof buf);
    int saw_del = 0;
    for (int off = 0; off + 4 <= n8;) {
        struct fsw_event *ev = (struct fsw_event *)(buf + off);
        if (ev->type == FSW_DELETE && !strcmp(ev->name, "b.txt")) saw_del = 1;
        off += ev->len;
    }
    printf("L8 n=%d delete=%d\\n", n8, saw_del);

    /* L9: zero-write O_TRUNC still settles (echo -n > file). */
    st = run("trunc", "/d/c.txt", 0);
    bits = fsw_drain(dw);
    printf("L9 cw=%d\\n", !!(bits & FSW_BIT(FSW_CLOSE_WRITE)));

    /* L10: overflow drains as ONE honest OVERFLOW record, then EAGAIN. */
    st = run("spam", "/d", "200");
    int n10 = (int)read(dw, buf, sizeof buf);
    struct fsw_event *ov = (struct fsw_event *)buf;
    errno = 0;
    int r10b = (int)read(dw, buf + 256, 16);
    printf("L10 helper=%d n=%d type=%d single=%d posteagain=%d\\n", st, n10,
           n10 >= 4 ? ov->type : -1, n10 >= 4 && n10 == ov->len,
           r10b < 0 && errno == EAGAIN);

    /* L11: MODIFY is opt-in via FSW_M_ALL. */
    mfd = fsw_open("/f.txt", FSW_M_ALL);
    st = run("write", "/f.txt", "modme");
    bits = fsw_drain(mfd);
    printf("L11 mod=%d cw=%d\\n", !!(bits & FSW_BIT(FSW_MODIFY)),
           !!(bits & FSW_BIT(FSW_CLOSE_WRITE)));

    /* L12: loud refusals — reserved flags EINVAL, absent path ENOENT. */
    errno = 0;
    int rf1 = __fs_watch("/f.txt", 0, 1);
    int einval = rf1 < 0 && errno == EINVAL;
    errno = 0;
    int rf2 = fsw_open("/no/such/path", 0);
    printf("L12 einval=%d enoent=%d\\n", einval, rf2 < 0 && errno == ENOENT);

    /* L13: close removes the watch (and the fd) cleanly. */
    int c1 = close(wfd), c2 = close(dw), c3 = close(mfd);
    st = run("write", "/f.txt", "after-close");   /* must not crash the kernel */
    printf("L13 closes=%d helper=%d\\n", c1 == 0 && c2 == 0 && c3 == 0, st);

    printf("DONE\\n");
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fswatch-e2e-'));
const write = (name, src) => { fs.writeFileSync(path.join(tmp, name), src); };
write('app.c', APP_C);
write('helper.c', HELPER_C);
const compile = (cfile, out) => cp.execFileSync('node',
  [path.join(ROOT, 'compiler.js'), path.join(tmp, cfile), '-o', path.join(tmp, out),
   '-I' + path.join(ROOT, 'os')],
  { stdio: 'pipe' });
compile('app.c', 'app.wasm');
compile('helper.c', 'helper.wasm');
const appImage = fs.readFileSync(path.join(tmp, 'app.wasm'));
const helperImage = fs.readFileSync(path.join(tmp, 'helper.wasm'));

// Brokered boot: FS_WATCH is fd-flavored — it needs the kernel-owned fd
// layer (a no-fs kernel answers ENOSYS like every 0x04xx op).
const store = new BLOCK_FS.MemoryByteStore(8 << 20);
const kfs = BLOCK_FS.createV4(store);

let out = '';
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? appImage : p === '/bin/helper' ? helperImage : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});
kernel.createTty({ cols: 80, rows: 24, output: () => {} });

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const line = (tag) => out.split('\n').find((l) => l.startsWith(tag + ' ')) || '';
const field = (tag, key) => {
  const m = line(tag).match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — fswatch e2e did not finish in 120s\noutput so far:\n' + out);
  process.exit(1);
}, 120000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('DONE');

  check('setup: pre-watch write helper exited 0', field('SETUP', 'helper') === 0, line('SETUP'));
  check('watch fd created', field('OPEN', 'wfd') >= 0, line('OPEN'));
  check('fresh watch reads EAGAIN (no stale events)',
    field('OPEN', 'preread') === -1 && field('OPEN', 'preerr') === 1, line('OPEN'));
  check('fresh watch not select-readable', field('OPEN', 'presel') === 0, line('OPEN'));

  check('L1: select() saw the settle before the drain', field('L1', 'sel') === 1, line('L1'));
  check('L1: cross-process write-then-close settles as FSW_CLOSE_WRITE',
    field('L1', 'cw') === 1, line('L1'));
  check('L1: no FSW_MODIFY under the default (settled) mask', field('L1', 'mod') === 0, line('L1'));
  check('L1: drained fd no longer select-readable', field('L1', 'postsel') === 0, line('L1'));

  check('L2: parked FS_WAIT woken by the settle (why=1)', field('L2', 'why') === 1, line('L2'));
  check('L2: the wake carried FSW_CLOSE_WRITE', field('L2', 'cw') === 1, line('L2'));

  check('L3: HEADLINE — rename-over save lands FSW_CLOSE_WRITE on the watched path',
    field('L3', 'helper') === 0 && field('L3', 'cw') === 1, line('L3'));

  check('L4: dry watch fd is EAGAIN, not a block',
    field('L4', 'r') === -1 && field('L4', 'eagain') === 1, line('L4'));

  check('L5: delete fires FSW_SELF_GONE', field('L5', 'gone') === 1, line('L5'));
  check('L5: watch stays armed — recreate settles again', field('L5', 'rearmed_cw') === 1, line('L5'));

  check('L6: dir watch — child create record carries the name', field('L6', 'create') === 1, line('L6'));
  check('L6: dir watch — child settle record carries the name', field('L6', 'cw') === 1, line('L6'));

  check('L7: same-dir rename is ONE record with both names', field('L7', 'rename') === 1, line('L7'));
  check('L8: delete record carries the name', field('L8', 'delete') === 1, line('L8'));
  check('L9: zero-write O_TRUNC settles', field('L9', 'cw') === 1, line('L9'));

  check('L10: overflow drains as a single FSW_OVERFLOW record',
    field('L10', 'type') === 7 && field('L10', 'single') === 1, line('L10'));
  check('L10: after the overflow drain the fd is dry (EAGAIN)',
    field('L10', 'posteagain') === 1, line('L10'));
  check('L10: the spamming writer was never blocked (helper exited 0)',
    field('L10', 'helper') === 0, line('L10'));

  check('L11: FSW_M_ALL sees MODIFY and the settle',
    field('L11', 'mod') === 1 && field('L11', 'cw') === 1, line('L11'));

  check('L12: reserved flags refuse EINVAL', field('L12', 'einval') === 1, line('L12'));
  check('L12: absent path refuses ENOENT', field('L12', 'enoent') === 1, line('L12'));

  check('L13: watch fds close clean; post-close mutation is fine',
    field('L13', 'closes') === 1 && field('L13', 'helper') === 0, line('L13'));

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nfswatch e2e: PASS' : `\nfswatch e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
