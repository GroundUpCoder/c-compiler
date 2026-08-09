// Guardrails for the mkpkg definition-source seam (#612, design §4B/§7):
// `--defs=<root>` adds ordered definition sources — each root contributes
// <root>/packages/*.json with every repo-relative asset path resolving
// against THAT root; c-compiler is the implicit source 0 and the union
// builds into the ONE index. gucman, the index schema, sha256/deps/minBase,
// sync-defaults and the storefront are unchanged by construction (the merge
// happens at build time — nothing here talks to any of them).
//
//   1. POSITIVE CONTROL, the §5d pin: a COMPILED def (a `project` entry
//      built by the cc driver) plus a `bin` asset, living entirely in a tmp
//      source, builds through `mkpkg --defs` — the payload carries the
//      compiled wasm and the asset bytes. Its mechanical `-sources`
//      companion synthesizes from the SIBLING's root (the closure at that
//      repo's paths), and a rebuild REUSES the fresh payload (the assetRoot
//      freshness scan finds the sibling inputs rather than restaling
//      forever).
//   2. COLLISION RED CONTROL: a duplicate package name across sources
//      refuses loudly naming BOTH files — sibling-vs-sibling and
//      sibling-vs-source-0 (a real packages/ name) both refuse, and the
//      refusal fires BEFORE the producer-gating filter (a gated def
//      collides too).
//   3. An explicit --defs that cannot contribute is a loud exit 1 (missing
//      root; root without packages/) — never a silent base fallback.
//   4. foldPackages threads the same seam (fat test images can still fold a
//      moved package): the folded manifest stays rootDir-relative by
//      contract — project/bin paths are RELOCATED so ROOT-bound bake
//      readers resolve them (buildProject really compiles the folded
//      entry), `text` inlines as `content`, and a sibling `c` entry refuses
//      with a named fix.
//   5. newestPkgInput's assetRoot: a touched sibling source file is the
//      newest input (the freshness scan reads the OWNING root).
//
// Run: node tests/serve/test_mkpkg_defs.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const MKPKG = path.join(ROOT, 'tools', 'mkpkg.js');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const ASSET = 'defs-seam-asset-bytes-612\n';
const WASM_MAGIC = Buffer.from([0, 0x61, 0x73, 0x6d]);

