#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

// Positional args (dir, port) plus optional flags. `--clang` folds the
// sibling clang-simplified `clang-apps` image overlay (todos/0118) into the
// served system blob when the sibling artifact is available (todos/0141);
// `--overlay=<id>` is the generic form, mirroring tools/mkimage.js.
const positionals = [];
const requestedOverlays = new Set();
// `--packages-index=clang` (set by serve-with-clang.js) asserts the served
// /packages repo is the SUPERSET index — dist/packages/index.json must exist
// and list at least one *-clang package (built by the wrapper's `mkpkg --clang`
// preflight). It never MUTATES anything (serve.js serves dist/packages
// verbatim, as today); it's a guard so a clang-mandatory serve can't silently
// serve a stale base index. Flagless serve.js is byte-identical to today.
let assertClangPackages = false;
// `--strict-port`: bind the REQUESTED port or fail loudly — never the silent
// walk to port+1 that tryListen does for a developer's convenience. The browser
// harness passes it (tests/browser/lib/os-harness.mjs startServer) because the
// walk is a false-signal generator there: the sweep's ports are fixed per file,
// so a squatting leftover pushes the real server aside while the test keeps
// polling the fixed port and talks to the STALE one — a red with nothing to do
// with the code under test. (Worse here than it looks: 3197 and 3198 are BOTH
// assigned to sweep files, so the +1 walk lands on another file's port.)
let strictPort = false;
for (const a of process.argv.slice(2)) {
  if (a === '--clang') requestedOverlays.add('clang-apps');
  else if (a === '--strict-port') strictPort = true;
  else if (a.startsWith('--overlay=')) requestedOverlays.add(a.slice(10));
  else if (a.startsWith('--overlays=')) a.slice(11).split(',').forEach((id) => id && requestedOverlays.add(id));
  else if (a === '--packages-index=clang') assertClangPackages = true;
  else if (a.startsWith('-')) { console.error(`serve.js: unknown option ${a}`); process.exit(2); }
  else positionals.push(a);
}
const arg = positionals[0] || 'build';
const preferredPort = parseInt(positionals[1] || '8080', 10);

const resolved = path.resolve(arg);
const stat = fs.statSync(resolved, { throwIfNoEntry: false });
const singleFile = stat && stat.isFile() ? resolved : null;
const root = singleFile ? path.dirname(resolved) : resolved;

