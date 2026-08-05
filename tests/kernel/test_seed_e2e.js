#!/usr/bin/env node
// The gucman `seed` CONTENT resource kind, end to end (design: ~git/meta
// gucos notes, "gucman `seed` — a first-class CONTENT resource kind").
//
// `seed` is the resource kind for USER-OWNED content: `{"<dest under
// /root>": "<payload-relative src>"}`, planted by COPY (never a symlink —
// the user gets a mutable copy) with desktop-defaults' additive semantics,
// recorded per file with a sha256 so remove unlinks only PRISTINE copies.
//
// Covered here:
//   - mkpkg NEGATIVE legs (§1.3): a dest with "..", an absolute dest, a
//     DOT-PREFIXED component (`.config/openwith` by name — the association-
//     hijack channel §2.1 exists to close), a src naming nothing in the
//     payload, two dests nested in one another, and the reserved
//     control.json payload path. Each fails the BUILD, loudly.
//   - install plants files + created dirs and records {path, sha256} per
//     file; `gucman info` lists them; remove of PRISTINE copies unlinks
//     them and rmdirs the dirs it created.
//   - COLLISION (§2.2): a dest the user already occupies is KEPT, said so,
//     and NOT recorded — so remove can never touch it.
//   - remove of a MODIFIED copy keeps the file and says
//     "kept … (modified since install)"; its directory survives with it.
//   - failed install UNWINDS: an earlier seed entry's plants are gone, no
//     /opt tree, no DB record.
//   - the VIRGIN-ROOT baked pass (§3.5): a package folded into the sealed
//     blob seeds a freshly created root straight from /usr/opt/<n>, with no
//     manifest involvement at all (the browser reads the RAW image.json, so
//     a manifest-side design would no-op there — design §0.4/§8.2).
//   - reconcile phase 3 (§3.4): deleting a BAKED package's seeded file and
//     running desktop-defaults restores it, recording nothing (a built-in
//     has no DB record and is not removable).
//
// Fixtures are throwaway package definitions under build/test-fixtures/
// (stable paths so the baked image caches) built through mkpkg's
// --packages-dir seam — the repo's packages/ dir is a bake input AND a
// shared mkpkg input for every other concurrently running test, so this
// never writes into it.
//
// Run: node tests/kernel/test_seed_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, startServer } = require('./lib/gucman.js');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const FIX = path.join(ROOT, 'build', 'test-fixtures');
const DEFS = path.join(FIX, 'seed-defs');
const REPO = path.join(FIX, 'seed-repo');
const SEED_IMG = path.join(FIX, 'os-system.seed.img');
const PKG = 'test-seed-pkg';
const BAD = 'test-seed-bad';

/* The acceptance package: a directory seed (with a nested subdir) and a
 * single-file seed, so both fo_merge granularities are exercised. */
const goodDef = {
  name: PKG, version: '1.0', summary: 'seed-engine acceptance fixture',
  files: {
    'demos/index.html': { content: '<h1>demo</h1>\n' },
    'demos/sub/deep.txt': { content: 'deep\n' },
    'notes.txt': { content: 'notes\n' },
  },
  seed: { 'Desktop/Demos': 'demos', 'notes.txt': 'notes.txt' },
};

/* The unwind fixture: its FIRST seed plants fine, its SECOND cannot — the
 * dest's parent is a regular file the user owns, so the copy hits ENOTDIR.
 * (Dests are planted in sorted order, and "Desktop/..." < "notes.txt/...".) */
const badDef = {
  name: BAD, version: '1.0', summary: 'seed unwind fixture',
  files: {
    'demos/index.html': { content: '<h1>bad</h1>\n' },
    'one.txt': { content: 'one\n' },
  },
  seed: { 'Desktop/BadDemos': 'demos', 'notes.txt/inner.txt': 'one.txt' },
};

function writeDefs() {
  fs.mkdirSync(DEFS, { recursive: true });
  for (const f of fs.readdirSync(DEFS)) fs.unlinkSync(path.join(DEFS, f));
  fs.writeFileSync(path.join(DEFS, PKG + '.json'), JSON.stringify(goodDef, null, 2) + '\n');
  fs.writeFileSync(path.join(DEFS, BAD + '.json'), JSON.stringify(badDef, null, 2) + '\n');
}

