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
// `--packages-index=<producer>[,<producer>]` (clang is set by
// serve-with-clang.js; rust is the todos/0416 twin) asserts the served
// /packages repo is the SUPERSET index over the named native-sibling
// producers — dist/packages/index.json must exist and list at least one
// package of each producer's suffix (*-clang / *-rust, built by an
// `mkpkg --<producer>` prebake). It never MUTATES anything (serve.js serves
// dist/packages verbatim, as today); it's a guard so a producer-mandatory
// serve can't silently serve a stale base index. Flagless serve.js is
// byte-identical to today.
const KNOWN_PRODUCERS = ['clang', 'rust'];
const assertProducers = [];
// Sibling definition sources (#614, design §7): the dev origin resolves the
// gucos-packages sibling checkout by default (GUCOS_PACKAGES= override →
// worktree-aware main-clone sibling → naive sibling; os-common
// resolveSiblingRepo) and asserts the served /packages index COVERS every
// package the sibling defines — the deploy box mandates the sibling
// (comguc), so a dev origin silently serving a base index while sibling
// definitions exist would be exactly the partial-index lie the deploy path
// refuses. `--no-extra-packages` is the explicit opt-out (comguc's flag);
// a box without the checkout is untouched (nothing resolves, nothing
// changes).
let noExtraPackages = false;
// `--strict-port`: bind the REQUESTED port or fail loudly — never the silent
// walk to port+1 that tryListen does for a developer's convenience. The browser
// harness passes it (tests/browser/lib/os-harness.mjs startServer) because the
// walk is a false-signal generator there: the sweep's ports are fixed per file,
// so a squatting leftover pushes the real server aside while the test keeps
// polling the fixed port and talks to the STALE one — a red with nothing to do
// with the code under test. (Worse here than it looks: 3197 and 3198 are BOTH
// assigned to sweep files, so the +1 walk lands on another file's port.)
let strictPort = false;
// `--minimal`: serve the DEPLOY shape instead of the dev-convenience FAT one.
// The deployed origin (comguc/scripts/build.mjs step 1) bakes a PLAIN
// `mkimage.js --out=…` — no `--packages` fold — and then publishes the mkpkg
// repo at /packages (step 2), so every optional app installs at RUNTIME over
// HTTP. serve.js's default is the opposite: it folds every packages/<name>.json
// back into the blob, which is why the whole browser sweep can be green on an
// image that is not the one users boot. With this flag the served blob is
// minimal (empty os-release PACKAGES=) and /packages is still served from
// dist/packages — i.e. the two halves of the deploy, together.
//
// The minimal blob bakes to a SIDECAR (os-system.minimal.img) and is only
// SERVED under the os-system.img URL, exactly like the overlay sidecar below.
// os/os-system.img stays the fat shared fixture that tests/lib/image-fixture.js
// and every other suite depend on — baking minimal over it would make all of
// them detect a package-set mismatch and re-bake.
let minimalImage = false;
for (const a of process.argv.slice(2)) {
  if (a === '--clang') requestedOverlays.add('clang-apps');
  else if (a === '--minimal') minimalImage = true;
  else if (a === '--no-extra-packages') noExtraPackages = true;
  else if (a === '--strict-port') strictPort = true;
  else if (a.startsWith('--overlay=')) requestedOverlays.add(a.slice(10));
  else if (a.startsWith('--overlays=')) a.slice(11).split(',').forEach((id) => id && requestedOverlays.add(id));
  else if (a.startsWith('--packages-index=')) {
    for (const p of a.slice(17).split(',').filter(Boolean)) {
      if (!KNOWN_PRODUCERS.includes(p)) {
        console.error(`serve.js: --packages-index names an unknown producer '${p}' (known: ${KNOWN_PRODUCERS.join(', ')})`);
        process.exit(2);
      }
      if (!assertProducers.includes(p)) assertProducers.push(p);
    }
  }
  else if (a.startsWith('-')) { console.error(`serve.js: unknown option ${a}`); process.exit(2); }
  else positionals.push(a);
}
const arg = positionals[0] || 'build';
const preferredPort = parseInt(positionals[1] || '8080', 10);

// An overlay is by definition an ADDITIVE fat augmentation of the dev image;
// `--minimal` is the deploy's plain bake. Combining them has no meaning, and
// silently letting one win would serve an artifact nobody asked for.
if (minimalImage && requestedOverlays.size) {
  console.error('serve.js: --minimal and --overlay/--clang are mutually exclusive ' +
                '(an overlay augments the dev image; --minimal is the deploy\'s plain bake)');
  process.exit(2);
}

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

