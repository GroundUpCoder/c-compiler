#!/usr/bin/env node
// tools/mkpkg.js — build gucman packages (gucman Slice 1).
//
// Input: packages/<name>.json — a package definition whose `files` entries
// use the SAME vocab as os/image.json (project/bin/text/content/c; `link`
// is refused — the v1 tar+gzip payload carries files and dirs only), plus
// the declarative surface gucman plants at install time:
//   { name, version, summary, [minBase], [deps],
//     files: { "<rel>": <image.json entry> },
//     bin:   { "<cmd>": "<rel>" },          // /usr/local/bin/<cmd> symlinks
//     openwith: { "<ext>": "<cmd>" },       // /etc/openwith delta keys
//     menu:  [ { group, entry, cmd } ] }    // /etc/menu/<group>/<entry>
//
// The package tree is assembled by the EXACT bake pipeline — os-common's
// seedEntries/buildProject/createCcDriver over an in-memory BlockFS — so a
// packaged binary is byte-identical to the same entry baked into the system
// blob (the --packages=all fixture fold and this tool share one compile
// path by construction).
//
// Output (dist/packages/ — the repo layout a Pages deploy publishes at
// /packages/*, and what serve.js serves there for the dev origin):
//   pool/<name>_<version>_<sha256pre16>.pkg.tar.gz   content-addressed payload
//   index.json                                       the repo index gucman fetches
//
// Payload = ustar tarball of one top-level control.json (the declarative
// manifest gucman replays: name/version/summary/bin/openwith/menu) + the
// package tree under opt/<name>/**, gzipped. Deterministic: sorted members,
// mtime 0, uid/gid 0, fixed gzip level — same inputs, same sha256.
//
//   node tools/mkpkg.js                # build every packages/<name>.json
//   node tools/mkpkg.js punes          # build specific packages
//   node tools/mkpkg.js --out=DIR --force --quiet
//
// A package whose pool payload is newer than all its inputs (compiler.js,
// this tool, its definition, its files' project/bin/asset closure) is
// REUSED, not rebuilt (--force overrides); index.json is rewritten every
// run (baseVersion/minBase track os/image.json).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OS_DIR = path.join(ROOT, 'os');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(OS_DIR, 'os-common.js'));

let outDir = path.join(ROOT, 'dist', 'packages');
let quiet = false;
let force = false;
const requested = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--out=')) outDir = path.resolve(a.slice(6));
  else if (a === '--quiet') quiet = true;
  else if (a === '--force') force = true;
  else if (a.startsWith('-')) {
    process.stderr.write(`mkpkg: unknown option ${a}\n`);
    process.exit(2);
  } else requested.push(a);
}
const log = quiet ? () => {} : (m) => process.stderr.write('[mkpkg] ' + m + '\n');

const imageManifest = JSON.parse(fs.readFileSync(path.join(OS_DIR, 'image.json'), 'utf-8'));
const avail = COMMON.listPackages(fs, path, ROOT);
const names = requested.length ? requested : avail;
for (const n of names) {
  if (!avail.includes(n)) {
    process.stderr.write(`mkpkg: unknown package '${n}' (declared in packages/: ${avail.join(', ') || 'none'})\n`);
    process.exit(2);
  }
}

/* ---- package-input freshness (the 0082 idea, scoped to one package) ----
 * Newest mtime across everything that can change this package's payload
 * bytes: the toolchain (compiler.js — buildProject/createCcDriver output),
 * this tool (tar/control encoding), the definition, and each file entry's
 * closure (project dirs through deps, `bin` blobs, os/-relative `c`/`text`
 * assets). Deliberately NARROW — the os/ tree at large is not an input, so
 * unrelated OS work doesn't force a punes recompile in the dev loop. */
