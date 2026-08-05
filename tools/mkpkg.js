#!/usr/bin/env node
// tools/mkpkg.js — build gucman packages (gucman Slice 1).
//
// Input: packages/<name>.json — a package definition whose `files` entries
// use the SAME vocab as os/image.json (project/bin/text/content/c; `link`
// is refused — the v1 tar+gzip payload carries files and dirs only), plus
// `tree` (win32 source-lib design §3.2, Node-only): a recursive directory
// copy `{"tree": "<repo-relative dir>", "exclude": [glob, ...]}` — dotfiles
// always excluded, symlinks refused (os-common listTreeFiles) — plus
// the declarative surface gucman plants at install time:
//   { name, version, summary, [minBase], [deps],
//     files: { "<rel>": <image.json entry> },
//     bin:   { "<cmd>": "<rel>" },          // /usr/local/bin/<cmd> symlinks
//     openwith: { "<ext>": "<cmd>" },       // /etc/openwith delta keys
//     commands: { "<name>": "<cmd>" },      // /etc/cmdalt claim lines: this
//                                           //   package provides dispatched
//                                           //   command <name> (todos/0338)
//     menu:  [ { group, entry, cmd } ],     // /etc/menu/<group>/<entry>
//     fonts: [ "<rel>" ],                   // /etc/fonts/fallback face lines
//     srclib: { include: ["<dir>"],         // source-lib §3.1: header +
//               src: { "<ns>": "<dir>" } }, //   require-source install tiers
//     seed:  { "<dest under /root>": "<rel>" } }  // the CONTENT resource
//                                           //   kind: copied into user
//                                           //   territory, never a symlink
//
// Besides the declared definitions, every build synthesizes the mechanical
// `<name>-sources` companion set (todos #407; os-common sourcePackageDefs):
// one source package per source-bearing unit — each ungated packages/ def
// with a project/c entry, and each os/image.json system binary — carrying
// the unit's compile closure at repo-relative paths plus
// srclib:{src:{<name>:'.'}}, so gucman plants the /usr/local/src/<name>
// namespace at install. Synthesized in memory only: listPackages, the
// fold, and the baked image never see them.
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
//   node tools/mkpkg.js --packages-dir=DIR   # read definitions from DIR
//                                            # instead of <repo>/packages
//   node tools/mkpkg.js --pool=DIR           # SHARED payload store (below)
//   node tools/mkpkg.js --clang [--clang-root=DIR] [--clang-unpackaged=FILE]
//   node tools/mkpkg.js --rust  [--rust-root=DIR]  [--rust-unpackaged=FILE]
//                                            # SUPERSET index over the enabled
//                                            # producers (independent booleans:
//                                            # neither, one, or both); the
//                                            # drift gate (below) reads each
//                                            # producer's exemption list
//
// A package whose pool payload is newer than all its inputs (compiler.js,
// this tool, its definition, its files' project/bin/asset closure) is
// REUSED, not rebuilt (--force overrides); index.json is rewritten every
// run (baseVersion/minBase track os/image.json).
//
// ---- one repo per writer: --pool and the concurrency guard (todos/0388) ----
//
// `index.json` + `pool/` are ONE repo, and a build REPLACES it: a base run's
// `avail` excludes every gated (`requires:"native-sibling:*"`) definition, so it rewrites
// the index without those names AND its orphan prune DELETES their payload
// bytes. Sequentially that is just the accepted clang/base thrash. Concurrently
// it is a race that silently retargets another builder's repo mid-read — and
// the dangerous direction is base-vs-base, where the result still LOOKS
// correct. So two builds must never share one output dir:
//
//   --pool=DIR  puts the expensive content-addressed payload store at DIR
//               instead of <out>/pool, so N isolated repos share ONE warm
//               cache (a cold build of the full set is ~90s; a reuse is ~0.1s).
//               <out>/pool is then materialized as a HARDLINKED VIEW of exactly
//               the payloads this index references — no byte copy, and each
//               repo's view is independently prunable.
//               🔴 A shared store is NEVER deleted from: both prunes (orphan
//               and superseded-version) are scoped to the private view, so a
//               concurrent builder can neither lose a payload it has already
//               indexed nor hit ENOENT materializing one. It is therefore
//               append-only and accumulates superseded payloads; that is what
//               makes it safe to share, and reclaiming it is `rm -rf` on the
//               store dir (the tests put theirs under the disposable build/).
//               Refcounted GC is deliberately NOT attempted — it would put the
//               deletes back, which is the whole bug.
//
// Independently, a lockfile refuses two concurrent builds of the SAME out dir
// (loud exit 1, self-healing across a killed holder) — isolation is the fix,
// but a future caller that forgets it gets a named failure, not an interleave.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Cross-tree preflight (todos/0341, extended by #142): writes dist/packages/
// in its own tree (and the prune REPLACES the repo there — todos/0388), so a
// foreign-cwd launch would rewrite another tree's package repo.
require(path.join(__dirname, '../tests/lib/tree-guard.js'))
  .assertSameTree(__dirname, { label: 'tools/mkpkg.js' });