// The blob file this serve BAKES and SERVES. `os-system.img` is the shared fat
// fixture (tests/lib/image-fixture.js, the kernel suite, every other browser
// file); an overlay serve and a `--minimal` serve each bake their own SIDECAR
// so the three shapes never thrash one another's artifact. Whatever the name,
// the browser still fetches `os-system.img` beside the page (kernel-worker.js),
// so the request is rewritten to the sidecar at serve time.
const servedImageName = overlayPlan ? overlayPlan.imageName
                      : minimalImage ? 'os-system.minimal.img'
                      : 'os-system.img';

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
  // The dev serve serves the FAT image by default: every packages/<name>.json
  // folded back into the blob (gucman pulls them out of a plain bake), so
  // the in-browser estate matches the kernel-test fixture. `--minimal` is the
  // DEPLOY shape (comguc/scripts/build.mjs step 1): a plain bake with nothing
  // folded, paired with the /packages repo that is already served below —
  // optional apps install at runtime instead of riding the blob.
  const folded = COMMON.foldPackages(fs, path, dir,
    JSON.parse(fs.readFileSync(manifestPath, 'utf-8')), minimalImage ? [] : 'all');
  const manifest = folded.manifest;
  const wantPkgs = folded.names;
  const wanted = manifest.version | 0;
  const imageName = servedImageName;
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
  // `-r parent-watch` (#725): this process is BLOCKED in spawnSync for the
  // whole bake — its own parent watchdog cannot fire — so a serve.js that
  // dies here (test torn down mid-startup) used to leave the bake running
  // for minutes as an adopted orphan (the 2026-08-20 gate incident). The
  // preload makes the bake exit itself ~1s after its parent vanishes. A
  // human's serve.js in a live terminal is untouched (parent alive).
  // Resolved from the SERVED tree like mkimagePath; absent (non-repo dir)
  // → no preload, the pre-#725 behavior.
  const parentWatch = path.join(dir, 'tests', 'lib', 'parent-watch.js');
  const preload = fs.existsSync(parentWatch) ? ['-r', parentWatch] : [];
  const r = require('child_process').spawnSync(process.execPath,
    [...preload, mkimagePath, `--out=${imgPath}`, ...overlayArgs, ...packagesArgs],
    { stdio: 'inherit',
      env: { ...process.env, CC_HARNESS_GROUP_LEADER: '0' } });
  if (r.status !== 0) {
    console.error('mkimage failed — not serving a stale system image');
    process.exit(1);
  }
}
if (!singleFile) {
  ensureSystemImage(root, overlayPlan);
  if (minimalImage) {
    console.log(`[serve] minimal image: serving os/${servedImageName} (no packages folded) ` +
                '+ the /packages repo — the deploy shape');
  }
  if (overlayPlan) {
    for (const e of overlayPlan.enabled) {
      console.log(`[serve] overlay ${e.id} folded in (${e.producer}@${e.commitShort})`);
    }
  }
}

// --packages-index guard: the served /packages repo must be the superset over
// every asserted producer (serve-with-clang.js prebakes the clang one via
// `mkpkg --clang`; a rust origin prebakes via `mkpkg --rust`). A base index
// here means the prebake was bypassed — fail loud rather than serve a
// producer-mandatory origin without its gated cards.
if (assertProducers.length && !singleFile) {
  const idxPath = path.join(root, 'dist', 'packages', 'index.json');
  let idxNames = [];
  try {
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    idxNames = Object.keys(idx.packages || {});
  } catch (e) { /* handled below */ }
  for (const p of assertProducers) {
    const cards = idxNames.filter((n) => n.endsWith('-' + p));
    if (!cards.length) {
      console.error(`serve.js --packages-index=${p}: ${path.relative(root, idxPath)} is not the ${p} superset`);
      console.error(`  expected at least one *-${p} package (run tools/mkpkg.js --${p}` +
        (p === 'clang' ? ', or use serve-with-clang.js)' : ')'));
      process.exit(1);
    }
    console.log(`[serve] ${p} package index: ${cards.length} *-${p} card(s)`);
  }
}

