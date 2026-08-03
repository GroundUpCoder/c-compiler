#!/usr/bin/env node
// todos/0338 acceptance, headless: the command-alternatives dispatcher.
//
// /usr/bin/cmdalt is a MULTICALL binary — under its own name it is the
// admin CLI, under any other name it dispatches that name to whichever
// implementation the cmdalt store picks (os/cmdalt.c + os/cmdalt.h over the
// cfgstore.h three-layer overlay). `python` is its first user, NOT the
// mechanism, so session A drives the whole mechanism with NON-python names
// and base-image binaries only, on a --packages=none boot:
//
//   1. dispatch + argv: every argument forwarded verbatim, flags included
//   2. exit status: a nonzero exit propagates, a signalled child is 128+sig
//   3. no implementation: 127 + a message naming the suggestion (this is
//      also acceptance bullet 1 — a fresh image resolves `python` to the
//      baked suggestion cpython-clang, which is NOT installed, on purpose)
//   4. shebang: `#!` on a dispatch link runs the implementation with the
//      script as argv[1] and the caller's args after it
//   5. self-dispatch: `cmdalt set foo foo` is refused, no fork bomb
//   6. layers: /etc beats the baked suggestion, a user pick beats /etc,
//      `cmdalt reset` falls back to /etc
//   7. GENERICITY: a second dispatched name is one link + one store line
//      and no C change — two names dispatch to two different programs at
//      the same time
//   8. the PATH-shadow diagnostics: `cmdalt which` names the shadowing
//      path, `cmdalt list` marks the key, and `cmdalt set` warns AT THE
//      MOMENT of the ineffective action (CHECK-0338: which/list only help
//      someone who already suspects the bug)
//
// Session B is the package half on the same minimal image, against a real
// mkpkg repo: `gucman install micropython` APPENDS its `commands` claim to
// /etc/cmdalt and plants NO /usr/local/bin/python (the alias that used to
// shadow the dispatcher is gone), `python` then really runs MicroPython
// with sys.argv intact and its status propagated, the picker-equivalent
// switch works through the same store, and `gucman remove` deletes exactly
// that claim line. It closes with the todos/0355 leg: a HAND-BUILT payload
// carrying a `bin` claim on the dispatched name `python` (a payload mkpkg
// refuses to build) makes gucman's install-time bin-plant guard fire —
// refused loudly, nothing planted, no DB record.
//
// Run: node tests/kernel/test_cmdalt_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* Host-side negative leg: a package definition may not claim a DISPATCHED
 * command name as a `bin`. The fat bake's claim() throw only covers FOLDED
 * packages — a `requires`-gated definition (every *-clang variant) is never
 * folded, so without this gate it would build clean and then plant
 * /usr/local/bin/<name> at install, shadowing the dispatcher forever. The
 * runtime twin lives in gucman's bin-plant loop; it is unreachable through
 * the shipped pipeline (mkpkg refuses to build such a payload, and gucman
 * verifies the payload sha against the mkpkg index) — which is why session
 * B's ==shadowinstall leg builds the payload BY HAND (addShadowPackage
 * below, todos/0355) to make that guard fire too. */
