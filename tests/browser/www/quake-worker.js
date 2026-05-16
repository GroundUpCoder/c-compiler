// Worker bootstrap for the browser Quake test. The wasm runs here, not
// on the main thread, because OPFS's sync access handle API (which
// our libc's fopen/fread/fseek/fwrite all use) is worker-only.
//
// Flow:
//   1. Main thread sends us its OffscreenCanvas via postMessage.
//   2. We fetch pak0.pak and write it to OPFS at /id1/pak0.pak.
//   3. We fetch quake.wasm and hand it to runModule with the
//      OffscreenCanvas as the SDL canvas. runModule's createBrowserSDL
//      treats it like a regular HTMLCanvasElement (same getContext('2d')
//      API).
//   4. stdout/stderr from the wasm flow back to main via postMessage.

importScripts('./host.js');

let mainCanvas = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'start') return;
  mainCanvas = m.canvas;
  try {
    await bootQuake();
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err), stack: err.stack });
  }
};

async function mountPak() {
  self.postMessage({ type: 'status', text: 'Fetching pak0.pak…' });
  const resp = await fetch('./pak0.pak');
  if (!resp.ok) throw new Error('fetch pak0.pak: ' + resp.status);
  const buf = new Uint8Array(await resp.arrayBuffer());

  self.postMessage({ type: 'status', text: 'Writing pak0.pak to OPFS…' });
  const root = await navigator.storage.getDirectory();
  const id1  = await root.getDirectoryHandle('id1', { create: true });
  const fh   = await id1.getFileHandle('pak0.pak', { create: true });
  // createSyncAccessHandle IS available here (worker context) — use it
  // for the write so it matches what the wasm will use to read.
  const sah  = await fh.createSyncAccessHandle();
  sah.truncate(0);
  sah.write(buf, { at: 0 });
  sah.flush();
  sah.close();
  self.postMessage({ type: 'stdout', text: `[worker] mounted /id1/pak0.pak (${buf.byteLength} bytes)\n` });
}

async function bootQuake() {
  await mountPak();

  self.postMessage({ type: 'status', text: 'Fetching quake.wasm…' });
  const r = await fetch('./quake.wasm');
  const bytes = new Uint8Array(await r.arrayBuffer());

  self.postMessage({ type: 'status', text: 'Booting Quake…' });

  const dec = new TextDecoder();
  const exitCode = await self.runModule({
    bytes,
    args: ['quake.wasm'],
    useBrowserFS: true,
    getBrowserSDL: mainCanvas,
    writeOut: (b) => self.postMessage({ type: 'stdout', text: dec.decode(b, { stream: true }) }),
    writeErr: (b) => self.postMessage({ type: 'stderr', text: dec.decode(b, { stream: true }) }),
  });
  self.postMessage({ type: 'exit', code: exitCode });
}
