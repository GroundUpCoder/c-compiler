// Host-level regression test (#638): the CJS bundle (-o <name>.js with
// --opfs-file payloads) used to name its data directory from the process id
// alone ("cjs-" + process.pid), mkdirSync it, and never clean up. Two defects:
// (A) the directory — embedded payloads AND anything the program wrote to its
// cwd — survived a clean exit forever; (B) because pids are reused and
// mkdirSync({recursive:true}) preserves an existing directory, a later
// unrelated program started up in a cwd already holding a previous program's
// files. Now the dir is fs.mkdtempSync-unique per invocation and removed on
// exit, so concurrent runs of the SAME bundle never collide either.
//
// Legs (each under its own private TMPDIR so os.tmpdir() in the bundle is
// hermetic; pid reuse is simulated by pinning process.pid in a wrapper):
//   1. control + leak: payload is visible in the program's cwd; NOTHING in
//      the temp dir survives a clean exit (embedded payload or program-authored).
//   2. contamination: run A (writes a file to its cwd), then run B under the
//      SAME pid — B's cwd must hold exactly B's own payload, none of A's files.
//   3. concurrency: two simultaneous runs of the SAME bundle under the SAME
//      pid must land in distinct working directories.
//
// Run: node tests/host/test_cjs_datadir.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// One program, three modes: "write" creates a file in its cwd (the
// program-authored-output half of the leak), "list" prints the cwd's entries
// sorted (opendir/readdir — popen produces no output under this toolchain),
// "cwd" prints getcwd (the standalone env passes through process.cwd()).
const SRC = `#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <dirent.h>

static int cmpstr(const void *a, const void *b) {
  return strcmp(*(const char * const *)a, *(const char * const *)b);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "";
  if (!strcmp(mode, "write")) {
    FILE *f = fopen("prog-output.txt", "w");
    if (!f) { printf("FOPEN-FAIL\\n"); return 1; }
    fputs("written-by-program\\n", f);
    fclose(f);
    printf("WROTE\\n");
    return 0;
  }
  if (!strcmp(mode, "list")) {
    DIR *d = opendir(".");
    if (!d) { printf("OPENDIR-FAIL\\n"); return 1; }
    char *names[64];
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) && n < 64) {
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      names[n++] = strdup(e->d_name);
    }
    closedir(d);
    qsort(names, n, sizeof(char *), cmpstr);
    for (int i = 0; i < n; i++) printf("%s\\n", names[i]);
    return 0;
  }
  if (!strcmp(mode, "cwd")) {
    char buf[1024];
    if (!getcwd(buf, sizeof buf)) { printf("GETCWD-FAIL\\n"); return 1; }
    printf("%s\\n", buf);
    return 0;
  }
  printf("BAD-MODE\\n");
  return 1;
}
`;

// The bundle reads process.argv.slice(2) as program args, so the wrapper
// splices the bundle path out of argv before requiring it. The pinned pid
// simulates OS pid reuse deterministically (the pre-fix dir name was
// "cjs-" + process.pid); post-fix the pid is simply never consulted.
const WRAP = `'use strict';
const bundle = process.argv.splice(2, 1)[0];
Object.defineProperty(process, 'pid', { value: 424242, configurable: true });
require(require('path').resolve(bundle));
`;

function runBundle(wrapPath, bundle, args, tmpDir, extraOpts) {
  const argv = wrapPath ? [wrapPath, bundle].concat(args) : [bundle].concat(args);
  return cp.spawnSync('node', argv, Object.assign({
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { TMPDIR: tmpDir }),
  }, extraOpts || {}));
}

