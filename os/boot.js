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
//   --packages=all|none|a,b   the package set the system blob must carry
//                  (gucman: apps pulled out of the base image into
//                  packages/<name>.json). Default `all` — headless dev/test
//                  boots keep the full estate baked in, matching the fixture.
//                  The gate compares the blob's os-release PACKAGES= line
//                  (os-common.bakedPackages) against this set, so a minimal
//                  blob is only reused under --packages=none (the
//                  test_gucman_e2e mode) and a bake folds exactly this set.
//   --host-platform=mac   seed the macos keyboard scheme as the DEFAULT on a
//                  freshly-created root volume (META-ARROW-KEYBIND.md decision
//                  4; the browser twin auto-detects via navigator). Any other
//                  value (default) leaves the baked windows scheme. A manual
//                  ~/.config/keys always overrides — this only sets the default.
//   --wait-lock[=SECS]  the heavy-test host lock (tests/lib/heavy-lock.js) is
//                  fail-fast by default: when another heavy job owns the host
//                  this boot exits 3 and names the holder. This flag opts in
//                  to a LOUD wait instead (poll + a status line every 30s),
//                  acquiring when the lock frees; with =SECS it exits 3 at
//                  the deadline. For an interactive reproduce beside a
//                  running suite.
//   --quiet        suppress boot progress on stderr
//   --screen=WxH   headless screen dims (default: the kernel's 1024x768) —
//                  small-viewport runs (todos/0282)
//   --vsync[=hz]   drive kernel.vsyncTick() from a host timer (ticket #424;
//                  default 60, want 1..1000 — a ms timer can't honestly
//                  deliver more). The headless twin of the browser
//                  compositor's rAF (todos/0100): the kernel advertises a
//                  frame clock at spawn, so SDL frame loops pace off
//                  vsyncWait instead of host.js's deadline pacer — the seam
//                  for testing frame-paced code without a browser. rAF
//                  semantics on overrun: missed ticks are skipped, never
//                  queued. Off by default: a plain boot advertises nothing
//                  and is byte-identical to today. The timer never parks
//                  (no compositor here; the todos/0169 park protocol is the
//                  browser's power model) and never holds the process open.
//   --tty-out      fd 1/2 tty-kind even under pipes (isatty(1) true, so
//                  shells go interactive — drive prompts/job control from
//                  a script; output gains prompts/echo, no longer byte-clean)
//   --dump-state   dev aid: dump each process's RPC/waiter state every 3s
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Cross-tree preflight (todos/0341, extended by #142): boot.js re-bakes and
// installs ITS OWN tree's image fixture, so a foreign-cwd launch silently
// rewrites another tree's blob. GUARDED, not exempted — the #142 survey
// measured every harness spawn: the kernel e2es inherit the suite-runner's
// `cwd: tests/kernel` (drive.js driveBoot passes no cwd; the mkdtemp fixture
// dir is only the --image= argument, never the cwd), and test_heavylock_e2e
// sets ROOT-based cwds explicitly. Ahead of the heavy requires and the
// heavy-lock join below — refuse before you load a compiler or take a
// machine-wide lock (the todos/0341 order).
require(path.join(ROOT, 'tests/lib/tree-guard.js'))
  .assertSameTree(__dirname, { label: 'os/boot.js' });

const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(__dirname, 'os-common.js'));
const OS_KSVC = require(path.join(__dirname, 'ksvc.js'));

/* ---- args ---- */
let imagePath = path.join(__dirname, 'os-system.img');
let fixturePath = path.join(__dirname, 'os-system.img');   // null = --no-fixture
let freshBoot = false;
let freshSystem = false;   // re-bake only the system blob (user files survive)
let staleOk = false;       // skip the 0082 input-freshness check
let quiet = false;
let dumpState = false;
let screenDims = null; // --screen=WxH: headless screen dims (kernel default 1024x768)
let vsyncHz = null;   // --vsync[=hz]: timer-driven vsyncTick (#424; null = off)
let ttyOut = false;   // force fd1/2 tty-kind under pipes (drive interactive shells)
let requireCleanOverlays = false;
let allOverlays = false;
let packagesWant = 'all';   // the package set the blob must carry (see header)
let packagesDir = null;     // --packages-dir=DIR: read definitions from DIR
let noDefaultPackages = false;  // --no-default-packages: throwaway bake, carry no default set
let hostPlatform = 'other'; // --host-platform: the keyboard-scheme auto-detect
                            // hint (META-ARROW-KEYBIND.md). Default 'other' =
                            // no seed = the baked windows scheme, so every
                            // headless boot stays byte-identical unless asked.
let waitLockMs = 0;         // --wait-lock[=SECS]: loud wait on the heavy-test
                            // host lock instead of the fail-fast exit 3
                            // (0 = fail fast, Infinity = no deadline)