const ROOT = path.resolve(__dirname, '..');
const OS_DIR = path.join(ROOT, 'os');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(OS_DIR, 'os-common.js'));

let outDir = path.join(ROOT, 'dist', 'packages');
let quiet = false;
let force = false;
// ---- native siblings (todos/0416; RUST.md §3 rule 4) ----------------------
// A NATIVE SIBLING is an out-of-repo producer of prebuilt payloads: one
// repository builds the binaries and publishes an `out-image/overlay.json`
// (overlay@1) manifest with a per-file sha256; this repository CONSUMES it
// and never invokes the producer's toolchain. `--<producer>` builds the
// SUPERSET index: it additionally includes the gated
// `requires:"native-sibling:<producer>"` package definitions (the *-clang /
// *-rust variants), whose `nativeApp`/`nativeFile` payloads are copied —
// sha256-verified — from that sibling's published overlay (for clang the
// same artifact the bake overlay consumes, CLANG-CPP-EPIC Part II §7).
// Plain mkpkg builds the BASE index — no gated name anywhere, by
// construction of listPackages' default filter. The producer flags are
// INDEPENDENT booleans: neither, one, or both, and the index is a superset
// over whatever was asked. `--<producer>-root=PATH` points at the sibling
// (default ../<repo>, the same relative convention as os/image.json's
// overlay manifest); a missing sibling/overlay under an EXPLICIT flag is a
// LOUD hard failure (exit 1 with the fix command), never a silent skip —
// an UNrequested absent sibling is a normal state and prints nothing
// (CLANG-CPP-EPIC §4 rule 2, RUST.md §3 rule 6).
// `--<producer>-unpackaged=FILE` overrides the drift gate's exemption list
// (see driftCheck) for the same reason --packages-dir exists: a test needs
// the allow-list branch without editing the shipped file.
const SIBLINGS = {
  clang: {
    repo: 'clang-simplified',
    root: path.resolve(ROOT, '..', 'clang-simplified'),
    overlayId: 'clang-apps',
    overlayProducer: (root) => path.join(root, 'wasm', 'tools', 'mk-overlay.mjs'),
    unpackaged: path.join(__dirname, 'clang-unpackaged.json'),
    what: 'the *-clang packages need the clang toolchain repo',
  },
  rust: {
    repo: 'gucos-rust',
    root: path.resolve(ROOT, '..', 'gucos-rust'),
    overlayId: 'rust-apps',
    overlayProducer: (root) => path.join(root, 'tools', 'mk-overlay.mjs'),
    unpackaged: path.join(__dirname, 'rust-unpackaged.json'),
    what: 'the *-rust packages need the Rust producer repo',
  },
};
const enabled = new Set();   // producers opted in on this run
// Where package DEFINITIONS are read from. The repo's packages/ dir is both
// a bake input and a shared mkpkg input, so a test that needs a throwaway
// definition points this at a tmpdir instead of writing into it (the same
// seam foldPackages/boot.js/mkimage.js expose as --packages-dir).
let pkgDir = path.join(ROOT, 'packages');
// The shared payload store (todos/0388). null = the classic layout, where the
// store IS <out>/pool and this tool owns it outright.
let poolStore = null;
const requested = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--out=')) { outDir = path.resolve(a.slice(6)); continue; }
  if (a.startsWith('--pool=')) { poolStore = path.resolve(a.slice(7)); continue; }
  if (a.startsWith('--packages-dir=')) { pkgDir = path.resolve(a.slice(15)); continue; }
  if (a === '--quiet') { quiet = true; continue; }
  if (a === '--force') { force = true; continue; }
  let handled = false;
  for (const p of Object.keys(SIBLINGS)) {
    if (a === '--' + p) { enabled.add(p); handled = true; }
    else if (a.startsWith(`--${p}-root=`)) { SIBLINGS[p].root = path.resolve(a.slice(p.length + 8)); handled = true; }
    else if (a.startsWith(`--${p}-unpackaged=`)) { SIBLINGS[p].unpackaged = path.resolve(a.slice(p.length + 14)); handled = true; }
    if (handled) break;
  }
  if (handled) continue;
  if (a.startsWith('-')) {
    process.stderr.write(`mkpkg: unknown option ${a}\n`);
    process.exit(2);
  }
  requested.push(a);
}
const log = quiet ? () => {} : (m) => process.stderr.write('[mkpkg] ' + m + '\n');

/* ---- one writer per out dir (todos/0388) --------------------------------
 * `index.json` + `pool/` are one replaceable unit, so two concurrent builds of
 * the same dir interleave into a repo that belongs to neither. Refuse LOUDLY
 * rather than produce one — a base-vs-base interleave yields a plausible index
 * and would otherwise mask, not cause, a failure. Self-healing: a lock whose
 * holder is gone (killed build, crashed CI step) is stolen, not obeyed. */