function newestPkgInput(name, pkg) {
  const newest = { mtimeMs: 0, path: null };
  const seenDirs = {};
  const seenProjects = {};
  const statFile = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isFile() && st.mtimeMs > newest.mtimeMs) { newest.mtimeMs = st.mtimeMs; newest.path = p; }
  };
  const walk = (dir) => {
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { return; }
    if (seenDirs[real]) return;
    seenDirs[real] = true;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.charAt(0) === '.') continue;
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (!/\.(img|md)$/.test(e.name)) statFile(path.join(dir, e.name));
    }
  };
  const normalize = (p) => {   // "a/b/../c" -> "a/c" (buildProject's rule)
    const out = [];
    p.split('/').forEach((seg) => {
      if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
      else if (seg !== '.') out.push(seg);
    });
    return out.join('/');
  };
  const addProject = (rel) => {
    const n = normalize(rel);
    if (seenProjects[n]) return;
    seenProjects[n] = true;
    const dir = n.slice(0, n.lastIndexOf('/'));
    walk(path.join(ROOT, dir));
    let proj;
    try { proj = JSON.parse(fs.readFileSync(path.join(ROOT, n), 'utf-8')); } catch (e) { return; }
    (proj.deps || []).forEach((d) => addProject(dir + '/' + d));
  };
  statFile(path.join(ROOT, 'compiler.js'));
  statFile(path.join(ROOT, 'tools', 'mkpkg.js'));
  statFile(path.join(ROOT, 'packages', name + '.json'));
  for (const rel of Object.keys(pkg.files || {})) {
    const entry = pkg.files[rel];
    if (entry.project !== undefined) addProject(entry.project);
    if (entry.bin !== undefined) statFile(path.join(ROOT, entry.bin));
    if (entry.text !== undefined) statFile(path.join(OS_DIR, entry.text));
    if (entry.c !== undefined) {
      statFile(path.join(OS_DIR, entry.c));
      (entry.hdrs || []).forEach((h) => statFile(path.join(OS_DIR, h)));
    }
  }
  return newest;
}

