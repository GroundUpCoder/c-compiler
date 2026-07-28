#!/usr/bin/env node
// cpython-clang acceptance, headless IN-OS (todos/0340 item 6 + todos/0331).
//
// Everything CPYTHON.md verified host-side it verified against bare host.js —
// node's filesystem, node's argv, no kernel. The claims that actually matter to
// a gucOS user all cross into the kernel: RemoteFS resolves the stdlib, the
// spawn broker creates the child, readlink walks a gucman symlink. This file is
// where those are measured rather than assumed. Legs:
//
//   - base purity IN-OS: the minimal image ships NO python IMPLEMENTATION (it
//     does ship a `python` VERB since todos/0338 — the cmdalt dispatcher, which
//     exits 127 naming the package to install)
//   - `gucman install cpython-clang`: /opt tree + /usr/local/bin symlink
//   - the banner reports Clang and `print(1+1)` prints 2 (0331)
//   - ZERO-ENV stdlib discovery over the kernel's fs: no PYTHONHOME/PYTHONPATH,
//     sys.prefix is the package prefix
//   - SYMLINKED-ARGV0 landmark discovery in-OS: reached through a symlink in an
//     unrelated directory, sys.prefix is still the REAL prefix. host.js's
//     readlink and RemoteFS's are different code, which is why this leg exists
//   - `cpython-clang foo.py a b`: sys.argv is the script + its args, and the
//     script's exit status propagates (both a 0 and a non-0)
//   - `subprocess.run(["ls"])` really spawns through posix_spawn: no fork
//     anywhere, PATH searched by posix_spawnp, close_fds=True honoured by the
//     kernel's CLOSEFROM fd action, output captured through a real kernel pipe
//   - the in-OS import sweep, whose NUMBER is recorded in the output
//   - the extensions that needed 0340 work: zlib/gzip round trip, sqlite3 on a
//     REAL BlockFS file, C _decimal, ELOOP present in errno
//   - the pyc cache lands under /var/cache and /opt stays pristine (which is
//     what makes gucman's checksum-gated remove exact)
//   - `gucman remove cpython-clang` leaves no symlink and no /opt tree
//
// Requires the clang-simplified sibling's published overlay. Absent → SKIP
// (exit 0); the base estate must never hard-require the clang toolchain repo.
//
// Run: node tests/kernel/test_cpython_clang_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensureClangPackages, startServer } = require('./lib/gucman.js');

const CLANG_ROOT = process.env.CLANG_ROOT ||
  path.join(require('os').homedir(), 'git', 'clang-simplified');
const OVERLAY = path.join(CLANG_ROOT, 'out-image', 'overlay.json');
const PREFIX = '/opt/cpython-clang';

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The in-OS import sweep. Deliberately the SAME enumeration rule as the
// host-side probe (top-level packages with __init__.py, plus top-level .py),
// so the number this prints is comparable with the vendor README's.
const SWEEP_PY = [
  'import os, sys',
  'libdir = os.path.dirname(os.__file__)',
  "skip = {'site-packages', 'lib-dynload', '__pycache__'}",
  'names = set()',
  'for e in sorted(os.listdir(libdir)):',
  '    p = os.path.join(libdir, e)',
  '    if os.path.isdir(p):',
  '        if e in skip: continue',
  "        if os.path.exists(os.path.join(p, '__init__.py')): names.add(e)",
  "    elif e.endswith('.py'):",
  '        n = e[:-3]',
  "        if n in ('antigravity', 'this'): continue",
  '        names.add(n)',
  'ok = 0; bad = []',
  'for n in sorted(names):',
  '    try:',
  '        __import__(n); ok += 1',
  '    except BaseException as ex:',
  "        bad.append(n + ':' + type(ex).__name__)",
  "print('SWEEP total=%d ok=%d fail=%d' % (len(names), ok, len(bad)))",
  "print('SWEEPFAIL ' + ' '.join(bad))",
].join('\n');

// argv + exit status. Prints its argv, then exits with the code it was given.
const ARGV_PY = [
  'import sys',
  "print('ARGV=' + repr(sys.argv))",
  'sys.exit(int(sys.argv[1]))',
].join('\n');

// subprocess over posix_spawn. `ls` is a bare name (PATH search →
// os.posix_spawnp) and close_fds defaults True (→ the CLOSEFROM fd action).
const SUBP_PY = [
  'import subprocess, sys',
  "print('FORK_EXEC=' + repr(subprocess._fork_exec))",
  "print('USE_SPAWN=%r SEARCHES_PATH=%r' % (subprocess._USE_POSIX_SPAWN,",
  '                                         subprocess._POSIX_SPAWN_SEARCHES_PATH))',
  "r = subprocess.run(['ls', '/opt'], capture_output=True, text=True)",
  "print('SUBP rc=%d out=%s' % (r.returncode, r.stdout.strip().replace(chr(10), ',')))",
  "r2 = subprocess.run(['sh', '-c', 'exit 7'])",
  "print('SUBP2 rc=%d' % r2.returncode)",
].join('\n');

