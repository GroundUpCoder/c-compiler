#!/usr/bin/env node
// MicroPython sys.path + stdlib e2e (todos/0117 R2). The third sibling of
// test_repl_pty_e2e.js (the interactive REPL) and test_micropython_script_e2e.js
// (the R1 CLI): this one proves the R2 deliverables — the SEARCH PATH policy
// and the curated module set — against a real kernel, real BlockFS and a real
// spawned process.
//
// The binary is installed the way gucman really installs it: payload at
// /opt/micropython/micropython with a /usr/local/bin/python SYMLINK. That is
// load-bearing, not decoration — the package's bundled-module directory is
// derived by chasing argv[0]'s trailing symlink, so a test that spawned the
// payload directly would pass while the shipped layout was broken.
//
// Legs:
//   - sys.path is [<script dir>, ".frozen", /usr/local/lib/micropython,
//     <exe dir>/lib] and the exe-dir entry survives the symlink hop
//   - a two-file program imports its sibling when run from ANOTHER cwd
//     (R1 only worked when cwd happened to be the script's directory)
//   - a module dropped in the writable site dir is importable from anywhere
//   - `-m mod` runs a module as __main__, `-m pkg` finds pkg/__main__.py
//   - `os` really drives the kernel fs: getcwd/chdir/listdir/mkdir/stat/
//     rename/remove, and os.path over real paths
//   - json / re / time / struct / binascii / random are present and work
//   - os.urandom() reads the kernel's /dev/urandom
//
// Run: node tests/kernel/test_micropython_stdlib_e2e.js
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

// --- the Python programs the init process writes out ----------------------

// Reports the whole search path so the assertions can be exact rather than
// "contains something plausible".
const PATHS_PY = [
  'import sys',
  'print("PATH=" + repr(sys.path))',
].join('\n') + '\n';

// A two-file program. app.py lives in /root/proj and imports its sibling; the
// init process runs it from /root, so cwd is NOT the script directory.
const APP_PY = [
  'import sys, sibling',
  'print("SIB=" + sibling.who())',
  'print("APP_PATH0=" + sys.path[0])',
].join('\n') + '\n';
const SIBLING_PY = 'def who():\n    return "sibling-of-app"\n';

// Dropped into /usr/local/lib/micropython — importable from any cwd.
const SITEMOD_PY = 'ORIGIN = "site-dir"\n';
const USESITE_PY = 'import sitemod\nprint("SITE=" + sitemod.ORIGIN)\n';

// -m targets: a plain module and a package with __main__.py.
const RUNME_PY = 'import sys\nprint("DASHM=" + __name__ + " argv0=" + sys.argv[0])\n';
const PKG_INIT_PY = 'NAME = "thepkg"\n';
const PKG_MAIN_PY = 'print("PKGMAIN=" + __name__)\n';

// A #! script (todos/0065 _spawnShebang). Proves the shebang story needs no
// new mechanism: the kernel re-dispatches to the interpreter with the script
// path as argv[1], which is exactly the CLI R1 built. It also pins the thing
// that matters for todos/0338 — the shebang names /usr/local/bin/python, the
// same path the dispatcher will own, so these scripts follow it for free.
const SHEBANG_PY = [
  '#!/usr/local/bin/python',
  'import sys, sibling2',
  'print("SHEBANG=" + sibling2.tag() + " argv=" + repr(sys.argv))',
].join('\n') + '\n';
const SIBLING2_PY = 'def tag():\n    return "via-shebang"\n';