const LOCK = () => path.join(outDir, '.mkpkg-lock');
let lockHeld = false;
function holderAlive(pid) {
  try { process.kill(pid, 0); return true; }          // signal 0 = liveness probe
  catch (e) { return e.code === 'EPERM'; }            // EPERM = alive, not ours
}
function acquireLock() {
  fs.mkdirSync(outDir, { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, host: require('os').hostname(),
                                argv: process.argv.slice(2), at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(LOCK(), mine, { flag: 'wx' }); lockHeld = true; return; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(LOCK(), 'utf-8')); } catch (e) { /* torn/garbage -> steal */ }
    const sameHost = held && held.host === require('os').hostname();
    if (held && sameHost && holderAlive(held.pid)) {
      process.stderr.write(
        `mkpkg: another build already owns ${outDir}\n` +
        `  held by pid ${held.pid} since ${held.at} (${(held.argv || []).join(' ') || 'no args'})\n` +
        `  two builds of one repo interleave index.json and prune each other's pool\n` +
        `  payloads; give this build its own repo instead:\n` +
        `    node tools/mkpkg.js --out=<dir> --pool=<shared cache dir>\n`);
      process.exit(1);
    }
    log(`stale lock from pid ${held ? held.pid : '?'} — stealing`);
    try { fs.unlinkSync(LOCK()); } catch (e) { /* raced with the holder's release */ }
  }
  process.stderr.write(`mkpkg: could not acquire ${LOCK()}\n`);
  process.exit(1);
}
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    // Only drop it if it is still OURS — never unlink a lock we already lost.
    const held = JSON.parse(fs.readFileSync(LOCK(), 'utf-8'));
    if (held.pid === process.pid) fs.unlinkSync(LOCK());
  } catch (e) { /* already gone */ }
}
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1)); });
}

const imageManifest = JSON.parse(fs.readFileSync(path.join(OS_DIR, 'image.json'), 'utf-8'));

// A sibling's overlay artifact — the single source of every `nativeApp` /
// `nativeFile` payload of its producer. Resolved + hard-preflighted only
// under that producer's flag (the base pipeline never touches it). The
// bytes are verified through os-common's loadOverlays (the EXACT same
// sha256/size enforcement mkimage's bake uses — one verifier, no drift).
// Memoized per producer: read + verify once, index by absolute /usr path.
const overlayPathOf = (p) => path.join(SIBLINGS[p].root, 'out-image', 'overlay.json');
const _overlayMaps = {};
function siblingOverlay(p) {
  if (_overlayMaps[p]) return _overlayMaps[p];
  const loaded = COMMON.loadOverlays(
    [{ id: SIBLINGS[p].overlayId, manifestPath: overlayPathOf(p) }],
    COMMON.nodeOverlayIo(fs, path, crypto), false, log);
  const map = new Map();
  for (const f of loaded[0].files) map.set(f.path, f);
  _overlayMaps[p] = map;
  return map;
}
for (const p of enabled) {
  // Preflight each requested sibling BEFORE any build (same loud-failure
  // discipline as serve-with-clang.js §6): absence is a fatal, actionable
  // error — an explicit producer request never degrades to the base set.
  const S = SIBLINGS[p];
  if (!fs.existsSync(S.root)) {
    process.stderr.write(
      `mkpkg --${p}: ${S.repo} sibling not found at ${S.root}\n` +
      `  ${S.what} (plain mkpkg needs nothing)\n` +
      `  fix: clone it next to this repo, or pass --${p}-root=PATH\n`);
    process.exit(1);
  }
  if (!fs.existsSync(overlayPathOf(p))) {
    process.stderr.write(
      `mkpkg --${p}: sibling overlay artifact not found at ${overlayPathOf(p)}\n` +
      `  fix: node ${S.overlayProducer(S.root)}\n`);
    process.exit(1);
  }
}

/* ---- gate validation: an unknown `requires` value fails LOUD --------------
 * listPackages EXCLUDES any gated def whose value it cannot parse (that is
 * what keeps the base pure by construction) — but without this check a
 * typo'd gate would silently drop its package from EVERY enumeration
 * forever. Runs on every build, flags or none. */
for (const f of (fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir) : [])) {
  if (!/\.json$/.test(f)) continue;
  let req;
  try { req = JSON.parse(fs.readFileSync(path.join(pkgDir, f), 'utf-8')).requires; }
  catch (e) { continue; }   // malformed json fails loud in buildPackage, not here
  if (req === undefined || req === null || req === '') continue;
  const p = COMMON.nativeSiblingProducer(req);
  if (p === null || !SIBLINGS[p]) {
    process.stderr.write(
      `mkpkg: ${f} declares requires: ${JSON.stringify(req)}, which is not a known gate\n` +
      `  a gated definition names its producer: requires: "native-sibling:<producer>"\n` +
      `  known producers: ${Object.keys(SIBLINGS).join(', ')}\n`);
    process.exit(1);
  }
}

