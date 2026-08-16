'use strict';
// Shared OS boot driver for the headless kernel e2e tests (todos/0146).
//
// Every `*_e2e.js` used to reimplement the same boilerplate inline: an
// mkdtemp image dir + `os.img` path, a `node os/boot.js --image=<img> --quiet`
// spawn with the test script piped on stdin, and the `if (r.error) throw`
// guard. This is that seam — the ONE place the future `wmctl wait` (0083)
// integrates, instead of the driver being copy-pasted per file.
//
//   const { driveBoot, freshImage, section } = require('./lib/drive.js');
//
//   // single session: driveBoot mints a throwaway image for you
//   const r = driveBoot(['winbox &', 'sleep 2', 'echo ==l1', 'wmctl list']);
//   const list = section(r.stdout, 'l1');
//
//   // multi-session (seed then read the shots back over the SAME image):
//   const { dir, image } = freshImage('os-apps-');
//   driveBoot(seedScript, { image, timeout: 300000 });
//   const back = driveBoot('cat /root/a.png\n', { image, encoding: null,
//                                                 maxBuffer: 32 * 1024 * 1024 });
//   fs.rmSync(dir, { recursive: true, force: true });
//
// driveBoot returns the raw spawnSync result (stdout/stderr/status/signal),
// throwing only on spawn error — callers keep asserting on stdout exactly as
// before. The chosen image path is attached as `r.image` for convenience.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { mkdtempOwned } = require('../../lib/harness-temp.js');

// lib/ sits one level below tests/kernel/, which is two below the repo root.
const ROOT = path.resolve(__dirname, '../../..');
const BOOT = path.join(ROOT, 'os/boot.js');

// A fresh throwaway image: an mkdtemp dir + its `os.img` path.
//
// The dir is now OWNED, not leaked. The old contract here was "the caller owns
// cleanup; most e2es leak the tmpdir like they always did and let the OS sweep
// /tmp" — but macOS never sweeps /var/folders on any useful horizon and each of
// these is 144-197 MB, so runs that died abruptly piled up 779 dirs / 49 GB and
// filled the disk. ENOSPC then surfaced as test timeouts and spurious failures,
// i.e. as a product regression that was not one.
//
// mkdtempOwned tags the dir with THIS process's pid and registers it for
// process-lifetime cleanup (tests/lib/harness-temp.js). Callers that already
// rmSync it explicitly are unaffected — rm is force:true and idempotent. The pid
// tag is what lets the next run's startup reaper tell an abandoned dir from one
// a live test is using right now, so a SIGKILLed run cleans up too.
function freshImage(prefix = 'os-e2e-') {
  const dir = mkdtempOwned(prefix);
  return { dir, image: path.join(dir, 'os.img') };
}