// os / os.path against the real kernel filesystem.
const OSMOD_PY = [
  'import os',
  'os.chdir("/root/osplay")',
  'print("CWD=" + os.getcwd())',
  'os.mkdir("d1")',
  'open("d1/a.txt", "w").write("12345")',
  'print("LS=" + repr(sorted(os.listdir("d1"))))',
  'st = os.stat("d1/a.txt")',
  'print("SIZE=%d ISREG=%s ISDIR=%s" % (st[6], os.path.isfile("d1/a.txt"), os.path.isdir("d1")))',
  'os.rename("d1/a.txt", "d1/b.txt")',
  'print("RENAMED=" + repr(sorted(os.listdir("d1"))))',
  // ilistdir while d1 still exists, so its (name, type) pair is checkable.
  'print("ILIST=" + repr(sorted((e[0], e[1] == 0x4000, e[1] == 0x8000)'
  + ' for e in os.ilistdir("d1"))))',
  'print("ILISTDIR=" + repr([(e[0], e[1] == 0x4000) for e in os.ilistdir(".")]))',
  'os.remove("d1/b.txt")',
  'os.rmdir("d1")',
  'print("GONE=%s" % (not os.path.exists("d1")))',
  'print("JOIN=" + os.path.join("/a/b", "c") + " ABS=" + os.path.abspath("z"))',
  'print("NORM=" + os.path.normpath("/a/b/../c/./d//e"))',
  'print("SPLIT=" + repr(os.path.split("/x/y.txt")) + repr(os.path.splitext("/x/y.txt")))',
  'print("SEP=" + os.sep + " CURDIR=" + os.path.curdir + " PARDIR=" + os.path.pardir)',
  'print("UNAME=" + os.uname()[0])',
  'print("RANDOM=%s" % (os.urandom(16) != os.urandom(16)))',
  // The symlink pair the installer really uses.
  'print("LINK=" + os.path.realpath("/usr/local/bin/python"))',
  'print("ISLINK=%s" % os.path.islink("/usr/local/bin/python"))',
].join('\n') + '\n';

// The curated module set, in one script so a missing module fails loudly.
const STDLIB_PY = [
  'import json, re, time, struct, binascii, random, heapq, collections, array, gc, errno',
  'print("JSON=" + json.dumps(json.loads(\'{"a":[1,2],"b":null}\')))',
  'print("RE=" + re.sub("[0-9]+", "#", "a12b345") + " " +'
  + ' re.match(r"(\\w+)@(\\w+)", "usr@host").group(2))',
  // Epoch is 1970 (mpconfigport.h), so this must agree with CPython.
  'print("TIME=" + repr(time.gmtime(1000000000)[:6]))',
  'print("STRUCT=" + repr(struct.unpack("<HI", struct.pack("<HI", 7, 99999))))',
  'print("B64=" + binascii.b2a_base64(b"hi").decode().strip() + " "'
  + ' + binascii.hexlify(b"\\x01\\xff").decode())',
  'h = []',
  'for v in (5, 1, 4): heapq.heappush(h, v)',
  'print("HEAPQ=%d" % heapq.heappop(h))',
  'print("NT=" + repr(collections.namedtuple("P", "x y")(1, 2)))',
  'print("ARRAY=" + repr(list(array.array("i", [1, 2, 3]))))',
  'print("ERRNO=%d" % errno.ENOENT)',
  'random.seed(1)',
  'print("RANDRANGE=%s" % (0 <= random.randrange(10) < 10))',
  'print("GC=%s" % (gc.mem_free() > 0))',
  // ticks must actually advance — before R2 mp_hal_ticks_ms was `return 0`.
  't0 = time.ticks_ms()',
  'time.sleep_ms(30)',
  'print("TICKS=%s" % (time.ticks_diff(time.ticks_ms(), t0) >= 20))',
].join('\n') + '\n';