/* ---- deterministic ustar writer ---- */
function octal(buf, off, len, val) {
  buf.write(val.toString(8).padStart(len - 1, '0'), off, 'ascii');
  buf[off + len - 1] = 0;
}
function tarHeader(name, size, mode, typeflag) {
  const b = Buffer.alloc(512);
  let nm = name, prefix = '';
  if (Buffer.byteLength(nm) > 100) {
    // ustar split: prefix "/" name; split at the last '/' that fits both.
    const i = nm.slice(0, 156).lastIndexOf('/');
    if (i <= 0 || Buffer.byteLength(nm.slice(i + 1)) > 100) {
      throw new Error(`mkpkg: tar member name too long: ${name}`);
    }
    prefix = nm.slice(0, i);
    nm = nm.slice(i + 1);
  }
  b.write(nm, 0, 'utf8');
  octal(b, 100, 8, mode);
  octal(b, 108, 8, 0);            // uid
  octal(b, 116, 8, 0);            // gid
  octal(b, 124, 12, size);
  octal(b, 136, 12, 0);           // mtime 0 — deterministic payloads
  b.fill(0x20, 148, 156);         // chksum field spaces while summing
  b.write(typeflag, 156, 'ascii');
  b.write('ustar', 257, 'ascii'); // magic + version "00"
  b.write('00', 263, 'ascii');
  if (prefix) b.write(prefix, 345, 'utf8');
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
    if (m.dir) {
      parts.push(tarHeader(m.name + '/', 0, 0o755, '5'));
    } else {
      parts.push(tarHeader(m.name, m.data.length, m.mode, '0'));
      parts.push(m.data);
      const pad = (512 - (m.data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));   // end-of-archive
  return Buffer.concat(parts);
}

/* ---- assemble one package tree via the bake pipeline ---- */
async function assembleTree(name, pkg) {
  const store = new BLOCK_FS.MemoryByteStore(1 << 20);
  const mfs = BLOCK_FS.createV4(store, { noDevNodes: true });
  mfs.mkdir('/etc', 0o755);   // seedEntries' c-compile staging area
  const base = '/opt/' + name;
  const section = { dirs: ['/opt', base], files: {} };
  for (const rel of Object.keys(pkg.files).sort()) {
    const entry = pkg.files[rel];
    if (entry.link !== undefined) {
      throw new Error(`package '${name}': ${rel} — link entries are not supported in packages (v1 tar+gzip payloads carry files and dirs only)`);
    }
    const parts = rel.split('/');
    let cur = base;
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      if (!section.dirs.includes(cur)) section.dirs.push(cur);
    }
    section.files[base + '/' + rel] = entry;
  }
  await COMMON.seedEntries(mfs, section, {
    readAsset: (n) => fs.readFileSync(path.join(OS_DIR, n), 'utf-8'),
    readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
    buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
    compile: COMMON.createCcDriver(CompilerJS, mfs),
    log: () => {},
  });
  // Walk the assembled tree into sorted tar members (dirs before children).
  const members = [];
  const walk = (abs, rel) => {
    const dh = mfs.opendir(abs);
    if (dh === null) throw new Error(`mkpkg: cannot list ${abs}`);
    const names = [];
    for (let e; (e = mfs.readdir(dh)) !== null;) {
      if (e.name !== '.' && e.name !== '..') names.push(e.name);
    }
    mfs.closedir(dh);
    for (const n of names.sort()) {
      const cAbs = abs + '/' + n, cRel = rel + '/' + n;
      const st = mfs.stat(cAbs);
      if (st === null) throw new Error(`mkpkg: cannot stat ${cAbs}`);
      if ((st.mode & 0o170000) === 0o040000) {
        members.push({ name: cRel, dir: true });
        walk(cAbs, cRel);
      } else {
        const bytes = COMMON.readFileBytes(mfs, cAbs);
        members.push({ name: cRel, data: Buffer.from(bytes), mode: (st.mode & 0o111) ? 0o755 : 0o644 });
      }
    }
  };
  members.push({ name: 'opt', dir: true });
  members.push({ name: 'opt/' + name, dir: true });
  walk(base, 'opt/' + name);
  return members;
}