function checkShadowingBinRefused(check) {
  const cp = require('child_process');
  const pathm = require('path');
  const osm = require('os');
  const defDir = fs.mkdtempSync(pathm.join(osm.tmpdir(), 'cmdalt-defs-'));
  const outDir = fs.mkdtempSync(pathm.join(osm.tmpdir(), 'cmdalt-out-'));
  try {
    fs.writeFileSync(pathm.join(defDir, 'test-shadow.json'), JSON.stringify({
      name: 'test-shadow', version: '1.0', summary: 'negative fixture',
      files: { tool: { content: '#!/bin/sh\necho hi\n', mode: 0o755 } },
      bin: { python: 'tool' },
    }, null, 2) + '\n');
    const r = cp.spawnSync(process.execPath,
      [pathm.join(ROOT, 'tools', 'mkpkg.js'), '--quiet', `--out=${outDir}`,
       `--packages-dir=${defDir}`, 'test-shadow'],
      { encoding: 'utf-8', timeout: 180000 });
    check('mkpkg refuses a bin that shadows a dispatched name (exit 1)',
          r.status === 1, `status=${r.status}`);
    check('...naming the dispatcher and pointing at `commands`',
          /would shadow the base image's command dispatcher at \/usr\/bin\/python/.test(String(r.stderr)) &&
          /"commands"/.test(String(r.stderr)), String(r.stderr).slice(0, 500));
  } finally {
    fs.rmSync(defDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/* The install-time twin's firing fixture (todos/0355). gucman's bin-plant
 * loop refuses to plant /usr/local/bin/<cmd> over a name the base image
 * DISPATCHES (`gm_same_file(disp, GM_DISPATCH)` in os/gucman/gucman.c) — the
 * runtime backstop for a payload that arrived OUTSIDE the shipped pipeline.
 * mkpkg will never build such a payload (that is the first tier, above), so
 * this builds one by hand: the same ustar+gzip encoding mkpkg emits — one
 * top-level control.json plus opt/<name>/** — carrying a `bin` claim on a
 * dispatched name, dropped into the test repo's pool with a matching
 * index.json entry so gucman's sha256 check accepts it all the way to the
 * bin-plant loop. Session B's ==shadowinstall leg asserts the refusal. */
function tarMember(name, data, mode, typeflag) {
  const b = Buffer.alloc(512);
  const octal = (off, len, val) => {
    b.write(val.toString(8).padStart(len - 1, '0'), off, 'ascii');
    b[off + len - 1] = 0;
  };
  if (Buffer.byteLength(name) > 100) throw new Error('tar member name too long: ' + name);
  b.write(name, 0, 'utf8');
  octal(100, 8, mode);            // mode
  octal(108, 8, 0);               // uid
  octal(116, 8, 0);               // gid
  octal(124, 12, data ? data.length : 0);
  octal(136, 12, 0);              // mtime
  b.fill(0x20, 148, 156);         // chksum spaces while summing
  b.write(typeflag, 156, 'ascii');
  b.write('ustar', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  b[154] = 0;
  b[155] = 0x20;
  if (!data) return b;
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([b, data, pad ? Buffer.alloc(pad) : Buffer.alloc(0)]);
}

function addShadowPackage(repo, check) {
  const zlib = require('zlib');
  const crypto = require('crypto');
  const pathm = require('path');
  /* PRESENCE controls: the fixture's premise is that the base image
   * dispatches `python` (/usr/bin/python -> /usr/bin/cmdalt in
   * os/image.json — the same derivation mkpkg's build-time gate uses). If
   * either control fails, the guard under test can no longer fire for this
   * name and the whole leg would decay into a trivially-different refusal:
   * re-pin the fixture to a name the derivation still yields. */
  const manifest = JSON.parse(fs.readFileSync(pathm.join(ROOT, 'os', 'image.json'), 'utf-8'));
  const dispatched = Object.keys(manifest.system.files || {})
    .filter((p) => p.startsWith('/usr/bin/') &&
                   (manifest.system.files[p] || {}).link === '/usr/bin/cmdalt')
    .map((p) => p.slice('/usr/bin/'.length));
  check('CONTROL: the base image still dispatches at least one command name',
        dispatched.length > 0,
        're-pin todos/0355 fixture: os/image.json has no /usr/bin/* -> /usr/bin/cmdalt link left');
  check('CONTROL: `python` is still a dispatched name (the shadow fixture claims it)',
        dispatched.includes('python'),
        `re-pin todos/0355 fixture to one of: ${dispatched.join(', ') || '(none)'}`);
  const control = JSON.stringify({
    name: 'shadowpkg', version: '1.0',
    summary: 'todos/0355 fixture: a bin claim on a dispatched name',
    bin: { python: 'tool' },
  }, null, 2) + '\n';
  const tool = Buffer.from('#!/bin/sh\necho SHADOW-TOOL-RAN\n');
  const tar = Buffer.concat([
    tarMember('control.json', Buffer.from(control), 0o644, '0'),
    tarMember('opt/', null, 0o755, '5'),
    tarMember('opt/shadowpkg/', null, 0o755, '5'),
    tarMember('opt/shadowpkg/tool', tool, 0o755, '0'),
    Buffer.alloc(1024),           // end-of-archive
  ]);
  const gz = zlib.gzipSync(tar, { level: 9 });
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const file = `shadowpkg_1.0_${sha.slice(0, 16)}.pkg.tar.gz`;
  fs.mkdirSync(pathm.join(repo.dir, 'pool'), { recursive: true });
  fs.writeFileSync(pathm.join(repo.dir, 'pool', file), gz);
  const idxPath = pathm.join(repo.dir, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
  idx.packages.shadowpkg = {
    version: '1.0',
    summary: 'todos/0355 fixture: a bin claim on a dispatched name',
    minBase: idx.baseVersion, deps: [],
    payload: { format: 'tar+gzip', url: 'pool/' + file, size: gz.length, sha256: sha },
  };
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n');
}

async function main() {
  checkShadowingBinRefused(check);
  const repo = ensurePackages(['micropython']);
  addShadowPackage(repo, check);
  const idx = repo.index;
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-cmdalt-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const BOOT = { image, args: ['--packages=none'], timeout: 420000,
                 maxBuffer: 64 * 1024 * 1024 };
  const boot = (script) => driveBoot(script, BOOT).stdout;

  /* ================= session A: the mechanism, no python ================ */

  const outA = boot([
    // ---- acceptance bullet 1: a fresh image has no python implementation.
    // The baked suggestion names cpython-clang, which is not installed, so
    // the dispatch link exits 127 with the install hint. That is the
    // SPECIFIED behaviour of "default python means once installed, never
    // baked" — not a bug to design around.
    'echo ==nopython',
    'python /root/whatever.py 2>&1; echo RC=$?',
    'echo ==cut',
    'echo ==baked',
    'grep -v "^#" /usr/share/cmdalt',
    'echo ==cut',

    // ---- the dispatch link for a NON-python name. /usr/bin is sealed, so
    // the test's links live in /usr/local/bin — the same thing a manifest
    // `link` entry produces, in the writable tier. NO C change anywhere.
    'ln -s /usr/bin/cmdalt /usr/local/bin/foo',
    'ln -s /usr/bin/cmdalt /usr/local/bin/bar',

    // ---- leg 1: dispatch + argv forwarded VERBATIM (flags included) ----
    'cmdalt set foo /bin/echo',
    'echo ==argv',
    'foo a b',
    'foo --help',
    'foo -c --version -',
    'echo ==cut',

    // ---- leg 7: a SECOND dispatched name, no code change ----
    'cmdalt set bar /bin/pwd',
    'echo ==two',
    'cd /root; bar',
    'foo still-echo',
    'echo ==cut',

    // ---- leg 2: exit status ----
    'cmdalt set foo /bin/sh',
    'echo ==status',
    'foo -c "exit 3"; echo RC=$?',
    "foo -c 'kill -TERM $$'; echo SIG=$?",   // single-quoted: $$ must expand in the CHILD sh, not this one
    'echo ==cut',

    // ---- leg 3: an unresolvable pick is an ERROR, never a silent fallback
    'echo ==missing',
    'cmdalt set foo nosuchprog',
    'foo x 2>&1; echo RC=$?',
    'echo ==cut',
    // ...and with another INSTALLED candidate present, the error names it
    "printf 'foo\\t/bin/echo\\n' > /etc/cmdalt",
    'echo ==missing2',
    'foo x 2>&1; echo RC=$?',
    'echo ==cut',

    // ---- leg 6: layer precedence + reset ----
    'echo ==layers',
    'cmdalt reset foo',        // drop the user pick -> /etc's /bin/echo
    'foo etc-layer',
    'cmdalt set foo /bin/pwd', // user pick beats /etc
    'cd /tmp; foo',
    'cmdalt reset foo',        // ...and back to /etc
    'cd /root; foo etc-again',
    'echo ==cut',
    'rm -f /etc/cmdalt',
    'cmdalt set foo /bin/echo',

    // ---- leg 4: a #! script on a dispatch link ----
    "printf '#!/usr/local/bin/foo\\n' > /root/script.sh",
    'chmod 755 /root/script.sh',
    'echo ==shebang',
    '/root/script.sh tail-arg',
    'echo ==cut',

    // ---- leg 5: self-dispatch is refused ----
    'echo ==selfdispatch',
    'cmdalt set foo foo',
    'foo boom 2>&1; echo RC=$?',
    'echo ==cut',
    'cmdalt set foo /bin/echo',

    // ---- cmdalt list ----
    'echo ==list',
    'cmdalt list',
    'echo ==cut',
    'echo ==which',
    'cmdalt which foo',
    'echo ==cut',

    // ---- leg 8: the PATH-shadow diagnostics. /usr/local/bin precedes
    // /bin, so a link planted there for a DISPATCHED name wins silently.
    // Planted LAST so it cannot perturb the legs above.
    "printf '#!/bin/sh\\necho SHADOW-RAN\\n' > /usr/local/bin/python",
    'chmod 755 /usr/local/bin/python',
    'echo ==shadowwhich',
    'cmdalt which python 2>&1; echo RC=$?',
    'echo ==cut',
    'echo ==shadowset',
    'cmdalt set python /bin/echo 2>&1',
    'echo ==cut',
    'echo ==shadowlist',
    'cmdalt list 2>&1',
    'echo ==cut',
    'echo ==shadowruns',
    'python anything',          // the shadow really does win — that IS the bug
    'echo ==cut',
    'rm -f /usr/local/bin/python /root/.config/cmdalt',
  ]);

  const A = (n) => section(outA, n);

  check('a fresh image exits 127 for python', /RC=127/.test(A('nopython')),
        JSON.stringify(A('nopython')));
  check('...and says no python implementation is installed',
        /python: no python implementation is installed/.test(outA),
        JSON.stringify(A('nopython')));
  check('...naming the baked suggestion in a gucman install hint',
        /install one:\s+gucman install cpython-clang/.test(outA), JSON.stringify(A('nopython')));
  check('the baked store carries exactly the python suggestion',
        A('baked').trim() === 'python\tcpython-clang', JSON.stringify(A('baked')));

  check('dispatch forwards plain args', /^a b$/m.test(A('argv')), JSON.stringify(A('argv')));
  check('dispatch forwards flag-shaped args verbatim',
        /^--help$/m.test(A('argv')) && /^-c --version -$/m.test(A('argv')),
        JSON.stringify(A('argv')));

  check('a SECOND dispatched name needs no C change (bar -> pwd)',
        /^\/root$/m.test(A('two')), JSON.stringify(A('two')));
  check('...and both names dispatch independently at the same time',
        /^still-echo$/m.test(A('two')), JSON.stringify(A('two')));

  check('a nonzero child exit propagates', /RC=3/.test(A('status')), JSON.stringify(A('status')));
  check('a signalled child reports 128+sig', /SIG=143/.test(A('status')), JSON.stringify(A('status')));

  check('an unresolvable pick exits 127', /RC=127/.test(A('missing')), JSON.stringify(A('missing')));
  check('...with the install hint for the picked implementation',
        /gucman install nosuchprog/.test(outA), JSON.stringify(A('missing')));
  check('an unresolvable pick with other candidates names them',
        /available: \/bin\/echo/.test(outA) && /switch with:\s+cmdalt set foo \/bin\/echo/.test(outA),
        JSON.stringify(A('missing2')));
  check('...and still exits 127 rather than silently running the other one',
        /RC=127/.test(A('missing2')) && !/^x$/m.test(A('missing2')), JSON.stringify(A('missing2')));

  check('an /etc claim beats the baked layer', /^etc-layer$/m.test(A('layers')),
        JSON.stringify(A('layers')));
  check('a user pick beats the /etc claim', /^\/tmp$/m.test(A('layers')),
        JSON.stringify(A('layers')));
  check('cmdalt reset falls back to the /etc claim', /^etc-again$/m.test(A('layers')),
        JSON.stringify(A('layers')));

  check('a #! script on a dispatch link runs the implementation',
        /^\/root\/script\.sh tail-arg$/m.test(A('shebang')), JSON.stringify(A('shebang')));

  check('self-dispatch is refused, not forked', /RC=127/.test(A('selfdispatch')),
        JSON.stringify(A('selfdispatch')));
  check('...loudly, naming the dispatcher',
        /is the command dispatcher itself/.test(outA), JSON.stringify(A('selfdispatch')));

  check('cmdalt list shows every key and its effective value',
        /^foo\s+-> \/bin\/echo/m.test(A('list')) && /^python\s+-> cpython-clang/m.test(A('list')),
        JSON.stringify(A('list')));
  check('cmdalt which prints the resolved program',
        A('which').trim() === '/bin/echo', JSON.stringify(A('which')));

  check('cmdalt which names a shadowing /usr/local/bin path',
        /\/usr\/local\/bin\/python shadows this setting/.test(outA),
        JSON.stringify(A('shadowwhich')));
  check('...and reports the shadow as what python REALLY runs',
        /^\/usr\/local\/bin\/python$/m.test(A('shadowwhich')), JSON.stringify(A('shadowwhich')));
  check('cmdalt SET warns at the moment of the ineffective switch',
        /warning: \/usr\/local\/bin\/python shadows this setting/.test(A('shadowset')),
        JSON.stringify(A('shadowset')));
  check('cmdalt list marks the shadowed key',
        /warning: \/usr\/local\/bin\/python shadows/.test(A('shadowlist')),
        JSON.stringify(A('shadowlist')));
  check('the shadow really does win (the bug the diagnostics point at)',
        /SHADOW-RAN/.test(A('shadowruns')), JSON.stringify(A('shadowruns')));

  /* ============ session B: the package claim + real python ============== */

  const port = await startServer(repo.dir);
  console.log(`[cmdalt] repo :${port} (micropython ${idx.packages.micropython.version})`);

  const outB = boot([
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'echo ==before',
    'python -c "print(1)" 2>&1; echo RC=$?',
    'echo ==cut',
    'gucman install micropython >/dev/null 2>&1; echo INSTALL=$?',
    'echo ==claim',
    'cat /etc/cmdalt',
    'echo ==cut',
    'echo ==noalias',
    'test -e /usr/local/bin/micropython && echo HAS-IMPL-LINK',
    'test -e /usr/local/bin/python && echo HAS-PYTHON-LINK || echo NO-PYTHON-LINK',
    'echo ==cut',
    'echo ==which',
    'cmdalt which python',
    'echo ==cut',
    'echo ==run',
    'python -c "print(1+1)"',
    "printf 'import sys\\nprint(\"ARGV=\" + repr(sys.argv))\\nsys.exit(7)\\n' > /root/t.py",
    'python /root/t.py alpha beta; echo RC=$?',
    'echo ==cut',
    "printf '#!/bin/python\\nimport sys\\nprint(\"SHEBANG=\" + repr(sys.argv))\\n' > /root/s.py",
    'chmod 755 /root/s.py',
    'echo ==shebang',
    '/root/s.py one two',
    'echo ==cut',
    // switching the default through the SAME store the picker writes
    'echo ==switch',
    'cmdalt set python /bin/echo 2>&1',
    'python switched',
    'cmdalt reset python',
    'python -c "print(\'back\')"',
    'echo ==cut',
    'gucman remove micropython >/dev/null 2>&1; echo REMOVE=$?',
    'echo ==after',
    'cat /etc/cmdalt 2>/dev/null; echo STORE=$?',
    'python -c "print(1)" 2>&1; echo RC=$?',
    'echo ==cut',

    // ---- todos/0355: the INSTALL-TIME shadow guard really fires ----
    // The repo carries a hand-built payload (addShadowPackage) whose
    // control.json claims bin `python` — a payload mkpkg refuses to build,
    // so the only thing standing between it and a permanent PATH shadow is
    // gucman's bin-plant guard. Last, so a regression here (an install that
    // wrongly SUCCEEDS) cannot perturb the legs above.
    'echo ==shadowctl',
    'readlink /usr/bin/python',
    'echo ==cut',
    'echo ==shadowinstall',
    'gucman install shadowpkg 2>&1; echo RC=$?',
    'echo ==cut',
    'echo ==shadowresidue',
    'test -e /usr/local/bin/python && echo PYTHON-LINK-PLANTED || echo NO-PYTHON-LINK',
    'test -e /var/lib/gucman/shadowpkg.json && echo DB-RECORD || echo NO-DB-RECORD',
    'test -e /opt/shadowpkg && echo OPT-RESIDUE || echo NO-OPT-RESIDUE',
    'echo ==cut',
  ]);

  const B = (n) => section(outB, n);

  check('before install, python exits 127', /RC=127/.test(B('before')), JSON.stringify(B('before')));
  check('gucman install micropython succeeded', /INSTALL=0/.test(outB),
        outB.slice(0, 400));
  check('install APPENDS the commands claim to /etc/cmdalt',
        /^python\s+\/usr\/local\/bin\/micropython$/m.test(B('claim')), JSON.stringify(B('claim')));
  check('install still plants the IMPLEMENTATION link',
        /HAS-IMPL-LINK/.test(B('noalias')), JSON.stringify(B('noalias')));
  check('install plants NO /usr/local/bin/python (the shadow is gone for good)',
        /NO-PYTHON-LINK/.test(B('noalias')), JSON.stringify(B('noalias')));
  check('cmdalt which reports the claimed implementation, no shadow',
        B('which').trim() === '/usr/local/bin/micropython', JSON.stringify(B('which')));

  check('python -c runs MicroPython through the dispatcher',
        /^2$/m.test(B('run')), JSON.stringify(B('run')));
  check('python FILE runs it with sys.argv intact',
        /ARGV=\['\/root\/t\.py', 'alpha', 'beta'\]/.test(B('run')), JSON.stringify(B('run')));
  check('...and the exit status propagates through the dispatcher',
        /RC=7/.test(B('run')), JSON.stringify(B('run')));
  check('a #!/bin/python script runs',
        /SHEBANG=\['\/root\/s\.py', 'one', 'two'\]/.test(B('shebang')), JSON.stringify(B('shebang')));

  check('cmdalt set switches the default', /^switched$/m.test(B('switch')),
        JSON.stringify(B('switch')));
  check('cmdalt reset reverts to the package claim', /^back$/m.test(B('switch')),
        JSON.stringify(B('switch')));

  check('gucman remove succeeded', /REMOVE=0/.test(outB), outB.slice(-600));
  check('remove deletes the claim line (last line -> no file)',
        !/^python\s+\/usr\/local\/bin\/micropython$/m.test(B('after')), JSON.stringify(B('after')));
  check('...and python is back to the 127 install hint',
        /RC=127/.test(B('after')), JSON.stringify(B('after')));

  /* todos/0355: the install-time guard's FIRING path. The message regex is
   * guard-branch-specific: gucman says "would shadow the command dispatcher
   * at", mkpkg's build-time tier says "would shadow the base image's command
   * dispatcher at" — so a refusal from anywhere earlier in the install
   * (index, sha256, tar validation) cannot satisfy it. */
  check('CONTROL: in-OS, /usr/bin/python really is the dispatcher link',
        B('shadowctl').trim() === '/usr/bin/cmdalt',
        `re-pin todos/0355 fixture: readlink /usr/bin/python said ${JSON.stringify(B('shadowctl'))}`);
  check('the hand-built shadow payload is REFUSED at install (exit 1)',
        /^RC=1$/m.test(B('shadowinstall')), JSON.stringify(B('shadowinstall')));
  check('...by the bin-plant guard, naming package, bin and dispatcher',
        /gucman: 'shadowpkg' bin python would shadow the command dispatcher at \/usr\/bin\/python/.test(B('shadowinstall')),
        JSON.stringify(B('shadowinstall')));
  check('...pointing at the `commands` claim as the right declaration',
        /declare a `commands` claim instead/.test(B('shadowinstall')),
        JSON.stringify(B('shadowinstall')));
  check('the refused install plants NO /usr/local/bin/python',
        /NO-PYTHON-LINK/.test(B('shadowresidue')), JSON.stringify(B('shadowresidue')));
  check('...and writes NO install-DB record',
        /NO-DB-RECORD/.test(B('shadowresidue')), JSON.stringify(B('shadowresidue')));
  check('...and leaves NO /opt/shadowpkg residue',
        /NO-OPT-RESIDUE/.test(B('shadowresidue')), JSON.stringify(B('shadowresidue')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nFAILED (${failures})` : '\nAll cmdalt e2e checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