// Pipe `script` to `os/boot.js --image=<image> --quiet [...args]`.
//   script    a string (piped verbatim) or an array of shell lines (joined
//             with '\n'); a trailing newline is guaranteed so the final
//             command always runs even without the classic trailing '' entry.
// opts:
//   image     reuse this image path (default: a fresh throwaway one)
//   prefix    mkdtemp prefix when minting a fresh image (default 'os-e2e-')
//   args      extra boot.js flags, e.g. ['--tty-out']
//   timeout   spawn timeout ms (default 300000)
//   maxBuffer stdout cap (default node's — pass for big shot cat-backs)
//   encoding  stdout encoding (default 'utf8'; pass null/'buffer' for raw
//             Buffer output, e.g. reading binary PNG frames back)
function driveBoot(script, opts = {}) {
  const image = opts.image || freshImage(opts.prefix).image;
  let input = Array.isArray(script) ? script.join('\n') : String(script);
  if (!input.endsWith('\n')) input += '\n';

  const spawnOpts = { input, timeout: opts.timeout != null ? opts.timeout : 300000 };
  const enc = 'encoding' in opts ? opts.encoding : 'utf8';
  if (enc != null && enc !== 'buffer') spawnOpts.encoding = enc;   // else raw Buffer
  if (opts.maxBuffer) spawnOpts.maxBuffer = opts.maxBuffer;

  // opts.nodeArgs: node/V8 flags BEFORE the script (e.g.
  // `--wasm-max-mem-pages=N` to bound every wasm instance's heap — the
  // deterministic-OOM knob for the comdlg-diag test; worker_threads
  // inherit the process's V8 flags).
  const args = [...(opts.nodeArgs || []), BOOT, '--image=' + image,
                ...(opts.quiet === false ? [] : ['--quiet']), ...(opts.args || [])];
  const r = cp.spawnSync('node', args, spawnOpts);
  if (r.error) throw r.error;
  r.image = image;   // let a follow-up session reuse the same image
  // Heavy-lock refusal propagation (todos/0342): boot.js exits 3 with a
  // `[heavy-lock]` stderr marker when another heavy test job owns the host.
  // That is NOT a test failure — surface the boot's refusal verbatim and exit
  // 3 ourselves, so `node tests/kernel/<e2e>.js` names the holder instead of
  // failing later on a missing marker. Exit 3 alone is not the signal (init
  // can exit 3 legitimately, e.g. `sh -c 'exit 3'`); require the marker too.
  if (r.status === 3 && String(r.stderr || '').includes('[heavy-lock]')) {
    process.stderr.write(String(r.stderr));
    process.exit(3);
  }
  // Loud-symptom gate (todos/0171): a `wmctl wait` that can't be satisfied
  // prints `wmctl: wait X timed out after Nms` and exits 1 — but a script
  // with no `set -e` just burns the full timeout and sails on, so a wait on
  // an unreachable condition passes SLOWLY instead of failing. (That is how
  // the AQ_GETTEXT-can't-see-popup bug hid: fileman_ops was 117s of dead
  // waits.) Any real timeout is a bug — no e2e legitimately expects one
  // (absence checks use nowin/nolabel, which succeed on absence). Surface it
  // as a hard failure naming every timed-out condition. Opt out with
  // opts.allowWaitTimeout for a deliberate negative wait test.
  if (!opts.allowWaitTimeout) {
    const hay = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const hits = hay.match(/wmctl: wait .* timed out after \d+ms/g);
    if (hits) {
      const uniq = Array.from(new Set(hits));
      // Locate the failure: the stdout tail up to (and including) the first
      // timeout line shows which script leg was running — without it the
      // error names the symptom but not the site.
      const so = String(r.stdout || '');
      const at = so.search(/wmctl: wait .* timed out after \d+ms/);
      const tail = (at >= 0 ? so.slice(0, at) : so).split('\n').slice(-12);
      throw new Error('driveBoot: wmctl wait timed out (a wait on an ' +
        'unreachable condition — root-cause it, do not lengthen the timeout):\n  ' +
        uniq.join('\n  ') +
        '\n--- stdout tail before the first timeout ---\n' + tail.join('\n'));
    }
  }
  return r;
}

// The `==marker\n … ==` marker-grep every e2e reimplements: return the slice
// of `out` between `==<name>\n` and the next `==` (or end of output). Empty
// string when the marker is absent. Matches the inline `section()` helper the
// ctxmenu/recycle/… tests carry.
function section(out, name) {
  const parts = String(out).split('==' + name + '\n');
  return parts.length > 1 ? parts[1].split('==')[0] : '';
}

// ---- the seeded desktop grid model (todos/0184/0185) ----
// The seeded /root/Desktop set is DERIVED from os/image.json's user section
// plus default packages that explicitly preserve a built-in Desktop shortcut
// (the todos/0166 rule: a new seeded icon must not silently shift hardcoded
// rows) — FILES and DIRS, direct children only (the deck links inside
// Presentations/ are not icons), plus wm.c's always-recreated Recycle Bin.
// deskSort replicates wm.c entcmp exactly: Recycle Bin last, dirs first,
// byte-order strcmp. deskCell maps a name to its column-major cell — 0184
// pushed the seeded set past one column at 1024x768 (11 rows/col), so
// column-0 math is no longer safe. Entries are {name, dir}; `extras` folds
// in a test's runtime-created entries (string = plain file) before sorting.
function deskEntries(extras = []) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8'));
  const u = manifest.user;
  const child = (p) => {
    if (!p.startsWith('/root/Desktop/')) return null;
    const n = p.slice('/root/Desktop/'.length);
    return n && !n.includes('/') ? n : null;
  };
  const ents = [];
  for (const p of Object.keys(u.files)) {
    const n = child(p);
    if (n) ents.push({ name: n, dir: false });
  }
  for (const p of u.dirs || []) {
    const n = child(p);
    if (n) ents.push({ name: n, dir: true });
  }
  for (const name of manifest.defaultPackages || []) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'packages', name + '.json'), 'utf8'));
    if (pkg.desktop && pkg.desktop.default === true) ents.push({ name, dir: false });
  }
  ents.push({ name: 'Recycle Bin', dir: false });   // wm.c ensure_recycle
  return deskSort(ents.concat(
    extras.map((e) => typeof e === 'string' ? { name: e, dir: false } : e)));
}
function deskSort(ents) {
  return ents.slice().sort((a, b) => {
    const ra = a.name === 'Recycle Bin' ? 1 : 0,
          rb = b.name === 'Recycle Bin' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const da = a.dir ? 1 : 0, db = b.dir ? 1 : 0;
    if (da !== db) return db - da;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }).map((e) => e.name);
}
// wm.c geometry (font-20 retune): 16px margin, 116x96 cells, 36px
// taskbar; rows/col = (scrH - 68) / 96 (7 at the e2es' 1024x768). x/y are
// the cell origin; cx/cy the icon-click center (the hit test is
// cell-granular, so mid-cell is safe).
function deskCell(list, name, scrH = 768) {
  const rows = Math.max(1, Math.floor((scrH - 36 - 32) / 96));
  const i = list.indexOf(name);
  if (i < 0) throw new Error('deskCell: "' + name + '" not on the desktop');
  const col = Math.floor(i / rows), row = i % rows;
  return { index: i, col, row, rows,
           x: 16 + col * 116, y: 16 + row * 96,
           cx: 16 + col * 116 + 58, cy: 16 + row * 96 + 48 };
}

