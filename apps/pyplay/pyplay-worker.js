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
importScripts('../../host.js');

var PKG = 'cpython-clang';
var PREFIX = '/opt/' + PKG;
var MARKER = PREFIX + '/.pyplay-installed';
var REPO = new URL('../../packages/', self.location.href);

var decoder = new TextDecoder();
var encoder = new TextEncoder();
var sdlRef = null;
var imageHandle = null;   // the OPFS sync-access handle; closed explicitly before 'exit' (see closeImage)

function post(msg) { self.postMessage(msg); }
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
  } else if (msg.type === 'sdl-input') {
    if (sdlRef) SDL_WEB.dispatch(sdlRef, msg.input);
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

  var wasm = PREFIX + '/bin/' + PKG + '.wasm';
  var bytes = readFile(fs, wasm);
  var args = [wasm, msg.entry].concat(msg.args || []);
  var env = {
    HOME: '/root', TMPDIR: '/tmp', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    PYTHONPYCACHEPREFIX: '/var/cache/' + PKG,   // keep /opt pristine (CPYTHON.md §5.3)
    PYTHONUNBUFFERED: '1',                       // prints land in the terminal as they happen
    PYTHONUTF8: '1',
  };

  var opts = {
    bytes: bytes,
    args: args,
    env: env,
    blockFsFactory: function (ctx) { return Promise.resolve({ c: fs.toWasmEnv(ctx) }); },
    stdinSab: msg.stdinSab,
    writeOut: function (buf) { post({ type: 'stdout', text: buf instanceof Uint8Array ? decoder.decode(buf) : String(buf) }); },
    writeErr: function (buf) { post({ type: 'stderr', text: buf instanceof Uint8Array ? decoder.decode(buf) : String(buf) }); },
    onReady: function (info) { sdlRef = info.sdl; post({ type: 'started' }); },
    notifyWindow: function (m) { post(m); },
  };
  if (msg.canvas) opts.getBrowserSDL = msg.canvas;
  if (msg.sharedAudioBuffer) {
    opts.sharedAudioBuffer = { sharedBuffer: msg.sharedAudioBuffer, bufferSize: msg.audioBufferSize };
    opts.notifyAudio = function (m) { post(m); };
  }
  return runModule(opts);
}