let egressDir = null;       // --egress-dir=DIR: the headless onEgress twin
                            // (todos/0398) — artifacts land as host files.
                            // Flag absent -> no hook -> the RPC answers
                            // ENOSYS (deliberately no silent fallback).
const requestedOverlays = new Set();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--image=')) imagePath = path.resolve(a.slice(8));
  else if (a.startsWith('--fixture=')) fixturePath = path.resolve(a.slice(10));
  else if (a === '--no-fixture') fixturePath = null;
  else if (a === '--stale-ok') staleOk = true;
  else if (a === '--fresh') freshBoot = true;
  else if (a === '--fresh-system') freshSystem = true;
  else if (a === '--quiet') quiet = true;
  else if (a.startsWith('--screen=')) {           // WxH (todos/0282: small-
    const m = /^(\d+)x(\d+)$/.exec(a.slice(9));   // viewport headless runs)
    if (!m) { process.stderr.write('boot: bad --screen (want WxH)\n'); process.exit(2); }
    screenDims = { w: +m[1], h: +m[2] };
  }
  else if (a === '--vsync') vsyncHz = 60;
  else if (a.startsWith('--vsync=')) {
    const hz = Number(a.slice(8));
    if (!Number.isFinite(hz) || hz < 1 || hz > 1000) {
      process.stderr.write('boot: bad --vsync (want hz 1..1000)\n');
      process.exit(2);
    }
    vsyncHz = hz;
  }
  else if (a === '--dump-state') dumpState = true;
  else if (a === '--tty-out') ttyOut = true;
  else if (a === '--overlays=all') allOverlays = true;
  else if (a.startsWith('--overlay=')) requestedOverlays.add(a.slice(10));
  else if (a.startsWith('--overlays=')) a.slice(11).split(',').forEach((id) => id && requestedOverlays.add(id));
  else if (a === '--require-clean-overlays') requireCleanOverlays = true;
  else if (a === '--packages=all') packagesWant = 'all';
  else if (a.startsWith('--packages='))
    packagesWant = a.slice(11) === 'none' ? [] : a.slice(11).split(',').filter(Boolean);
  else if (a.startsWith('--packages-dir=')) packagesDir = path.resolve(a.slice(15));
  else if (a === '--no-default-packages') noDefaultPackages = true;
  else if (a.startsWith('--host-platform=')) hostPlatform = a.slice(16);
  else if (a.startsWith('--egress-dir=')) egressDir = path.resolve(a.slice(13));
  else if (a === '--wait-lock') waitLockMs = Infinity;
  else if (a.startsWith('--wait-lock=')) {
    const secs = Number(a.slice(12));
    if (!Number.isFinite(secs) || secs < 0) {
      process.stderr.write('boot: bad --wait-lock (want seconds)\n');
      process.exit(2);
    }
    waitLockMs = secs * 1000;
  }
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
  // bin entries (game data: gameboy ROMs) are repo-relative binaries
  readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
  // project entries (busybox hush) are repo-relative multi-file builds
  buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
    (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
  log: bootLog,
};
const rawManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'image.json'), 'utf-8'));

// Fold the wanted package set into the bake manifest (gucman): the folded
// manifest drives the bake AND the input-freshness scan (a fat blob depends
// on the folded packages' vendor closure too); wantPkgs is what the
// identity gates compare against the blob's PACKAGES= line.
let manifest, wantPkgs;
try {
  const folded = COMMON.foldPackages(fs, path, ROOT, rawManifest, packagesWant,
    { packagesDir, noDefaultPackages });
  manifest = folded.manifest;
  wantPkgs = folded.names;
} catch (e) {
  process.stderr.write(`boot.js: ${e.message}\n`);
  process.exit(2);
}

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