// Sibling definition-source guard (#614): resolve the gucos-packages sibling
// and hold the served /packages repo to the MERGED result. Runs only when
// serving an OS tree (an os/image.json to serve against) — a bare-dir serve
// (the gucman e2es' repo servers) has no package origin to guard.
if (!singleFile && fs.existsSync(path.join(root, 'os', 'image.json'))) {
  // A served tree that carries os/image.json but no (or a pre-#614)
  // os-common.js is a synthetic fixture or a legacy checkout, not a repo
  // with definition sources to guard — stand down rather than crash the
  // serve (test_clang_overlay's trees are exactly this shape).
  let COMMON = null;
  try {
    COMMON = require(path.join(root, 'os', 'os-common.js'));
    if (typeof COMMON.resolveSiblingRepo !== 'function') COMMON = null;
  } catch (e) { COMMON = null; }
  if (COMMON === null) {
    // nothing to guard
  } else if (noExtraPackages) {
    console.log('[serve] --no-extra-packages: sibling definition sources ignored');
  } else {
    const sibling = COMMON.resolveSiblingRepo(fs, path, root, 'gucos-packages',
      { env: process.env.GUCOS_PACKAGES });
    if (sibling && !fs.existsSync(sibling.root)) {
      // Only the env override can name a nonexistent path (discovery
      // candidates are existence-checked) — an explicit override that is
      // wrong must fail loud, never fall through to a discovered candidate.
      console.error(`serve.js: GUCOS_PACKAGES=${process.env.GUCOS_PACKAGES} does not exist`);
      console.error('  fix: point it at the gucos-packages checkout, unset it, or pass --no-extra-packages');
      process.exit(1);
    }
    if (sibling) {
      let siblingNames;
      try {
        // The union enumeration surfaces a cross-source duplicate name LOUDLY
        // at serve start (#612's refusal), before any browser boots against it.
        COMMON.listPackages(fs, path, root, { defs: [sibling.root] });
        siblingNames = COMMON.listPackages(fs, path, sibling.root, {});
      } catch (e) {
        console.error(`serve.js: sibling definition source at ${sibling.root}: ${e.message}`);
        process.exit(1);
      }
      console.log(`[serve] gucos-packages sibling: ${sibling.root} (via ${sibling.via}, ${siblingNames.length} package(s))`);
      if (siblingNames.length) {
        const idxPath = path.join(root, 'dist', 'packages', 'index.json');
        if (fs.existsSync(idxPath)) {
          let idxNames = [];
          try { idxNames = Object.keys(JSON.parse(fs.readFileSync(idxPath, 'utf-8')).packages || {}); }
          catch (e) { /* unreadable index: every sibling name reports missing below */ }
          const missing = siblingNames.filter((n) => !idxNames.includes(n));
          if (missing.length) {
            console.error(`serve.js: ${path.relative(root, idxPath)} is missing sibling package(s): ${missing.join(', ')}`);
            console.error(`  the served /packages repo must be the MERGED index over the sibling definitions`);
            console.error(`  fix: node tools/mkpkg.js --defs=${sibling.root}   (or pass --no-extra-packages)`);
            process.exit(1);
          }
          console.log(`[serve] merged package index covers all ${siblingNames.length} sibling package(s)`);
        } else if (minimalImage) {
          // The deploy shape serves optional apps EXCLUSIVELY through
          // /packages — with sibling definitions present and no repo built,
          // the origin cannot match the deploy behaviour it claims to model.
          console.error(`serve.js --minimal: sibling defines ${siblingNames.length} package(s) but there is no dist/packages/index.json`);
          console.error(`  fix: node tools/mkpkg.js --defs=${sibling.root}   (or pass --no-extra-packages)`);
          process.exit(1);
        } else {
          console.error(`[serve] ⚠ sibling defines ${siblingNames.length} package(s) but no dist/packages repo is built — ` +
            `gucman installs of ${siblingNames.join(', ')} will 404 (build one: node tools/mkpkg.js --defs=${sibling.root})`);
        }
      }
    }
  }
}

// The browser always fetches `os-system.img` beside the page
// (kernel-worker.js) — serve the sidecar bytes for that path when this serve
// bakes one (an overlay, or `--minimal`), so the boot gets the requested blob
// without any kernel-worker change.
const baseImgFile = path.join(root, 'os', 'os-system.img');
const sidecarImgFile = servedImageName === 'os-system.img'
  ? null : path.join(root, 'os', servedImageName);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const serveStartedAt = new Date().toISOString();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // Identity handshake (#546): the browser harness asserts the 200s it
  // takes come from the serve.js it just SPAWNED, not from a stale one
  // squatting the port — a stale server answers 200s indistinguishably at
  // the HTTP level and certifies the WRONG TREE (the L77 fake-green class).
  if (url === '/__serve-id') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pid: process.pid, root, startedAt: serveStartedAt }));
    return;
  }
  let file = singleFile && url === '/' ? singleFile : path.join(root, url === '/' ? 'index.html' : url);
  // The package repo (gucman): /packages/* serves tools/mkpkg.js output from
  // dist/packages/* — the same layout the Pages deploy publishes, so the
  // baked origin-relative repo default (/usr/share/gucman/repos) works
  // against the dev serve too.
  if (url === '/packages/index.json' || url.startsWith('/packages/pool/')) {
    file = path.join(root, 'dist', url.slice(1));
  }
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (sidecarImgFile && path.resolve(file) === baseImgFile) file = sidecarImgFile;
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