// ---- the baked Start-menu tree model (the 0164/0166 rule applied to menu
// rows — a291187/0272 added a Demos entry and the hardcoded DEMOS lists in
// wm_service/os-shell silently clicked the wrong row for ~14h) ----
// The FAT test image (mkimage --packages=all, what image-fixture/serve.js
// bake) unions image.json's /usr/share/menu tree with every NON-GATED
// package's menu entries (foldPackages plants them at
// /usr/share/menu/<group>/<entry>; gating rule = os-common listPackages, the
// single source — a def with a non-empty `requires` stays out of the fold).
// A fresh boot has an empty /etc/menu, so the baked tree IS wm.c's
// menu_load_union result; sort replicates entcmp (groups first, byte strcmp;
// no Recycle Bin in menu land). menuGroups() = the top-level flyout rows,
// menuLeaves(group) = one group's rows.
function menuTree() {
  const OS_COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const sys = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8')).system;
  const kids = new Map();   // parent rel ('' = top) -> Map(name -> isDir)
  const put = (rel, dir) => {
    const i = rel.lastIndexOf('/');
    const parent = i < 0 ? '' : rel.slice(0, i);
    const name = i < 0 ? rel : rel.slice(i + 1);
    if (!kids.has(parent)) kids.set(parent, new Map());
    kids.get(parent).set(name, dir || kids.get(parent).get(name) || false);
  };
  const under = (p) => p.startsWith('/usr/share/menu/')
    ? p.slice('/usr/share/menu/'.length) : null;
  for (const p of sys.dirs || []) {
    const rel = under(p);
    if (rel) put(rel, true);
  }
  for (const p of Object.keys(sys.files || {})) {
    const rel = under(p);
    if (rel) put(rel, false);
  }
  for (const name of OS_COMMON.listPackages(fs, path, ROOT)) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'packages', name + '.json'), 'utf8'));
    for (const me of pkg.menu || []) {
      put(me.group, true);
      put(me.group + '/' + me.entry, false);
    }
  }
  return kids;
}
function menuSort(m) {
  return Array.from(m.entries()).sort((a, b) => {
    if (a[1] !== b[1]) return a[1] ? -1 : 1;              // groups first
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;        // byte strcmp
  }).map((e) => e[0]);
}
function menuGroups() { return menuSort(menuTree().get('') || new Map()); }
function menuLeaves(group) {
  const m = menuTree().get(group);
  if (!m) throw new Error('menuLeaves: no baked menu group "' + group + '"');
  return menuSort(m);
}

// ---- the seed-carrying package model (the gucman `seed` content resource
// kind; the 0166 "derive it, never hardcode it" rule applied to planted
// content) ----
// A package's `seed` section maps "<dest under /root>" -> "<payload-relative
// src>", and its `files` section says what the payload holds. pkgSeedPlants()
// composes the two into the exact /root paths a FAT image (or a `gucman
// install`) must carry — using os-common's OWN tree enumeration, so a test
// can never disagree with the bake about which files ship. Adding a file to
// a seeded tree therefore lands in the assertions automatically; nothing here
// lists a demo, a page or a count.
//   -> { files: ['/root/Desktop/.../index.html', ...],   sorted
//        dirs:  ['/root/Desktop/.../counter', ...] }      sorted, no dupes
function pkgSeedPlants(name) {
  const OS_COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const pkg = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'packages', name + '.json'), 'utf8'));
  const label = `package '${name}'`;

  // payload-relative path -> exists. `tree` expands; every other file kind
  // (bin/content/project/...) is one payload path named by its key.
  const payload = new Set();
  for (const [key, entry] of Object.entries(pkg.files || {})) {
    if (entry && entry.tree !== undefined) {
      for (const rel of OS_COMMON.listTreeFiles(fs, path, ROOT, entry, label)) {
        payload.add(key + '/' + rel);
      }
    } else {
      payload.add(key);
    }
  }

  const files = new Set(), dirs = new Set(), dests = [];
  for (const [dest, src] of Object.entries(pkg.seed || {})) {
    const base = '/root/' + dest;
    dests.push(base);
    for (const p of payload) {
      let rel = null;
      if (p === src) rel = '';
      else if (p.startsWith(src + '/')) rel = p.slice(src.length + 1);
      if (rel === null) continue;
      const abs = rel ? base + '/' + rel : base;
      files.add(abs);
      for (let i = abs.lastIndexOf('/'); i > '/root'.length; i = abs.lastIndexOf('/', i - 1)) {
        dirs.add(abs.slice(0, i));
      }
    }
  }
  return { files: [...files].sort(), dirs: [...dirs].sort(), dests: dests.sort() };
}

