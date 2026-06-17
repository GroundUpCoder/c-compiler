// Worker bootstrap for the browser Quake test. The wasm runs here, not
// on the main thread, because the block FS's sync access handle API
// (which our libc's fopen/fread/fseek/fwrite all use) is worker-only.
//
// Flow:
//   1. Main thread sends us its OffscreenCanvas via postMessage.
//   2. We fetch pak0.pak into memory.
//   3. We fetch quake.wasm and hand it to runModule with a blockFsFactory
//      that opens a BLOCK_FS image (one OPFS file), writes pak0.pak into
//      it at /id1/pak0.pak, and returns the wasm FS env. The same
//      OffscreenCanvas is passed as the SDL canvas; runModule's
//      createBrowserSDL treats it like a regular HTMLCanvasElement.
//   4. stdout/stderr from the wasm flow back to main via postMessage.
//
// This uses the BLOCK_FS backend (single OPFS file), the same one the
// compiler-emitted pages default to — NOT the legacy full-OPFS tree.

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

async function fetchPak() {
  self.postMessage({ type: 'status', text: 'Fetching pak0.pak…' });
  const resp = await fetch('./pak0.pak');
  if (!resp.ok) throw new Error('fetch pak0.pak: ' + resp.status);
  return new Uint8Array(await resp.arrayBuffer());
}

async function bootQuake() {
  const pak = await fetchPak();

  self.postMessage({ type: 'status', text: 'Fetching quake.wasm…' });
  const r = await fetch('./quake.wasm');
  const bytes = new Uint8Array(await r.arrayBuffer());

  self.postMessage({ type: 'status', text: 'Booting Quake…' });

  const dec = new TextDecoder();
  const exitCode = await self.runModule({
    bytes,
    args: ['quake.wasm'],
    // BLOCK_FS backend: a single OPFS file holds the whole FS image.
    // BLOCK_FS.init returns a Promise<BlockFS>; the dispatch expects
    // blockFsFactory to return Promise<{ [ENV_KEY]: env }>.
    blockFsFactory: function (ctx) {
      return self.BLOCK_FS.init('quake-blockfs').then(function (fs) {
        // Mount pak0.pak at /id1/pak0.pak inside the block image. We
        // rewrite it every boot (O_TRUNC) — the test always wants a
        // known-good copy and an 18 MB write is cheap against a sync
        // access handle.
        try { fs.mkdir('/id1', 0o755); } catch (e) {}
        const fd = fs.open('/id1/pak0.pak', 0x40 | 0x200, 0o644); // O_CREAT | O_TRUNC
        if (fd === null || fd < 0) throw new Error('block FS: could not open /id1/pak0.pak for write');
        fs.write(fd, pak, pak.length);
        fs.close(fd);
        self.postMessage({ type: 'stdout', text: `[worker] mounted /id1/pak0.pak into BLOCK_FS (${pak.byteLength} bytes)\n` });
        return { c: fs.toWasmEnv(ctx) };
      });
    },
    getBrowserSDL: mainCanvas,
    writeOut: (b) => self.postMessage({ type: 'stdout', text: dec.decode(b, { stream: true }) }),
    writeErr: (b) => self.postMessage({ type: 'stderr', text: dec.decode(b, { stream: true }) }),
  });
  self.postMessage({ type: 'exit', code: exitCode });
}