const avail = COMMON.listPackages(fs, path, ROOT, { producers: [...enabled], packagesDir: pkgDir });

/* ---- mechanical `<name>-sources` companions (todos #407) ----------------
 * Synthesized in memory from the ONE rule in os-common sourcePackageDefs —
 * never written into packages/, never visible to listPackages, so the fold
 * and the baked image are untouched by construction; sources ship
 * exclusively through this repo's index + pool and install like any other
 * package. Native-sibling packages get no unit (their source lives in the
 * producer repo, which publishes only binaries). */
const sourceUnits = new Map();
for (const u of COMMON.sourcePackageDefs(fs, path, ROOT, { packagesDir: pkgDir, imageManifest, CompilerJS })) {
  sourceUnits.set(u.name, u);
}
const allAvail = avail.concat([...sourceUnits.keys()]).sort();
const names = requested.length ? requested : allAvail;
for (const n of names) {
  if (!allAvail.includes(n)) {
    // Naming a gated package without its producer flag gets the actionable
    // message, not the generic unknown-name one.
    let req = null;
    try { req = JSON.parse(fs.readFileSync(path.join(pkgDir, n + '.json'), 'utf-8')).requires; }
    catch (e) { /* fall through to unknown */ }
    const p = COMMON.nativeSiblingProducer(req);
    if (p !== null && SIBLINGS[p]) {
      process.stderr.write(`mkpkg: package '${n}' is gated on the ${p} sibling ` +
        `(requires: ${JSON.stringify(req)}) — build it with --${p}\n`);
    } else {
      process.stderr.write(`mkpkg: unknown package '${n}' (declared in packages/: ${avail.join(', ') || 'none'};` +
        ` plus ${sourceUnits.size} synthesized -sources companions)\n`);
    }
    process.exit(2);
  }
}

/* ---- overlay ⟷ packages/ drift gate (todos/0337) --------------------------
 * Standing rule: EVERY app a sibling builds must be reachable through gucman.
 * The sibling overlay is the producer of record, so its executable payloads —
 * the `/usr/bin/*` entries — are the authoritative demand list, and each one
 * must be CLAIMED by some packages/*.json `nativeApp` entry gated on that
 * producer. A payload the sibling publishes with no definition here is
 * invisible to every deploy: it was built, it just silently never ships.
 * That is exactly how gameboy-clang/stl4/sdldemo sat unpackaged while the
 * other seven shipped.
 *
 * The gate is on the OVERLAY side of the relation, not a hand-list of names,
 * so a new sibling project fails the build the first time it is published
 * rather than the first time somebody notices it missing. It runs per
 * ENABLED producer only (a base build has no overlay to compare against)
 * and BEFORE any payload is built — and since a clang build is the deploy
 * default (comguc scripts/build.mjs), no deploy can route around it.
 *
 * A payload that genuinely should not be a package needs an EXPLICIT entry
 * in the producer's tools/<producer>-unpackaged.json giving the reason.
 * Silence is never an allowed answer; an unexplained gap is the failure
 * mode this gate exists to kill. An ABSENT exemption file means "no
 * exemptions" (tools/rust-unpackaged.json does not exist today because the
 * rust overlay has none).
 *
 * Scoped to /usr/bin/*: non-executable overlay payloads (assets like
 * /usr/share/tinyrenderer/*.obj, menu links) belong to whichever package
 * carries their binary, and a package is free to leave an asset behind —
 * gameboy-clang deliberately drops the copyrighted PokemonBlue.gb the overlay
 * publishes for the local bake, because comguc never hosts ROMs publicly. */