const FEAT_PY = [
  'import zlib, gzip, io, sqlite3, decimal, errno, os, sys',
  "raw = b'gucos' * 500",
  'c = zlib.compress(raw, 9)',
  "print('ZLIB %d->%d ok=%r' % (len(raw), len(c), zlib.decompress(c) == raw))",
  'b = io.BytesIO()',
  "g = gzip.GzipFile(fileobj=b, mode='wb'); g.write(raw); g.close()",
  'b.seek(0)',
  "print('GZIP ok=%r' % (gzip.GzipFile(fileobj=b).read() == raw,))",
  // A REAL file on the brokered BlockFS, not :memory: — a file-backed sqlite3
  // db is what exposed the brokered-fsync crash fixed in todos/0036.
  "cn = sqlite3.connect('/root/t.db')",
  "cn.execute('create table t(a)'); cn.execute('insert into t values (42)'); cn.commit()",
  "print('SQLITE %s %r' % (sqlite3.sqlite_version, cn.execute('select a from t').fetchone()))",
  'cn.close()',
  "print('DECIMAL c=%r %s' % (hasattr(decimal, 'HAVE_CONTEXTVAR'), decimal.Decimal(1) / decimal.Decimal(7)))",
  "print('ELOOP %d %s' % (errno.ELOOP, os.strerror(errno.ELOOP)))",
  "print('PLATFORM ' + sys.platform)",
].join('\n');

