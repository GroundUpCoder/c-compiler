#!/usr/bin/env node
// Ticket #439 acceptance, headless: the C standard library is READABLE
// inside gucOS.
//
//   - baked headers: a VIRGIN boot — no install step — can cat every header
//     the compiler's `#include <...>` resolves, at /usr/include/<name>, and
//     the bytes are EXACTLY the in-compiler literal map (hazard 1: the
//     planted files are documentation of the builtin surface, so drift is
//     the failure mode this gate exists to catch). Checked on the MINIMAL
//     (no-packages) image — the base guarantee — as full-set sha256
//     equality: every map entry present, byte-equal, and NOTHING extra.
//   - the fat image agrees: same full-set check with every package folded
//     in, proving the srclib symlink-farm tier (windows.h, png.h, ...)
//     coexists without shadowing or colliding (hazard 2, end to end).
//   - libc-sources (the #407-convention companion, 'builtin' derivation):
//     installs through gucman, plants /usr/local/src/libc, and the .c
//     implementation units are byte-exact vs the compiler's literal maps.
//
// Run: node tests/kernel/test_stdinc_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const sha = (text) => crypto.createHash('sha256')
  .update(Buffer.from(text, 'utf8')).digest('hex');

// Expected: name -> sha256, straight from the compiler's merged map.
const hdrs = COMMON.stdlibHeaderMap(CompilerJS);
const expected = new Map();
hdrs.forEach((text, name) => expected.set('/usr/include/' + name, sha(text)));

// Parse `sha256sum` output lines into a Map(path -> hash).
function parseSums(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const mm = /^([0-9a-f]{64})\s+(\S.*)$/.exec(line.trim());
    if (mm) m.set(mm[2], mm[1]);
  }
  return m;
}

// Full-set equality: every expected file present with the right hash, and
// nothing extra among the REAL files under /usr/include (srclib package
// plants are symlinks — `find -type f` doesn't follow, by design).
function checkFullSet(label, out) {
  const got = parseSums(out);
  const missing = [...expected.keys()].filter((p) => !got.has(p));
  const wrong = [...expected.keys()].filter((p) => got.has(p) && got.get(p) !== expected.get(p));
  const extra = [...got.keys()].filter((p) => !expected.has(p));
  check(`${label}: every merged-map header present (${expected.size} files)`,
    missing.length === 0, 'missing: ' + missing.join(','));
  check(`${label}: every header BYTE-EQUAL to the compiler map`,
    wrong.length === 0, 'drifted: ' + wrong.join(','));
  check(`${label}: nothing extra baked under /usr/include`,
    extra.length === 0, 'extra: ' + extra.join(','));
}

async function main() {
  /* ---- leg 1+3: the MINIMAL image — virgin readability + libc-sources ---- */
  const repo = ensurePackages(['libc-sources']);
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-stdinc-');
  fs.copyFileSync(MIN, image);
  const port = await startServer(repo.dir);
  console.log(`[stdinc] repo :${port}`);

  const script = [
    'echo ==inc',
    'find /usr/include -type f | sort | xargs sha256sum',
    'echo ==smoke',
    'head -1 /usr/include/stdio.h',
    'head -1 /usr/include/regex.h',
    'echo ==pkg',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install libc-sources 2>&1; echo RC=$?',
    'readlink /usr/local/src/libc',
    // Count at the payload ROOT (busybox find does not traverse a symlink
    // argument), .c/.h only so a control sidecar can never skew it.
    "find /opt/libc-sources -name '*.c' -o -name '*.h' | wc -l",
    'sha256sum /usr/local/src/libc/__stdio.c /usr/local/src/libc/regcomp.c /usr/local/src/libc/fnmatch.c /usr/local/src/libc/stdio.h',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');

  checkFullSet('minimal (virgin boot, no install step)', section(out, 'inc'));

  const smoke = section(out, 'smoke');
  check('an agent can head a standard header (readable text, not a hole)',
    /\S/.test(smoke), smoke);

  const p = section(out, 'pkg');
  check('libc-sources installs (exit 0)', p.includes('RC=0'), p);
  check('/usr/local/src/libc -> /opt/libc-sources (the payload root)',
    p.split('\n').some((l) => l.trim() === '/opt/libc-sources'), p);
  const nFiles = hdrs.size + Object.keys(CompilerJS.getStdlibSources()).length + 6; // + the 6 ext .c units
  check(`the source tree carries all ${nFiles} files`,
    p.split('\n').some((l) => l.trim() === String(nFiles)), p);
  const srcs = CompilerJS.getStdlibSources();
  const ext = JSON.parse((() => {
    const t = fs.readFileSync(path.join(ROOT, 'libc-ext.js'), 'utf-8');
    return t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  })());
  const psums = parseSums(p);
  check('__stdio.c is BYTE-EXACT vs the in-compiler literal map',
    psums.get('/usr/local/src/libc/__stdio.c') === sha(srcs['__stdio.c']), p);
  check('regcomp.c (TRE, via libc-ext.js) is BYTE-EXACT',
    psums.get('/usr/local/src/libc/regcomp.c') === sha(ext['regcomp.c']), p);
  check('fnmatch.c (musl, via libc-ext.js) is BYTE-EXACT',
    psums.get('/usr/local/src/libc/fnmatch.c') === sha(ext['fnmatch.c']), p);
  check('the source tree carries the headers too (stdio.h byte-exact)',
    psums.get('/usr/local/src/libc/stdio.h') === sha(hdrs.get('stdio.h')), p);

  /* ---- leg 2: the FAT image (the default fixture) agrees ---- */
  const r2 = driveBoot([
    'echo ==inc',
    'find /usr/include -type f | sort | xargs sha256sum',
    'echo ==tier',
    'test -L /usr/include/windows.h && echo SRCLIB-TIER-PRESENT',
    'echo ==done',
  ], { timeout: 420000 });
  const out2 = String(r2.stdout || '');
  checkFullSet('fat (every package folded)', section(out2, 'inc'));
  check('fat: the srclib symlink-farm tier coexists (windows.h is a link)',
    section(out2, 'tier').includes('SRCLIB-TIER-PRESENT'), section(out2, 'tier'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
