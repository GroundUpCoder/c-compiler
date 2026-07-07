#!/usr/bin/env node
// AF_UNIX sockets end-to-end (todos/0008): real C processes in
// worker_threads over the brokered kernel prove the acceptance criteria:
//   - socket/bind/listen/accept/connect/send/recv between two SPAWNED
//     processes (the server's accept PARKS and is woken by the client's
//     connect; the client's recv parks and is woken by the server's send)
//   - socketpair() inside one process, both directions + EOF
//   - poll()/select() integration (poll rides __select_impl)
//   - the bound path is a real S_IFSOCK node (stat/S_ISSOCK)
//   - close semantics: peer read returns 0 at EOF
//
// Exit-code convention: server/client return a bitmask of passed stages so
// interleaved stdout can't garble the verdict; init prints both masks.
//
// Run: node tests/kernel/test_sockets_e2e.js
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

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const INIT_C = `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <errno.h>

int main(void) {
    int sv[2]; char buf[64]; ssize_t n, m;

    /* socketpair: bidirectional inside one process, then EOF */
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv)) { printf("pair errno=%d\\n", errno); return 99; }
    write(sv[0], "ab", 2);
    n = read(sv[1], buf, sizeof buf);
    write(sv[1], "XYZ", 3);
    m = read(sv[0], buf + 8, sizeof buf - 8);
    printf("pair=%d%d\\n", n == 2 && !memcmp(buf, "ab", 2),
           m == 3 && !memcmp(buf + 8, "XYZ", 3));
    close(sv[0]);
    n = read(sv[1], buf, sizeof buf);
    printf("pair_eof=%d\\n", n == 0);
    close(sv[1]);

    /* bad-family/type validation stays libc-side */
    printf("af=%d proto=%d\\n",
           socket(AF_INET, SOCK_STREAM, 0) < 0 && errno == EAFNOSUPPORT,
           socket(AF_UNIX, SOCK_DGRAM, 0) < 0 && errno == EPROTONOSUPPORT);

    /* the client/server pair (each exits with a stage bitmask) */
    char *sargv[] = { "server", 0 };
    char *cargv[] = { "client", 0 };
    pid_t sp, cpid;
    int sst, cst;
    if (posix_spawn(&sp, "/bin/server", 0, 0, sargv, 0)) return 98;
    if (posix_spawn(&cpid, "/bin/client", 0, 0, cargv, 0)) return 97;
    waitpid(sp, &sst, 0);
    waitpid(cpid, &cst, 0);
    printf("server=%d client=%d\\n", WEXITSTATUS(sst), WEXITSTATUS(cst));

    /* the rendezvous is a real S_IFSOCK node */
    struct stat st;
    printf("issock=%d\\n", stat("/tmp/e2e.sock", &st) == 0 && S_ISSOCK(st.st_mode) != 0);
    printf("done\\n");
    return 0;
}
`;

const SERVER_C = `
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>
#include <poll.h>

int main(void) {
    int ok = 0;
    int lfd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strcpy(sa.sun_path, "/tmp/e2e.sock");
    if (lfd >= 0 && bind(lfd, (struct sockaddr *)&sa, sizeof sa) == 0) ok |= 1;
    if (listen(lfd, 4) == 0) ok |= 2;

    /* select() watches the listener; readable exactly when a connect is
       queued (the client may or may not have arrived yet — both paths are
       the same select semantics). */
    fd_set rf;
    FD_ZERO(&rf);
    FD_SET(lfd, &rf);
    if (select(lfd + 1, &rf, 0, 0, 0) == 1 && FD_ISSET(lfd, &rf)) ok |= 4;

    int cfd = accept(lfd, 0, 0);
    if (cfd >= 0) ok |= 8;

    /* poll() on the connection: readable once the ping lands */
    struct pollfd pf;
    pf.fd = cfd; pf.events = POLLIN; pf.revents = 0;
    if (poll(&pf, 1, -1) == 1 && (pf.revents & POLLIN)) ok |= 16;

    char buf[32];
    ssize_t n = recv(cfd, buf, sizeof buf, 0);
    if (n == 4 && !memcmp(buf, "ping", 4)) ok |= 32;
    if (send(cfd, "PONG!", 5, 0) == 5) ok |= 64;

    n = read(cfd, buf, sizeof buf);          /* client closes -> EOF */
    if (n == 0) ok |= 128;
    close(cfd);
    close(lfd);
    return ok;                               /* 255 = every stage passed */
}
`;

const CLIENT_C = `
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

int main(void) {
    int ok = 0, i;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strcpy(sa.sun_path, "/tmp/e2e.sock");
    for (i = 0; i < 200; i++) {              /* the server may not have bound yet */
        if (connect(fd, (struct sockaddr *)&sa, SUN_LEN(&sa)) == 0) break;
        usleep(25000);
    }
    if (i < 200) ok |= 1;
    if (send(fd, "ping", 4, 0) == 4) ok |= 2;
    char buf[32];
    ssize_t n = recv(fd, buf, sizeof buf, 0);  /* parks until the server replies */
    if (n == 5 && !memcmp(buf, "PONG!", 5)) ok |= 4;
    close(fd);
    return ok;                               /* 7 = every stage passed */
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-sockets-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compile('init', INIT_C)],
  ['/bin/server', compile('server', SERVER_C)],
  ['/bin/client', compile('client', CLIENT_C)],
]);

// ---- boot brokered ----
const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);
kfs.mkdir('/tmp', 0o777);

let out = '';
let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});
kernel.createTty({ output: () => {} });

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\noutput:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 0', status === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    'pair=11',
    'pair_eof=1',
    'af=1 proto=1',
    'server=255 client=7',
    'issock=1',
    'done',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));
  check('rendezvous map empty after halt', kernel._sockBinds.size === 0,
    String(kernel._sockBinds.size));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsockets e2e: PASS' : `\nsockets e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