async function main() {
  if (!fs.existsSync(OVERLAY)) {
    console.log(`SKIP: no sibling overlay at ${OVERLAY} (clang-simplified not present/published)`);
    return;
  }

  const repo = ensureClangPackages(['cpython-clang'], CLANG_ROOT);
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-pyclang-');
  fs.copyFileSync(MIN, image);

  const port = await startServer(repo.dir);
  console.log(`[cpython-clang] repo :${port}`);

  const heredoc = (name, body) => [`cat > ${name} <<'PYEOF'`, body, 'PYEOF'];

  const script = [
    'echo ==purity',
    // A fresh gucOS ships no python IMPLEMENTATION — assert that rather than
    // assuming it, because it is the claim every "gucOS python" sentence has
    // to carry.
    //
    // This leg used to assert "NO python verb AT ALL" (`grep -c python` == 0).
    // That was true on this ticket's base and is false by design on main:
    // todos/0338 bakes `python` as a cmdalt KEY whose value is the suggestion
    // `cpython-clang` (jku's 2026-07-28 name-split ruling — os/cmdalt.h). So a
    // fresh image DOES carry a `python` verb; what must stay true is that
    // nothing on the image can RUN python. Pin the dispatcher's behaviour too,
    // so replacing the stale claim makes this leg stronger, not weaker.
    'echo PYVERBS=$(ls /usr/bin /usr/local/bin 2>/dev/null | grep -c python)',
    'ls /usr/bin /usr/local/bin 2>/dev/null | grep python | sort | tr "\\n" " "; echo',
    'echo PYIMPL=$(ls /usr/bin/cpython-clang /usr/local/bin/cpython-clang 2>/dev/null | wc -l)',
    'python -c "print(1+1)" >/dev/null 2>&1; echo PYRC=$?',
    'python -c "print(1+1)" 2>&1 | grep -c "gucman install cpython-clang" | sed "s/^/PYHINT=/"',
    'echo ==catalog',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman list --all | grep cpython-clang',
    'echo ==install',
    'gucman install cpython-clang; echo RC=$?',
    'readlink /usr/local/bin/cpython-clang',
    `ls ${PREFIX}/bin`,
    `ls ${PREFIX}/lib`,
    'echo ==readdir',
    // Regression guard for the bug this ticket found: the brokered __readdir
    // used to set errno=EIO at end-of-directory, so the POSIX idiom
    // `errno = 0; while ((e = readdir(d))) …; if (errno) error;` reported a
    // phantom I/O error on EVERY directory walk under a kernel. That is what
    // made the whole CPython stdlib unimportable in-OS while working fine
    // under bare host.js. Asserted in C because it is a libc contract, not a
    // Python one — every in-OS program that walks a directory depends on it.
    ...heredoc('/tmp/rd.c', [
      '#include <stdio.h>',
      '#include <dirent.h>',
      '#include <errno.h>',
      'int main(int argc, char **argv) {',
      '  DIR *d = opendir(argv[1]);',
      '  if (!d) { printf("RD OPENFAIL %d\\n", errno); return 1; }',
      '  int n = 0; struct dirent *e;',
      '  for (;;) { errno = 0; e = readdir(d); if (!e) break; n++; }',
      '  printf("RD count=%d errno_at_eof=%d\\n", n, errno);',
      '  closedir(d);',
      '  return 0;',
      '}',
    ].join('\n')),
    'cc /tmp/rd.c -o /tmp/rd; echo CCRC=$?',
    `/tmp/rd ${PREFIX}/lib/python3.13`,
    'echo ==banner',
    'cpython-clang -c "print(1+1)"',
    'cpython-clang -c "import sys; print(sys.version)"',
    'echo ==syspath',
    // ZERO env vars: nothing below sets PYTHONHOME or PYTHONPATH.
    'echo "HOME_ENV=[$PYTHONHOME] PATH_ENV=[$PYTHONPATH]"',
    'cpython-clang -c "import sys,os; print(\'PREFIX=\'+sys.prefix); print(\'OSFILE=\'+os.__file__)"',
    'echo ==symlinkargv0',
    // The landmark walk THROUGH a symlink, from an unrelated directory: the
    // real prefix must still be found. Both the launcher-script path (what a
    // user types) and a bare symlink straight at the .wasm.
    'mkdir -p /tmp/elsewhere',
    `ln -s ${PREFIX}/bin/cpython-clang.wasm /tmp/elsewhere/py`,
    'cd /tmp && PYTHONPYCACHEPREFIX=/var/cache/cpython-clang ./elsewhere/py -c "import sys; print(\'SYMPREFIX=\'+sys.prefix)"',
    'cd /root',
    'echo ==argv',
    ...heredoc('/root/a.py', ARGV_PY),
    'cpython-clang /root/a.py 0 beta gamma; echo ARC=$?',
    'cpython-clang /root/a.py 3; echo ARC2=$?',
    'echo ==subprocess',
    ...heredoc('/root/s.py', SUBP_PY),
    'cpython-clang /root/s.py 2>&1; echo SRC=$?',
    'echo ==features',
    ...heredoc('/root/f.py', FEAT_PY),
    'cpython-clang /root/f.py; echo FRC=$?',
    'echo ==sweep',
    ...heredoc('/root/w.py', SWEEP_PY),
    'cpython-clang /root/w.py; echo WRC=$?',
    'echo ==pyc',
    // The launcher's PYTHONPYCACHEPREFIX contract: caches under /var, /opt
    // pristine, which is what keeps gucman's checksum-gated remove exact.
    'find /var/cache/cpython-clang -name "*.pyc" | head -1',
    `find ${PREFIX} -name "__pycache__" | head -1; echo OPTCLEAN=$?`,
    `find ${PREFIX} -name "*.pyc" | wc -l`,
    'echo ==remove',
    'gucman remove cpython-clang; echo RRC=$?',
    'test ! -e /usr/local/bin/cpython-clang && echo BIN-GONE',
    `test ! -e ${PREFIX} && echo OPT-GONE`,
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 900000 });
  const out = String(r.stdout || '');

  const purity = section(out, 'purity');
  // The claim that has to hold: no python IMPLEMENTATION. The `python` verb
  // itself is the 0338 cmdalt dispatcher and is expected — see the probe above.
  check('a fresh gucOS ships NO python implementation',
    /^PYIMPL=0$/m.test(purity), purity);
  check('the only python verb on a fresh image is the cmdalt dispatcher',
    /^PYVERBS=1$/m.test(purity), purity);
  check('that verb cannot run code — it exits 127',
    /^PYRC=127$/m.test(purity), purity);
  check('...and it names the package to install',
    /^PYHINT=[1-9]/m.test(purity), purity);

  const cat = section(out, 'catalog');
  check('catalog lists cpython-clang', cat.includes('cpython-clang'), cat);

  const inst = section(out, 'install');
  check('cpython-clang installs (exit 0)', inst.includes('RC=0'), inst);
  check(`/usr/local/bin/cpython-clang -> ${PREFIX}/bin/cpython-clang`,
    inst.includes(`${PREFIX}/bin/cpython-clang`), inst);
  check('the package tree carries both the launcher and the wasm',
    inst.includes('cpython-clang.wasm'), inst);
  check('the stdlib tree landed at lib/python3.13', inst.includes('python3.13'), inst);

  const rd = section(out, 'readdir');
  check('the readdir probe built in-OS', rd.includes('CCRC=0'), rd);
  const rdm = /RD count=(\d+) errno_at_eof=(\d+)/.exec(rd);
  check('readdir enumerates the stdlib dir', rdm && Number(rdm[1]) > 100, rd);
  check('readdir leaves errno UNTOUCHED at end-of-directory (POSIX)',
    rdm && Number(rdm[2]) === 0, rd);

  const ban = section(out, 'banner');
  check('print(1+1) is 2 in-OS', /^2$/m.test(ban), ban);
  check('the banner reports 3.13.5', ban.includes('3.13.5'), ban);
  check('the banner reports Clang (0331)', /\[Clang /.test(ban), ban);
  check('the build date/time is pinned (byte-reproducible payload)',
    ban.includes('xx/xx/xx') && ban.includes('xx:xx:xx'), ban);

  const sp = section(out, 'syspath');
  check('no PYTHONHOME / PYTHONPATH is set anywhere', sp.includes('HOME_ENV=[] PATH_ENV=[]'), sp);
  check(`zero-env landmark discovery finds ${PREFIX}`, sp.includes(`PREFIX=${PREFIX}`), sp);
  check('os.py loads out of the package stdlib tree',
    sp.includes(`OSFILE=${PREFIX}/lib/python3.13/os.py`), sp);

  const sym = section(out, 'symlinkargv0');
  check('symlinked argv0 still resolves the REAL prefix in-OS',
    sym.includes(`SYMPREFIX=${PREFIX}`), sym);

  const av = section(out, 'argv');
  check('script mode passes argv through',
    av.includes("ARGV=['/root/a.py', '0', 'beta', 'gamma']"), av);
  check('a script exit status of 0 propagates', av.includes('ARC=0'), av);
  check('a NON-zero script exit status propagates', av.includes('ARC2=3'), av);

  const sub = section(out, 'subprocess');
  check('_posixsubprocess is absent, as designed (no fork on gucOS)',
    sub.includes('FORK_EXEC=None'), sub);
  check('subprocess is forced onto the posix_spawn path',
    sub.includes('USE_SPAWN=True SEARCHES_PATH=True'), sub);
  check('subprocess.run([bare name]) really spawns and captures output',
    /SUBP rc=0 out=.*cpython-clang/.test(sub), sub);
  check('a child exit status comes back through waitpid', sub.includes('SUBP2 rc=7'), sub);
  check('the subprocess script exits clean', sub.includes('SRC=0'), sub);

  const feat = section(out, 'features');
  check('zlib round-trips in-OS', /ZLIB \d+->\d+ ok=True/.test(feat), feat);
  check('gzip round-trips in-OS (zlib is what revived it)', feat.includes('GZIP ok=True'), feat);
  check('sqlite3 works on a REAL BlockFS file',
    /SQLITE 3\.\d+\.\d+ \(42,\)/.test(feat), feat);
  check('_decimal is the C implementation', feat.includes('DECIMAL c=True'), feat);
  check('ELOOP is in errno with its strerror (the pathlib/zipfile unblock)',
    feat.includes('ELOOP 40 Too many levels of symbolic links'), feat);
  check('sys.platform is gucos', feat.includes('PLATFORM gucos'), feat);
  check('the feature script exits clean', feat.includes('FRC=0'), feat);

  const sw = section(out, 'sweep');
  const m = /SWEEP total=(\d+) ok=(\d+) fail=(\d+)/.exec(sw);
  check('the in-OS import sweep ran', !!m, sw);
  if (m) {
    const [, total, ok, fail] = m.map(Number);
    console.log(`  ---- in-OS import sweep: ${ok}/${total} import, ${fail} fail`);
    console.log('  ---- ' + (/SWEEPFAIL (.*)/.exec(sw) || [, '(none)'])[1]);
    // The acceptance floor is CPYTHON.md's >=154; the measured figure is
    // printed above so a regression shows as a NUMBER, not just a verdict.
    check(`in-OS import sweep >= 154 (got ${ok} of ${total})`, ok >= 154, sw);
    // Every failure must be a NAMED §3.3 cause. A new one means the casualty
    // list has gone stale, which is the thing that table exists to prevent.
    const allowed = /^(asyncio|bz2|ctypes|curses|ftplib|imaplib|lzma|mailbox|multiprocessing|poplib|smtplib|socket|socketserver|ssl):/;
    const bad = ((/SWEEPFAIL (.*)/.exec(sw) || [, ''])[1] || '')
      .split(/\s+/).filter(Boolean).filter((x) => !allowed.test(x));
    check('every import failure is a named CPYTHON.md §3.3 casualty',
      bad.length === 0, bad.join(' '));
  }

  const pyc = section(out, 'pyc');
  check('the pyc cache lands under /var/cache/cpython-clang',
    /\/var\/cache\/cpython-clang\/.*\.pyc/.test(pyc), pyc);
  check('/opt stays pristine — no __pycache__, no .pyc',
    !new RegExp(PREFIX + '/.*__pycache__').test(pyc) && /^0$/m.test(pyc), pyc);

  const rm = section(out, 'remove');
  check('remove exits 0', rm.includes('RRC=0'), rm);
  check('bin symlink gone after remove', rm.includes('BIN-GONE'), rm);
  check('the /opt tree is gone after remove', rm.includes('OPT-GONE'), rm);

  console.log(failures ? `FAILURES: ${failures}` : 'PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
