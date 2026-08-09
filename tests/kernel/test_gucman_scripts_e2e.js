#!/usr/bin/env node
// gucman postinst/prerm script hatch (ticket #74) — the narrow escape valve
// Slice 1 reserved: optional #!/bin/sh scripts, shipped as ordinary payload
// members and named by payload-relative control.json paths, run
// synchronously at the transaction edges for the rare package whose setup
// the declarative surface cannot express.
//
// The semantics under test (the #74 design decisions):
//   - postinst runs AFTER the whole declarative plant succeeds and BEFORE
//     the DB record is written: a failing postinst rolls the install back
//     COMPLETELY (unwound plant, /opt tree gone, no DB record), so the DB
//     stays binary — record exists ⟺ package correctly installed.
//   - a script's side effects OUTSIDE the recorded plant are its own
//     responsibility: the rollback does not (cannot) revert them, and this
//     test PINS that honestly rather than implying otherwise.
//   - prerm runs FIRST in remove, while the package is fully intact; a
//     failing prerm warns loudly and the removal CONTINUES (an unremovable
//     package is worse than a dirty one).
//   - scripts get a fixed contract: argv[1] = "install"/"remove", cwd =
//     /opt/<name>, env = PATH:/usr/local/bin:/bin + HOME=/root.
//   - a wall-clock bound (default 120 s, GUCMAN_SCRIPT_TIMEOUT_MS override —
//     the test seam) SIGKILLs a hung script and fails the transaction.
//   - install-time validation: the named member must exist in the staged
//     tree and pass the ow_is_runnable peek (#! or wasm magic) BEFORE the
//     stage->/opt rename — a payload that "arrived another way" with a
//     non-runnable script is refused with nothing published (the hand-rolled
//     repo below is exactly such a payload; mkpkg refuses to BUILD one).
//   - build/fold gates: mkpkg cross-checks the script against the assembled
//     payload and its runnable magic; foldPackages REFUSES a script-carrying
//     def (a baked package never runs an install transaction, so folding one
//     would ship it silently unconfigured).
//
// Run: node tests/kernel/test_gucman_scripts_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, startServer, PKG_ROOT, POOL } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- transient package definitions (the test-bad-desktop pattern:
 * mkpkg has no packages-dir seam, so defs are written into packages/ for
 * exactly the duration of the build and removed in finally). All four are
 * VALID defs a sibling test's all-defs mkpkg run could build harmlessly. */
const DEFS = {
  'hatch-ok': {
    name: 'hatch-ok', version: '1.0', summary: 'postinst/prerm success fixture',
    files: {
      'hello.txt': { content: 'hi\n' },
      'postinst': { content: '#!/bin/sh\necho "postinst:$1:$(pwd)" >> /root/hatch.log\n', mode: 0o755 },
      'prerm': { content: '#!/bin/sh\necho "prerm:$1:$(pwd)" >> /root/hatch.log\n', mode: 0o755 },
    },
    postinst: 'postinst', prerm: 'prerm',
  },
  'hatch-fail': {
    name: 'hatch-fail', version: '1.0', summary: 'failing-postinst fixture',
    files: {
      'tool': { content: '#!/bin/sh\necho tool\n', mode: 0o755 },
      'postinst': { content: '#!/bin/sh\ntouch /root/hatch-fail-ran\nexit 7\n', mode: 0o755 },
    },
    bin: { hatchtool: 'tool' },
    postinst: 'postinst',
  },
  'hatch-hang': {
    name: 'hatch-hang', version: '1.0', summary: 'hanging-postinst fixture',
    files: {
      'postinst': { content: '#!/bin/sh\nsleep 500\n', mode: 0o755 },
    },
    postinst: 'postinst',
  },
  'hatch-prermfail': {
    name: 'hatch-prermfail', version: '1.0', summary: 'failing-prerm fixture',
    files: {
      'prerm': { content: '#!/bin/sh\nexit 3\n', mode: 0o755 },
    },
    prerm: 'prerm',
  },
};

function writeDefs(defs) {
  const paths = [];
  for (const name of Object.keys(defs)) {
    const p = path.join(ROOT, 'packages', `${name}.json`);
    fs.writeFileSync(p, JSON.stringify(defs[name], null, 2) + '\n');
    paths.push(p);
  }
  return paths;
}

