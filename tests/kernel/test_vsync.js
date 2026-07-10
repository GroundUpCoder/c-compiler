#!/usr/bin/env node
// 0100: the kernel vsync broadcast — deterministic, no wasm, no threads.
// A fake createWorker captures spawn specs; the test plays the process side
// (KernelClient over the real kernel page) and the embedder side (vsyncTick,
// standing in for the compositor rAF). Covers: the advertise flag is set at
// spawn iff the kernel declared a vsync source, vsyncTick bumps + notifies
// every live pcb (and skips reaped ones), vsyncWait resolves on a tick,
// resolves immediately when a tick landed since the last wait (rAF catch-up
// semantics), and parks until the NEXT tick otherwise.
//
// Run: node tests/kernel/test_vsync.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/a', new Uint8Array([2])],
]);

// Per-kernel worker map — two kernels run side by side here and both number
// pids from 1, so a shared map would cross their handles.
function makeKernel(opts) {
  const workers = new Map();
  const kernel = new K.Kernel(Object.assign({
    createWorker: function (procSpec) {
      const h = {
        procSpec,
        msg: null,
        terminated: false,
        postMessage() {},
        onMessage(fn) { h.msg = fn; },
        onExit(fn) { h.exitCb = fn; },
        terminate() { h.terminated = true; },
      };
      workers.set(procSpec.pid, h);
      return h;
    },
    loadImage: (p) => images.get(p) || null,
    onOutput: () => {},
    onHalt: () => {},
    log: () => {},
  }, opts || {}));
  kernel._testWorkers = workers;
  return kernel;
}

async function rpc(kernel, pid, op, req) {
  const h = kernel._testWorkers.get(pid);
  const pcb = kernel.process(pid);
  const i32 = new Int32Array(pcb.page), u8 = new Uint8Array(pcb.page);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const resp = K.readPayload(i32, u8);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
  return resp;
}

async function main() {
  // ---- advertise flag ------------------------------------------------
  console.log('vsync advertise:');
  const kv = makeKernel({ vsync: true });
  const pid1 = await kernel_boot(kv);
  const p1 = new Int32Array(kv.process(pid1).page);
  check('vsync kernel sets KP_VSYNC_EN at spawn',
    Atomics.load(p1, K.KP_VSYNC_EN) === 1);
  check('tick counter starts at 0', Atomics.load(p1, K.KP_VSYNC_SEQ) === 0);

  const r = await rpc(kv, pid1, K.OP.SPAWN,
    { path: '/bin/a', argv: ['a'], envp: [], cwd: '/' });
  const p2 = new Int32Array(kv.process(r.pid).page);
  check('children advertise too', Atomics.load(p2, K.KP_VSYNC_EN) === 1);

  const kn = makeKernel({});
  const pidN = await kernel_boot(kn);
  const pN = new Int32Array(kn.process(pidN).page);
  check('no-vsync kernel leaves KP_VSYNC_EN clear',
    Atomics.load(pN, K.KP_VSYNC_EN) === 0);

  // ---- vsyncTick -----------------------------------------------------
  console.log('vsyncTick:');
  kv.vsyncTick();
  kv.vsyncTick();
  check('tick bumps every live pcb',
    Atomics.load(p1, K.KP_VSYNC_SEQ) === 2 && Atomics.load(p2, K.KP_VSYNC_SEQ) === 2);

  // Reap pid2, then tick again: only survivors bump, nothing throws.
  kv._testWorkers.get(r.pid).msg({ type: 'exited', code: 0 });
  await tick();
  await rpc(kv, pid1, K.OP.WAIT, { pid: -1, options: 0 });
  const seq2 = Atomics.load(p2, K.KP_VSYNC_SEQ);
  kv.vsyncTick();
  check('reaped pcb no longer ticks',
    Atomics.load(p1, K.KP_VSYNC_SEQ) === 3 && Atomics.load(p2, K.KP_VSYNC_SEQ) === seq2);

  // ---- KernelClient.vsyncWait ----------------------------------------
  console.log('vsyncWait (KernelClient over the same page):');
  const client = new K.KernelClient(kv.process(pid1).page, () => {});
  check('vsyncEnabled true on the advertised page', client.vsyncEnabled() === true);
  const clientN = new K.KernelClient(kn.process(pidN).page, () => {});
  check('vsyncEnabled false without a source', clientN.vsyncEnabled() === false);

  // Park, then tick: the wait resolves.
  let woke = false;
  const w1 = client.vsyncWait().then(() => { woke = true; });
  await tick();
  check('wait parks until a tick arrives', woke === false);
  kv.vsyncTick();
  await w1;
  check('tick wakes the parked wait', woke === true);

  // A tick that lands between frame callbacks resolves the next wait
  // immediately (rAF catch-up semantics — no extra frame lost).
  kv.vsyncTick();
  let fast = false;
  await client.vsyncWait().then(() => { fast = true; });
  check('missed tick resolves the next wait immediately', fast === true);

  // And with no missed tick, the wait parks again for the NEXT one.
  let woke2 = false;
  const w2 = client.vsyncWait().then(() => { woke2 = true; });
  await tick();
  check('caught-up wait parks again', woke2 === false);
  kv.vsyncTick();
  await w2;
  check('and wakes on the next tick', woke2 === true);

  console.log(failures ? `\nvsync: ${failures} FAILURE(S)` : '\nvsync: PASS');
  process.exit(failures ? 1 : 0);
}

function kernel_boot(kernel) {
  return kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
}

main().catch((e) => { console.error(e); process.exit(1); });
