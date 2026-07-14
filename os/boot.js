#!/usr/bin/env node
// boot.js — headless boot of the reference OS (todos/0004; OS.md
// "agent-friendly by construction"). Same kernel, same image manifest, same
// shell as os/os.html — but under plain Node with the tty on stdio, so
// agents and CI drive the OS with pipes and exit codes:
//
//   echo 'ls /' | node os/boot.js
//   printf 'cc hello.c && ./a.out\nexit\n' | node os/boot.js
//   node os/boot.js                    # interactive (raw-mode terminal)
//
// The OS lives on TWO volumes (todos/0026 + the 0040 flip): a WRITABLE root
// volume at `/` (/etc, /var, /tmp, /root, /dev, /run — user territory, never
// touched by upgrades) and a READ-ONLY baked system blob mounted at `/usr`
// (`/bin` is a root-volume symlink to /usr/bin). The blob is materialized
// here on demand — a missing, version-stale, or input-stale (todos/0082)
// system image installs a prebaked fixture when one is fresh, else re-bakes
// from os/image.json (the same pipeline as tools/mkimage.js); the root volume is
// seeded once, when freshly created, from the manifest's `user` section.
// Upgrades are therefore "swap the blob": user files can't be touched.
//
//   --image=PATH   system image file (default: os/os-system.img); the root
//                  image lives beside it (foo-system.img -> foo-root.img)
//   --fixture=PATH prebaked blob to INSTALL (file copy, no compiling) when
//                  the system image must be materialized (todos/0082).
//                  Default: os/os-system.img (tools/mkimage.js output).
//                  Used only if version-current AND input-fresh.
//   --no-fixture   never install a prebaked blob — a needed blob really
//                  bakes (the bake-path tests use this)
//   --stale-ok     trust any version-current blob: skip the 0082
//                  input-freshness check (which re-bakes when compiler.js/
//                  os// vendor sources are newer than the blob)
//   --fresh        discard BOTH images: re-materialize + re-seed
//   --fresh-system re-BAKE the system blob outright (user files survive;
//                  implies --no-fixture)
//   --overlay=<id> enable a declared image overlay (todos/0118, repeatable);
//                  --overlays=all enables all. Forces a system re-bake (the
//                  prebaked fixture and any reused blob are base-only).
//   --require-clean-overlays  a dirty overlay provenance is fatal (else warns)
//   --quiet        suppress boot progress on stderr
//   --tty-out      fd 1/2 tty-kind even under pipes (isatty(1) true, so
//                  shells go interactive — drive prompts/job control from
//                  a script; output gains prompts/echo, no longer byte-clean)
//   --dump-state   dev aid: dump each process's RPC/waiter state every 3s
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(__dirname, 'os-common.js'));

/* ---- args ---- */
let imagePath = path.join(__dirname, 'os-system.img');
let fixturePath = path.join(__dirname, 'os-system.img');   // null = --no-fixture
let freshBoot = false;
let freshSystem = false;   // re-bake only the system blob (user files survive)
let staleOk = false;       // skip the 0082 input-freshness check
let quiet = false;
let dumpState = false;
let ttyOut = false;   // force fd1/2 tty-kind under pipes (drive interactive shells)
let requireCleanOverlays = false;
let allOverlays = false;
const requestedOverlays = new Set();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--image=')) imagePath = path.resolve(a.slice(8));
  else if (a.startsWith('--fixture=')) fixturePath = path.resolve(a.slice(10));
  else if (a === '--no-fixture') fixturePath = null;
  else if (a === '--stale-ok') staleOk = true;
  else if (a === '--fresh') freshBoot = true;
  else if (a === '--fresh-system') freshSystem = true;
  else if (a === '--quiet') quiet = true;
  else if (a === '--dump-state') dumpState = true;
  else if (a === '--tty-out') ttyOut = true;
  else if (a === '--overlays=all') allOverlays = true;
  else if (a.startsWith('--overlay=')) requestedOverlays.add(a.slice(10));
  else if (a.startsWith('--overlays=')) a.slice(11).split(',').forEach((id) => id && requestedOverlays.add(id));
  else if (a === '--require-clean-overlays') requireCleanOverlays = true;
  else {
    process.stderr.write(`boot.js: unknown option ${a}\n`);
    process.exit(2);
  }
}
// The root (writable) volume lives beside the system image: foo-system.img
// or foo.img -> foo-root.img (default pair: os-system.img + os-root.img).
const rootImagePath = imagePath.endsWith('-system.img')
  ? imagePath.slice(0, -11) + '-root.img'
  : imagePath.endsWith('.img')
    ? imagePath.slice(0, -4) + '-root.img'
    : imagePath + '-root';