function mkpkgRun(outDir, names, expectFail) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = cp.spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet',
     `--out=${outDir}`, `--pool=${POOL}`, ...names],
    { encoding: 'utf-8', timeout: 600000 });
  if (!expectFail && r.status !== 0) {
    throw new Error(`mkpkg ${names.join(' ')} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return r;
}

/* ---- a minimal deterministic ustar writer (the mkpkg tarHeader shape,
 * short names only) for the payload gucman must refuse at RUNTIME: mkpkg
 * will not build a non-runnable script, so the refusal leg needs a payload
 * that arrived outside the official pipeline. */
function tarHeader(name, size, mode, typeflag) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 'utf8');
  const octal = (off, len, val) => {
    b.write(val.toString(8).padStart(len - 1, '0'), off, 'ascii');
    b[off + len - 1] = 0;
  };
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  b.fill(0x20, 148, 156);
  b.write(typeflag, 156, 'ascii');
  b.write('ustar', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  b[154] = 0;
  b[155] = 0x20;
  return b;
}
function tarball(members) {
  const parts = [];
  for (const m of members) {
    if (m.dir) { parts.push(tarHeader(m.name + '/', 0, 0o755, '5')); continue; }
    parts.push(tarHeader(m.name, m.data.length, m.mode, '0'));
    parts.push(m.data);
    const pad = (512 - (m.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/* Build the hand-rolled hatch-noexec repo: a structurally valid payload whose
 * postinst has neither a #! line nor wasm magic. */
function buildNoexecRepo(dir) {
  const name = 'hatch-noexec';
  const control = {
    name, version: '1.0', summary: 'non-runnable postinst fixture',
    bin: {}, openwith: {}, commands: {}, menu: [], fonts: [],
    postinst: 'postinst',
  };
  const members = [
    { name: 'control.json', data: Buffer.from(JSON.stringify(control, null, 2) + '\n'), mode: 0o644 },
    { name: 'opt', dir: true },
    { name: `opt/${name}`, dir: true },
    { name: `opt/${name}/postinst`, data: Buffer.from('echo this has no shebang\n'), mode: 0o755 },
  ];
  const gz = zlib.gzipSync(tarball(members), { level: 9 });
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const url = `pool/${name}_1.0.pkg.tar.gz`;
  fs.mkdirSync(path.join(dir, 'pool'), { recursive: true });
  fs.writeFileSync(path.join(dir, url), gz);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    baseVersion: 1,
    packages: { [name]: { version: '1.0', summary: '', minBase: 0, deps: [],
      payload: { format: 'tar+gzip', url, size: gz.length, sha256: sha } } },
  }, null, 2) + '\n');
}

/* Pull control.json back out of a built payload (gunzip + tar walk). */
function payloadControl(repoDir, index, name) {
  const gz = fs.readFileSync(path.join(repoDir, index.packages[name].payload.url));
  const tar = zlib.gunzipSync(gz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const nm = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!nm) break;
    const size = parseInt(tar.toString('ascii', off + 124, off + 136).replace(/\0.*$/, ''), 8) || 0;
    if (nm === 'control.json') {
      return JSON.parse(tar.toString('utf8', off + 512, off + 512 + size));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`no control.json in ${name} payload`);
}

async function main() {
  const MIN = ensureMinimalImage();

  /* ================= host legs: mkpkg + fold gates ================= */

  // Positive: the official pipeline builds a scripts-carrying package and
  // control.json carries the keys (this is the red control's first tripwire:
  // the pre-#74 packageControl silently DROPS unknown def keys).
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(PKG_ROOT, 'scripts-e2e-'));
  const defPaths = writeDefs(DEFS);
  let index;
  try {
    mkpkgRun(outDir, Object.keys(DEFS));
    index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf-8'));
    for (const n of Object.keys(DEFS)) {
      if (!index.packages[n]) throw new Error(`mkpkg produced no ${n} entry`);
    }
    const ctl = payloadControl(outDir, index, 'hatch-ok');
    check('mkpkg: control.json carries postinst', ctl.postinst === 'postinst', JSON.stringify(ctl));
    check('mkpkg: control.json carries prerm', ctl.prerm === 'prerm', JSON.stringify(ctl));

    // Negative: postinst naming no payload member refuses the build.
    const badDef = path.join(ROOT, 'packages', 'hatch-badref.json');
    fs.writeFileSync(badDef, JSON.stringify({
      name: 'hatch-badref', version: '1.0', summary: 'negative fixture',
      files: { 'hello.txt': { content: 'hi\n' } },
      postinst: 'nope',
    }, null, 2) + '\n');
    try {
      const r = mkpkgRun(fs.mkdtempSync(path.join(PKG_ROOT, 'scripts-badref-')),
        ['hatch-badref'], true);
      check('mkpkg refuses postinst naming no payload member (exit 1)', r.status === 1,
        `status=${r.status}`);
      check('mkpkg refusal names the postinst cause',
        /postinst .*names no file in the assembled payload/.test(String(r.stderr)), String(r.stderr));
    } finally { fs.rmSync(badDef, { force: true }); }

    // Negative: a non-runnable script member refuses the build.
    const nrDef = path.join(ROOT, 'packages', 'hatch-noshebang.json');
    fs.writeFileSync(nrDef, JSON.stringify({
      name: 'hatch-noshebang', version: '1.0', summary: 'negative fixture',
      files: { 'postinst': { content: 'echo no shebang\n', mode: 0o755 } },
      postinst: 'postinst',
    }, null, 2) + '\n');
    try {
      const r = mkpkgRun(fs.mkdtempSync(path.join(PKG_ROOT, 'scripts-noshebang-')),
        ['hatch-noshebang'], true);
      check('mkpkg refuses a non-runnable script (exit 1)', r.status === 1, `status=${r.status}`);
      check('mkpkg refusal names the runnable rule',
        /postinst .*not runnable/.test(String(r.stderr)), String(r.stderr));
    } finally { fs.rmSync(nrDef, { force: true }); }

    // Fold gate: foldPackages refuses a script-carrying def loudly (a baked
    // package never runs an install transaction). Driven through the
    // packagesDir seam, so nothing transient is needed beyond a temp dir.
    {
      const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
      const foldDir = fs.mkdtempSync(path.join(PKG_ROOT, 'scripts-fold-'));
      fs.writeFileSync(path.join(foldDir, 'hatch-ok.json'),
        JSON.stringify(DEFS['hatch-ok'], null, 2) + '\n');
      let err = null;
      try {
        COMMON.foldPackages(fs, path, ROOT, { version: 1, system: { dirs: [], files: {} } },
          ['hatch-ok'], { packagesDir: foldDir });
      } catch (e) { err = e; }
      check('foldPackages refuses a postinst/prerm-carrying def', !!err, 'no throw');
      check('fold refusal says scripts cannot be folded',
        !!err && /cannot be folded/.test(String(err.message)), err && err.message);
      fs.rmSync(foldDir, { recursive: true, force: true });
    }
  } finally {
    for (const p of defPaths) fs.rmSync(p, { force: true });
  }

  /* ================= the e2e boot session ================= */

  const { dir: tmp, image } = freshImage('os-gucman-scripts-');
  fs.copyFileSync(MIN, image);

  const noexecDir = path.join(tmp, 'noexec-repo');
  buildNoexecRepo(noexecDir);

  const goodPort = await startServer(outDir);
  const noexecPort = await startServer(noexecDir);
  console.log(`[gucman-scripts] repo :${goodPort}, hand-rolled repo :${noexecPort}`);

  const BOOT_ARGS = { image, args: ['--packages=none'], timeout: 420000 };
  const script = [
    'echo ==setup',
    'mkdir -p /etc/gucman',
    'printf "# this test owns its package state\\n" > /etc/gucman/defaults',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,

    'echo ==okinstall',
    'gucman install hatch-ok 2>&1; echo RC=$?',
    'cat /root/hatch.log',
    // cJSON_Print separates key and value with ':' + TAB, not ': ' — match any
    // separator but still demand the exact quoted path on the key's line.
    'grep -o "\\"postinst\\":.*\\"/opt/hatch-ok/postinst\\"" /var/lib/gucman/hatch-ok.json',
    'grep -o "\\"prerm\\":.*\\"/opt/hatch-ok/prerm\\"" /var/lib/gucman/hatch-ok.json',
    'echo ==okinfo',
    'gucman info hatch-ok 2>/dev/null',
    'echo ==okremove',
    'gucman remove hatch-ok 2>&1; echo RC=$?',
    'cat /root/hatch.log',
    'test ! -e /opt/hatch-ok && echo OPT-GONE',
    'test ! -e /var/lib/gucman/hatch-ok.json && echo DB-GONE',

    'echo ==fail',
    'gucman install hatch-fail 2>&1; echo RC=$?',
    'test -e /root/hatch-fail-ran && echo SCRIPT-SIDE-EFFECT-KEPT',
    'test ! -e /opt/hatch-fail && echo OPT-ROLLED-BACK',
    'test ! -e /usr/local/bin/hatchtool && echo LINK-ROLLED-BACK',
    'test ! -e /var/lib/gucman/hatch-fail.json && echo NO-DB-AFTER-FAIL',
    'test ! -e /opt/.staging.hatch-fail && echo NO-STAGING-AFTER-FAIL',

    'echo ==hang',
    'export GUCMAN_SCRIPT_TIMEOUT_MS=2000',
    'gucman install hatch-hang 2>&1; echo RC=$?',
    'unset GUCMAN_SCRIPT_TIMEOUT_MS',
    'test ! -e /opt/hatch-hang && echo OPT-ROLLED-BACK-HANG',
    'test ! -e /var/lib/gucman/hatch-hang.json && echo NO-DB-AFTER-HANG',

    'echo ==prermfail',
    'gucman install hatch-prermfail 2>&1; echo RC=$?',
    'gucman remove hatch-prermfail 2>&1; echo RC2=$?',
    'test ! -e /opt/hatch-prermfail && echo OPT-GONE-PF',
    'test ! -e /var/lib/gucman/hatch-prermfail.json && echo DB-GONE-PF',

    'echo ==noexec',
    `echo http://127.0.0.1:${noexecPort} > /etc/gucman/repos`,
    'gucman install hatch-noexec 2>&1; echo RC=$?',
    'test ! -e /opt/hatch-noexec && echo NOTHING-PUBLISHED',
    'test ! -e /opt/.staging.hatch-noexec && echo STAGING-SWEPT',
    'test ! -e /var/lib/gucman/hatch-noexec.json && echo NO-DB-NX',
    'echo ==done',
  ];
  const r = driveBoot(script, BOOT_ARGS);
  const out = String(r.stdout || '');

  const ok = section(out, 'okinstall');
  check('hatch-ok installs (exit 0)', ok.includes('RC=0'), ok);
  check('postinst ran with verb "install" and cwd /opt/hatch-ok',
    ok.includes('postinst:install:/opt/hatch-ok'), ok);
  check('DB records the postinst path',
    /"postinst":\s*"\/opt\/hatch-ok\/postinst"/.test(ok), ok);
  check('DB records the prerm path',
    /"prerm":\s*"\/opt\/hatch-ok\/prerm"/.test(ok), ok);

  const info = section(out, 'okinfo');
  check('info shows the postinst script', /^postinst:\s+\/opt\/hatch-ok\/postinst/m.test(info), info);
  check('info shows the prerm script', /^prerm:\s+\/opt\/hatch-ok\/prerm/m.test(info), info);

  const okrm = section(out, 'okremove');
  check('hatch-ok removes (exit 0)', okrm.includes('RC=0'), okrm);
  check('prerm ran with verb "remove" and cwd /opt/hatch-ok',
    okrm.includes('prerm:remove:/opt/hatch-ok'), okrm);
  check('postinst did not re-run at remove',
    (okrm.match(/postinst:install/g) || []).length === 1, okrm);
  check('/opt/hatch-ok fully removed after prerm', okrm.includes('OPT-GONE'), okrm);
  check('DB record removed', okrm.includes('DB-GONE'));

  const fail = section(out, 'fail');
  check('failing postinst fails the install (exit 1)', fail.includes('RC=1'), fail);
  check('failure names the script exit status', /postinst .*exited 7|exit(ed)? 7/.test(fail), fail);
  check('the script really ran (outside-plant side effect kept — documented semantics)',
    fail.includes('SCRIPT-SIDE-EFFECT-KEPT'), fail);
  check('/opt tree rolled back', fail.includes('OPT-ROLLED-BACK'), fail);
  check('planted bin symlink rolled back', fail.includes('LINK-ROLLED-BACK'), fail);
  check('no DB record after the rollback', fail.includes('NO-DB-AFTER-FAIL'));
  check('no staging leftovers after the rollback', fail.includes('NO-STAGING-AFTER-FAIL'));

  const hang = section(out, 'hang');
  check('hung postinst fails the install (exit 1)', hang.includes('RC=1'), hang);
  check('timeout is named in the failure', /did not finish within \d+ ms/.test(hang), hang);
  check('/opt tree rolled back after the kill', hang.includes('OPT-ROLLED-BACK-HANG'), hang);
  check('no DB record after the kill', hang.includes('NO-DB-AFTER-HANG'));

  const pf = section(out, 'prermfail');
  check('hatch-prermfail installs (exit 0)', pf.includes('RC=0'), pf);
  check('failing prerm does NOT block the removal (exit 0)', pf.includes('RC2=0'), pf);
  check('prerm failure is loud', /prerm .*(exited 3|failed)/.test(pf), pf);
  check('package removed despite the failing prerm', pf.includes('OPT-GONE-PF'), pf);
  check('DB record removed despite the failing prerm', pf.includes('DB-GONE-PF'));

  const nx = section(out, 'noexec');
  check('non-runnable postinst payload is refused (exit 1)', nx.includes('RC=1'), nx);
  check('refusal names the runnable rule', /not runnable/.test(nx), nx);
  check('nothing published to /opt', nx.includes('NOTHING-PUBLISHED'), nx);
  check('staging swept after the refusal', nx.includes('STAGING-SWEPT'));
  check('no DB record after the refusal', nx.includes('NO-DB-NX'));

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(failures ? `\ngucman scripts e2e: ${failures} FAILED` : '\ngucman scripts e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