function driftCheck(producer) {
  const S = SIBLINGS[producer];
  const published = [];
  for (const p of siblingOverlay(producer).keys()) {
    if (p.startsWith('/usr/bin/')) published.push(p.slice('/usr/bin/'.length));
  }
  published.sort();
  // Claimed = every nativeApp named by ANY definition in pkgDir gated on
  // this producer, not just the ones this invocation builds — `mkpkg
  // box2d-clang` must still gate the whole relation, or a single-package
  // rebuild would launder the drift away.
  const claimedBy = new Map();
  for (const n of COMMON.listPackages(fs, path, ROOT, { producers: [producer], packagesDir: pkgDir })) {
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(pkgDir, n + '.json'), 'utf-8')); }
    catch (e) { continue; }   // malformed → fails loud in the build below
    if (COMMON.nativeSiblingProducer(def.requires) !== producer) continue;   // ungated base defs claim nothing
    for (const entry of Object.values(def.files || {})) {
      if (entry && typeof entry.nativeApp === 'string') claimedBy.set(entry.nativeApp, n);
    }
  }
  let allowed = {};
  if (fs.existsSync(S.unpackaged)) {
    allowed = JSON.parse(fs.readFileSync(S.unpackaged, 'utf-8')).unpackaged || {};
  }
  const orphans = published.filter((a) => !claimedBy.has(a) && !allowed[a]);
  if (orphans.length) {
    process.stderr.write(
      `mkpkg --${producer}: ${orphans.length} overlay app(s) published by the sibling have NO packages/*.json:\n` +
      orphans.map((a) => `    /usr/bin/${a}\n`).join('') +
      `  every ${producer} app we build must be installable through gucman.\n` +
      `  fix: add packages/<name>.json with {"requires":"native-sibling:${producer}",\n` +
      `       "files":{"<name>":{"nativeApp":"${orphans[0]}"}}, "bin":{...}} —\n` +
      `       see packages/box2d-clang.json (clang, windowed) or packages/wc-rust.json (rust, tty)\n` +
      `  or, if a payload is deliberately not a package, record it WITH A REASON in\n` +
      `  ${path.relative(ROOT, S.unpackaged)}\n`);
    process.exit(1);
  }
  // A stale allow-list entry is drift too: it claims an exemption for a
  // payload that no longer exists (or has since been packaged), so the next
  // reader trusts a rule that isn't doing anything.
  const stale = Object.keys(allowed).filter((a) => !published.includes(a) || claimedBy.has(a));
  if (stale.length) {
    process.stderr.write(
      `mkpkg --${producer}: stale ${path.relative(ROOT, S.unpackaged)} entries — ${stale.join(', ')}\n` +
      `  (no longer published by the sibling, or now packaged); remove them\n`);
    process.exit(1);
  }
  log(`${producer} drift: ${published.length} overlay app(s), all packaged`
    + (Object.keys(allowed).length ? ` (${Object.keys(allowed).length} explicitly unpackaged)` : '') + ' ✓');
}
for (const p of enabled) driftCheck(p);

/* ---- package-input freshness (the 0082 idea, scoped to one package) ----
 * The scan itself is os-common's newestPkgInput — extracted there
 * (todos/0363) so tests/host/test_bakeinput_sources.js can drive it against
 * a synthetic tree, exactly like its twin newestBakeInput. This wrapper
 * binds this tool's context: the repo ROOT, the (possibly --packages-dir
 * overridden) definition dir, and the enabled siblings' overlay paths. */
function newestPkgInput(name, pkg, extraInputs) {
  return COMMON.newestPkgInput(fs, path, ROOT, name, pkg, {
    pkgDir,
    extraInputs,
    overlayPathFor: (p) => (SIBLINGS[p] ? overlayPathOf(p) : null),
  });
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
  // The package's producer, from its gate value — which sibling overlay its
  // nativeApp/nativeFile entries resolve against. null = an ungated base def.
  const producer = COMMON.nativeSiblingProducer(pkg.requires);
  const nativePlants = [];   // { abs, ovPath, mode } — planted AFTER seedEntries
  // One payload path, one producer: tree expansion introduces the class of
  // two entries writing the same path (a tree file shadowed by an explicit
  // entry), which Object assignment would resolve silently — refuse instead.
  const claim = (p, entry) => {
    if (section.files[p] !== undefined) {
      throw new Error(`package '${name}': payload path ${p.slice(base.length + 1)} is produced twice`);
    }
    section.files[p] = entry;
  };
  const pushDirs = (rel) => {
    const parts = rel.split('/');
    let cur = base;
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      if (!section.dirs.includes(cur)) section.dirs.push(cur);
    }
  };
  for (const rel of Object.keys(pkg.files).sort()) {
    const entry = pkg.files[rel];
    if (entry.link !== undefined) {
      throw new Error(`package '${name}': ${rel} — link entries are not supported in packages (v1 tar+gzip payloads carry files and dirs only)`);
    }
    // `tree` (source-lib §3.2, Node-only): recursive directory copy — one
    // `bin` (repo-relative bytes) entry per enumerated file, dirs derived
    // from the file paths. Same enumeration as the freshness scan below.
    if (entry.tree !== undefined) {
      const treeFiles = COMMON.listTreeFiles(fs, path, ROOT, entry, `package '${name}': ${rel}`);
      for (const tf of treeFiles) {
        pushDirs(rel + '/' + tf);
        claim(base + '/' + rel + '/' + tf, { bin: entry.tree + '/' + tf });
      }
      continue;
    }
    pushDirs(rel);
    // A `nativeApp` entry is NOT bake vocabulary (seedEntries refuses it, like
    // `link`): its bytes come pre-built from the sibling overlay, not from
    // compiler.js. It's resolved + planted after seedEntries builds the dirs.
    if (entry.nativeApp !== undefined) {
      if (typeof entry.nativeApp !== 'string' || !entry.nativeApp.length) {
        throw new Error(`package '${name}': ${rel} — nativeApp must name an app`);
      }
      requireProducer(name, rel, 'nativeApp');
      nativePlants.push({ abs: base + '/' + rel, ovPath: '/usr/bin/' + entry.nativeApp, mode: 0o755 });
    } else if (entry.nativeFile !== undefined) {
      // nativeFile: any non-binary overlay payload by absolute /usr path (T3:
      // tinyrenderer's model assets). Same verifier, same producer gating.
      if (typeof entry.nativeFile !== 'string' || !entry.nativeFile.startsWith('/usr/')) {
        throw new Error(`package '${name}': ${rel} — nativeFile must be an absolute /usr overlay path`);
      }
      requireProducer(name, rel, 'nativeFile');
      nativePlants.push({ abs: base + '/' + rel, ovPath: entry.nativeFile, mode: 0o644 });
    } else {
      claim(base + '/' + rel, entry);
    }
  }
  function requireProducer(pkgName, rel, kind) {
    if (producer === null || !SIBLINGS[producer]) {
      throw new Error(`package '${pkgName}': ${rel} — a ${kind} entry needs ` +
        `requires: "native-sibling:<producer>" naming its sibling`);
    }
    if (!enabled.has(producer)) {
      throw new Error(`package '${pkgName}': ${rel} — ${kind} entries require mkpkg --${producer}`);
    }
  }
  await COMMON.seedEntries(mfs, section, {
    readAsset: (n) => fs.readFileSync(path.join(OS_DIR, n), 'utf-8'),
    readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
    buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
    compile: COMMON.createCcDriver(CompilerJS, mfs),
    log: () => {},
  });
  // Plant each nativeApp/nativeFile: pull the named payload out of the
  // package's producer overlay (bytes ALREADY sha256+size verified by
  // loadOverlays) and write it into the tree.
  if (nativePlants.length) {
    const ov = siblingOverlay(producer);
    for (const p of nativePlants) {
      const f = ov.get(p.ovPath);
      if (!f) {
        throw new Error(`package '${name}': no ${p.ovPath} in the sibling overlay (${overlayPathOf(producer)})`);
      }
      if (f.bytes === undefined) {
        throw new Error(`package '${name}': ${p.ovPath} is a symlink in the overlay, not a payload`);
      }
      COMMON.writeFile(mfs, p.abs, f.bytes, p.mode);
    }
  }
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