// Every package the FAT image folds (the non-gated set — os-common's
// listPackages is the single source), paired with what it seeds.
function bakedSeedPlants() {
  const OS_COMMON = require(path.join(ROOT, 'os/os-common.js'));
  return OS_COMMON.listPackages(fs, path, ROOT)
    .map((name) => ({ name, ...pkgSeedPlants(name) }))
    .filter((p) => p.dests.length > 0);
}

// The direct children of a /root directory on a FRESH boot, as the file
// manager sorts them (directories first, then byte-order strcmp) — the
// generalisation of deskEntries() to any user directory, and the model a
// test must navigate by. Two sources, both derived: image.json's `user`
// section and every baked package's seed plants. A new seed that lands in
// a folder a test walks therefore MOVES that test's rows automatically
// instead of silently breaking its DOWN-count.
//   -> [{ name, dir }] sorted; names(absDir) for just the labels
function userDirEntries(absDir) {
  const base = absDir.replace(/\/+$/, '');
  const u = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8')).user;
  const ents = new Map();
  const child = (p, dir) => {
    if (!p.startsWith(base + '/')) return;
    const n = p.slice(base.length + 1);
    if (!n || n.includes('/') || n.charAt(0) === '.') return;
    ents.set(n, (ents.get(n) || false) || dir);
  };
  for (const p of Object.keys(u.files || {})) child(p, false);
  for (const p of u.dirs || []) child(p, true);
  for (const p of bakedSeedPlants()) {
    for (const f of p.files) child(f, false);
    for (const d of p.dirs) child(d, true);
  }
  return [...ents.entries()]
    .map(([name, dir]) => ({ name, dir }))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1)
                                     : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

/* Read shots back OUT of a boot's root volume and decode them (#657).
 *
 * `wmctl shot`/`wmctl thumb` write PNG (os/wmctl.c); a test that shot to
 * /root/x.png reads it here AFTER the boot has exited, without a second
 * cat-back session and without the six lines of BlockFS boilerplate that
 * used to be copy-pasted into every file that does this.
 *
 *   const { d, bar } = readShots(tmp, { d: 'd.png', bar: 'bar.png' });
 *   check('desktop is 1024x768', d.w === 1024 && d.h === 768);
 *   check('empty area is teal', String(d.px(500, 400).slice(0, 3)) === '0,128,128');
 *
 * `tmp` is freshImage()'s dir. Names are relative to /root unless absolute.
 * A missing or undecodable shot THROWS naming the path — a shot the test
 * believes it took must never silently degrade into a skipped assertion.
 * Values are parsePng results: { w, h, rgba, px(x,y) -> [r,g,b,a], next }. */
function readShots(tmp, names) {
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const { parsePng } = require('../../lib/png.js');
  const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  const out = {};
  for (const key of Object.keys(names)) {
    const name = names[key];
    const abs = name.charAt(0) === '/' ? name : '/root/' + name;
    let raw;
    try { raw = COMMON.readFileBytes(ufs, abs); }
    catch (e) { throw new Error(`readShots: ${abs} is not in the image (${e.message})`); }
    if (!raw) throw new Error(`readShots: ${abs} is not in the image`);
    try { out[key] = parsePng(Buffer.from(raw)); }
    catch (e) { throw new Error(`readShots: ${abs} did not decode as PNG (${e.message})`); }
  }
  return out;
}

module.exports = { ROOT, BOOT, freshImage, driveBoot, section,
                   deskEntries, deskSort, deskCell,
                   menuGroups, menuLeaves, readShots,
                   pkgSeedPlants, bakedSeedPlants, userDirEntries };