const bootLog = quiet ? () => {} : (m) => process.stderr.write('[boot] ' + m + '\n');

/* ---- the seed/bake io (repo-relative assets, synchronous reads) ---- */
const seedIo = {
  readAsset: (name) => fs.readFileSync(path.join(__dirname, name), 'utf-8'),
  // bin entries (game data: doom1.wad, ROMs) are repo-relative binaries
  readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
  // project entries (busybox hush) are repo-relative multi-file builds
  buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
    (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
  log: bootLog,
};
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'image.json'), 'utf-8'));

// Optional opt-in image overlays (todos/0118): resolve requested ids against
// image.json `overlays[]` (unknown id -> exit 2, before any work). Overlays are
// baked into the system blob, so requesting any forces a real bake — the
// prebaked fixture and any reused/version-current blob are base-only.
const resolvedOverlays = (() => {
  const declared = manifest.overlays || [];
  const byId = new Map(declared.map((o) => [o.id, o]));
  const ids = allOverlays ? declared.map((o) => o.id) : [...requestedOverlays];
  for (const id of ids) {
    if (!byId.has(id)) {
      process.stderr.write(`boot.js: unknown overlay '${id}' (declared: ${declared.map((o) => o.id).join(', ') || 'none'})\n`);
      process.exit(2);
    }
  }
  return ids.map((id) => {
    const o = byId.get(id);
    return { id, manifestPath: path.isAbsolute(o.manifest) ? o.manifest : path.join(ROOT, o.manifest) };
  });
})();
if (resolvedOverlays.length) {
  freshSystem = true;   // overlays live in the system blob — bake, never reuse/install
  fixturePath = null;
  seedIo.overlays = resolvedOverlays;
  seedIo.overlayIo = COMMON.nodeOverlayIo(fs, path, require('crypto'));
  seedIo.requireCleanOverlays = requireCleanOverlays;
}