// A synthetic definition source: packages/<name>.json + src/<name>/ (compiled
// through the cc driver) + assets/<name>/ + os/<name>.txt (`text` vocab) —
// the §7 sibling layout.
function makeSource(name, opts) {
  opts = opts || {};
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-defs-'));
  fs.mkdirSync(path.join(src, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(src, 'src', name), { recursive: true });
  fs.mkdirSync(path.join(src, 'assets', name), { recursive: true });
  fs.mkdirSync(path.join(src, 'os'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src', name, 'bin.json'),
    JSON.stringify({ type: 'bin', sources: ['main.c'] }));
  fs.writeFileSync(path.join(src, 'src', name, 'main.c'),
    '#include <stdio.h>\nint main(void) { printf("' + name + ' ok\\n"); return 0; }\n');
  fs.writeFileSync(path.join(src, 'assets', name, 'data.txt'), ASSET);
  fs.writeFileSync(path.join(src, 'os', 'readme.txt'), 'sibling text entry\n');
  const def = {
    name, version: '1.0', summary: 'defs-seam fixture (#612)', minBase: 0,
    files: {
      ['bin/' + name]: { project: 'src/' + name + '/bin.json' },
      'share/data.txt': { bin: 'assets/' + name + '/data.txt' },
      'share/readme.txt': { text: 'readme.txt' },
    },
    bin: { [name]: 'bin/' + name },
  };
  Object.assign(def, opts.defOverride || {});
  fs.writeFileSync(path.join(src, 'packages', name + '.json'), JSON.stringify(def, null, 2));
  return src;
}

function run(args) {
  return cp.spawnSync(process.execPath, [MKPKG, '--no-baseline', ...args],
    { cwd: ROOT, encoding: 'utf-8', timeout: 300000 });
}
function tarOf(outDir, idx, name) {
  return zlib.gunzipSync(fs.readFileSync(path.join(outDir, idx.packages[name].payload.url)));
}

const cleanups = [];
try {
  // --- 1. positive control: compiled def + asset entirely outside c-compiler
  const sib = makeSource('blockdemo');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-defs-out-'));
  cleanups.push(sib, out);
  {
    const r = run(['blockdemo', 'blockdemo-sources', `--defs=${sib}`, `--out=${out}`]);
    check('positive: mkpkg --defs builds a compiled sibling def', r.status === 0,
      'exit ' + r.status + '  ' + r.stderr);
    const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf-8'));
    check('positive: index carries the sibling package + its -sources companion',
      !!idx.packages.blockdemo && !!idx.packages['blockdemo-sources'],
      Object.keys(idx.packages || {}).join(','));
    const tar = tarOf(out, idx, 'blockdemo');
    const at = tar.indexOf('opt/blockdemo/bin/blockdemo');
    check('positive: payload has the compiled binary member', at >= 0);
    // The member's bytes start 512 B (one tar header) after its name field's
    // header start; cheaper and just as sharp: the wasm magic appears AND the
    // asset bytes appear verbatim.
    check('positive: payload carries wasm magic', tar.includes(WASM_MAGIC));
    check('positive: payload carries the sibling asset bytes', tar.includes(ASSET));
    check('positive: payload carries the inlined text entry', tar.includes('sibling text entry'));
    const srcTar = tarOf(out, idx, 'blockdemo-sources');
    check('positive: -sources companion mirrors the SIBLING tree (design §5d)',
      srcTar.includes('opt/blockdemo-sources/src/blockdemo/main.c') &&
      srcTar.includes('opt/blockdemo-sources/src/blockdemo/bin.json'));

    // Freshness: a second run must REUSE (the assetRoot scan sees the sibling
    // inputs — a scan rooted in c-compiler would restale or, worse, never
    // notice a sibling edit).
    const r2 = run(['blockdemo', `--defs=${sib}`, `--out=${out}`]);
    check('positive: unchanged sibling inputs reuse the pool payload',
      r2.status === 0 && /reusing/.test(r2.stderr), 'exit ' + r2.status + '  ' + r2.stderr);
    // ...and a touched sibling source restales it.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(sib, 'src', 'blockdemo', 'main.c'), future, future);
    const r3 = run(['blockdemo', `--defs=${sib}`, `--out=${out}`]);
    check('positive: a touched sibling source rebuilds',
      r3.status === 0 && /building/.test(r3.stderr), 'exit ' + r3.status + '  ' + r3.stderr);
  }

  // --- 5. newestPkgInput assetRoot (in-process pin of the same fact)
  {
    const def = JSON.parse(fs.readFileSync(path.join(sib, 'packages', 'blockdemo.json'), 'utf-8'));
    const inp = COMMON.newestPkgInput(fs, path, ROOT, 'blockdemo', def, {
      pkgDir: path.join(sib, 'packages'), assetRoot: sib,
    });
    check('newestPkgInput: the newest input is the touched SIBLING source',
      inp.path === path.join(sib, 'src', 'blockdemo', 'main.c'), inp.path);
  }

  // --- 2. collision red controls
  {
    const sib2 = makeSource('blockdemo');
    cleanups.push(sib2);
    const r = run(['blockdemo', `--defs=${sib}`, `--defs=${sib2}`, `--out=${out}`]);
    check('collision: sibling-vs-sibling duplicate refuses', r.status === 1, 'exit ' + r.status);
    check('collision: the refusal names BOTH files',
      r.stderr.includes(path.join(sib, 'packages', 'blockdemo.json')) &&
      r.stderr.includes(path.join(sib2, 'packages', 'blockdemo.json')), r.stderr);

    // vs source 0: shadow a REAL packages/ name (read from the live list so
    // this never goes stale against the repo).
    const realName = COMMON.listPackages(fs, path, ROOT, {})[0];
    check('collision fixture: the repo has at least one real package', !!realName);
    const sib3 = makeSource(realName);
    cleanups.push(sib3);
    const r0 = run([`--defs=${sib3}`, `--out=${out}`]);
    check('collision: a sibling shadowing a source-0 package refuses', r0.status === 1, 'exit ' + r0.status);
    check('collision: names the source-0 file and the sibling file',
      r0.stderr.includes(path.join(ROOT, 'packages', realName + '.json')) &&
      r0.stderr.includes(path.join(sib3, 'packages', realName + '.json')), r0.stderr);

    // The refusal fires BEFORE the gating filter: a producer-GATED duplicate
    // collides on a plain enumeration too (in-process — the gate would
    // otherwise hide the pair from a base build).
    const sib4 = makeSource('blockdemo', { defOverride: { requires: 'native-sibling:clang' } });
    cleanups.push(sib4);
    let threw = null;
    try { COMMON.listPackages(fs, path, ROOT, { defs: [sib, sib4] }); }
    catch (e) { threw = e; }
    check('collision: a GATED duplicate still refuses (pre-gating check)',
      threw !== null && /blockdemo/.test(String(threw && threw.message)), String(threw));
  }

  // --- 3. --defs preflight is loud
  {
    const missing = run([`--defs=${path.join(os.tmpdir(), 'no-such-defs-root-612')}`, `--out=${out}`]);
    check('preflight: missing --defs root exits 1 naming it',
      missing.status === 1 && /--defs root not found/.test(missing.stderr), missing.stderr);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-defs-bare-'));
    cleanups.push(bare);
    const nopkgs = run([`--defs=${bare}`, `--out=${out}`]);
    check('preflight: --defs root without packages/ exits 1',
      nopkgs.status === 1 && /has no packages\/ dir/.test(nopkgs.stderr), nopkgs.stderr);
    const twice = run([`--defs=${sib}`, `--defs=${sib}`, `--out=${out}`]);
    check('preflight: the same root twice exits 1',
      twice.status === 1 && /already in the source list/.test(twice.stderr), twice.stderr);
  }

  // --- 4. foldPackages: the folded manifest stays rootDir-relative
  {
    const manifest = { version: 1, system: { dirs: [], files: {} } };
    const folded = COMMON.foldPackages(fs, path, ROOT, manifest, ['blockdemo'],
      { packagesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-defs-p0-')), defs: [sib] }).manifest;
    const binEntry = folded.system.files['/usr/opt/blockdemo/bin/blockdemo'];
    const dataEntry = folded.system.files['/usr/opt/blockdemo/share/data.txt'];
    const textEntry = folded.system.files['/usr/opt/blockdemo/share/readme.txt'];
    check('fold: the compiled entry is claimed with a RELOCATED project path',
      !!binEntry && typeof binEntry.project === 'string' &&
      fs.existsSync(path.join(ROOT, binEntry.project)), JSON.stringify(binEntry));
    check('fold: the bin entry relocates to a ROOT-resolvable path',
      !!dataEntry && fs.existsSync(path.join(ROOT, dataEntry.bin)) &&
      fs.readFileSync(path.join(ROOT, dataEntry.bin), 'utf-8') === ASSET,
      JSON.stringify(dataEntry));
    check('fold: the text entry inlines as content',
      !!textEntry && textEntry.text === undefined && textEntry.content === 'sibling text entry\n',
      JSON.stringify(textEntry));
    check('fold: /usr/bin symlink + control.json planted as for any package',
      !!folded.system.files['/usr/bin/blockdemo'] &&
      !!folded.system.files['/usr/opt/blockdemo/control.json']);
    // The load-bearing half: a ROOT-bound reader (exactly bakeSystemImage's
    // binding) really COMPILES the folded project entry.
    const wasm = COMMON.buildProject(CompilerJS, binEntry.project,
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'));
    check('fold: buildProject over the folded path yields wasm via ROOT-bound readers',
      wasm && wasm.length > 8 && Buffer.from(wasm.slice(0, 4)).equals(WASM_MAGIC),
      wasm && wasm.length);

    // A sibling `c` entry cannot fold — loud, with the named fix.
    const sibC = makeSource('cdemo', {
      defOverride: { files: { tool: { c: 'tool.c' } }, bin: undefined },
    });
    cleanups.push(sibC);
    fs.writeFileSync(path.join(sibC, 'os', 'tool.c'), 'int main(void){return 0;}\n');
    let threw = null;
    try {
      COMMON.foldPackages(fs, path, ROOT, manifest, ['cdemo'],
        { packagesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-defs-p0-')), defs: [sibC] });
    } catch (e) { threw = e; }
    check('fold: a sibling `c` entry refuses with the named `project` fix',
      threw !== null && /`c` entry/.test(String(threw.message)) && /project/.test(String(threw.message)),
      String(threw));
  }
} finally {
  for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
}

if (failures) { console.log('FAIL (' + failures + ')'); process.exit(1); }
console.log('PASS');