// Resolve requested image overlays (todos/0141) against os/image.json's
// `overlays[]` declaration. "Available" = the sibling-published overlay.json
// exists; a missing sibling build is a NORMAL state (the overlay is an opt-in
// convenience), so a requested-but-absent overlay is DROPPED with a loud line
// and we serve the base image — never an error, never a triggered sibling
// build. Returns the enabled overlay specs + the sidecar image name they bake
// to (a base blob and a +overlay blob are DIFFERENT images at the same
// version; keying the sidecar by the overlay set stops a `--clang` serve and a
// plain serve from thrashing each other's os/os-system.img), or null when
// nothing is enabled (→ plain base path, byte-identical to a flagless serve).
function resolveOverlayPlan(dir) {
  if (singleFile || requestedOverlays.size === 0) return null;
  const manifestPath = path.join(dir, 'os', 'image.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const byId = new Map((manifest.overlays || []).map((o) => [o.id, o]));
  const enabled = [];
  for (const id of requestedOverlays) {
    const o = byId.get(id);
    if (!o) { console.error(`[serve] overlay '${id}' is not declared in os/image.json overlays[] — ignoring`); continue; }
    const ovManifest = path.isAbsolute(o.manifest) ? o.manifest : path.join(dir, o.manifest);
    const st = fs.statSync(ovManifest, { throwIfNoEntry: false });
    if (!st) { console.log(`[serve] --clang requested but ${o.manifest} not found — serving base image`); continue; }
    let producer = '?', commitShort = '?';
    try {
      const om = JSON.parse(fs.readFileSync(ovManifest, 'utf-8'));
      producer = (om.provenance && om.provenance.producer) || '?';
      commitShort = (om.provenance && om.provenance.repo && om.provenance.repo.commitShort) || '?';
    } catch (e) { /* a malformed overlay.json is mkimage's job to reject loudly */ }
    enabled.push({ id, manifestPath: ovManifest, mtimeMs: st.mtimeMs, producer, commitShort });
  }
  if (!enabled.length) return null;
  const ids = enabled.map((e) => e.id).sort();
  return { enabled, ids, imageName: `os-system.${ids.join('+')}.img` };
}
const overlayPlan = resolveOverlayPlan(root);

// Prebaked system-image freshness (todos/0040 + 0082): when serving the OS
// tree, make sure os/os-system.img is current BEFORE listening — a stale/
// missing blob makes every fresh browser boot silently fall back to the
// ~16s in-worker bake, and a version-current blob baked before an
// uncommitted compiler.js/os//vendor edit would be silently FETCHED (the
// browser can't check input mtimes — this gate is the browser-path half of
// todos/0082). Baking is delegated to tools/mkimage.js (the same seed
// pipeline). Version rule mirrors kernel-worker.js: rebake only when
// baked < manifest (a NEWER blob is kept); input rule: rebake when any
// bake input (compiler.js, os/, vendor closure) is newer than the blob.
// `plan` is resolveOverlayPlan's result (null → base image). With a plan the
// gate becomes overlay-aware (todos/0141): the blob is a sidecar keyed by the
// overlay set, and freshness compares the DESIRED overlay set against the
// blob's baked OVERLAYS= line (os-common.bakedOverlays) in addition to the
// version/input-mtime rules — plus the sibling overlay.json's mtime folds into
// the input-freshness check so re-publishing the overlay re-bakes.
function ensureSystemImage(dir, plan) {
  const manifestPath = path.join(dir, 'os', 'image.json');
  const mkimagePath = path.join(dir, 'tools', 'mkimage.js');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(mkimagePath)) return;
  const { BLOCK_FS } = require(path.join(dir, 'host.js'));
  const COMMON = require(path.join(dir, 'os', 'os-common.js'));
  // The dev serve always serves the FAT image: every packages/<name>.json
  // folded back into the blob (gucman pulls them out of a plain bake), so
  // the in-browser estate matches the kernel-test fixture. A future deploy
  // build serves the minimal blob + the packages pool instead.
  const folded = COMMON.foldPackages(fs, path, dir,
    JSON.parse(fs.readFileSync(manifestPath, 'utf-8')), 'all');
  const manifest = folded.manifest;
  const wantPkgs = folded.names;
  const wanted = manifest.version | 0;
  const imageName = plan ? plan.imageName : 'os-system.img';
  const imgPath = path.join(dir, 'os', imageName);
  const wantOverlays = plan ? plan.ids : [];
  const overlayArgs = plan ? plan.enabled.map((e) => `--overlay=${e.id}`) : [];
  const packagesArgs = wantPkgs.length ? ['--packages=all'] : [];
  let baked = -1;
  let why = null;
  if (fs.existsSync(imgPath)) {
    const store = new COMMON.NodeFileStore(fs, imgPath, false);
    baked = COMMON.bakedVersion(BLOCK_FS, store);
    const bakedOv = COMMON.bakedOverlays(BLOCK_FS, store);
    const bakedPk = COMMON.bakedPackages(BLOCK_FS, store);
    store.close();
    const overlaysMatch = bakedOv.length === wantOverlays.length &&
      bakedOv.every((id, i) => id === wantOverlays[i]);
    const packagesMatch = bakedPk.join(',') === wantPkgs.join(',');
    if (baked >= wanted && !overlaysMatch) {
      why = `overlay set [${bakedOv.join(',') || 'base'}] != wanted [${wantOverlays.join(',') || 'base'}]`;
    } else if (baked >= wanted && !packagesMatch) {
      why = `package set [${bakedPk.join(',') || 'none'}] != wanted [${wantPkgs.join(',') || 'none'}]`;
    } else if (baked >= wanted) {
      const inp = COMMON.newestBakeInput(fs, path, dir, manifest);
      let newestMs = inp.mtimeMs, newestPath = inp.path;
      if (plan) for (const e of plan.enabled) {
        if (e.mtimeMs > newestMs) { newestMs = e.mtimeMs; newestPath = e.manifestPath; }
      }
      if (fs.statSync(imgPath).mtimeMs >= newestMs) return;
      why = `v${baked} but input-stale (${path.relative(dir, newestPath)} is newer)`;
    }
  }
  if (!why) why = `${baked < 0 ? 'missing' : 'is v' + baked} < manifest v${wanted}`;
  console.log(`os/${imageName} ${why} — baking${wantOverlays.length ? ' (+' + wantOverlays.join(',') + ')' : ''}…`);
  const r = require('child_process').spawnSync(process.execPath,
    [mkimagePath, `--out=${imgPath}`, ...overlayArgs, ...packagesArgs], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('mkimage failed — not serving a stale system image');
    process.exit(1);
  }
}
if (!singleFile) {
  ensureSystemImage(root, overlayPlan);
  if (overlayPlan) {
    for (const e of overlayPlan.enabled) {
      console.log(`[serve] overlay ${e.id} folded in (${e.producer}@${e.commitShort})`);
    }
  }
}

// --packages-index=clang guard: the served /packages repo must be the clang
// superset (serve-with-clang.js builds it via `mkpkg --clang` before spawning
// us). A base index here means the wrapper's preflight was bypassed — fail loud
// rather than serve a clang-mandatory origin without its *-clang cards.
if (assertClangPackages && !singleFile) {
  const idxPath = path.join(root, 'dist', 'packages', 'index.json');
  let clangNames = [];
  try {
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    clangNames = Object.keys(idx.packages || {}).filter((n) => /-clang$/.test(n));
  } catch (e) { /* handled below */ }
  if (!clangNames.length) {
    console.error(`serve.js --packages-index=clang: ${path.relative(root, idxPath)} is not the clang superset`);
    console.error('  expected at least one *-clang package (run tools/mkpkg.js --clang, or use serve-with-clang.js)');
    process.exit(1);
  }
  console.log(`[serve] clang package index: ${clangNames.length} *-clang card(s)`);
}