function mkpkg(defsDir, outDir, names) {
  return cp.spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet',
     `--packages-dir=${defsDir}`, `--out=${outDir}`, ...names],
    { encoding: 'utf-8', timeout: 300000 });
}

/* One negative build: a lone bad definition in its own defs dir, so nothing
 * else is even enumerated. */
function refuses(label, def, re) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-baddef-'));
  const o = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-badout-'));
  try {
    fs.writeFileSync(path.join(d, def.name + '.json'), JSON.stringify(def, null, 2) + '\n');
    const r = mkpkg(d, o, [def.name]);
    const err = String(r.stderr || '');
    check(`mkpkg refuses ${label} (exit 1)`, r.status === 1, `status=${r.status} ${err}`);
    check(`mkpkg refusal names the cause for ${label}`, re.test(err), err);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(o, { recursive: true, force: true });
  }
}

/* The seed-carrying system blob (baked once + cached, the ensureMinimalImage
 * gate shape): version-current, PACKAGES == [PKG], input-fresh. */
function ensureSeedImage() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
  // noDefaultPackages: the shipped default set (#420: doom) is not
  // installable from this throwaway defs dir — same flag as the bakes below.
  const folded = COMMON.foldPackages(fs, path, ROOT, raw, [PKG], { packagesDir: DEFS, noDefaultPackages: true }).manifest;
  let fresh = false;
  try {
    const st = fs.statSync(SEED_IMG);
    const store = new COMMON.NodeFileStore(fs, SEED_IMG, false);
    const v = COMMON.bakedVersion(BLOCK_FS, store);
    const pk = COMMON.bakedPackages(BLOCK_FS, store);
    store.close();
    fresh = v === (raw.version | 0) && pk.join(',') === PKG &&
      st.mtimeMs >= COMMON.newestBakeInput(fs, path, ROOT, folded).mtimeMs &&
      st.mtimeMs >= fs.statSync(path.join(DEFS, PKG + '.json')).mtimeMs;
  } catch (e) { /* missing -> bake */ }
  if (!fresh) {
    console.log('[seed] baking the seed-carrying system blob…');
    const r = cp.spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'mkimage.js'), `--out=${SEED_IMG}`, '--quiet',
       `--packages-dir=${DEFS}`, `--packages=${PKG}`, '--no-default-packages'],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: 900000 });
    if (r.status !== 0) throw new Error('mkimage (seed) failed');
  }
  return SEED_IMG;
}