const INIT_C = `
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/wait.h>

static void put(const char *path, const char *body) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { printf("PUT-FAIL %s\\n", path); return; }
    write(fd, body, strlen(body));
    close(fd);
}

// Everything is spawned through /usr/local/bin/python — the symlink, not the
// payload — so argv[0] is what a user actually types.
static int run_path(const char *exe, char *const argv[]) {
    pid_t pid;
    if (posix_spawn(&pid, exe, NULL, NULL, argv, NULL) != 0) {
        printf("SPAWN-FAIL %s\\n", exe);
        return -1;
    }
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

static int run(char *const argv[]) {
    pid_t pid;
    if (posix_spawn(&pid, "/usr/local/bin/python", NULL, NULL, argv, NULL) != 0) {
        printf("SPAWN-FAIL\\n");
        return -1;
    }
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

int main(void) {
    mkdir("/root/proj", 0755);
    mkdir("/root/osplay", 0755);
    mkdir("/root/pkgroot", 0755);
    mkdir("/root/pkgroot/thepkg", 0755);
    mkdir("/root/shb", 0755);

    put("/root/paths.py",   ${JSON.stringify(PATHS_PY)});
    put("/root/proj/app.py", ${JSON.stringify(APP_PY)});
    put("/root/proj/sibling.py", ${JSON.stringify(SIBLING_PY)});
    put("/usr/local/lib/micropython/sitemod.py", ${JSON.stringify(SITEMOD_PY)});
    put("/root/usesite.py", ${JSON.stringify(USESITE_PY)});
    put("/root/pkgroot/runme.py", ${JSON.stringify(RUNME_PY)});
    put("/root/pkgroot/thepkg/__init__.py", ${JSON.stringify(PKG_INIT_PY)});
    put("/root/pkgroot/thepkg/__main__.py", ${JSON.stringify(PKG_MAIN_PY)});
    put("/root/osmod.py",   ${JSON.stringify(OSMOD_PY)});
    put("/root/shb/run.py", ${JSON.stringify(SHEBANG_PY)});
    put("/root/shb/sibling2.py", ${JSON.stringify(SIBLING2_PY)});
    chmod("/root/shb/run.py", 0755);
    put("/root/stdlib.py",  ${JSON.stringify(STDLIB_PY)});

    chdir("/root");

    char *a1[] = { "python", "/root/paths.py", NULL };
    printf("paths_status=%d\\n", run(a1));

    // Run the two-file program from /root, NOT from /root/proj.
    char *a2[] = { "python", "/root/proj/app.py", NULL };
    printf("app_status=%d\\n", run(a2));

    char *a3[] = { "python", "/root/usesite.py", NULL };
    printf("site_status=%d\\n", run(a3));

    char *a4[] = { "python", "/root/osmod.py", NULL };
    printf("os_status=%d\\n", run(a4));

    char *a5[] = { "python", "/root/stdlib.py", NULL };
    printf("stdlib_status=%d\\n", run(a5));

    // -m resolves against sys.path[0] == cwd.
    chdir("/root/pkgroot");
    char *a6[] = { "python", "-m", "runme", NULL };
    printf("dashm_status=%d\\n", run(a6));
    char *a7[] = { "python", "-m", "thepkg", NULL };
    printf("dashmpkg_status=%d\\n", run(a7));
    char *a8[] = { "python", "-m", "no_such_module", NULL };
    printf("dashmmissing_status=%d\\n", run(a8));

    // The shebang script runs as its own command, from an unrelated cwd.
    chdir("/root");
    char *a9[] = { "/root/shb/run.py", "zed", NULL };
    printf("shebang_status=%d\\n", run_path("/root/shb/run.py", a9));

    printf("done\\n");
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-mpstdlib-'));
function compileSrc(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
function compileProject(binJson) {
  const wasm = path.join(tmp, path.basename(path.dirname(binJson)) + '.wasm');
  cp.execFileSync('node', [COMPILER, path.join(ROOT, binJson), '-o', wasm],
    { stdio: 'pipe', cwd: ROOT });
  return fs.readFileSync(wasm);
}

const MP_PAYLOAD = '/opt/micropython/micropython';
const PY_LINK = '/usr/local/bin/python';
const images = new Map([
  ['/bin/init', compileSrc('init', INIT_C)],
  [MP_PAYLOAD, compileProject('vendor/micropython/bin.json')],
]);

const store = new BLOCK_FS.MemoryByteStore(24 << 20);
const kfs = BLOCK_FS.createV4(store);
for (const d of ['/root', '/opt', '/opt/micropython', '/usr', '/usr/local',
                 '/usr/local/bin', '/usr/local/lib', '/usr/local/lib/micropython']) {
  kfs.mkdir(d, 0o755);
}
// A real (empty) file stands in for the payload on the fs: the BYTES come from
// `images`, but readlink/stat/realpath in the guest must see the real layout.
{
  const fd = kfs.open(MP_PAYLOAD, 1 | 0o100 | 0o1000 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  if (fd === null) throw new Error('open payload: ' + kfs._lastError);
  kfs.close(fd);
}
if (kfs.symlink(MP_PAYLOAD, PY_LINK) === null) {
  throw new Error('symlink ' + PY_LINK + ': ' + kfs._lastError);
}

function readFsFile(p) {
  const fd = kfs.open(p, 0, 0);
  if (fd === null) return null;
  const st = kfs.fstat(fd);
  const buf = new Uint8Array(st.size);
  let off = 0;
  while (off < buf.length) {
    const n = kfs.read(fd, buf.subarray(off), buf.length - off);
    if (n === null || n === 0) break;
    off += n;
  }
  kfs.close(fd);
  return off === buf.length ? buf : null;
}

// Follow a trailing-component symlink chain on the kernel fs (absolute targets
// only — that is all this layout uses).
function resolveLink(p) {
  for (let hop = 0; hop < 8; hop++) {
    const buf = new Uint8Array(512);
    const n = kfs.readlink(p, buf, buf.length);
    if (n === null || n <= 0) return p;
    p = Buffer.from(buf.subarray(0, n)).toString();
  }
  return p;
}

let out = '';
let err = '';
let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  // loadImage gets the path as SPAWNED, so /usr/local/bin/python arrives
  // unresolved — chase the link through the fs first, the way a real embedder
  // serving binaries out of a volume does. Anything not in the wasm map is
  // read from the volume, which is what makes a #! script spawnable (the
  // kernel needs its BYTES to see the "#!" and re-dispatch).
  loadImage: (p) => images.get(resolveLink(p)) || readFsFile(p),
  onOutput: (pid, fd, bytes) => {
    const s = Buffer.from(bytes).toString();
    if (fd === 2) { err += s; } else { out += s; }
  },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\nstdout:\n' + out + '\nstderr:\n' + err);
  process.exit(1);
}, 240000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  const has = (needle) => out.includes(needle);
  const line = (prefix) => {
    const m = out.match(new RegExp('^' + prefix + '(.*)$', 'm'));
    return m ? m[1] : null;
  };

  check('init exited 0', status === 0, String(status));

  // --- sys.path policy ---------------------------------------------------
  const p = line('PATH=');
  check('sys.path reported', p !== null, JSON.stringify(out.slice(0, 400)));
  if (p) {
    check('sys.path[0] is the script dir', p.startsWith("['/root',"), p);
    check('sys.path keeps .frozen', p.includes("'.frozen'"), p);
    check('sys.path has the writable site dir',
          p.includes("'/usr/local/lib/micropython'"), p);
    // The bundled-module dir must be derived from the PAYLOAD's directory,
    // i.e. the symlink at /usr/local/bin/python was chased.
    check('sys.path has <payload dir>/lib (symlink chased)',
          p.includes("'/opt/micropython/lib'"), p);
    check('site dir precedes the package lib dir',
          p.indexOf("'/usr/local/lib/micropython'") < p.indexOf("'/opt/micropython/lib'"), p);
  }
  check('paths script exited 0', has('paths_status=0'));

  // --- two-file import from another cwd ----------------------------------
  check('sibling module imported from a different cwd', has('SIB=sibling-of-app'));
  check('sys.path[0] is the SCRIPT dir, not the cwd', has('APP_PATH0=/root/proj'));
  check('two-file program exited 0', has('app_status=0'));

  // --- writable site dir -------------------------------------------------
  check('module in /usr/local/lib/micropython importable', has('SITE=site-dir'));
  check('site-dir script exited 0', has('site_status=0'));

  // --- os / os.path over the kernel fs -----------------------------------
  check('os.chdir + os.getcwd', has('CWD=/root/osplay'));
  check('os.mkdir + os.listdir', has("LS=['a.txt']"));
  check('os.stat size + os.path.isfile/isdir', has('SIZE=5 ISREG=True ISDIR=True'));
  check('os.rename', has("RENAMED=['b.txt']"));
  check('os.remove + os.rmdir', has('GONE=True'));
  check('os.ilistdir names a regular file with its S_IFREG type',
        has("ILIST=[('b.txt', False, True)]"), line('ILIST='));
  check('os.ilistdir names a directory with its S_IFDIR type',
        has("ILISTDIR=[('d1', True)]"), line('ILISTDIR='));
  check('os.path.join + abspath', has('JOIN=/a/b/c ABS=/root/osplay/z'));
  check('os.path.normpath collapses .. and .', has('NORM=/a/c/d/e'));
  check('os.path.split + splitext',
        has("SPLIT=('/x', 'y.txt')('/x/y', '.txt')"), line('SPLIT='));
  check('os.sep / curdir / pardir are the real strings',
        has('SEP=/ CURDIR=. PARDIR=..'), line('SEP='));
  check('os.uname reports the port platform', has('UNAME=gucos'), line('UNAME='));
  check('os.urandom reads /dev/urandom', has('RANDOM=True'));
  check('os.path.realpath follows the install symlink',
        has('LINK=/opt/micropython/micropython'), line('LINK='));
  check('os.path.islink', has('ISLINK=True'));
  check('os script exited 0', has('os_status=0'));

  // --- the curated stdlib ------------------------------------------------
  check('json round-trip', has('JSON={"a": [1, 2], "b": null}'), line('JSON='));
  check('re sub + groups', has('RE=a#b# host'), line('RE='));
  check('time.gmtime uses the 1970 epoch',
        has('TIME=(2001, 9, 9, 1, 46, 40)'), line('TIME='));
  check('struct pack/unpack', has('STRUCT=(7, 99999)'));
  check('binascii base64 + hexlify', has('B64=aGk= 01ff'), line('B64='));
  check('heapq', has('HEAPQ=1'));
  check('collections.namedtuple', has('NT=P(x=1, y=2)'));
  check('array', has('ARRAY=[1, 2, 3]'));
  check('errno', has('ERRNO=2'));
  check('random.randrange', has('RANDRANGE=True'));
  check('gc.mem_free', has('GC=True'));
  check('time ticks actually advance', has('TICKS=True'));
  check('stdlib script exited 0', has('stdlib_status=0'));

  // --- -m ----------------------------------------------------------------
  check('-m runs a module as __main__', has('DASHM=__main__ argv0=runme'), line('DASHM='));
  check('-m module exited 0', has('dashm_status=0'));
  check('-m finds a package __main__.py', has('PKGMAIN=__main__'), line('PKGMAIN='));
  check('-m package exited 0', has('dashmpkg_status=0'));
  check('-m on a missing module exits 1', has('dashmmissing_status=1'));
  check('-m failure reported on fd 2', /no_such_module|module not found/.test(err),
        JSON.stringify(err.slice(0, 300)));

  // --- shebang (todos/0065 _spawnShebang) --------------------------------
  check('a #!/usr/local/bin/python script runs as its own command',
        has("SHEBANG=via-shebang argv=['/root/shb/run.py', 'zed']"), line('SHEBANG='));
  check('shebang script exited 0', has('shebang_status=0'));

  check('init reached the end', has('done'));
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));

  if (failures) console.log('---- stdout ----\n' + out + '\n---- stderr ----\n' + err + '\n----');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nMicroPython stdlib/sys.path e2e: PASS'
                             : `\nMicroPython stdlib/sys.path e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
