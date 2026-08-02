#!/usr/bin/env node
// todos #407 acceptance, headless: the mechanical `<pkg>-sources` companion
// packages install through the normal gucman path and land readable source
// on the OS — BOTH derivations of the one rule, with no per-package edits:
//
//   - gcode-sources (image derivation — the jku demo: gcode is a BAKED
//     binary, /usr/bin/gcode): install plants the payload root as the
//     /usr/local/src/gcode source namespace (the writable srclib tier —
//     /usr is the sealed image volume, so /usr/src belongs to the fold),
//     creating the tier on a virgin root, and the source bytes are
//     BYTE-EXACT vs the repo (in-OS sha256sum vs a host hash)
//   - lua-sources (package derivation — the second package the ticket
//     requires): same rule, same layout, /usr/local/src/lua readable
//   - remove replays exactly: links gone, /opt trees gone, and the tier
//     dir its creator recorded is rmdir'd once empty — NO residue
//     (remove order lua first, then gcode: the tier's recorded creator
//     goes last, the srclib tier-sharing rule)
//
// Run: node tests/kernel/test_gucman_sources_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

async function main() {
  const repo = ensurePackages(['gcode-sources', 'lua-sources']);
  const idx = repo.index;
  const MIN = ensureMinimalImage();

  const { dir: tmp, image } = freshImage('os-gucman-sources-');
  fs.copyFileSync(MIN, image);

  const port = await startServer(repo.dir);
  console.log(`[gucman-sources] repo :${port}`);

  const gcodeSha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'os', 'gcode', 'gcode.c'))).digest('hex');

  const script = [
    'echo ==virgin',
    'test ! -e /usr/local/src && echo NO-SRC-TIER-BAKED',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'echo ==gcode',
    'gucman install gcode-sources 2>&1; echo RC=$?',
    'readlink /usr/local/src/gcode',
    'test -d /opt/gcode-sources && echo OPT-OK',
    'sha256sum /usr/local/src/gcode/os/gcode/gcode.c',
    'cat /usr/local/src/gcode/os/gcode/bin.json',
    'echo ==lua',
    'gucman install lua-sources 2>&1; echo RC2=$?',
    'readlink /usr/local/src/lua',
    'grep -c LUA_VERSION_MAJOR /usr/local/src/lua/vendor/lua/src/lua.h && echo LUA-READABLE',
    'ls /usr/local/src',
    'echo ==db',
    'cat /var/lib/gucman/gcode-sources.json',
    'echo ==remove',
    'gucman remove lua-sources 2>&1; echo RRC=$?',
    'test ! -e /usr/local/src/lua && echo NO-LUA-LINK',
    'test ! -e /opt/lua-sources && echo NO-LUA-OPT',
    'test -e /usr/local/src/gcode && echo GCODE-LINK-KEPT',
    'gucman remove gcode-sources 2>&1; echo RRC2=$?',
    'test ! -e /usr/local/src && echo TIER-GONE',
    'test ! -e /opt/gcode-sources && echo NO-GCODE-OPT',
    'test ! -e /var/lib/gucman/gcode-sources.json && echo NO-DB',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');

  const virgin = section(out, 'virgin');
  check('minimal image has no baked /usr/local/src tier', virgin.includes('NO-SRC-TIER-BAKED'), virgin);

  const g = section(out, 'gcode');
  check('gcode-sources installs (exit 0)', g.includes('RC=0'), g);
  check('installed banner names the image-derived version',
    g.includes(`installed gcode-sources ${idx.packages['gcode-sources'].version}`), g);
  check('/usr/local/src/gcode -> /opt/gcode-sources (the payload root)',
    g.split('\n').some((l) => l.trim() === '/opt/gcode-sources'), g);
  check('/opt/gcode-sources published', g.includes('OPT-OK'));
  check('gcode.c is BYTE-EXACT vs the repo (in-OS sha256)', g.includes(gcodeSha), g);
  check('the project recipe rides along (bin.json readable)',
    g.includes('"name": "gcode"'), g);

  const l = section(out, 'lua');
  check('lua-sources installs (exit 0)', l.includes('RC2=0'), l);
  check('/usr/local/src/lua -> /opt/lua-sources',
    l.split('\n').some((ln) => ln.trim() === '/opt/lua-sources'), l);
  check('lua source readable in-OS', l.includes('LUA-READABLE'), l);
  check('the tier lists both namespaces', /gcode/.test(l) && /\blua\b/.test(l), l);

  const db = section(out, 'db');
  check('DB records the namespace link', db.includes('"/usr/local/src/gcode"'), db.slice(0, 400));
  check('DB records the tier dir it created', /"srclib_dirs":\s*\[\s*"\/usr\/local\/src"/.test(db), db.slice(0, 400));

  const rm = section(out, 'remove');
  check('lua-sources removes (exit 0)', rm.includes('RRC=0'), rm);
  check('lua link gone', rm.includes('NO-LUA-LINK'));
  check('lua /opt tree gone', rm.includes('NO-LUA-OPT'));
  check('shared tier keeps the other link', rm.includes('GCODE-LINK-KEPT'));
  check('gcode-sources removes (exit 0)', rm.includes('RRC2=0'), rm);
  check('tier dir rmdir\'d once empty — no residue', rm.includes('TIER-GONE'), rm);
  check('gcode /opt tree gone', rm.includes('NO-GCODE-OPT'));
  check('DB record gone last', rm.includes('NO-DB'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