/* ---- single-instance image guard (todos/0293, the 0045 follow-up) ---- */
// The browser side has always been guarded (one kernel per origin: a Web
// Lock named after the OPFS image pair, todos/0045); headless boot.js was
// "safe by isolation, not by design" — the kernel e2es mint a fresh mkdtemp
// pair per boot, so nothing ever collided IN TESTS, but two hand-run boots
// against the default os/ pair are two live BlockFS instances over one
// writable store, and BlockFS's own multi-instance rules call that silent
// cross-file corruption. So: one boot per image pair, machine-wide, keyed
// by a sidecar lockfile beside the WRITABLE root image (the corruptible
// store; the pair derives 1:1 from it). Same semantics as the Web Lock:
// REFUSE and say so — no queueing, because a second boot of one pair is
// never a legitimate workload to wait for. Self-heals a stale file left by
// a SIGKILLed holder (dead pid = steal), releases on exit and signals.
// Exit 5 = IMAGE PAIR BUSY (1 boot-fail, 2 bad args, 3 heavy lock held,
// 4 cross-tree). Taken BEFORE the machine-wide heavy lock below: refuse
// over the narrow resource before contending for the wide one.
const IMAGE_LOCK_PATH = rootImagePath + '.lock';
{
  const { pidAlive } = require(path.join(ROOT, 'tests/lib/heavy-lock.js'));
  const readHolder = () => {
    try { return JSON.parse(fs.readFileSync(IMAGE_LOCK_PATH, 'utf8')); }
    catch { return null; }   // missing or half-written → treat as none
  };
  for (;;) {
    try {
      const fd = fs.openSync(IMAGE_LOCK_PATH, 'wx');   // O_EXCL: atomic
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        image: imagePath,
        startedAt: new Date().toISOString(),
        argv: process.argv.slice(1),
      }));
      fs.closeSync(fd);
      break;                                           // we own the pair
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const h = readHolder();
      if (h && h.pid !== process.pid && pidAlive(h.pid)) {
        process.stderr.write(
          `boot: REFUSING to boot ${imagePath}: the image pair is in use.\n` +
          `  held by: pid ${h.pid} since ${h.startedAt} (lock ${IMAGE_LOCK_PATH})\n` +
          `  Two boots of one pair are two writers over one root volume —\n` +
          `  silent cross-file corruption, not sharing. Wait for that boot to\n` +
          `  exit, or boot a different --image= pair.\n`);
        process.exit(5);
      }
      // stale (dead/garbage holder): steal, then loop to re-create
      try { fs.unlinkSync(IMAGE_LOCK_PATH); } catch { /* raced a stealer */ }
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const h = readHolder();
    if (h && h.pid === process.pid) {
      try { fs.unlinkSync(IMAGE_LOCK_PATH); } catch { /* gone */ }
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(130); });
  }
}

