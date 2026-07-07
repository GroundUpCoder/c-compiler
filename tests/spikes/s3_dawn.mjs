// Spike S3 (todos/0012, WM.md appendix): Dawn via the `webgpu` npm package
// (dawn-gpu/node-webgpu) under Node — device creation, render-to-texture,
// copyTextureToBuffer readback (the canvas-less present tail), and the same
// inside worker_threads (one device per process worker, like the OS).
//
// Optional dep: skips cleanly when the package is absent.
// Run: node tests/spikes/s3_dawn.mjs
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

async function clearAndReadback(tag) {
  const { create, globals } = await import('webgpu').then(m => m.default || m);
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('no adapter');
  const device = await adapter.requestDevice();
  const W = 64, H = 64;
  const tex = device.createTexture({
    size: { width: W, height: H },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: tex.createView(), loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0, g: 1, b: 0, a: 1 },
    }],
  });
  pass.end();
  const buf = device.createBuffer({
    size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: W * 4 }, { width: W, height: H });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(buf.getMappedRange());
  const mid = ((H / 2) * W + W / 2) * 4;
  const got = [px[mid], px[mid + 1], px[mid + 2], px[mid + 3]].join(',');
  if (got !== '0,255,0,255') throw new Error(`${tag}: expected 0,255,0,255 got ${got}`);
  return `${tag}: readback ok (green), adapter=${(adapter.info && adapter.info.vendor) || '?'}`;
}

if (!isMainThread) {
  // CAVEAT (recorded in WM.md): worker.terminate() while Dawn has pending
  // async events aborts the WHOLE process (napi_throw on a torn-down env).
  // Workers must exit gracefully — device.destroy() + natural exit. The OS's
  // SIGKILL path (worker.terminate) needs this in mind for Dawn-tier procs.
  clearAndReadback('worker')
    .then(msg => { parentPort.postMessage({ ok: true, msg }); process.exit(0); })
    .catch(e => { parentPort.postMessage({ ok: false, msg: String(e && e.message || e) }); process.exit(1); });
} else {
  let hasDawn = true;
  try { await import('webgpu'); } catch { hasDawn = false; }
  if (!hasDawn) { console.log('S3: SKIP (webgpu package not installed)'); process.exit(0); }

  console.log(await clearAndReadback('main'));
  // Two concurrent workers, each with its own device — the OS's shape.
  const self = fileURLToPath(import.meta.url);
  const runWorker = () => new Promise((res, rej) => {
    const w = new Worker(self);
    let msg = null;
    w.once('message', m => { msg = m; });
    w.once('exit', () => { msg && msg.ok ? res(msg.msg) : rej(new Error(msg ? msg.msg : 'no message')); });
    w.once('error', rej);
  });
  const [a, b] = await Promise.all([runWorker(), runWorker()]);
  console.log(a); console.log(b);
  console.log('S3: PASS — Dawn device per worker_thread, render + readback all green');
}
