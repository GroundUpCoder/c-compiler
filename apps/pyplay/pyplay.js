// pyplay — main-thread controller. Loads a program (zip / folder / loose .py
// files), lets the user pick the entry script, and runs it on the cpython-clang
// package inside a Worker (pyplay-worker.js). Everything the program sees is a
// private BlockFS image: the runtime is unpacked from the gucman package repo
// (/packages) once per package sha and cached in OPFS; the program's files are
// re-seeded under /game on every run.
//
// This page is also the program's DISPLAY SERVER, in the exact shape gucOS's
// kernel plays for its processes: host.js's surface SDL flavor in the worker
// presents into a shared-memory mailbox (the SH_* header + double buffer),
// reads input from a shared ring (IR_* header + 8-word records) and paces
// itself on a vsync word — and this thread composites the mailbox onto the
// canvas every rAF, writes DOM input into the ring, and bumps the vsync word.
// A blocked interpreter (pygame's `while True`) therefore presents and gets
// input without ever yielding, and without JSPI. Nothing here is gucOS —
// no kernel, no wm, no OS image — the protocol is host.js's, byte for byte.
//
// Shared with the other standalone runners: SDL_WEB (DOM → SDL key/mouse
// descriptors), createAudioReceiver (per-device audio rings), and the
// live-stdin SharedArrayBuffer protocol BlockFS speaks (SI_* header words).
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    open: $('open'), open2: $('open2'), file: $('file'), entry: $('entry'), args: $('args'),
    run: $('run'), stop: $('stop'), reset: $('reset'), status: $('status'),
    drop: $('drop'), main: $('main'), canvasContainer: $('canvas-container'),
    canvas: $('canvas'), terminal: $('terminal'),
  };

  // ---- state -------------------------------------------------------------
  var program = null;        // { files: [{path, data:Uint8Array}], entry: string }
  var worker = null;
  var running = false;
  var canvas = els.canvas;
  var ctx2d = null;
  var outputLog = '';        // test probe: everything written to stdout/stderr
  var enc = new TextEncoder();

  // ---- terminal ----------------------------------------------------------
  var term = new Terminal({
    cursorBlink: true, fontSize: 14, convertEol: false,
    fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace",
    theme: { background: '#0d0d1a', foreground: '#d8d8e8', cursor: '#b0f0b0' },
  });
  var fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(els.terminal);
  fitAddon.fit();
  window.addEventListener('resize', function () { fitAddon.fit(); publishWinsize(); publishScreen(); });

  // Live stdin: a SharedArrayBuffer ring the worker's BlockFS reads from
  // (host.js _readStdinSab). Header = 8 Int32 words: SEQ, AVAIL, WRITEPOS,
  // READPOS, EOF, COLS, ROWS, TERMIOS (bit0 icanon, bit1 echo, bit2 opost).
  // Works with or without JSPI — the worker parks on the SEQ futex.
  var SI_SEQ = 0, SI_AVAIL = 1, SI_WRITEPOS = 2, SI_EOF = 4, SI_COLS = 5, SI_ROWS = 6, SI_TERMIOS = 7;
  var SI_HDR_BYTES = 32, STDIN_RING = 64 * 1024;
  var stdinSab = null, stdinCtrl = null, stdinRing = null;
  var lineBuf = '';

  function newStdinSab() {
    stdinSab = new SharedArrayBuffer(SI_HDR_BYTES + STDIN_RING);
    stdinCtrl = new Int32Array(stdinSab, 0, 8);
    stdinRing = new Uint8Array(stdinSab, SI_HDR_BYTES, STDIN_RING);
    Atomics.store(stdinCtrl, SI_TERMIOS, 7);   // cooked + echo + opost until tcsetattr says otherwise
    publishWinsize();
  }
  function publishWinsize() {
    if (!stdinCtrl) return;
    Atomics.store(stdinCtrl, SI_COLS, term.cols);
    Atomics.store(stdinCtrl, SI_ROWS, term.rows);
  }
  function pushStdin(bytes) {
    if (!stdinCtrl) return;
    var size = stdinRing.length;
    if (Atomics.load(stdinCtrl, SI_AVAIL) + bytes.length > size) return; // ring full: drop (a TTY would too)
    var wp = Atomics.load(stdinCtrl, SI_WRITEPOS);
    for (var i = 0; i < bytes.length; i++) stdinRing[(wp + i) % size] = bytes[i];
    Atomics.store(stdinCtrl, SI_WRITEPOS, (wp + bytes.length) % size);
    Atomics.add(stdinCtrl, SI_AVAIL, bytes.length);
    Atomics.add(stdinCtrl, SI_SEQ, 1);
    Atomics.notify(stdinCtrl, SI_SEQ);
  }
  function stdinEof() {
    if (!stdinCtrl) return;
    Atomics.store(stdinCtrl, SI_EOF, 1);
    Atomics.add(stdinCtrl, SI_SEQ, 1);
    Atomics.notify(stdinCtrl, SI_SEQ);
  }
  term.onData(function (data) {
    if (!running || primary) return;   // with a window up, keys belong to the game (the canvas)
    var mode = Atomics.load(stdinCtrl, SI_TERMIOS);
    var icanon = !!(mode & 1), echo = !!(mode & 2);
    if (!icanon) {                       // raw: bytes go straight through
      pushStdin(enc.encode(data));
      return;
    }
    for (var i = 0; i < data.length; i++) {  // cooked: page-side line discipline
      var ch = data[i];
      if (ch === '\r' || ch === '\n') {
        if (echo) term.write('\r\n');
        pushStdin(enc.encode(lineBuf + '\n'));
        lineBuf = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (lineBuf.length) { lineBuf = lineBuf.slice(0, -1); if (echo) term.write('\b \b'); }
      } else if (ch === '\x04') {        // ^D: flush the partial line, then EOF on an empty one
        if (lineBuf.length) { pushStdin(enc.encode(lineBuf)); lineBuf = ''; }
        else stdinEof();
      } else if (ch === '\x03') {        // ^C: no signals without a kernel — stop the run
        term.write('^C\r\n');
        stopRun();
      } else if (ch >= ' ') {
        lineBuf += ch;
        if (echo) term.write(ch);
      }
    }
  });

  function writeOutput(text, isErr) {
    outputLog += text;
    var opost = !stdinCtrl || (Atomics.load(stdinCtrl, SI_TERMIOS) & 4);
    if (opost) text = text.replace(/\r?\n/g, '\r\n');
    term.write(isErr ? '\x1b[31m' + text + '\x1b[0m' : text);
  }
  function setStatus(text, isErr) {
    els.status.textContent = text || '';
    els.status.className = isErr ? 'err' : '';
  }

  // ---- program loading ---------------------------------------------------
  var IGNORE_RE = /(^|\/)(__MACOSX|\.git|__pycache__|\.DS_Store)(\/|$)/;

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Minimal zip reader: central directory walk, stored + deflate members.
  // No zip64, no encryption, no data descriptors needed (sizes come from the
  // central directory, which is authoritative).
  async function readZip(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
    var count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 archives are not supported');
    var dec = new TextDecoder('utf-8');
    var files = [];
    var p = cdOff;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip central directory');
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (name.endsWith('/') || IGNORE_RE.test(name)) continue;
      if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('corrupt zip local header for ' + name);
      var dataOff = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      var raw = u8.subarray(dataOff, dataOff + csize);
      var data;
      if (method === 0) data = new Uint8Array(raw);
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('unsupported zip compression method ' + method + ' for ' + name);
      if (data.length !== usize) throw new Error('size mismatch inflating ' + name);
      files.push({ path: name, data: data });
    }
    return files;
  }

  // Normalise paths, drop a single common top-level folder (a zipped
  // directory), refuse escapes.
  function normalizeFiles(files) {
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].path.replace(/\\/g, '/').split('/').filter(function (s) { return s && s !== '.'; });
      if (parts.some(function (s) { return s === '..'; })) throw new Error('refusing path with ..: ' + files[i].path);
      if (!parts.length) continue;
      out.push({ path: parts.join('/'), data: files[i].data });
    }
    if (out.length > 1 || (out.length === 1 && out[0].path.indexOf('/') >= 0)) {
      var top = out[0].path.split('/')[0];
      var allShare = out.every(function (f) { return f.path.split('/').length > 1 && f.path.split('/')[0] === top; });
      if (allShare) out = out.map(function (f) { return { path: f.path.slice(top.length + 1), data: f.data }; });
    }
    return out;
  }
  function entryCandidates(files) {
    return files.map(function (f) { return f.path; }).filter(function (p) { return /\.(py|wasm)$/i.test(p); })
      .sort(function (a, b) {
        var da = a.split('/').length, db = b.split('/').length;
        return da !== db ? da - db : a.localeCompare(b);
      });
  }
  function pickEntry(cands) {
    var prefs = ['main.py', '__main__.py', 'game.py', 'run.py', 'app.py', 'start.py'];
    for (var i = 0; i < prefs.length; i++) if (cands.indexOf(prefs[i]) >= 0) return prefs[i];
    var root = cands.filter(function (p) { return p.indexOf('/') < 0; });
    if (root.length === 1) return root[0];
    return cands[0] || null;
  }

  async function loadFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var name = f.webkitRelativePath || f.name;
      if (/\.zip$/i.test(name) || f.type === 'application/zip') {
        var members = await readZip(await f.arrayBuffer());
        for (var j = 0; j < members.length; j++) files.push(members[j]);
      } else {
        files.push({ path: name, data: new Uint8Array(await f.arrayBuffer()) });
      }
    }
    setProgram(files);
  }
  function setProgram(files) {
    files = normalizeFiles(files);
    var cands = entryCandidates(files);
    if (!cands.length) { setStatus('No .py files found in that drop.', true); return; }
    program = { files: files, entry: pickEntry(cands) };
    els.entry.innerHTML = '';
    cands.forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; els.entry.appendChild(o);
    });
    els.entry.value = program.entry;
    els.entry.disabled = false;
    els.run.disabled = false;
    els.drop.classList.add('hidden');
    var bytes = files.reduce(function (s, f) { return s + f.data.length; }, 0);
    setStatus(files.length + ' files, ' + (bytes / 1024).toFixed(0) + ' KB — entry ' + program.entry);
    term.focus();
    if (autorun) { autorun = false; startRun(); }
  }
  els.entry.addEventListener('change', function () { if (program) program.entry = els.entry.value; });

  // Folder drops arrive as DataTransferItem entries; walk them.
  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve, reject) {
      if (entry.isFile) {
        entry.file(function (file) {
          file.arrayBuffer().then(function (buf) {
            out.push({ path: prefix + entry.name, data: new Uint8Array(buf) }); resolve();
          }, reject);
        }, reject);
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        (function more() {
          reader.readEntries(function (ents) {
            if (!ents.length) {
              Promise.all(all.map(function (e) { return walkEntry(e, prefix + entry.name + '/', out); })).then(resolve, reject);
              return;
            }
            all = all.concat(ents); more();
          }, reject);
        })();
      } else resolve();
    });
  }
  async function loadDrop(dt) {
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (entries.some(function (e) { return e.isDirectory; })) {
      var out = [];
      for (var i = 0; i < entries.length; i++) await walkEntry(entries[i], '', out);
      // A dropped single .zip inside a folder walk still needs unzipping.
      var files = [];
      for (var k = 0; k < out.length; k++) {
        if (/\.zip$/i.test(out[k].path)) files = files.concat(await readZip(out[k].data.buffer));
        else files.push(out[k]);
      }
      setProgram(files);
      return;
    }
    await loadFiles(dt.files);
  }

  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.remove('hidden'); els.drop.classList.add('armed'); });
  });
  document.addEventListener('dragleave', function (e) {
    if (e.relatedTarget === null) { els.drop.classList.remove('armed'); if (program) els.drop.classList.add('hidden'); }
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    els.drop.classList.remove('armed');
    loadDrop(e.dataTransfer).catch(function (err) { setStatus('Load failed: ' + err.message, true); });
  });
  els.open.addEventListener('click', function () { els.file.click(); });
  els.open2.addEventListener('click', function () { els.file.click(); });
  els.file.addEventListener('change', function () {
    loadFiles(els.file.files).catch(function (err) { setStatus('Load failed: ' + err.message, true); });
    els.file.value = '';
  });

  // ---- the display server: page-state words, surfaces, ring, vsync -------
  // Page-state SAB (shared with the worker's page broker): [0] VSEQ vsync tick
  // counter, [1] ARMED waiters, [2] FOCUSED, [3]/[4] SCREEN_W/H.
  var PS_VSEQ = 0, PS_ARMED = 1, PS_FOCUSED = 2, PS_SCREEN_W = 3, PS_SCREEN_H = 4, PS_WORDS = 8;
  var stateSab = null, state = null;
  // Layouts: host.js's own table (WM_SAB_LAYOUT_HOST) — the constants the
  // worker's surface flavor writes with, read here by name, never restated.
  var L = WM_SAB_LAYOUT_HOST;
  var surfaces = new Map();   // sid -> { sid, w, h, sab, i32, u8, img, seq, visible, bitmap }
  var order = [];             // creation order; the first is the primary (owns the canvas size)
  var primary = null;
  var ring = null;            // { i32, f32, cap }
  var rafId = 0;
  var f32scratch = new Float32Array(1), i32scratch = new Int32Array(f32scratch.buffer);
  function f32bits(v) { f32scratch[0] = v; return i32scratch[0]; }

  function publishScreen() {
    if (!state) return;
    var r = els.canvasContainer.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width || els.main.clientWidth)), h = Math.max(1, Math.round(r.height || els.main.clientHeight));
    Atomics.store(state, PS_SCREEN_W, Math.min(8192, w));
    Atomics.store(state, PS_SCREEN_H, Math.min(8192, h));
  }
  function setFocused(on) {
    if (!state) return;
    var was = Atomics.load(state, PS_FOCUSED);
    Atomics.store(state, PS_FOCUSED, on ? 1 : 0);
    if (was !== (on ? 1 : 0) && inputSid()) pushRecord([on ? L.ev.FOCUS_GAINED : L.ev.FOCUS_LOST, inputSid(), 0, 0, 0, 0, 0, 0]);
  }
  // The ring: single producer (this thread), the kernel's _wmPushEvent shape —
  // drop-newest when full, notify the WPOS futex (the worker's park word).
  function pushRecord(words) {
    if (!ring) return false;
    var cap2 = ring.cap * 2;
    var wpos = Atomics.load(ring.i32, L.irWpos), rpos = Atomics.load(ring.i32, L.irRpos);
    if (((wpos - rpos + cap2) % cap2) >= ring.cap) { Atomics.add(ring.i32, L.irDropped, 1); return false; }
    var base = (L.irHdrBytes >> 2) + (wpos % ring.cap) * L.irRecordWords;
    for (var k = 0; k < L.irRecordWords; k++) ring.i32[base + k] = words[k] | 0;
    Atomics.store(ring.i32, L.irWpos, (wpos + 1) % cap2);
    Atomics.notify(ring.i32, L.irWpos);
    return true;
  }
  function inputSid() {   // the newest visible window gets input (popup semantics)
    for (var i = order.length - 1; i >= 0; i--) { var s = surfaces.get(order[i]); if (s && s.visible) return s.sid; }
    return 0;
  }
  function bindSurface(s, sab, w, h) {
    s.sab = sab; s.i32 = new Int32Array(sab); s.u8 = new Uint8Array(sab);
    s.w = w; s.h = h; s.img = new ImageData(w, h); s.seq = -1;
  }
  function onSurfaceCreate(msg) {
    var s = { sid: msg.sid, visible: msg.visible !== false, title: msg.title, bitmap: null, relativeMouse: !!(msg.flags & 2) };
    bindSurface(s, msg.fb, msg.w, msg.h);
    surfaces.set(s.sid, s);
    order.push(s.sid);
    if (msg.ring && !ring) {
      var i32 = new Int32Array(msg.ring);
      ring = { i32: i32, f32: new Float32Array(msg.ring), cap: i32[L.irCap] };
    }
    if (!primary) {
      primary = s;
      canvas.width = s.w; canvas.height = s.h;
      ctx2d = canvas.getContext('2d');
      els.canvasContainer.style.display = 'flex';
      els.terminal.classList.add('aside');
      fitAddon.fit();
      publishScreen();
      if (msg.title) document.title = msg.title;
      attachInput();
      canvas.focus();
      setFocused(true);
      probe.window = { w: s.w, h: s.h, title: msg.title };
    }
  }
  function onSurfaceConfigure(msg) {
    var s = surfaces.get(msg.sid);
    if (!s) return;
    bindSurface(s, msg.fb, msg.w, msg.h);
    if (s === primary) { canvas.width = s.w; canvas.height = s.h; probe.window = { w: s.w, h: s.h, title: s.title }; }
  }
  function onSurfaceDestroy(sid) {
    var s = surfaces.get(sid);
    if (!s) return;
    if (s.bitmap) { s.bitmap.close(); s.bitmap = null; }
    surfaces.delete(sid);
    order = order.filter(function (x) { return x !== sid; });
    if (s === primary) { primary = null; if (order.length) primary = surfaces.get(order[0]); }
  }
  // Composite: for each visible surface (primary first, then the rest on top
  // at their own size, anchored top-left — this page hosts one top-level
  // window; extra windows are popups/tooltips), copy the FRONT buffer under
  // SH_LOCK (the compositor.js discipline: try-lock, never wait on the
  // producer; on contention keep the previous frame and retry next rAF).
  var SHM_TRY_SPIN = 4096;
  function tryLock(i32) {
    for (var i = 0; i < SHM_TRY_SPIN; i++) if (Atomics.compareExchange(i32, L.shLock, 0, 1) === 0) return true;
    return false;
  }
  function compose(s) {
    if (!s.visible || !ctx2d) return;
    if (s.bitmap) { ctx2d.drawImage(s.bitmap, 0, 0); return; }
    var seq = Atomics.load(s.i32, L.shSeq);
    if (seq === s.seq && s !== primary) { return; }
    if (seq !== s.seq) {
      if (Atomics.load(s.i32, L.shMagic) !== L.shMagicValue) return;
      if (!tryLock(s.i32)) return;              // producer mid-flip: keep the previous frame
      var front = Atomics.load(s.i32, L.shFlip) & 1;
      seq = Atomics.load(s.i32, L.shSeq);
      var bytes = s.w * s.h * 4;
      s.img.data.set(s.u8.subarray(L.shHdrBytes + front * bytes, L.shHdrBytes + (front + 1) * bytes));
      Atomics.store(s.i32, L.shLock, 0);
      Atomics.notify(s.i32, L.shLock);
      s.seq = seq;
      probe.frames++;
    }
    if (s === primary) ctx2d.putImageData(s.img, 0, 0);
    else {   // an overlay window: draw through a scratch canvas so alpha composites
      var oc = s.scratch || (s.scratch = document.createElement('canvas'));
      if (oc.width !== s.w || oc.height !== s.h) { oc.width = s.w; oc.height = s.h; }
      oc.getContext('2d').putImageData(s.img, 0, 0);
      ctx2d.drawImage(oc, 0, 0);
    }
  }
  function tick() {
    if (!running) { rafId = 0; return; }
    Atomics.add(state, PS_VSEQ, 1);          // the display clock the worker's vsyncWait parks on
    Atomics.notify(state, PS_VSEQ);
    if (primary) {
      compose(primary);
      for (var i = 0; i < order.length; i++) { var s = surfaces.get(order[i]); if (s && s !== primary) compose(s); }
    }
    rafId = requestAnimationFrame(tick);
  }

  // ---- input: DOM → ring records (SDL_WEB derives scancode/keysym/mod) -------
  function logical() { return primary ? { w: primary.w, h: primary.h } : { w: canvas.width, h: canvas.height }; }
  function onKeydown(e) {
    if (!primary || document.activeElement === els.args) return;
    e.preventDefault();
    var m = SDL_WEB.keyMsg(e, true);
    pushRecord([L.ev.KEYDOWN, inputSid(), m.scancode, m.sym, m.mod, m.repeat, 0, 0]);
  }
  function onKeyup(e) {
    if (!primary || document.activeElement === els.args) return;
    e.preventDefault();
    var m = SDL_WEB.keyMsg(e, false);
    pushRecord([L.ev.KEYUP, inputSid(), m.scancode, m.sym, m.mod, 0, 0, 0]);
  }
  function onMousedown(e) {
    if (!primary) return;
    canvas.focus();
    if (primary.relativeMouse && document.pointerLockElement !== canvas && canvas.requestPointerLock) canvas.requestPointerLock();
    var m = SDL_WEB.mouseButtonMsg(canvas, e, true, logical());
    pushRecord([L.ev.MOUSEBUTTONDOWN, inputSid(), f32bits(m.x), f32bits(m.y), m.button, 0, 0, 0]);
  }
  function onMouseup(e) {
    if (!primary) return;
    var m = SDL_WEB.mouseButtonMsg(canvas, e, false, logical());
    pushRecord([L.ev.MOUSEBUTTONUP, inputSid(), f32bits(m.x), f32bits(m.y), m.button, 0, 0, 0]);
  }
  function onMousemove(e) {
    if (!primary) return;
    if (document.pointerLockElement === canvas) {
      var r = SDL_WEB.mouseMoveRelMsg(canvas, e, logical());
      pushRecord([L.ev.MOUSEMOTION, inputSid(), f32bits(r.dx), f32bits(r.dy), r.state, 1, 0, 0]);
      return;
    }
    var m = SDL_WEB.mouseMoveMsg(canvas, e, logical());
    pushRecord([L.ev.MOUSEMOTION, inputSid(), f32bits(m.x), f32bits(m.y), m.state, 0, 0, 0]);
  }
  function onWheel(e) {
    if (!primary) return;
    e.preventDefault();
    var m = SDL_WEB.wheelMsg(e);
    pushRecord([L.ev.MOUSEWHEEL, inputSid(), f32bits(m.x), f32bits(m.y), m.direction, 0, 0, 0]);
  }
  function onFocus() { setFocused(true); }
  function onBlur() { setFocused(false); }
  var inputAttached = false;
  function attachInput() {
    if (inputAttached) return;
    inputAttached = true;
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('keyup', onKeyup, true);
    canvas.addEventListener('mousedown', onMousedown);
    canvas.addEventListener('mouseup', onMouseup);
    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('focus', onFocus);
    canvas.addEventListener('blur', onBlur);
  }
  function detachInput() {
    if (!inputAttached) return;
    inputAttached = false;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('keyup', onKeyup, true);
    canvas.removeEventListener('mousedown', onMousedown);
    canvas.removeEventListener('mouseup', onMouseup);
    canvas.removeEventListener('mousemove', onMousemove);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('focus', onFocus);
    canvas.removeEventListener('blur', onBlur);
  }

  // ---- audio: one receiver per device ring -----------------------------------
  var audioDevices = new Map();   // aid -> receiver
  var masterVolume = 0.4;
  function onAudioOpen(msg) {
    var rx = createAudioReceiver({ sharedBuffer: msg.sab, bufferSize: msg.bufferSize });
    rx.setVolume(masterVolume * masterVolume);
    rx.handleMessage({ type: 'audio-open', id: msg.aid, freq: msg.freq, format: msg.format, channels: msg.channels });
    audioDevices.set(msg.aid, rx);
  }
  function onAudioClose(aid) {
    var rx = audioDevices.get(aid);
    if (rx) { try { rx.close(); } catch (e) {} audioDevices.delete(aid); }
  }
  function closeAudio() { audioDevices.forEach(function (rx) { try { rx.close(); } catch (e) {} }); audioDevices.clear(); }

  // ---- running -----------------------------------------------------------
  function splitArgs(s) {
    var out = [], m, re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    return out;
  }
  function freshCanvas() {
    var c = document.createElement('canvas');
    c.id = 'canvas'; c.tabIndex = 0; c.width = 800; c.height = 600;
    canvas.replaceWith(c);
    canvas = c;
    ctx2d = null;
  }

  var probe = window.__pyplay = {
    state: 'idle', lastExit: null, events: [], frames: 0, window: null,
    get output() { return outputLog; },
    runFiles: function (files, entry) {     // test seam: bypass the DOM drop path
      setProgram(files.map(function (f) { return { path: f.path, data: typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data) }; }));
      if (entry) { program.entry = entry; els.entry.value = entry; }
      return startRun();
    },
    stop: function () { stopRun(); },
    requestClose: function () { return requestClose(); },
    program: function () { return program; },
    // Pixel probe for tests: the composited canvas is a plain 2D canvas on
    // this thread, so a read-back is exact (no GPU/worker indirection).
    pixel: function (x, y) { return ctx2d ? Array.from(ctx2d.getImageData(x, y, 1, 1).data) : null; },
  };
  var autorun = false;
  var runDone = null;
  var closeTimer = null;

  function startRun() {
    if (!program || running) return Promise.resolve();
    stopRun();
    running = true;
    outputLog = '';
    probe.state = 'starting'; probe.lastExit = null; probe.frames = 0; probe.window = null;
    els.run.disabled = true; els.stop.disabled = false; els.entry.disabled = true;
    term.clear();
    els.canvasContainer.style.display = 'none';
    els.terminal.classList.remove('aside');
    fitAddon.fit();
    newStdinSab();
    freshCanvas();
    surfaces.clear(); order = []; primary = null; ring = null;
    stateSab = new SharedArrayBuffer(PS_WORDS * 4);
    state = new Int32Array(stateSab);
    publishScreen();
    worker = new Worker('pyplay-worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (e) {
      writeOutput('Worker error: ' + e.message + '\n', true);
      finishRun(-1);
    };
    var files = program.files.map(function (f) { return { path: f.path, data: f.data }; }); // structured clone (program stays reusable)
    worker.postMessage({
      type: 'run',
      files: files,
      entry: program.entry,
      args: splitArgs(els.args.value),
      stdinSab: stdinSab,
      stateSab: stateSab,
    });
    setStatus('Preparing runtime…');
    if (!rafId) rafId = requestAnimationFrame(tick);
    return new Promise(function (resolve) { runDone = resolve; });
  }
  // Ask the program to quit the way a window close does under gucOS: a QUIT
  // record on its primary window (pygame sees pygame.QUIT). An app that never
  // consumes it is force-stopped after a grace period (the #486 shape).
  function requestClose() {
    if (!running) return Promise.resolve(probe.lastExit);
    if (primary && ring) {
      pushRecord([L.ev.QUIT, primary.sid, 0, 0, 0, 0, 0, 0]);
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(function () { closeTimer = null; if (running) stopRun(); }, 3000);
      setStatus('Close requested…');
      return new Promise(function (resolve) { var prev = runDone; runDone = function (c) { if (prev) prev(c); resolve(c); }; });
    }
    stopRun();
    return Promise.resolve(null);
  }
  function stopRun() {
    if (!worker) return;
    var w = worker; worker = null;
    try { w.terminate(); } catch (e) {}
    if (running) { writeOutput('\n[stopped]\n', true); finishRun(null); }
  }
  function finishRun(code) {
    running = false;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    probe.state = 'done'; probe.lastExit = code;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    closeAudio();
    detachInput();
    surfaces.forEach(function (s) { if (s.bitmap) s.bitmap.close(); });
    els.run.disabled = !program; els.stop.disabled = true; els.entry.disabled = !program;
    if (code === null) setStatus('Stopped.');
    else setStatus(code === 0 ? 'Exited (0).' : 'Exit code ' + code, code !== 0);
    if (runDone) { var r = runDone; runDone = null; r(code); }
  }
  els.run.addEventListener('click', function () { startRun(); });
  els.stop.addEventListener('click', function () { requestClose(); });
  window.addEventListener('beforeunload', function () { if (worker) { try { worker.terminate(); } catch (e) {} } });

  function onWorkerMessage(e) {
    var msg = e.data;
    switch (msg.type) {
      case 'stdout': writeOutput(msg.text, false); break;
      case 'stderr': writeOutput(msg.text, true); break;
      case 'status': setStatus(msg.text); probe.events.push(msg.text); if (msg.text) probe.state = 'preparing'; break;
      case 'started': probe.state = 'running'; setStatus('Running ' + program.entry); break;
      case 'exit': finishRun(msg.exitCode); break;
      case 'exit-status': break;    // the ordered exit handshake; 'exit' follows with the status
      case 'error': writeOutput('Runtime error: ' + msg.message + '\n', true); finishRun(-1); break;
      case 'surface-create': onSurfaceCreate(msg); break;
      case 'surface-configure': onSurfaceConfigure(msg); break;
      case 'surface-destroy': onSurfaceDestroy(msg.sid); break;
      case 'surface-resize': pushRecord([L.ev.WINDOW_RESIZED, msg.sid, msg.w, msg.h, msg.serial, 0, 0, 0]); break;
      case 'surface-frame': {
        var s = surfaces.get(msg.sid);
        if (!s) { msg.bmp.close(); break; }
        if (s.bitmap) s.bitmap.close();
        s.bitmap = msg.bmp;
        if (s === primary && (canvas.width !== msg.bmp.width || canvas.height !== msg.bmp.height)) { canvas.width = msg.bmp.width; canvas.height = msg.bmp.height; }
        probe.frames++;
        break;
      }
      case 'surface-title': { var t = surfaces.get(msg.sid); if (t) t.title = msg.title; if (t === primary) document.title = msg.title || 'pyplay'; break; }
      case 'surface-flags': { var f = surfaces.get(msg.sid); if (f) f.relativeMouse = msg.relativeMouse;
        if (!msg.relativeMouse && document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock(); break; }
      case 'surface-cursor': canvas.style.cursor = msg.css; break;
      case 'surface-visible': { var v = surfaces.get(msg.sid); if (v) v.visible = msg.visible; break; }
      case 'audio-ring-open': onAudioOpen(msg); break;
      case 'audio-ring-close': onAudioClose(msg.aid); break;
      case 'audio-gain': audioDevices.forEach(function (rx) { rx.setVolume(masterVolume * masterVolume * msg.gain / 100); }); break;
    }
  }

  // ---- runtime reset -----------------------------------------------------
  els.reset.addEventListener('click', async function () {
    if (!confirm('Delete the cached Python runtime image and reload? It is re-downloaded on the next run.')) return;
    stopRun();
    try {
      var root = await navigator.storage.getDirectory();
      var names = [];
      for await (var entry of root.keys()) if (/^pyplay-/.test(entry)) names.push(entry);
      for (var i = 0; i < names.length; i++) { try { await root.removeEntry(names[i]); } catch (e) {} }
    } catch (e) {}
    location.reload();
  });

  // ?run=<url-of-zip> autoloads and runs a same-origin zip (demo links, tests).
  var params = new URLSearchParams(location.search);
  if (params.get('run')) {
    autorun = params.get('autorun') !== '0';
    fetch(params.get('run')).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + params.get('run'));
      return r.arrayBuffer();
    }).then(function (buf) { return readZip(buf); })
      .then(function (files) { setProgram(files); })
      .catch(function (err) { setStatus('Load failed: ' + err.message, true); });
  }
  setStatus('');
})();
