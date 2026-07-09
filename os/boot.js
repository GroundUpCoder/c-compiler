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
// (`/bin` is a root-volume symlink to /usr/bin). The blob is baked here on
// demand — missing or version-stale system image -> re-bake from
// os/image.json (the same pipeline as tools/mkimage.js); the root volume is
// seeded once, when freshly created, from the manifest's `user` section.
// Upgrades are therefore "swap the blob": user files can't be touched.
//
//   --image=PATH   system image file (default: os/os-system.img); the root
//                  image lives beside it (foo-system.img -> foo-root.img)
//   --fresh        discard BOTH images: re-bake + re-seed
//   --fresh-system re-bake only the system blob (user files survive)
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
let freshBoot = false;
let freshSystem = false;   // re-bake only the system blob (user files survive)
let quiet = false;
let dumpState = false;
let ttyOut = false;   // force fd1/2 tty-kind under pipes (drive interactive shells)
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--image=')) imagePath = path.resolve(a.slice(8));
  else if (a === '--fresh') freshBoot = true;
  else if (a === '--fresh-system') freshSystem = true;
  else if (a === '--quiet') quiet = true;
  else if (a === '--dump-state') dumpState = true;
  else if (a === '--tty-out') ttyOut = true;
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

/* ---- boot ---- */
mountAndBoot().catch((e) => {
  process.stderr.write('boot failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});

async function mountAndBoot() {
  /* System blob: bake on demand (missing / version-stale / --fresh*), then
   * mount READ-ONLY at /usr. bakedVersion() is the staleness gate — it reads
   * the blob's own /usr/share/os-release, written last in the bake, so a
   * crashed half-bake reads -1 and re-bakes. STRICTLY older re-bakes; a
   * NEWER blob (an upgrade swapped in from outside, e.g. mkimage against a
   * bumped manifest) is kept as-is — "upgrade = swap the blob". */
  const store = new COMMON.NodeFileStore(fs, imagePath, freshBoot || freshSystem);
  let baked = false;
  if (COMMON.bakedVersion(BLOCK_FS, store) < (manifest.version | 0)) {
    store.resize(0);   // a stale blob re-bakes from scratch (regenerable)
    await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, manifest, seedIo);
    baked = true;
  }
  const sysFs = BLOCK_FS.createV4(store, { readonly: true });

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
  bootLog('image ' + imagePath + (baked ? ' (baked)' : ' (reused)') +
    ' + ' + rootImagePath + (rootFresh ? ' (seeded)' : ''));

  const ccCompile = COMMON.createCcDriver(CompilerJS, kfs);
  const interactive = !!process.stdin.isTTY;

  const kernel = new K.Kernel({
    fs: kfs,
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
      kernel._procs.forEach((pcb) => {
        const st = Atomics.load(pcb.i32, 4 /* KP_RPC_STATE */);
        const op = Atomics.load(pcb.i32, 5 /* KP_RPC_OP */);
        process.stderr.write(`[state] pid ${pcb.pid} ${pcb.state} rpc=${st}/op=0x${op.toString(16)}` +
          ` waiter=${pcb.waiter ? pcb.waiter.op : '-'} ttyq=${kernel._ttyWaiters}\n`);
      });
    }, 3000).unref();
  }

  // The WM control plane (todos/0014) — same shape as kernel-worker.js:
  // endpoint first, /bin/wm as a kernel service after pid 1 (non-fatal;
  // kernel-chrome is the fallback, `wm &` respawns).
  kernel.wmServe();
  await kernel.boot({
    path: '/bin/sh',
    argv: ['sh'],
    envp: ['PATH=/usr/local/bin:/bin', 'HOME=/root', 'TERM=xterm-256color'],
    cwd: '/root',
  });
  await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/usr/local/bin:/bin'] });
}