/* ---- boot ---- */
mountAndBoot().catch((e) => {
  process.stderr.write('boot failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});

async function mountAndBoot() {
  /* System blob: materialize on demand, then mount READ-ONLY at /usr.
   * bakedVersion() reads the blob's own /usr/share/os-release, written last
   * in the bake, so a crashed half-bake/half-copy reads -1 and
   * re-materializes. STRICTLY older re-bakes; a NEWER blob (an upgrade
   * swapped in from outside, e.g. mkimage against a bumped manifest) is
   * kept as-is — "upgrade = swap the blob". A blob at EXACTLY the manifest
   * version must also be input-fresh (todos/0082): bake inputs newer than
   * the blob's mtime mean it predates the current tree — never silently
   * reuse it (--stale-ok overrides). Materialization prefers INSTALLING a
   * prebaked fixture (file copy ≪ bake; --fixture=, default the repo's
   * os/os-system.img) when that fixture is itself version-current and
   * input-fresh; --no-fixture and --fresh-system force a real bake. */
  const store = new COMMON.NodeFileStore(fs, imagePath, freshBoot || freshSystem);
  const mfVersion = manifest.version | 0;
  let inputScan = null;   // lazy: ~10-25ms over ~2500 files, only when needed
  const newestInput = () => inputScan ||
    (inputScan = COMMON.newestBakeInput(fs, path, ROOT, manifest));
  let sysMode = null;   // 'reused' | 'installed' | 'baked'
  const bv = COMMON.bakedVersion(BLOCK_FS, store);
  if (bv > mfVersion) sysMode = 'reused';           // an upgrade blob is kept
  else if (bv === mfVersion) {
    if (staleOk || fs.statSync(imagePath).mtimeMs >= newestInput().mtimeMs) {
      sysMode = 'reused';
    } else {
      bootLog('system blob is input-stale (' + path.relative(ROOT, newestInput().path) +
        ' is newer) — re-materializing');
    }
  }
  if (sysMode === null && fixturePath && !freshSystem &&
      path.resolve(fixturePath) !== imagePath) {
    try {
      const fSt = fs.statSync(fixturePath);
      const bytes = fs.readFileSync(fixturePath);
      const mem = new BLOCK_FS.MemoryByteStore(bytes.length);
      mem.setBytes(0, bytes);
      const fv = COMMON.bakedVersion(BLOCK_FS, mem);
      if (fv >= mfVersion && (staleOk || fSt.mtimeMs >= newestInput().mtimeMs)) {
        bootLog('installing prebaked system image ' + fixturePath + ' (v' + fv + ')');
        // Superblock LAST (the kernel-worker discipline): a crash mid-copy
        // reads version -1 next boot and re-materializes.
        store.resize(0);
        if (bytes.length > 256) store.setBytes(256, bytes.subarray(256));
        store.setBytes(0, bytes.subarray(0, Math.min(256, bytes.length)));
        store.flush();
        fs.utimesSync(imagePath, fSt.atime, fSt.mtime);  // freshness rides along
        sysMode = 'installed';
      } else if (fv >= mfVersion) {
        bootLog('prebaked ' + fixturePath + ' is input-stale (' +
          path.relative(ROOT, newestInput().path) + ' is newer) — baking instead');
      }
    } catch (e) { /* missing/unreadable fixture -> bake */ }
  }
  if (sysMode === null) {
    // Stamp the blob with the bake START time: an input edited DURING the
    // bake may or may not be reflected, so it must read as newer.
    const bakeStart = new Date();
    store.resize(0);   // a stale blob re-bakes from scratch (regenerable)
    await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, manifest, seedIo);
    store.flush();
    fs.utimesSync(imagePath, bakeStart, bakeStart);
    sysMode = 'baked';
  }
  const sysFs = BLOCK_FS.createV4(store, { readonly: true });
  // Process-side read-only /usr (todos/0180): ONE SAB copy of the sealed
  // system image, shipped to every process worker at spawn — /usr reads
  // (fonts, configs, assets) stop crossing the RPC boundary.
  const roSab = BLOCK_FS.storeToSab(store);

  /* Root (writable) volume: fresh files get the skeleton + the manifest's
   * `user` section, exactly once. Later boots (and system re-bakes) never
   * write here — that's the whole 0040 contract. */
  const rootFresh = freshBoot || !fs.existsSync(rootImagePath);
  const rootStore = new COMMON.NodeFileStore(fs, rootImagePath, freshBoot);
  const rootFs = BLOCK_FS.createV4(rootStore);   // devNodes ON: its /dev IS /dev
  // /proc (todos/0043): a synthetic kernel-rendered volume — the Kernel
  // constructor binds itself to it via the mount table.
  const kfs = new BLOCK_FS.MountFS({ '/': rootFs, '/usr': sysFs, '/proc': new K.ProcFS() });
  if (rootFresh) {
    bootLog('seeding user volume (manifest v' + manifest.version + ')');
    COMMON.initRootVolume(kfs);
    await COMMON.seedEntries(kfs, manifest.user, seedIo);
    rootStore.flush();
  }
  bootLog('image ' + imagePath + ' (' + sysMode + ')' +
    ' + ' + rootImagePath + (rootFresh ? ' (seeded)' : ''));

  const ccCompile = COMMON.createCcDriver(CompilerJS, kfs);
  const interactive = !!process.stdin.isTTY;

  const kernel = new K.Kernel({
    fs: kfs,
    roImage: { prefix: '/usr', sab: roSab },   // todos/0180
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => COMMON.readFileBytes(kfs, p),
    compile: ccCompile,
    onOutput: (pid, fd, bytes) => {
      (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(bytes));
    },
    onHalt: (status) => {
      rootStore.flush();
      rootStore.close();
      store.close();                    // read-only: nothing to flush
      // POSIX-style: exit code for a clean init exit, 128+sig if it died.
      const sig = status & 0x7f;
      process.exit(sig ? 128 + sig : (status >> 8) & 0xff);
    },
    log: quiet ? () => {} : (m) => process.stderr.write('[kernel] ' + m + '\n'),
  });

  const tty = kernel.createTty({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    // Echo/edit control bytes matter only when a human is typing; under piped
    // stdin (agents, CI) dropping them keeps stdout byte-exact program output.
    output: interactive ? (b) => process.stdout.write(Buffer.from(b)) : () => {},
    // A human terminal makes fd 1/2 tty-kind (isatty true -> the shell goes
    // interactive: prompt, line editing, job control). Piped runs keep plain
    // output channels so stdout stays byte-exact.
    interactiveOut: ttyOut || (interactive && !!process.stdout.isTTY),
  });

  /* ---- stdio <-> tty bridge ---- */
  if (interactive) {
    process.stdin.setRawMode(true);          // the KERNEL owns the line discipline
    process.stdout.on('resize', () => {
      tty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    });
  }
  process.stdin.on('data', (chunk) => tty.input(new Uint8Array(chunk)));
  process.stdin.on('end', () => tty.eof());
  process.stdin.resume();

  /* ---- debug: periodic kernel-state dump (development aid) ---- */
  if (dumpState) {
    setInterval(() => {
      // fgPgid vs each pcb's pgid: the 0171 wedge class is a foreground
      // pgid pointing at a dead/wrong pgroup (tty reads then die SIGTTIN/EIO).
      process.stderr.write(`[state] tty fgPgid=${tty.fgPgid}` +
        ` cooked=${JSON.stringify(String.fromCharCode.apply(null, tty._cooked.slice(0, 80)))}` +
        ` line=${JSON.stringify(String.fromCharCode.apply(null, tty._line.slice(0, 80)))}` +
        ` lflag=0x${tty.termios.lflag.toString(16)} waiters=[${tty.waiters}]\n`);
      kernel._procs.forEach((pcb) => {
        const st = Atomics.load(pcb.i32, 4 /* KP_RPC_STATE */);
        const op = Atomics.load(pcb.i32, 5 /* KP_RPC_OP */);
        process.stderr.write(`[state] pid ${pcb.pid} pgid ${pcb.pgid} ${pcb.state}` +
          ` rpc=${st}/op=0x${op.toString(16)}` +
          ` waiter=${pcb.waiter ? pcb.waiter.op : '-'}\n`);
      });
    }, 3000).unref();
  }

  // The WM control plane (todos/0014) — same shape as kernel-worker.js:
  // endpoint first, /bin/wm as a kernel service after pid 1 (non-fatal;
  // kernel-chrome is the fallback, `wm &` respawns).
  kernel.wmServe();
  await kernel.boot({
    path: '/bin/sh',
    // "-sh": login shell — hush sources /etc/profile then ~/.profile, where
    // per-user exports (ANTHROPIC_* for /bin/code) live (todos/0174)
    argv: ['-sh'],
    envp: ['PATH=/usr/local/bin:/bin', 'HOME=/root', 'TERM=xterm-256color'],
    cwd: '/root',
  });
  await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/usr/local/bin:/bin'] });
}
