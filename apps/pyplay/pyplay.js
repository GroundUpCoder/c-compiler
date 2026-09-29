// pyplay — main-thread controller. Loads a program (zip / folder / loose .py
// files), lets the user pick the entry script, and runs it on the cpython-clang
// package inside a Worker (pyplay-worker.js). Everything the program sees is a
// private BlockFS image: the runtime is unpacked from the gucman package repo
// (/packages) once per package sha and cached in OPFS; the program's files are
// re-seeded under /game on every run.
//
// This page deliberately shares its plumbing with the compiler-emitted
// single-file page (compiler.js HtmlOutput) and the c/ standalone runner:
// SDL_WEB for DOM→SDL input, createAudioReceiver for the shared audio ring,
// and the live-stdin SharedArrayBuffer protocol BlockFS already speaks
// (SI_* header words, see host.js setStdinSab). Nothing here is gucOS —
// no kernel, no wm, no compositor.
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
  var hasSDL = false;
  var sdlCanvasW = 0, sdlCanvasH = 0, sdlRelativeMouse = false;
  var audioReceiver = null;
  var canvas = els.canvas;
  var outputLog = '';        // test probe: everything written to stdout/stderr

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
  window.addEventListener('resize', function () { fitAddon.fit(); publishWinsize(); });

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
  var enc = new TextEncoder();
  term.onData(function (data) {
    if (!running || hasSDL) return;
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
  function pyCandidates(files) {
    return files.map(function (f) { return f.path; }).filter(function (p) { return /\.py$/i.test(p); })
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
    var cands = pyCandidates(files);
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
    return c.transferControlToOffscreen();
  }

  var probe = window.__pyplay = {
    state: 'idle', lastExit: null, events: [], get output() { return outputLog; },
    runFiles: function (files, entry) {     // test seam: bypass the DOM drop path
      setProgram(files.map(function (f) { return { path: f.path, data: typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data) }; }));
      if (entry) { program.entry = entry; els.entry.value = entry; }
      return startRun();
    },
    stop: function () { stopRun(); },
    program: function () { return program; },
  };
  var autorun = false;
  var runDone = null;

  function startRun() {
    if (!program || running) return Promise.resolve();
    stopRun();
    running = true;
    hasSDL = false;
    outputLog = '';
    probe.state = 'starting'; probe.lastExit = null;
    els.run.disabled = true; els.stop.disabled = false; els.entry.disabled = true;
    term.clear();
    els.canvasContainer.style.display = 'none';
    els.terminal.classList.remove('aside');
    fitAddon.fit();
    newStdinSab();
    var offscreen = freshCanvas();
    var sharedAudio = null;
    audioReceiver = null;
    if (typeof createSharedAudioBuffer === 'function') {
      sharedAudio = createSharedAudioBuffer();
      audioReceiver = createAudioReceiver({ sharedBuffer: sharedAudio.sharedBuffer, bufferSize: sharedAudio.bufferSize });
    }
    worker = new Worker('pyplay-worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (e) {
      writeOutput('Worker error: ' + e.message + '\n', true);
      finishRun(-1);
    };
    var transfer = [offscreen];
    var files = program.files.map(function (f) { return { path: f.path, data: f.data }; }); // structured clone (program stays reusable)
    var msg = {
      type: 'run',
      files: files,
      entry: program.entry,
      args: splitArgs(els.args.value),
      canvas: offscreen,
      stdinSab: stdinSab,
    };
    if (sharedAudio) { msg.sharedAudioBuffer = sharedAudio.sharedBuffer; msg.audioBufferSize = sharedAudio.bufferSize; }
    worker.postMessage(msg, transfer);
    setStatus('Preparing runtime…');
    return new Promise(function (resolve) { runDone = resolve; });
  }
  function stopRun() {
    if (!worker) return;
    var w = worker; worker = null;
    try { w.terminate(); } catch (e) {}
    if (running) { writeOutput('\n[stopped]\n', true); finishRun(null); }
  }
  function finishRun(code) {
    running = false;
    probe.state = 'done'; probe.lastExit = code;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    if (audioReceiver) { try { audioReceiver.close(); } catch (e) {} audioReceiver = null; }
    els.run.disabled = !program; els.stop.disabled = true; els.entry.disabled = !program;
    detachSdlInput();
    if (code === null) setStatus('Stopped.');
    else setStatus(code === 0 ? 'Exited (0).' : 'Exit code ' + code, code !== 0);
    if (runDone) { var r = runDone; runDone = null; r(code); }
  }
  els.run.addEventListener('click', function () { startRun(); });
  els.stop.addEventListener('click', stopRun);
  window.addEventListener('beforeunload', function () { if (worker) { try { worker.terminate(); } catch (e) {} } });

  function onWorkerMessage(e) {
    var msg = e.data;
    switch (msg.type) {
      case 'stdout': writeOutput(msg.text, false); break;
      case 'stderr': writeOutput(msg.text, true); break;
      case 'status': setStatus(msg.text); probe.events.push(msg.text); if (msg.text) probe.state = 'preparing'; break;
      case 'started': probe.state = 'running'; setStatus('Running ' + program.entry); break;
      case 'exit': finishRun(msg.exitCode); break;
      case 'error': writeOutput('Runtime error: ' + msg.message + '\n', true); finishRun(-1); break;
      case 'sdl-window':
        hasSDL = true;
        sdlCanvasW = msg.width || 800; sdlCanvasH = msg.height || 600;
        els.canvasContainer.style.display = 'flex';
        els.terminal.classList.add('aside');
        fitAddon.fit();
        if (msg.title) document.title = msg.title;
        attachSdlInput();
        canvas.focus();
        break;
      case 'sdl-title': document.title = msg.title || 'pyplay'; break;
      case 'sdl-relative-mouse':
        sdlRelativeMouse = !!msg.enabled;
        if (!sdlRelativeMouse && document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        break;
      default:
        if (msg.type && msg.type.indexOf('audio-') === 0 && audioReceiver) audioReceiver.handleMessage(msg);
    }
  }

  // ---- SDL input (DOM → SDL_WEB → worker) --------------------------------
  function sdlLogical() { return { w: sdlCanvasW, h: sdlCanvasH }; }
  function post(input) { if (worker) worker.postMessage({ type: 'sdl-input', input: input }); }
  function onKeydown(e) { if (!hasSDL || document.activeElement === els.args) return; e.preventDefault(); post(SDL_WEB.keyMsg(e, true)); }
  function onKeyup(e) { if (!hasSDL || document.activeElement === els.args) return; e.preventDefault(); post(SDL_WEB.keyMsg(e, false)); }
  function onMousedown(e) {
    if (!hasSDL) return;
    canvas.focus();
    if (sdlRelativeMouse && document.pointerLockElement !== canvas && canvas.requestPointerLock) canvas.requestPointerLock();
    post(SDL_WEB.mouseButtonMsg(canvas, e, true, sdlLogical()));
  }
  function onMouseup(e) { if (hasSDL) post(SDL_WEB.mouseButtonMsg(canvas, e, false, sdlLogical())); }
  function onMousemove(e) {
    if (!hasSDL) return;
    if (document.pointerLockElement === canvas) post(SDL_WEB.mouseMoveRelMsg(canvas, e, sdlLogical()));
    else post(SDL_WEB.mouseMoveMsg(canvas, e, sdlLogical()));
  }
  function onWheel(e) { if (!hasSDL) return; e.preventDefault(); post(SDL_WEB.wheelMsg(e)); }
  var sdlAttached = false;
  function attachSdlInput() {
    if (sdlAttached) return;
    sdlAttached = true;
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('keyup', onKeyup, true);
    canvas.addEventListener('mousedown', onMousedown);
    canvas.addEventListener('mouseup', onMouseup);
    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
  }
  function detachSdlInput() {
    if (!sdlAttached) return;
    sdlAttached = false;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('keyup', onKeyup, true);
    canvas.removeEventListener('mousedown', onMousedown);
    canvas.removeEventListener('mouseup', onMouseup);
    canvas.removeEventListener('mousemove', onMousemove);
    canvas.removeEventListener('wheel', onWheel);
    hasSDL = false;
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
