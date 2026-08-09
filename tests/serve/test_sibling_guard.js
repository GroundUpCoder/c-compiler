'use strict';
// #614: serve.js's sibling definition-source guard — the dev origin resolves
// the gucos-packages sibling by default and holds the served /packages repo
// to the MERGED result, matching the deploy behaviour (comguc mandates the
// sibling on the deploy box; a dev origin silently serving a base index
// while sibling definitions exist is the partial-index lie both refuse).
//
// Legs, each against a synthetic OS-shaped tree (os/image.json present so
// the guard arms; no tools/mkimage.js so the bake gate self-skips):
//   - GUCOS_PACKAGES pointing nowhere refuses loudly (an explicit override
//     never falls through to a discovered candidate)
//   - a served index MISSING a sibling package refuses, naming the package
//     and the mkpkg --defs fix
//   - a COVERING index passes and says so
//   - --minimal with sibling packages and NO index refuses (the deploy
//     shape serves optional apps exclusively through /packages)
//   - the default (fat) shape with NO index warns loudly but serves
//   - --no-extra-packages opts out entirely
//   - a cross-source duplicate name refuses at serve start (#612's rule)
//
//   node tests/serve/test_sibling_guard.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sibguard-'));
const w = (rel, text) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

const TREE = path.join(tmp, 'tree');
w('tree/os/image.json', JSON.stringify({ version: 1, system: { files: {} } }) + '\n');
fs.copyFileSync(path.join(ROOT, 'os', 'os-common.js'), path.join(TREE, 'os', 'os-common.js'));
const SIB = path.join(tmp, 'sib');
w('sib/packages/sibpkg.json', JSON.stringify({
  name: 'sibpkg', version: '1', summary: 'sibling fixture', minBase: 0,
  files: { 'share/x.txt': { content: 'hi\n' } },
}) + '\n');

// Run serve.js until it either exits or prints its URL (= it is listening,
// i.e. every pre-listen guard passed); kill it in the latter case.
function run(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), ...args],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ out, err, listened: false, code: null, timedOut: true });
    }, timeoutMs || 15000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (/https?:\/\/\S+/.test(out)) {
        child.kill('SIGTERM');
        finish({ out, err, listened: true, code: null });
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => finish({ out, err, listened: false, code }));
  });
}

async function main() {
  {
    const r = await run([TREE, '0'], { GUCOS_PACKAGES: path.join(tmp, 'no-such') });
    check('GUCOS_PACKAGES pointing nowhere refuses (exit 1)', r.code === 1, JSON.stringify(r));
    check('  …naming the variable and the fix', /GUCOS_PACKAGES/.test(r.err) && /--no-extra-packages/.test(r.err), r.err);
  }
  {
    w('tree/dist/packages/index.json', JSON.stringify({ schemaVersion: 1, packages: {} }) + '\n');
    const r = await run([TREE, '0'], { GUCOS_PACKAGES: SIB });
    check('an index missing a sibling package refuses (exit 1)', r.code === 1, JSON.stringify(r));
    check('  …naming the package and the mkpkg --defs fix',
      /sibpkg/.test(r.err) && /--defs=/.test(r.err), r.err);
  }
  {
    w('tree/dist/packages/index.json',
      JSON.stringify({ schemaVersion: 1, packages: { sibpkg: { version: '1' } } }) + '\n');
    const r = await run([TREE, '0'], { GUCOS_PACKAGES: SIB });
    check('a covering index serves', r.listened === true, JSON.stringify(r));
    check('  …and reports the merged coverage', /merged package index covers/.test(r.out), r.out);
  }
  {
    fs.rmSync(path.join(TREE, 'dist'), { recursive: true, force: true });
    const r = await run([TREE, '0', '--minimal'], { GUCOS_PACKAGES: SIB });
    check('--minimal with sibling packages and no index refuses (exit 1)', r.code === 1, JSON.stringify(r));
    check('  …naming the mkpkg --defs fix', /--defs=/.test(r.err), r.err);
  }
  {
    const r = await run([TREE, '0'], { GUCOS_PACKAGES: SIB });
    check('the fat shape with no index serves anyway', r.listened === true, JSON.stringify(r));
    check('  …with a loud warning naming the 404s to come',
      /sibling defines 1 package/.test(r.err) && /404/.test(r.err), r.err);
  }
  {
    const r = await run([TREE, '0', '--no-extra-packages'], { GUCOS_PACKAGES: path.join(tmp, 'no-such') });
    check('--no-extra-packages opts out entirely (even a bad override is moot)',
      r.listened === true && /--no-extra-packages/.test(r.out), JSON.stringify(r));
  }
  {
    w('tree/packages/sibpkg.json', JSON.stringify({
      name: 'sibpkg', version: '2', summary: 'source-0 twin', minBase: 0,
      files: { 'share/y.txt': { content: 'yo\n' } },
    }) + '\n');
    const r = await run([TREE, '0'], { GUCOS_PACKAGES: SIB });
    check('a cross-source duplicate name refuses at serve start', r.code === 1, JSON.stringify(r));
    check('  …citing both definition sources', /two definition sources/.test(r.err), r.err);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' check(s) FAILED' : 'sibling guard OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
