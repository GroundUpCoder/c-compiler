// pyplay — the run worker. One worker per run: it owns the OPFS-backed BlockFS
// image for the session, installs the cpython-clang package into it (once per
// package sha), seeds the program under /game, and runs the interpreter with
// host.js's runModule — the same runtime entry the c/ standalone page and the
// compiler-emitted .html use. No kernel: the fs is private, stdin is the
// page's SharedArrayBuffer ring, stdout/stderr are postMessage'd.
//
// Package source = the gucman repo the page's origin serves (/packages/*),
// resolved relative to this script so a sub-path deploy keeps working. The
// payload is a ustar tar in gzip (tools/mkpkg.js), members rooted at
// opt/<name>/ — installed at the SAME /opt/<name> prefix gucman uses, so the
// interpreter's argv0 landmark walk (docs/CPYTHON.md §5.2) finds
// /opt/cpython-clang/lib/python3.13 with zero environment variables.
//
// SDL on this page is host.js's SURFACE flavor (createSurfaceSDL) — the one
// gucOS processes use — driven by a KERNEL-FREE hook set built below
// (makePageHooks). The interpreter may block in its main loop (pygame's
// `while True: ... flip()`): presents are shm mailbox flips into a
// SharedArrayBuffer, input arrives on the ring SAB, SDL_Delay parks on it,
// and the PAGE (pyplay.js, main thread) composites the mailbox and feeds the
// ring. That is the gucOS transport with the page standing in for the
// kernel's compositor and input bridge — one transport, two embedders. It
// needs no JSPI and works wherever Atomics.wait works in a worker.
importScripts('../../host.js');

var PKG = 'cpython-clang';
var PREFIX = '/opt/' + PKG;
var MARKER = PREFIX + '/.pyplay-installed';
var REPO = new URL('../../packages/', self.location.href);

var decoder = new TextDecoder();
var encoder = new TextEncoder();
var imageHandle = null;   // the OPFS sync-access handle; closed explicitly before 'exit' (see closeImage)

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function status(text) { post({ type: 'status', text: text }); }

// Release the OPFS handle deterministically: a terminated worker's handle is
// dropped asynchronously by the browser, and the NEXT run's worker (or a reload)
// would collide with it. Flush first so the pyc cache survives.
function closeImage() {
  if (!imageHandle) return;
  try { imageHandle.flush(); } catch (e) {}
  try { imageHandle.close(); } catch (e) {}
  imageHandle = null;
}

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'run') {
    doRun(msg).then(function (exitCode) {
      closeImage();
      post({ type: 'exit', exitCode: exitCode });
    }, function (err) {
      closeImage();
      post({ type: 'error', message: (err && err.stack) || String(err) });
    });
  }
};

// ---- fs helpers -----------------------------------------------------------
var O_WRONLY_CREAT_TRUNC = 0x241;   // O_WRONLY|O_CREAT|O_TRUNC — a write on an O_RDONLY fd fails (#542)

function mkdirp(fs, dir) {
  var parts = dir.split('/').filter(Boolean), cur = '';
  for (var i = 0; i < parts.length; i++) {
    cur += '/' + parts[i];
    if (fs.stat(cur)) continue;
    if (fs.mkdir(cur, 0o755) < 0) throw new Error('mkdir ' + cur + ' failed');
  }
}
function writeFile(fs, path, data) {
  mkdirp(fs, path.substring(0, path.lastIndexOf('/')) || '/');
  var fd = fs.open(path, O_WRONLY_CREAT_TRUNC, 0o644);
  if (fd < 0) throw new Error('open for write failed: ' + path);
  var off = 0;
  while (off < data.length) {
    var n = fs.write(fd, off ? data.subarray(off) : data, data.length - off);
    if (n <= 0) { fs.close(fd); throw new Error('write failed at ' + off + ' of ' + path); }
    off += n;
  }
  fs.close(fd);
}
function readFile(fs, path) {
  var fd = fs.open(path, 0, 0);
  if (fd < 0) throw new Error('open failed: ' + path);
  var st = fs.fstat(fd);
  var out = new Uint8Array(st.size), off = 0;
  while (off < st.size) {
    var n = fs.read(fd, out.subarray(off), st.size - off);
    if (n <= 0) break;
    off += n;
  }
  fs.close(fd);
  return off === st.size ? out : out.subarray(0, off);
}
function rmrf(fs, path) {
  var st = fs.lstat(path);
  if (!st) return;
  if ((st.mode & 0o170000) === 0o040000) {
    var h = fs.opendir(path), names = [], ent;
    while ((ent = fs.readdir(h))) if (ent.name !== '.' && ent.name !== '..') names.push(ent.name);
    fs.closedir(h);
    for (var i = 0; i < names.length; i++) rmrf(fs, path + '/' + names[i]);
    fs.rmdir(path);
  } else {
    fs.unlink(path);
  }
}