/* ---- build / reuse one package; returns its index entry ---- */
async function buildPackage(name, poolDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', name + '.json'), 'utf-8'));
  if (pkg.name !== name) throw new Error(`packages/${name}.json declares name ${JSON.stringify(pkg.name)}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pkg.name)) throw new Error(`package '${name}': bad name`);
  if (typeof pkg.version !== 'string' || !/^[A-Za-z0-9._-]+$/.test(pkg.version)) {
    throw new Error(`package '${name}': bad version ${JSON.stringify(pkg.version)}`);
  }
  if (!pkg.files || !Object.keys(pkg.files).length) throw new Error(`package '${name}': no files`);
  const bin = pkg.bin || {};
  for (const cmd of Object.keys(bin)) {
    if (!pkg.files[bin[cmd]]) throw new Error(`package '${name}': bin ${cmd} -> ${bin[cmd]} names no package file`);
  }
  for (const ext of Object.keys(pkg.openwith || {})) {
    if (!bin[pkg.openwith[ext]]) throw new Error(`package '${name}': openwith ${ext} -> ${pkg.openwith[ext]} names no bin command`);
  }
  for (const me of pkg.menu || []) {
    if (!me.group || !me.entry || !bin[me.cmd]) throw new Error(`package '${name}': bad menu entry ${JSON.stringify(me)}`);
  }

  const entryFor = (file, sha, size) => ({
    version: pkg.version,
    summary: pkg.summary || '',
    minBase: pkg.minBase !== undefined ? (pkg.minBase | 0) : (imageManifest.version | 0),
    deps: pkg.deps || [],
    payload: { format: 'tar+gzip', url: 'pool/' + file, size, sha256: sha },
  });

  // Reuse a fresh payload (same version, newer than every input).
  const poolRe = new RegExp('^' + name + '_' + pkg.version.replace(/[.]/g, '\\.') + '_[0-9a-f]{16}\\.pkg\\.tar\\.gz$');
  const existing = fs.existsSync(poolDir) ? fs.readdirSync(poolDir).filter((f) => poolRe.test(f)) : [];
  if (!force && existing.length === 1) {
    const p = path.join(poolDir, existing[0]);
    const inp = newestPkgInput(name, pkg);
    if (fs.statSync(p).mtimeMs >= inp.mtimeMs) {
      const bytes = fs.readFileSync(p);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (existing[0].includes('_' + sha.slice(0, 16) + '.')) {
        log(`${name} ${pkg.version}: pool payload fresh — reusing ${existing[0]}`);
        return entryFor(existing[0], sha, bytes.length);
      }
    }
  }

  log(`${name} ${pkg.version}: building…`);
  const t0 = Date.now();
  const control = {
    name: pkg.name,
    version: pkg.version,
    summary: pkg.summary || '',
    bin,
    openwith: pkg.openwith || {},
    menu: pkg.menu || [],
  };
  const members = [
    { name: 'control.json', data: Buffer.from(JSON.stringify(control, null, 2) + '\n'), mode: 0o644 },
    ...await assembleTree(name, pkg),
  ];
  const gz = zlib.gzipSync(tarball(members), { level: 9 });
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const file = `${name}_${pkg.version}_${sha.slice(0, 16)}.pkg.tar.gz`;
  fs.mkdirSync(poolDir, { recursive: true });
  const tmp = path.join(poolDir, file + '.tmp-' + process.pid);
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, path.join(poolDir, file));
  for (const old of fs.readdirSync(poolDir)) {   // drop superseded payloads
    if (old !== file && old.startsWith(name + '_') && old.endsWith('.pkg.tar.gz')) {
      fs.unlinkSync(path.join(poolDir, old));
    }
  }
  log(`${name} ${pkg.version}: ${file} (${(gz.length / (1 << 20)).toFixed(1)} MiB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return entryFor(file, sha, gz.length);
}

async function main() {
  const poolDir = path.join(outDir, 'pool');
  const index = {
    schemaVersion: 1,
    baseVersion: imageManifest.version | 0,
    packages: {},
  };
  // Rebuild requested packages; carry every other declared package's entry
  // forward so a single-package invocation still writes a complete index.
  for (const n of avail) {
    if (names.includes(n)) {
      index.packages[n] = await buildPackage(n, poolDir);
    } else {
      const prev = readIndex();
      if (prev && prev.packages && prev.packages[n]) index.packages[n] = prev.packages[n];
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, 'index.json.tmp-' + process.pid);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(tmp, path.join(outDir, 'index.json'));
  // Prune orphans: a package REMOVED from packages/ drops out of the index
  // above, but its old payload would sit in pool/ forever (and deploys copy
  // the whole pool dir). Anything the fresh index doesn't reference goes.
  const live = new Set(Object.values(index.packages).map((p) => path.basename(p.payload.url)));
  if (fs.existsSync(poolDir)) {
    for (const f of fs.readdirSync(poolDir)) {
      if (!live.has(f)) {
        fs.unlinkSync(path.join(poolDir, f));
        log(`pruned orphan pool payload ${f}`);
      }
    }
  }
  log(`index.json: ${Object.keys(index.packages).length} package(s), baseVersion ${index.baseVersion}`);
}
let cachedIndex = null, cachedIndexRead = false;
function readIndex() {
  if (!cachedIndexRead) {
    cachedIndexRead = true;
    try { cachedIndex = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf-8')); }
    catch (e) { cachedIndex = null; }
  }
  return cachedIndex;
}

main().catch((e) => {
  process.stderr.write('mkpkg failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