/* ---- heavy-test host lock (todos/0342, closing todos/0303) ---- */
// A full-OS boot is the unit of RAM the heavy lock bounds (~2-4 GB per boot
// node), so the guard runs HERE — where the boot starts — not in whichever
// runner or e2e spawned it. Under a suite runner the runner already owns the
// lock and exported CC_HEAVY_LOCK_PID; joinHeavyLock verifies that marker
// (pid alive AND equal to the recorded holder) and joins re-entrantly, which
// is why the kernel suite's fan-out of concurrent boots cannot deadlock. A
// bare boot, a single-file e2e, or a bench tool contends normally: own the
// lock, or exit 3 naming the holder (--wait-lock[=SECS] opts in to a loud
// wait instead). All argument validation stays ABOVE this call — refuse
// before you take a machine-wide lock (the todos/0341 order).
require(path.join(ROOT, 'tests/lib/heavy-lock.js'))
  .joinHeavyLock({ name: 'os/boot.js', waitMs: waitLockMs });

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
  const wantPkgKey = wantPkgs.join(',');
  const pkgsMatch = (st) => COMMON.bakedPackages(BLOCK_FS, st).join(',') === wantPkgKey;
  const bv = COMMON.bakedVersion(BLOCK_FS, store);
  if (bv > mfVersion) sysMode = 'reused';           // an upgrade blob is kept
  else if (bv === mfVersion) {
    if (!pkgsMatch(store)) {
      bootLog('system blob package set [' +
        COMMON.bakedPackages(BLOCK_FS, store).join(',') + '] != wanted [' +
        wantPkgKey + '] — re-materializing');
    } else if (staleOk || fs.statSync(imagePath).mtimeMs >= newestInput().mtimeMs) {
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
      if (fv >= mfVersion && !pkgsMatch(mem)) {
        bootLog('prebaked ' + fixturePath + ' package set [' +
          COMMON.bakedPackages(BLOCK_FS, mem).join(',') + '] != wanted [' +
          wantPkgKey + '] — baking instead');
      } else if (fv >= mfVersion && (staleOk || fSt.mtimeMs >= newestInput().mtimeMs)) {
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
    // Baked packages' `seed` content (gucman content-resource design §3.5):
    // planted from the SEALED BLOB, after the manifest's own user entries
    // (which therefore win any collision). Identical here and in the browser
    // worker by construction — neither reads the manifest for this.
    const nseed = COMMON.seedBakedSeeds(kfs, bootLog);
    if (nseed) bootLog('seeded ' + nseed + ' file(s) from baked packages');
    // Host keyboard-scheme auto-detect (META-ARROW-KEYBIND.md decision 4):
    // seed macos as the DEFAULT on a Mac host (admin layer; user config wins).
    if (COMMON.seedHostKeyScheme(kfs, hostPlatform))
      bootLog('host keyboard scheme -> macos (Mac host default)');
    rootStore.flush();
  }
  // Persisted host verdict (ticket #96): every boot, fresh or stale root —
  // keys.h's implicit host-native paste row reads /run/host-platform.
  COMMON.writeHostPlatform(kfs, hostPlatform);
  bootLog('image ' + imagePath + ' (' + sysMode + ')' +
    ' + ' + rootImagePath + (rootFresh ? ' (seeded)' : ''));

  const ccCompile = COMMON.createCcDriver(CompilerJS, kfs);
  const interactive = !!process.stdin.isTTY;

  // Kernel text service (todos/0275): same blob, same loader as the browser
  // kernel worker — a throw here fails the boot loudly (nonzero exit), so
  // headless composites can never quietly go textless.
  const textService = OS_KSVC.load(kfs, { log: quiet ? () => {} : bootLog });

  // The switchable HTTP fetch (ticket #349, NETWORK.md Tier 2.5) — same
  // wrapper as the browser kernel-worker, so headless honours the same
  // `net` store: OFF (default) is the bound global fetch, byte-identical
  // to passing nothing; ON reroutes through the localhost bridge.
  const netFetch = COMMON.createNetFetch();

  const kernel = new K.Kernel({
    fs: kfs,
    fetch: netFetch,   // #349 — the Tier 2.5 net-bridge wrapper
    screen: screenDims || undefined,   // --screen=WxH (todos/0282)
    vsync: vsyncHz != null,   // --vsync[=hz] (#424): advertise the frame
                              // clock at spawn; the timer below is its
                              // source. False = today's no-clock boot.
    textService,   // todos/0275 — headless composite label text
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
    // Egress (todos/0398): the headless twin of the browser download/save
    // actor — the finished artifact lands as a host file under --egress-dir
    // (both dispositions; there is no picker to raise here). Collisions get
    // the dropFile '-N' suffix: an egress never overwrites an earlier one.
    // A write failure throws back into the kernel dispatch -> the caller
    // sees EIO, loud.
    onEgress: egressDir ? (dispo, name, bytes) => {
      fs.mkdirSync(egressDir, { recursive: true });
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let final = name;
      for (let i = 1; fs.existsSync(path.join(egressDir, final)); i++) {
        if (i > 99) throw new Error('egress: 99 name collisions on ' + name);
        final = stem + '-' + i + ext;
      }
      fs.writeFileSync(path.join(egressDir, final), bytes);
      bootLog('egress (' + dispo + ') ' + final + ' <- ' + bytes.length + ' bytes');
    } : undefined,
    log: quiet ? () => {} : (m) => process.stderr.write('[kernel] ' + m + '\n'),
  });

  /* ---- headless frame clock (--vsync[=hz], ticket #424) ----
   * The browser twin is the compositor rAF calling vsyncTick() per composite
   * (os/compositor.js). Here a drift-corrected setTimeout chain aims at an
   * absolute hz schedule (the todos/0100 pacer lesson: naive fixed-delay
   * timers add callback time to the period). Overrun keeps rAF semantics:
   * missed ticks are SKIPPED, never queued — vsyncWait's catch-up collapses
   * them to one immediate frame, same as a browser tab that stalled. The
   * timer is unref'd so it never keeps a halted boot alive, and it never
   * parks: headless has no compositor, so the 0169 park protocol (an idle-
   * power concern) has no counterpart here — an always-visible display. */
  if (vsyncHz != null) {
    const period = 1000 / vsyncHz;
    let nextDue = Date.now() + period;
    const arm = () => {
      setTimeout(() => {
        kernel.vsyncTick();
        nextDue += period;
        const now = Date.now();
        if (nextDue <= now) nextDue = now + period;   // overrun: skip, don't burst
        arm();
      }, Math.max(0, nextDue - Date.now())).unref();
    };
    arm();
  }

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

  // The net-bridge toggle rides the watchPath choke (ticket #349) — a
  // settled write to any `net` store layer retargets the NEXT transfer.
  COMMON.netFetchAttach(netFetch, kernel, kfs);

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
  // Default-package sync (#419): eager install of the declared default set on
  // any boot where one is missing (jku ruling 2026-08-03 — the eager shape; a
  // font default is pulled in by a glyph-cache miss, not a click, so the
  // trigger must be the boot). Spawned only when a defaults list exists at
  // all — the shipped manifest declares none, so a no-defaults boot spawns
  // nothing and stays byte-identical. Non-fatal like wm; the service's fd 1/2
  // route to the boot console (the progress/failure UI); a failed install
  // retries on the next boot; outcome record at /run/gucman-sync.status.
  if (kfs.stat('/etc/gucman/defaults') || kfs.stat('/usr/share/gucman/defaults')) {
    await kernel.service({ path: '/bin/gucman', argv: ['gucman', 'sync-defaults'],
                           envp: ['PATH=/usr/local/bin:/bin'] });
  }
}