// ---- package install ------------------------------------------------------
async function sha256Hex(bytes) {
  var d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}
async function gunzip(bytes) {
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// ustar reader: name(100) mode size(12 octal @124) typeflag(@156) linkname(100 @157)
// magic(@257) prefix(155 @345). Two zero blocks end the archive.
function untar(bytes, onMember) {
  var p = 0, N = bytes.length;
  function str(off, len) {
    var end = off; while (end < off + len && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(off, end));
  }
  while (p + 512 <= N) {
    var allZero = true;
    for (var i = 0; i < 512; i++) if (bytes[p + i]) { allZero = false; break; }
    if (allZero) break;
    var name = str(p, 100), size = parseInt(str(p + 124, 12).trim() || '0', 8);
    var type = bytes[p + 156], link = str(p + 157, 100), prefix = str(p + 345, 155);
    if (prefix) name = prefix + '/' + name;
    var data = bytes.subarray(p + 512, p + 512 + size);
    onMember(name, type, data, link);
    p += 512 + Math.ceil(size / 512) * 512;
  }
}

async function resolvePackage() {
  var r = await fetch(new URL('index.json', REPO));
  if (!r.ok) throw new Error('package repo: HTTP ' + r.status + ' for ' + new URL('index.json', REPO));
  var idx = await r.json();
  var table = idx.packages || idx;
  var entry = table[PKG];
  if (!entry || !entry.payload) throw new Error('package repo has no ' + PKG + ' entry — run `node tools/mkpkg.js --clang` (needs the clang-simplified sibling)');
  return entry;
}

async function openImage(sha) {
  var name = 'pyplay-' + PKG + '-' + sha.slice(0, 16) + '.img';
  var root = await navigator.storage.getDirectory();
  var stale = [];
  for await (var key of root.keys()) if (/^pyplay-/.test(key) && key !== name) stale.push(key);
  for (var i = 0; i < stale.length; i++) { try { await root.removeEntry(stale[i]); } catch (e) {} }
  // A v4 volume, NOT BLOCK_FS.init's legacy v3 format: /dev/{null,zero,urandom}
  // are materialised only on v4 mounts (ensureDevNodes), and this CPython
  // build seeds hash randomization from /dev/urandom (pyconfig.h has no
  // HAVE_GETENTROPY) — on a v3 image it dies at _Py_HashRandomization_Init.
  var fh = await root.getFileHandle(name, { create: true });
  // The previous run's worker may still be releasing its handle (a Stop
  // terminates it mid-run, and Chromium drops the handle asynchronously):
  // retry briefly instead of failing the run on a lock the page itself held.
  var handle = null, lastErr = null;
  for (var attempt = 0; attempt < 50 && !handle; attempt++) {
    try { handle = await fh.createSyncAccessHandle(); }
    catch (e) { lastErr = e; await new Promise(function (r) { setTimeout(r, 100); }); }
  }
  if (!handle) throw new Error('runtime image is locked by another tab or a run that has not released it yet (' + (lastErr && lastErr.message) + ')');
  imageHandle = handle;
  return BLOCK_FS.createV4(new BLOCK_FS.SyncAccessHandleStore(handle));
}

async function ensureRuntime() {
  status('Resolving Python runtime…');
  var entry = await resolvePackage();
  var sha = entry.payload.sha256;
  var fs = await openImage(sha);
  if (fs.stat(MARKER)) return { fs: fs, entry: entry };

  status('Downloading Python ' + entry.version + ' (' + (entry.payload.size / 1048576).toFixed(1) + ' MB)…');
  var res = await fetch(new URL(entry.payload.url, REPO));
  if (!res.ok) throw new Error('package payload: HTTP ' + res.status);
  var gz = new Uint8Array(await res.arrayBuffer());
  var got = await sha256Hex(gz);
  if (got !== sha) throw new Error('package sha256 mismatch: index says ' + sha + ', payload is ' + got);

  status('Unpacking runtime…');
  var tar = await gunzip(gz);
  rmrf(fs, PREFIX);
  var count = 0;
  untar(tar, function (name, type, data, link) {
    name = name.replace(/^\.?\/+/, '');
    if (!name || name === 'control.json') return;
    if (name.indexOf('opt/' + PKG + '/') !== 0 && name !== 'opt/' + PKG && name !== 'opt/') {
      throw new Error('package member outside its prefix: ' + name);
    }
    if (name.split('/').indexOf('..') >= 0) throw new Error('package member escapes: ' + name);
    var path = '/' + name.replace(/\/+$/, '');
    if (type === 53 /* '5' dir */) { mkdirp(fs, path); return; }
    if (type === 50 /* '2' symlink */) { mkdirp(fs, path.substring(0, path.lastIndexOf('/'))); fs.symlink(link, path); return; }
    if (type === 48 || type === 0 /* '0' or NUL: regular */) { writeFile(fs, path, data); count++; return; }
    // hard links / devices never appear in mkpkg output; refuse loudly rather than skip
    throw new Error('unsupported tar member type ' + type + ' for ' + name);
  });
  // Silence getpath's "Could not find platform dependent libraries" note: the
  // landmark for <exec_prefix> is lib-dynload/, empty is enough (CPYTHON.md §5.2).
  mkdirp(fs, PREFIX + '/lib/python3.13/lib-dynload');
  writeFile(fs, MARKER, encoder.encode(sha + '\n'));
  status('Installed ' + count + ' files.');
  return { fs: fs, entry: entry };
}

// ---- the page broker: kernel-free spawnHooks for createSurfaceSDL ----------
// Page-state SAB words, shared with pyplay.js (the main thread writes SCREEN_*
// and FOCUSED, bumps VSEQ once per rAF; the worker parks on VSEQ).
var PS_VSEQ = 0, PS_ARMED = 1, PS_FOCUSED = 2, PS_SCREEN_W = 3, PS_SCREEN_H = 4;

function makePageHooks(state, fs) {
  var nextSid = 1, nextAid = 1, cfgSerial = 1, masterGain = 100;
  var surfaces = new Map();          // sid -> { w, h, fb, flags, visible, serial }
  var ringI32 = null;                // the process's ONE input ring (page = producer)
  var vsyncSeen;
  function fdReadable(fd) {
    // No kernel fd table: fd 0 is the page's stdin ring; everything else a
    // process can hold here is a regular file, which select(2) calls readable.
    if (fd === 0) return fs._stdinSab ? fs._stdinSabReady() : true;
    return true;
  }
  return {
    // Layout tripwire (CD26): host.js's own table — no second declaration
    // exists in this embedder, so this is the honest answer, not a bypass.
    wmSabLayout: WM_SAB_LAYOUT_HOST,
    payloadChunk: 65536,             // clipboard/http staging chunk; no kernel page to derive it from
    // No process broker on this page: posix_spawn and friends fail loud.
    spawn: function () { return { errno: 'ENOSYS' }; },
    wait: function () { return { errno: 'ECHILD' }; },
    kill: function () { return { errno: 'ESRCH' }; },
    getpgid: function () { return { pgid: 1 }; },
    getsid: function () { return { sid: 1 }; },

    // ---- surfaces: the page composites the shm mailbox (pyplay.js) ----
    surfaceCreate: function (w, h, title, fbSab, ringSab, flags) {
      var sid = nextSid++;
      if (!ringI32 && ringSab) ringI32 = new Int32Array(ringSab);
      var visible = !(flags & 256);          // bit8 = SDL_WINDOW_HIDDEN construction
      surfaces.set(sid, { w: w, h: h, fb: fbSab, flags: flags | 0, visible: visible, serial: 1 });
      post({ type: 'surface-create', sid: sid, w: w, h: h, title: title || '', flags: flags | 0,
             visible: visible, fb: fbSab, ring: ringSab });
      return { sid: sid, lifecycle: 2 };
    },
    surfaceDestroy: function (sid) {
      if (!surfaces.delete(sid)) return { errno: 'EINVAL' };
      post({ type: 'surface-destroy', sid: sid });
      return {};
    },
    surfaceSetTitle: function (sid, title) { post({ type: 'surface-title', sid: sid, title: title || '' }); return {}; },
    surfaceSetFlags: function (sid, flags) {
      var s = surfaces.get(sid);
      if (!s) return { errno: 'EINVAL' };
      s.flags = flags | 0;
      post({ type: 'surface-flags', sid: sid, flags: flags | 0, relativeMouse: !!(flags & 2) });
      return {};
    },
    surfaceSetCursor: function (sid, shape) {
      post({ type: 'surface-cursor', sid: sid, css: CURSOR_CSS[shape] || 'default' });
      return {};
    },
    surfaceSetVisible: function (sid, visible) {
      var s = surfaces.get(sid);
      if (!s) return { errno: 'EINVAL' };
      s.visible = !!visible;
      post({ type: 'surface-visible', sid: sid, visible: !!visible });
      return {};
    },
    surfaceActivate: function (sid) { return surfaces.has(sid) ? {} : { errno: 'EINVAL' }; },
    surfaceSetOwner: function (sid) { return surfaces.has(sid) ? {} : { errno: 'EINVAL' }; },
    surfaceGetState: function (sid) {
      var s = surfaces.get(sid);
      if (!s) return { errno: 'EINVAL' };
      return { visible: s.visible, viewable: s.visible, minimized: false,
               focused: Atomics.load(state, PS_FOCUSED) === 1 && s.visible,
               x: 0, y: 0, w: s.w, h: s.h };
    },
    // Owner-initiated resize (SDL_SetWindowSize): the same renegotiation as
    // under the kernel — a WINDOW_RESIZED ring record carrying a configure
    // serial, acked by surfaceConfigure with the new buffer. The ring has ONE
    // producer (the page), so the record is pushed there, not here.
    surfaceResize: function (sid, w, h) {
      var s = surfaces.get(sid);
      if (!s) return { errno: 'EINVAL' };
      var serial = ++cfgSerial;
      post({ type: 'surface-resize', sid: sid, w: w, h: h, serial: serial });
      return {};
    },
    surfaceConfigure: function (sid, w, h, sab, serial) {
      var s = surfaces.get(sid);
      if (!s) return { errno: 'EINVAL' };
      if (!sab) return {};                    // declined: keep the old buffer
      s.w = w; s.h = h; s.fb = sab; s.serial = serial | 0;
      post({ type: 'surface-configure', sid: sid, w: w, h: h, fb: sab, serial: serial | 0 });
      return {};
    },
    // GPU-tier frames (SDL_Renderer on WebGPU, webgpu.h): ImageBitmaps, the
    // gucOS gpu transport. The page drawImage()s them.
    surfaceFrame: function (sid, bmp, serial) {
      post({ type: 'surface-frame', sid: sid, bmp: bmp, serial: serial | 0 }, [bmp]);
      return {};
    },
    screen: function () { return { w: Atomics.load(state, PS_SCREEN_W), h: Atomics.load(state, PS_SCREEN_H) }; },

    // ---- vsync: the page's rAF is the display clock (KernelClient discipline) ----
    vsyncEnabled: function () { return typeof Atomics.waitAsync === 'function'; },
    vsyncSeq: function () { return Atomics.load(state, PS_VSEQ); },
    vsyncWait: function () {
      var cur = Atomics.load(state, PS_VSEQ);
      if (vsyncSeen === undefined) vsyncSeen = cur;
      if (cur !== vsyncSeen) { vsyncSeen = cur; return Promise.resolve(); }   // missed tick(s): fire now
      Atomics.add(state, PS_ARMED, 1);
      var r = Atomics.waitAsync(state, PS_VSEQ, cur);
      if (!r.async) { Atomics.sub(state, PS_ARMED, 1); vsyncSeen = Atomics.load(state, PS_VSEQ); return Promise.resolve(); }
      return r.value.then(function () { Atomics.sub(state, PS_ARMED, 1); vsyncSeen = Atomics.load(state, PS_VSEQ); });
    },
    vsyncWaitUntil: function (target) {
      for (;;) {
        var cur = Atomics.load(state, PS_VSEQ);
        if (((cur - target) | 0) >= 0) return cur;
        Atomics.add(state, PS_ARMED, 1);
        Atomics.wait(state, PS_VSEQ, cur, 1000);    // 1 s chunks: a hidden tab stops ticking (honest pause)
        Atomics.sub(state, PS_ARMED, 1);
      }
    },
    compParked: function () { return false; },   // the page compositor runs every rAF while a run is live
    wantFrame: function () {},
    frameIdle: function () {},

    // Unified wait (docs/archive/0178 shape): {r:[fds], ring, timeoutMs|null} →
    // {why: 0 timeout | 1 fd | 2 ring}. Readiness check + park; the only fd
    // with a real wait source here is stdin (its SEQ futex), so a wait that
    // mixes the ring and stdin parks in 50 ms slices — one futex per wait.
    waitMulti: function (req) {
      var fds = req.r || [], wantRing = !!(req.ring && ringI32);
      var wantStdin = fds.indexOf(0) >= 0 && !!fs._stdinSab;
      var deadline = req.timeoutMs == null ? Infinity : performance.now() + req.timeoutMs;
      for (;;) {
        if (wantRing && Atomics.load(ringI32, WMIR_WPOS) !== Atomics.load(ringI32, WMIR_RPOS)) return { why: 2 };
        for (var i = 0; i < fds.length; i++) if (fdReadable(fds[i])) return { why: 1 };
        var left = deadline - performance.now();
        if (left <= 0) return { why: 0 };
        var slice = Math.min(left, wantRing && wantStdin ? 50 : 1000);
        if (wantRing) Atomics.wait(ringI32, WMIR_WPOS, Atomics.load(ringI32, WMIR_WPOS), slice);
        else if (wantStdin) Atomics.wait(fs._stdinCtrl, 0 /* SI_SEQ */, Atomics.load(fs._stdinCtrl, 0), slice);
        else BLOCK_FS.blockingSleepMs(slice);
      }
    },
    exit: function (status) { post({ type: 'exit-status', status: status | 0 }); return {}; },
    padName: function () { return { name: '' }; },

    // ---- audio: one page receiver per device ring (the standalone ring layout) ----
    audioOpen: function (freq, format, channels, sab) {
      var aid = nextAid++;
      post({ type: 'audio-ring-open', aid: aid, freq: freq | 0, format: format | 0, channels: channels | 0,
             sab: sab, bufferSize: WMAUDIO_RING_BYTES });
      // Dummy-driver contract: the sink runs at the requested spec (Web Audio
      // resamples per AudioContext), so no format conversion is asked of the app.
      return { aid: aid, sinkFormat: format | 0, sinkChannels: channels | 0, sinkFreq: freq | 0 };
    },
    audioClose: function (aid) { post({ type: 'audio-ring-close', aid: aid }); return {}; },
    audioGain: function (gain) {
      if (gain >= 0) { masterGain = Math.min(200, gain | 0); post({ type: 'audio-gain', gain: masterGain }); }
      return { gain: masterGain };
    },
  };
}

// ---- run --------------------------------------------------------------------
async function doRun(msg) {
  var rt = await ensureRuntime();
  var fs = rt.fs;

  status('Seeding program…');
  rmrf(fs, '/game');
  mkdirp(fs, '/game');
  for (var i = 0; i < msg.files.length; i++) writeFile(fs, '/game/' + msg.files[i].path, msg.files[i].data);
  mkdirp(fs, '/root');
  mkdirp(fs, '/tmp');
  mkdirp(fs, '/var/cache/' + PKG);
  fs.chdir('/game');

  // The entry is a Python script run by the package interpreter — or, when
  // it is a .wasm produced by this repo's compiler, the program itself (a
  // dropped compiled game; also how the transport is tested before pygame).
  var exe, args;
  if (/\.wasm$/i.test(msg.entry)) {
    exe = '/game/' + msg.entry;
    args = [exe].concat(msg.args || []);
  } else {
    exe = PREFIX + '/bin/' + PKG + '.wasm';
    args = [exe, msg.entry].concat(msg.args || []);
  }
  var bytes = readFile(fs, exe);
  var env = {
    HOME: '/root', TMPDIR: '/tmp', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    PYTHONPYCACHEPREFIX: '/var/cache/' + PKG,   // keep /opt pristine (CPYTHON.md §5.3)
    PYTHONUNBUFFERED: '1',                       // prints land in the terminal as they happen
    PYTHONUTF8: '1',
  };
  var state = new Int32Array(msg.stateSab);

  var opts = {
    bytes: bytes,
    args: args,
    env: env,
    blockFsFactory: function (ctx) { return Promise.resolve({ c: fs.toWasmEnv(ctx) }); },
    stdinSab: msg.stdinSab,
    // The page broker: makes runModule pick createSurfaceSDL (surface ops on
    // the hooks) — kernel-shaped SDL with the page as compositor.
    spawnHooks: makePageHooks(state, fs),
    writeOut: function (buf) { post({ type: 'stdout', text: buf instanceof Uint8Array ? decoder.decode(buf) : String(buf) }); },
    writeErr: function (buf) { post({ type: 'stderr', text: buf instanceof Uint8Array ? decoder.decode(buf) : String(buf) }); },
    onReady: function () { post({ type: 'started' }); },
  };
  return runModule(opts);
}
