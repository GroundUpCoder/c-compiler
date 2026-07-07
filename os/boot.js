#!/usr/bin/env node
// boot.js — headless boot of the reference OS (todos/0004; OS.md
// "agent-friendly by construction"). Same kernel, same image manifest, same
// protoshell as os/os.html — but under plain Node with the tty on stdio, so
// agents and CI drive the OS with pipes and exit codes:
//
//   echo 'ls /' | node os/boot.js
//   printf 'cc hello.c && ./a.out\nexit\n' | node os/boot.js
//   node os/boot.js                    # interactive (raw-mode terminal)
//
// The image persists in a plain file (default os/os.img — first boot seeds
// it from os/image.json, later boots reuse it, so files survive "reboots").
//
//   --image=PATH   image file (default: os/os.img)
//   --fresh        discard the image and re-seed
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
let imagePath = path.join(__dirname, 'os.img');
let freshBoot = false;
let quiet = false;
let dumpState = false;
let ttyOut = false;   // force fd1/2 tty-kind under pipes (drive interactive shells)
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--image=')) imagePath = path.resolve(a.slice(8));
  else if (a === '--fresh') freshBoot = true;
  else if (a === '--quiet') quiet = true;
  else if (a === '--dump-state') dumpState = true;
  else if (a === '--tty-out') ttyOut = true;
  else {
    process.stderr.write(`boot.js: unknown option ${a}\n`);
    process.exit(2);
  }
}
const bootLog = quiet ? () => {} : (m) => process.stderr.write('[boot] ' + m + '\n');

/* ---- NodeFileStore: the ByteStore interface over a plain file ----
 * The headless twin of host.js's SyncAccessHandleStore (OPFS). */
function NodeFileStore(filePath, fresh) {
  if (fresh) { try { fs.unlinkSync(filePath); } catch (e) {} }
  this._fd = fs.openSync(filePath, fs.existsSync(filePath) ? 'r+' : 'w+');
  this._tmp4 = new Uint8Array(4);
  this._tmpDV = new DataView(this._tmp4.buffer);
}
NodeFileStore.prototype.getUint32 = function (off) {
  this._tmp4.fill(0);
  fs.readSync(this._fd, this._tmp4, 0, 4, off);
  return this._tmpDV.getUint32(0, true);
};
NodeFileStore.prototype.setUint32 = function (off, val) {
  this._tmpDV.setUint32(0, val, true);
  fs.writeSync(this._fd, this._tmp4, 0, 4, off);
};
NodeFileStore.prototype.getBytes = function (off, len) {
  const buf = new Uint8Array(len);
  if (len > 0) fs.readSync(this._fd, buf, 0, len, off);
  return buf;
};
NodeFileStore.prototype.setBytes = function (off, data) {
  if (data.length > 0) fs.writeSync(this._fd, data, 0, data.length, off);
};
NodeFileStore.prototype.size = function () { return fs.fstatSync(this._fd).size; };
NodeFileStore.prototype.resize = function (newSize) { fs.ftruncateSync(this._fd, newSize); };
NodeFileStore.prototype.flush = function () { fs.fsyncSync(this._fd); };
NodeFileStore.prototype.close = function () { fs.closeSync(this._fd); };

/* ---- mount + seed ---- */
const store = new NodeFileStore(imagePath, freshBoot);
const kfs = BLOCK_FS.createV4(store);
const ccCompile = COMMON.createCcDriver(CompilerJS, kfs);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'image.json'), 'utf-8'));

/* ---- the system ---- */
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
    store.flush();
    store.close();
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

/* ---- boot ---- */
seedAndBoot().catch((e) => {
  process.stderr.write('boot failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});

async function seedAndBoot() {
  const seeded = await COMMON.seedImage(kfs, manifest, {
    readAsset: (name) => fs.readFileSync(path.join(__dirname, name), 'utf-8'),
    // bin entries (game data: doom1.wad, ROMs) are repo-relative binaries
    readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
    compile: ccCompile,
    // project entries (busybox hush) are repo-relative multi-file builds
    buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
    log: bootLog,
  });
  if (seeded) store.flush();
  bootLog('image ' + imagePath + (seeded ? ' (seeded)' : ''));
  // The WM control plane (todos/0014) — same shape as kernel-worker.js:
  // endpoint first, /bin/wm as a kernel service after pid 1 (non-fatal;
  // kernel-chrome is the fallback, `wm &` respawns).
  kernel.wmServe();
  await kernel.boot({
    path: '/bin/sh',
    argv: ['sh'],
    envp: ['PATH=/bin', 'HOME=/root', 'TERM=xterm-256color'],
    cwd: '/root',
  });
  await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/bin'] });
}
