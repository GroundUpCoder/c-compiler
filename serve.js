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
for (const a of process.argv.slice(2)) {
  if (a === '--clang') requestedOverlays.add('clang-apps');
  else if (a.startsWith('--overlay=')) requestedOverlays.add(a.slice(10));
  else if (a.startsWith('--overlays=')) a.slice(11).split(',').forEach((id) => id && requestedOverlays.add(id));
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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const wanted = manifest.version | 0;
  const imageName = plan ? plan.imageName : 'os-system.img';
  const imgPath = path.join(dir, 'os', imageName);
  const wantOverlays = plan ? plan.ids : [];
  const overlayArgs = plan ? plan.enabled.map((e) => `--overlay=${e.id}`) : [];
  const { BLOCK_FS } = require(path.join(dir, 'host.js'));
  const COMMON = require(path.join(dir, 'os', 'os-common.js'));
  let baked = -1;
  let why = null;
  if (fs.existsSync(imgPath)) {
    const store = new COMMON.NodeFileStore(fs, imgPath, false);
    baked = COMMON.bakedVersion(BLOCK_FS, store);
    const bakedOv = COMMON.bakedOverlays(BLOCK_FS, store);
    store.close();
    const overlaysMatch = bakedOv.length === wantOverlays.length &&
      bakedOv.every((id, i) => id === wantOverlays[i]);
    if (baked >= wanted && !overlaysMatch) {
      why = `overlay set [${bakedOv.join(',') || 'base'}] != wanted [${wantOverlays.join(',') || 'base'}]`;
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
    [mkimagePath, `--out=${imgPath}`, ...overlayArgs], { stdio: 'inherit' });
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

function tryListen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < preferredPort + 10) {
      tryListen(port + 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port);
}

server.once('listening', () => {
  const port = server.address().port;
  // There is no index.html at the repo root, so the bare URL 404s — point
  // at the real entry when serving a tree that contains the OS page.
  const osPage = !singleFile && fs.existsSync(path.join(root, 'os', 'os.html'));
  console.log(`Open http://localhost:${port}${osPage ? '/os/os.html' : ''}`);
});

tryListen(preferredPort);