/* ---- build / reuse one package; returns its index entry ----
 * `poolDir` is the payload STORE. When it is shared (--pool), this build is one
 * of several readers, so it may only ADD to it — see the superseded-drop below. */
async function buildPackage(name, poolDir, sharedPool, synth) {
  const pkg = synth ? synth.def
    : JSON.parse(fs.readFileSync(path.join(pkgDir, name + '.json'), 'utf-8'));
  if (pkg.name !== name) throw new Error(`packages/${name}.json declares name ${JSON.stringify(pkg.name)}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pkg.name)) throw new Error(`package '${name}': bad name`);
  if (typeof pkg.version !== 'string' || !/^[A-Za-z0-9._-]+$/.test(pkg.version)) {
    throw new Error(`package '${name}': bad version ${JSON.stringify(pkg.version)}`);
  }
  if (!pkg.files || !Object.keys(pkg.files).length) throw new Error(`package '${name}': no files`);
  COMMON.checkReservedPackageFiles(pkg, `package '${name}'`);
  const bin = pkg.bin || {};
  for (const cmd of Object.keys(bin)) {
    if (!pkg.files[bin[cmd]]) throw new Error(`package '${name}': bin ${cmd} -> ${bin[cmd]} names no package file`);
  }
  // todos/0338: a `bin` command must not be a name the BASE IMAGE dispatches.
  // The fat bake's claim() throw catches this for FOLDED packages only — a
  // `requires`-gated definition (every *-clang variant) is never folded, so
  // without this check it would build clean and then plant
  // /usr/local/bin/<name> at install, silently shadowing the dispatcher
  // FOREVER (/usr/local/bin precedes /bin on PATH, and /var/local is user
  // territory an image upgrade never rewrites). `commands` is the way to
  // provide a dispatched name.
  const dispatched = Object.keys(imageManifest.system.files || {})
    .filter((p) => p.startsWith('/usr/bin/') &&
                   (imageManifest.system.files[p] || {}).link === '/usr/bin/cmdalt')
    .map((p) => p.slice('/usr/bin/'.length));
  for (const cmd of Object.keys(bin)) {
    if (dispatched.includes(cmd)) {
      throw new Error(`package '${name}': bin ${cmd} would shadow the base image's ` +
        `command dispatcher at /usr/bin/${cmd} — declare ` +
        `"commands": { ${JSON.stringify(cmd)}: "<your bin command>" } instead (todos/0338)`);
    }
  }
  for (const ext of Object.keys(pkg.openwith || {})) {
    if (!bin[pkg.openwith[ext]]) throw new Error(`package '${name}': openwith ${ext} -> ${pkg.openwith[ext]} names no bin command`);
  }
  // `commands` (todos/0338): dispatched command names this package claims —
  // gucman appends `<name>\t/usr/local/bin/<cmd>` to /etc/cmdalt at install
  // and deletes exactly that line at remove. A ROLE name (`python`) is a
  // claim; an IMPLEMENTATION name (`micropython`) is a `bin` entry.
  for (const cmd of Object.keys(pkg.commands || {})) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(cmd)) {   // gm_valid_name's alphabet
      throw new Error(`package '${name}': commands key ${JSON.stringify(cmd)} is not a command name`);
    }
    if (!bin[pkg.commands[cmd]]) throw new Error(`package '${name}': commands ${cmd} -> ${pkg.commands[cmd]} names no bin command`);
  }
  for (const me of pkg.menu || []) {
    if (!me.group || !me.entry || !bin[me.cmd]) throw new Error(`package '${name}': bad menu entry ${JSON.stringify(me)}`);
  }
  // Explicit desktop eligibility (win32 source-lib design §5): an object so
  // it can grow (icon asset, label, …); today exactly {cmd}. Absent = the
  // package is desktop-ineligible — gucman plants icons by THIS field, not
  // by any launchable-command heuristic.
  if (pkg.desktop !== undefined) {
    const d = pkg.desktop;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      throw new Error(`package '${name}': desktop must be an object {cmd}`);
    }
    for (const k of Object.keys(d)) {
      if (k !== 'cmd') throw new Error(`package '${name}': desktop has an unknown key ${JSON.stringify(k)}`);
    }
    if (typeof d.cmd !== 'string' || !bin[d.cmd]) {
      throw new Error(`package '${name}': desktop.cmd ${JSON.stringify(d.cmd)} names no bin command`);
    }
  }
  for (const fp of pkg.fonts || []) {
    if (typeof fp !== 'string' || !pkg.files[fp]) throw new Error(`package '${name}': fonts ${fp} names no package file`);
  }
  // srclib (source-lib design §3.1) and seed (the content resource kind,
  // `seed` design §1.3): shape-validate early; their payload references are
  // checked against the ASSEMBLED payload after the build, and both sections
  // ride into control.json for gucman's install plant.
  const srclib = pkg.srclib !== undefined
    ? COMMON.validateSrclibShape(pkg.srclib, `package '${name}'`) : null;
  const seed = pkg.seed !== undefined
    ? COMMON.validateSeedShape(pkg.seed, `package '${name}'`) : null;
  // The §4.4 require-block drift gate (Lane B2): the win32 payload ships
  // windows.h/menucore.h/gdi32.c whose hand-written __require_source
  // blocks must equal the lib.json truth — refuse to build a package that
  // would plant a drifted veneer. (tools/win32ports.js runs the same gate
  // host-side; os-common win32RequireDriftErrors is the ONE checker.)
  if (name === 'win32') {
    const drift = COMMON.win32RequireDriftErrors((rel) => {
      try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; }
    });
    if (drift.length) {
      throw new Error(`package '${name}': require-block drift\n  ` + drift.join('\n  '));
    }
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
  // NEWEST candidate wins. An owned pool holds at most one payload per
  // (name, version) because the superseded-drop below prunes the rest — but a
  // SHARED store (--pool) is append-only, so one version legitimately keeps
  // several shas as its inputs change. Demanding exactly one there would
  // silently stop reusing anything and rebuild the world every run.
  if (!force && existing.length) {
    const newest = existing
      .map((f) => ({ f, mtimeMs: fs.statSync(path.join(poolDir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    const inp = newestPkgInput(name, pkg, synth ? synth.inputs : null);
    if (newest.mtimeMs >= inp.mtimeMs) {
      const p = path.join(poolDir, newest.f);
      const bytes = fs.readFileSync(p);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (newest.f.includes('_' + sha.slice(0, 16) + '.')) {
        log(`${name} ${pkg.version}: pool payload fresh — reusing ${newest.f}`);
        return entryFor(newest.f, sha, bytes.length);
      }
    }
  }

  log(`${name} ${pkg.version}: building…`);
  const t0 = Date.now();
  const payload = await assembleTree(name, pkg);
  if (srclib) {
    const dirSet = new Set(payload.filter((m) => m.dir).map((m) => m.name));
    for (const d of srclib.include.concat(Object.values(srclib.src))) {
      // '.' = the payload root (todos #407), which always exists.
      if (d !== '.' && !dirSet.has(`opt/${name}/${d}`)) {
        throw new Error(`package '${name}': srclib dir ${d} is not in the assembled payload`);
      }
    }
  }
  if (seed) {
    const nameSet = new Set(payload.map((m) => m.name));
    for (const dest of Object.keys(seed)) {
      if (!nameSet.has(`opt/${name}/${seed[dest]}`)) {
        throw new Error(`package '${name}': seed ${dest} -> ${seed[dest]} names no file or directory in the assembled payload`);
      }
    }
  }
  // The ONE control.json producer (os-common packageControl) — the same
  // bytes foldPackages bakes at /usr/opt/<name>/control.json, so installed
  // and built-in packages present an identical manifest.
  const members = [
    { name: 'control.json',
      data: Buffer.from(COMMON.packageControlText(pkg, `package '${name}'`)),
      mode: 0o644 },
    ...payload,
  ];
  const gz = zlib.gzipSync(tarball(members), { level: 9 });
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const file = `${name}_${pkg.version}_${sha.slice(0, 16)}.pkg.tar.gz`;
  fs.mkdirSync(poolDir, { recursive: true });
  const tmp = path.join(poolDir, file + '.tmp-' + process.pid);
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, path.join(poolDir, file));
  // Drop superseded payloads — but ONLY when this build owns the store. Under
  // --pool another repo's already-published index may still reference the older
  // sha, and its hardlinked view would be the only thing keeping the bytes
  // alive; a shared store is append-only (todos/0388).
  if (!sharedPool) {
    for (const old of fs.readdirSync(poolDir)) {
      if (old !== file && old.startsWith(name + '_') && old.endsWith('.pkg.tar.gz')) {
        fs.unlinkSync(path.join(poolDir, old));
      }
    }
  }
  // Cloudflare Pages refuses any single file over 25 MiB (26,214,400 B —
  // the cap that blocked the v219 image ship, #408). A payload over it
  // builds fine locally and then silently never deploys; warn LOUDLY here,
  // where the byte count is first known.
  if (gz.length > 25 * (1 << 20)) {
    process.stderr.write(`mkpkg: WARNING: ${file} is ${(gz.length / (1 << 20)).toFixed(1)} MiB — ` +
      `over the 25 MiB Cloudflare Pages per-file cap; this payload will not deploy\n`);
  }
  log(`${name} ${pkg.version}: ${file} (${(gz.length / (1 << 20)).toFixed(1)} MiB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return entryFor(file, sha, gz.length);
}

/* Materialize <out>/pool as a hardlinked view of exactly `live` (todos/0388).
 * Hardlinks, so N repos sharing a store cost one inode each and no bytes; the
 * payload name is content-addressed, so an identical name is identical bytes
 * and copyFileSync is an equally correct fallback where linking is refused. */
function materializeView(store, view, live) {
  fs.mkdirSync(view, { recursive: true });
  for (const f of live) {
    const src = path.join(store, f);
    const dst = path.join(view, f);
    const s = fs.statSync(src, { throwIfNoEntry: false });
    if (!s) throw new Error(`mkpkg: shared pool ${store} is missing ${f}`);
    const d = fs.statSync(dst, { throwIfNoEntry: false });
    if (d && d.ino === s.ino && d.dev === s.dev) continue;   // already this payload
    if (d) fs.unlinkSync(dst);
    try { fs.linkSync(src, dst); }
    catch (e) { fs.copyFileSync(src, dst); }                 // EXDEV / EPERM
  }
}

async function main() {
  acquireLock();
  // The STORE is where payloads are built and reused; the VIEW is the pool/
  // the index's relative urls address. They are the same dir unless --pool
  // decouples them.
  const store = poolStore || path.join(outDir, 'pool');
  const view = path.join(outDir, 'pool');
  const sharedPool = store !== view;
  const index = {
    schemaVersion: 1,
    baseVersion: imageManifest.version | 0,
    packages: {},
  };
  // Rebuild requested packages; carry every other declared package's entry
  // forward so a single-package invocation still writes a complete index.
  for (const n of allAvail) {
    if (names.includes(n)) {
      index.packages[n] = await buildPackage(n, store, sharedPool, sourceUnits.get(n));
    } else {
      const prev = readIndex();
      if (prev && prev.packages && prev.packages[n]) index.packages[n] = prev.packages[n];
    }
  }
  const live = new Set(Object.values(index.packages).map((p) => path.basename(p.payload.url)));
  fs.mkdirSync(outDir, { recursive: true });
  // Populate the view BEFORE publishing the index, so the repo is never
  // momentarily advertising a payload that isn't there yet.
  if (sharedPool) materializeView(store, view, live);
  const tmp = path.join(outDir, 'index.json.tmp-' + process.pid);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(tmp, path.join(outDir, 'index.json'));
  // Prune orphans: a package REMOVED from packages/ drops out of the index
  // above, but its old payload would sit in pool/ forever (and deploys copy
  // the whole pool dir). Anything the fresh index doesn't reference goes.
  // Scoped to the VIEW — never a shared store, which this build does not own.
  if (fs.existsSync(view)) {
    for (const f of fs.readdirSync(view)) {
      if (!live.has(f)) {
        fs.unlinkSync(path.join(view, f));
        log(`pruned orphan pool payload ${f}`);
      }
    }
  }
  log(`index.json: ${Object.keys(index.packages).length} package(s), baseVersion ${index.baseVersion}`
    + (sharedPool ? ` (pool store ${store})` : ''));
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