async function main() {
  writeDefs();

  /* ---- stage 1: mkpkg validation, the negative legs (§1.3) ---- */
  const withSeed = (seed, files) => Object.assign({}, goodDef,
    { name: 'test-seed-neg', seed }, files ? { files } : {});
  refuses('a seed dest escaping with ".."', withSeed({ '../etc/openwith': 'notes.txt' }),
    /seed dest "\.\.\/etc\/openwith" must be a relative path under \/root/);
  refuses('an absolute seed dest', withSeed({ '/etc/openwith': 'notes.txt' }),
    /seed dest "\/etc\/openwith" must be a relative path under \/root/);
  // The association-hijack channel by name: ~/.config/openwith is the
  // HIGHEST cfgstore layer, so planting a merely-ABSENT file there would
  // redirect every "open with" in the system.
  refuses('a dot-prefixed seed dest (.config/openwith)',
    withSeed({ '.config/openwith': 'notes.txt' }),
    /seed dest "\.config\/openwith" has a dot-prefixed component/);
  refuses('a dot-prefixed component deeper in the dest',
    withSeed({ 'Desktop/.config/openwith': 'notes.txt' }),
    /has a dot-prefixed component/);
  refuses('a seed src naming nothing in the payload',
    withSeed({ 'Desktop/X': 'nosuchfile' }),
    /seed Desktop\/X -> nosuchfile names no file or directory in the assembled payload/);
  refuses('two seed dests nested in one another',
    withSeed({ 'Desktop/A': 'demos', 'Desktop/A/b': 'notes.txt' }),
    /seed dest "Desktop\/A\/b" is inside "Desktop\/A"/);
  refuses('a payload claiming the reserved control.json path',
    withSeed({ 'Desktop/Demos': 'demos' },
      { 'control.json': { content: '{}\n' }, 'demos/index.html': { content: 'x\n' } }),
    /control\.json is reserved at the payload root/);

  /* ---- build the real fixtures + serve them ---- */
  fs.mkdirSync(REPO, { recursive: true });
  const built = mkpkg(DEFS, REPO, [PKG, BAD]);
  if (built.status !== 0) throw new Error('mkpkg (seed fixtures) failed: ' + built.stderr);
  const idx = JSON.parse(fs.readFileSync(path.join(REPO, 'index.json'), 'utf-8'));
  for (const n of [PKG, BAD]) if (!idx.packages[n]) throw new Error(`mkpkg produced no ${n} entry`);

  const MIN = ensureMinimalImage();
  const port = await startServer(REPO);
  console.log(`[seed] repo :${port}`);

  const repoLines = ['mkdir -p /etc/gucman', `echo http://127.0.0.1:${port} > /etc/gucman/repos`];
  const BOOT_ARGS = { args: ['--packages=none'], timeout: 420000 };
  const freshMin = (prefix) => {
    const { image } = freshImage(prefix);
    fs.copyFileSync(MIN, image);      // copy mtime = now -> input-fresh at boot
    return image;
  };

  /* ---- session A: plant, record, info, remove-pristine ---- */
  const a = driveBoot([
    ...repoLines,
    'echo ==plant',
    `gucman install ${PKG}; echo RC=$?`,
    'echo "IDX=$(cat /root/Desktop/Demos/index.html)-END"',
    'echo "DEEP=$(cat /root/Desktop/Demos/sub/deep.txt)-END"',
    'echo "NOTE=$(cat /root/notes.txt)-END"',
    'test ! -L /root/Desktop/Demos && echo SEED-IS-A-REAL-DIR',
    'test ! -L /root/notes.txt && echo SEED-IS-A-REAL-FILE',
    'echo ==db',
    `cat /var/lib/gucman/${PKG}.json`,
    'echo ==info',
    `gucman info ${PKG}`,
    'echo ==rm',
    `gucman remove ${PKG}; echo RC=$?`,
    'test ! -e /root/Desktop/Demos && echo DIR-GONE',
    'test ! -e /root/notes.txt && echo FILE-GONE',
    'test -d /root/Desktop && echo DESKTOP-KEPT',
    'echo ==done',
  ], Object.assign({ image: freshMin('os-seedA-') }, BOOT_ARGS));
  const aout = String(a.stdout || '') + '\n' + String(a.stderr || '');

  const plant = section(aout, 'plant');
  check('install succeeds (exit 0)', plant.includes('RC=0'), plant);
  check('directory seed planted, nested file and all',
    plant.includes('IDX=<h1>demo</h1>-END') && plant.includes('DEEP=deep-END'), plant);
  check('single-file seed planted', plant.includes('NOTE=notes-END'), plant);
  check('a seed is a real directory, not a symlink into /opt',
    plant.includes('SEED-IS-A-REAL-DIR'), plant);
  check('a seeded file is a real file, not a symlink into /opt',
    plant.includes('SEED-IS-A-REAL-FILE'), plant);

  const db = section(aout, 'db');
  let rec = null;
  try { rec = JSON.parse(db.slice(db.indexOf('{'), db.lastIndexOf('}') + 1)); } catch (e) {}
  const seedPaths = rec ? (rec.seeds || []).map((s) => s.path).sort() : [];
  check('DB records one entry per planted seed FILE',
    JSON.stringify(seedPaths) === JSON.stringify([
      '/root/Desktop/Demos/index.html', '/root/Desktop/Demos/sub/deep.txt', '/root/notes.txt']),
    JSON.stringify(seedPaths));
  check('every seed record carries a 64-hex sha256',
    !!rec && (rec.seeds || []).length === 3 &&
    (rec.seeds || []).every((s) => /^[0-9a-f]{64}$/.test(s.sha256)), db.slice(0, 400));
  check('DB records the dirs the plant CREATED (and only those)',
    !!rec && JSON.stringify((rec.seed_dirs || []).slice().sort()) === JSON.stringify(
      ['/root/Desktop/Demos', '/root/Desktop/Demos/sub']),
    JSON.stringify(rec && rec.seed_dirs));
  check('the pre-existing /root/Desktop is NOT recorded as ours',
    !!rec && !(rec.seed_dirs || []).includes('/root/Desktop'), JSON.stringify(rec && rec.seed_dirs));
  check('the verified control.json is materialized at /opt/<name>/control.json',
    !!rec && (rec.files || []).includes(`/opt/${PKG}/control.json`), JSON.stringify(rec && rec.files));

  const info = section(aout, 'info');
  check('info lists a seeded files: section',
    /^seeded files:$/m.test(info) && info.includes('/root/notes.txt'), info);

  const rm = section(aout, 'rm');
  check('remove succeeds (exit 0)', rm.includes('RC=0'), rm);
  check('pristine seeded files are unlinked',
    rm.includes('DIR-GONE') && rm.includes('FILE-GONE'), rm);
  check('a dir the plant did NOT create survives', rm.includes('DESKTOP-KEPT'), rm);

  /* ---- session B: collision (kept, unrecorded, untouchable) + remove of a
   *      MODIFIED copy ---- */
  const b = driveBoot([
    ...repoLines,
    'printf mine > /root/notes.txt',                 // the user got there first
    'echo ==collide',
    `gucman install ${PKG}; echo RC=$?`,
    'echo "NOTE=$(cat /root/notes.txt)-END"',
    'echo ==db2',
    `cat /var/lib/gucman/${PKG}.json`,
    'echo ==edit',
    'printf MINE > /root/Desktop/Demos/index.html',  // the user edits a seed
    `gucman remove ${PKG}; echo RC=$?`,
    'echo "EDITED=$(cat /root/Desktop/Demos/index.html)-END"',
    'echo "SQUAT=$(cat /root/notes.txt)-END"',
    'test ! -e /root/Desktop/Demos/sub/deep.txt && echo PRISTINE-GONE',
    'test ! -e /root/Desktop/Demos/sub && echo EMPTY-DIR-GONE',
    'test -d /root/Desktop/Demos && echo BUSY-DIR-KEPT',
    'echo ==done',
  ], Object.assign({ image: freshMin('os-seedB-') }, BOOT_ARGS));
  const bout = String(b.stdout || '') + '\n' + String(b.stderr || '');

  const coll = section(bout, 'collide');
  check('a collision does not fail the install', coll.includes('RC=0'), coll);
  check('the user\'s file at a seed dest is never overwritten',
    coll.includes('NOTE=mine-END'), coll);
  check('the collision is named on the way past',
    /gucman: kept existing \/root\/notes\.txt/.test(bout), coll);
  let rec2 = null;
  const db2 = section(bout, 'db2');
  try { rec2 = JSON.parse(db2.slice(db2.indexOf('{'), db2.lastIndexOf('}') + 1)); } catch (e) {}
  check('a KEPT dest is not recorded — remove can never touch it',
    !!rec2 && !(rec2.seeds || []).some((s) => s.path === '/root/notes.txt'),
    JSON.stringify(rec2 && rec2.seeds));

  const edit = section(bout, 'edit');
  check('remove with a modified seed still exits 0', edit.includes('RC=0'), edit);
  check('a MODIFIED seeded file survives remove', edit.includes('EDITED=MINE-END'), edit);
  check('remove says so, loudly',
    /gucman: kept \/root\/Desktop\/Demos\/index\.html \(modified since install\)/.test(bout), edit);
  check('pristine siblings still go', edit.includes('PRISTINE-GONE'), edit);
  check('a now-empty created dir is rmdir\'d', edit.includes('EMPTY-DIR-GONE'), edit);
  check('the dir holding the kept file survives', edit.includes('BUSY-DIR-KEPT'), edit);
  check('the never-recorded collision file is untouched by remove',
    edit.includes('SQUAT=mine-END'), edit);

  /* ---- session C: a failed install unwinds every seed it planted ---- */
  const c = driveBoot([
    ...repoLines,
    'printf mine > /root/notes.txt',        // makes the 2nd seed's parent a FILE
    'echo ==unwind',
    `gucman install ${BAD}; echo RC=$?`,
    'test ! -e /root/Desktop/BadDemos && echo FIRST-SEED-UNWOUND',
    `test ! -e /opt/${BAD} && echo OPT-GONE`,
    `test ! -e /var/lib/gucman/${BAD}.json && echo NO-DB`,
    'echo "NOTE=$(cat /root/notes.txt)-END"',
    'echo ==done',
  ], Object.assign({ image: freshMin('os-seedC-') }, BOOT_ARGS));
  const cout = String(c.stdout || '') + '\n' + String(c.stderr || '');

  const unwind = section(cout, 'unwind');
  check('a seed that cannot be planted FAILS the install', unwind.includes('RC=1'), unwind);
  check('the earlier seed entry\'s plants are unwound',
    unwind.includes('FIRST-SEED-UNWOUND'), unwind);
  check('the /opt tree is unwound too', unwind.includes('OPT-GONE'), unwind);
  check('no DB record is left behind', unwind.includes('NO-DB'), unwind);
  check('the user file that caused the failure is untouched',
    unwind.includes('NOTE=mine-END'), unwind);

  /* ---- session D: the virgin-root baked pass (§3.5) + reconcile phase 3 ---- */
  const SEED_BLOB = ensureSeedImage();
  const { image: bakedImg } = freshImage('os-seedD-');
  fs.copyFileSync(SEED_BLOB, bakedImg);
  const d = driveBoot([
    'echo ==baked',
    'grep PACKAGES /usr/share/os-release',
    `test -f /usr/opt/${PKG}/control.json && echo BAKED-CONTROL`,
    'echo "IDX=$(cat /root/Desktop/Demos/index.html)-END"',
    'echo "DEEP=$(cat /root/Desktop/Demos/sub/deep.txt)-END"',
    'echo "NOTE=$(cat /root/notes.txt)-END"',
    'test ! -L /root/Desktop/Demos && echo BAKED-SEED-IS-REAL',
    'test ! -e /var/lib/gucman && echo NO-DB-DIR',
    'echo ==restore',
    'rm -r /root/Desktop/Demos',
    'printf MINE > /root/notes.txt',
    'desktop-defaults',
    'echo "RC=$?"',
    'echo "IDX2=$(cat /root/Desktop/Demos/index.html)-END"',
    'echo "NOTE2=$(cat /root/notes.txt)-END"',
    'test ! -e /var/lib/gucman && echo STILL-NO-DB-DIR',
    'echo ==done',
  ], { image: bakedImg, args: [`--packages=${PKG}`, `--packages-dir=${DEFS}`, '--no-default-packages'], timeout: 420000 });
  const dout = String(d.stdout || '') + '\n' + String(d.stderr || '');

  const baked = section(dout, 'baked');
  check('the blob records the folded package', baked.includes(`PACKAGES=${PKG}`), baked);
  check('the fold planted the package manifest into the blob',
    baked.includes('BAKED-CONTROL'), baked);
  check('a virgin root carries the baked package\'s directory seed',
    baked.includes('IDX=<h1>demo</h1>-END') && baked.includes('DEEP=deep-END'), baked);
  check('a virgin root carries the baked package\'s file seed',
    baked.includes('NOTE=notes-END'), baked);
  check('baked seeds are real copies, not links into the sealed /usr',
    baked.includes('BAKED-SEED-IS-REAL'), baked);
  check('a baked package needs no install DB', baked.includes('NO-DB-DIR'), baked);

  const restore = section(dout, 'restore');
  check('reconcile exits 0 over baked packages', restore.includes('RC=0'), restore);
  check('phase 3 restores a deleted baked seed',
    restore.includes('IDX2=<h1>demo</h1>-END'), restore);
  check('phase 3 keeps an edited baked seed', restore.includes('NOTE2=MINE-END'), restore);
  check('phase 3 records nothing (a built-in is not removable)',
    restore.includes('STILL-NO-DB-DIR'), restore);

  console.log(failures ? `\nseed e2e: ${failures} FAILED` : '\nseed e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