function runBundleAsync(wrapPath, bundle, args, tmpDir) {
  return new Promise(resolve => {
    const child = cp.spawn('node', [wrapPath, bundle].concat(args), {
      env: Object.assign({}, process.env, { TMPDIR: tmpDir }),
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cjs-datadir-'));
  fs.writeFileSync(path.join(tmp, 'prog.c'), SRC);
  fs.writeFileSync(path.join(tmp, 'data-a.txt'), 'PAYLOAD-A\n');
  fs.writeFileSync(path.join(tmp, 'data-b.txt'), 'PAYLOAD-B\n');
  const wrapPath = path.join(tmp, 'wrap.js');
  fs.writeFileSync(wrapPath, WRAP);

  const bundleA = path.join(tmp, 'a.js');
  const bundleB = path.join(tmp, 'b.js');
  const ca = cp.spawnSync('node', [COMPILER, path.join(tmp, 'prog.c'),
    '--opfs-file', path.join(tmp, 'data-a.txt') + ':/data-a.txt', '-o', bundleA],
    { encoding: 'utf-8' });
  check('bundle A compiles', ca.status === 0, 'status=' + ca.status + ' stderr=' + ca.stderr);
  const cb = cp.spawnSync('node', [COMPILER, path.join(tmp, 'prog.c'),
    '--opfs-file', path.join(tmp, 'data-b.txt') + ':/data-b.txt', '-o', bundleB],
    { encoding: 'utf-8' });
  check('bundle B compiles', cb.status === 0, 'status=' + cb.status + ' stderr=' + cb.stderr);
  if (failures) { finish(tmp); return; }

  // --- Leg 1: control + leak ---------------------------------------------
  const t1 = fs.mkdtempSync(path.join(tmp, 'leg1-'));
  const r1 = runBundle(null, bundleB, ['list'], t1);
  check('leg1: list run exits 0', r1.status === 0, 'status=' + r1.status + ' stderr=' + r1.stderr);
  check('leg1: payload visible in program cwd (control)',
    r1.stdout === 'data-b.txt\n', JSON.stringify(r1.stdout));
  check('leg1: nothing survives a clean exit',
    fs.readdirSync(t1).length === 0, JSON.stringify(fs.readdirSync(t1)));
  const r1w = runBundle(null, bundleA, ['write'], t1);
  check('leg1: write run exits 0', r1w.status === 0, 'status=' + r1w.status + ' stderr=' + r1w.stderr);
  check('leg1: program-authored cwd output does not survive either',
    fs.readdirSync(t1).length === 0, JSON.stringify(fs.readdirSync(t1)));

  // --- Leg 2: cross-program contamination under pid reuse ----------------
  const t2 = fs.mkdtempSync(path.join(tmp, 'leg2-'));
  const r2a = runBundle(wrapPath, bundleA, ['write'], t2);
  check('leg2: program A exits 0', r2a.status === 0, 'status=' + r2a.status + ' stderr=' + r2a.stderr);
  const r2b = runBundle(wrapPath, bundleB, ['list'], t2);
  check('leg2: program B exits 0', r2b.status === 0, 'status=' + r2b.status + ' stderr=' + r2b.stderr);
  check('leg2: same-pid successor sees ONLY its own payload',
    r2b.stdout === 'data-b.txt\n', JSON.stringify(r2b.stdout));

  // --- Leg 3: concurrent runs of the SAME bundle -------------------------
  const t3 = fs.mkdtempSync(path.join(tmp, 'leg3-'));
  const [r3a, r3b] = await Promise.all([
    runBundleAsync(wrapPath, bundleB, ['cwd'], t3),
    runBundleAsync(wrapPath, bundleB, ['cwd'], t3),
  ]);
  check('leg3: run 1 exits 0', r3a.status === 0, 'status=' + r3a.status + ' stderr=' + r3a.stderr);
  check('leg3: run 2 exits 0', r3b.status === 0, 'status=' + r3b.status + ' stderr=' + r3b.stderr);
  const cwdA = r3a.stdout.trim(), cwdB = r3b.stdout.trim();
  const t3real = fs.realpathSync(t3);
  check('leg3: run 1 cwd is under its TMPDIR', cwdA.startsWith(t3real + path.sep), cwdA);
  check('leg3: run 2 cwd is under its TMPDIR', cwdB.startsWith(t3real + path.sep), cwdB);
  check('leg3: concurrent same-bundle runs get DISTINCT data dirs',
    cwdA !== cwdB && cwdA !== '' && cwdB !== '',
    JSON.stringify({ cwdA, cwdB }));

  finish(tmp);
}

function finish(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' check(s) FAILED' : 'test_cjs_datadir: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