// When an overlay is active, the browser still fetches `os-system.img` beside
// the page (kernel-worker.js) — serve the overlay sidecar bytes for that path
// so the boot gets the augmented blob without any kernel-worker change.
const baseImgFile = path.join(root, 'os', 'os-system.img');
const overlayImgFile = overlayPlan ? path.join(root, 'os', overlayPlan.imageName) : null;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let file = singleFile && url === '/' ? singleFile : path.join(root, url === '/' ? 'index.html' : url);
  // The package repo (gucman): /packages/* serves tools/mkpkg.js output from
  // dist/packages/* — the same layout the Pages deploy publishes, so the
  // baked origin-relative repo default (/usr/share/gucman/repos) works
  // against the dev serve too.
  if (url === '/packages/index.json' || url.startsWith('/packages/pool/')) {
    file = path.join(root, 'dist', url.slice(1));
  }
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (overlayImgFile && path.resolve(file) === baseImgFile) file = overlayImgFile;
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
});

// Best-effort "who is holding this port?" for the --strict-port diagnostic.
// Naming the squatter at the source is the whole point — the alternative is a
// downstream ERR_CONNECTION_REFUSED or, worse, a silently stale server.
function portHolders(port) {
  try {
    const out = require('child_process').execFileSync(
      'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map((pid) => {
      try {
        const ps = require('child_process').execFileSync(
          'ps', ['-o', 'ppid=,command=', '-p', pid],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return `pid ${pid} (ppid ${ps.split(/\s+/)[0]}) ${ps.replace(/^\s*\d+\s+/, '').slice(0, 120)}`;
      } catch { return `pid ${pid}`; }
    });
  } catch { return []; }
}

// --strict-port tolerates a BOUNDED retry on the same port before giving up:
// sweep files reuse ports (3197 is assigned to four of them), so the previous
// file's server may still be releasing its socket when the next one binds. A
// graceful teardown clears in well under a second; a real squatter never does.
// Started at the FIRST collision, not at module load: serve.js may re-bake a
// stale image for minutes before it ever calls listen(), which would otherwise
// have burned the whole window before the race it exists to absorb.
const STRICT_RETRY_MS = 3000;
let strictDeadline = null;

function tryListen(port) {
  // `once` removes itself before firing, so re-entering here re-registers
  // exactly one handler — no listener accumulation across retries.
  server.once('error', (err) => {
    if (err.code !== 'EADDRINUSE') { console.error(err.message); process.exit(1); }
    if (strictPort) {
      if (strictDeadline === null) strictDeadline = Date.now() + STRICT_RETRY_MS;
      if (Date.now() < strictDeadline) { setTimeout(() => tryListen(port), 100); return; }
      const held = portHolders(port);
      console.error(
        `serve.js: port ${port} is still in use after ${STRICT_RETRY_MS}ms and --strict-port was requested.\n` +
        (held.length ? held.map((h) => `  held by ${h}\n`).join('')
                     : '  (could not identify the holder — lsof unavailable)\n') +
        '  Refusing to fall through to another port: the caller polls THIS one, so falling\n' +
        '  through would hand it a stale server and produce reds that look like product bugs.\n' +
        '  A PPID-1 holder is an orphan from a killed run — `node tests/lib/harness-leaks.js`\n' +
        '  reaps those (the heavy runners now do it at startup).');
      process.exit(1);
    }
    if (port < preferredPort + 10) { tryListen(port + 1); return; }
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port);
}

// Die with our parent. serve.js is always spawned by something that owns it (a
// browser test file, os-drive, a developer's shell); when that owner is killed
// we get reparented to init and would otherwise keep LISTENING forever on a
// fixed harness port. 70 such orphans squatted the sweep's ports in one round.
// A poll, not a handler, because a parent's death delivers no signal here — and
// because it must survive the owner being SIGKILLed, which runs no handler
// anywhere. Same idiom as the suite-runner load generators. An already-
// parentless start (ppid 1, e.g. a deliberately daemonized serve) is left alone.
const INITIAL_PPID = process.ppid;
if (INITIAL_PPID > 1) {
  const watch = setInterval(() => {
    if (process.ppid === INITIAL_PPID) return;
    clearInterval(watch);
    console.error(`[serve] parent ${INITIAL_PPID} exited (reparented to ${process.ppid}) — ` +
                  `exiting so port ${server.address() ? server.address().port : preferredPort} is not squatted`);
    process.exit(0);
  }, 1000);
  watch.unref();
}

server.once('listening', () => {
  const port = server.address().port;
  // There is no index.html at the repo root, so the bare URL 404s — point
  // at the real entry when serving a tree that contains the OS page.
  const osPage = !singleFile && fs.existsSync(path.join(root, 'os', 'os.html'));
  console.log(`Open http://localhost:${port}${osPage ? '/os/os.html' : ''}`);
});

tryListen(preferredPort);
