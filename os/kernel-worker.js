// kernel-worker.js — the OS's kernel worker (todos/0004; layout in
// todos/OS.md "Reference build"). Runs once per tab: mounts BlockFS on OPFS
// (SyncAccessHandle is worker-only — this is WHY the kernel lives in a
// worker) — a writable root volume at / plus the read-only baked system
// blob at /usr (todos/0040; materialized by fetch-or-bake when missing or
// stale), owns the process table + tty + fd layer (kernel.js), backs
// /bin/cc with compiler.js, and spawns one nested process worker per pid.
//
// Protocol with the page (os.html, a dumb UI bridge):
//   page -> kernel: {type:'input', data}         raw tty bytes/keystrokes
//                   {type:'resize', cols, rows}
//                   {type:'eof'}
//                   {type:'boot-retry'}          two-tab guard (todos/0045):
//                                                re-attempt the boot lock
//                                                after a boot-locked
//                   {type:'wm-canvas', canvas}   the desktop OffscreenCanvas
//                                                (todos/WM.md — the kernel
//                                                composites in-worker)
//                   {type:'wm-input', ev}        raw desktop key/pointer input
//                   {type:'screen-resize', w, h} dynamic screen resolution
//                                                (todos/0023): resize the
//                                                OffscreenCanvas + wmSetScreen
//                                                (-> EV_SCREEN to the wm)
//                   {type:'drop-file', name, [rel], [episode], bytes}
//                                                host file dropped on the
//                                                desktop (todos/0067): write
//                                                bytes to /root/Desktop/<name>
//                                                (kernel-side fs — no process,
//                                                no RPC); /bin/wm's coarse
//                                                re-read grows the icon ~1s
//                                                later. bytes is a transferred
//                                                ArrayBuffer (zero-copy).
//                                                rel/episode (todos/0398): a
//                                                directory drop's tree path —
//                                                the root uniquifies once per
//                                                episode, parents mkdir -p.
//                   {type:'host-paste-files', files:[{name, bytes}]}
//                                                host paste chord carried
//                                                files (todos/0398 D6): wipe +
//                                                repopulate /root/.hoststage,
//                                                publish an fmt-2 "copy" list
//                                                on the kernel slot, stamp
//                                                clip freshness; the forwarded
//                                                chord follows on this FIFO.
//                   {type:'clipboard', text}     host -> gucOS clipboard
//                                                (ticket #79): the page read
//                                                the host clipboard (focus
//                                                sync / clip-read refresh);
//                                                land it in the kernel's one
//                                                slot so the next gucOS
//                                                paste sees it
//                   {type:'clip-read-done'}      clipboard seam: the page's
//                                                clip-read refresh settled
//                                                (any {type:'clipboard'}
//                                                update already landed —
//                                                postMessage FIFO); resume
//                                                every CLIP_GET parked on it
//   kernel -> page: {type:'out', bytes}          tty output (program + echo)
//                   {type:'clipboard', text}     gucOS -> host clipboard
//                                                (ticket #79): a process
//                                                committed a TEXT copy; the
//                                                page mirrors it out via
//                                                navigator.clipboard
//                   {type:'clip-read'}           clipboard seam: a paste
//                                                consumer is PARKED on
//                                                CLIP_GET — re-read the host
//                                                clipboard inside the
//                                                triggering gesture's still-
//                                                live activation, then
//                                                answer clip-read-done
//                                                (ALWAYS — the worker's
//                                                timeout is the backstop,
//                                                not the plan)
//                   {type:'egress', dispo, name, bytes}
//                                                egress (todos/0398): ONE
//                                                kernel-materialized artifact;
//                                                the page downloads it (or
//                                                raises the saveas picker)
//                                                inside the initiating click's
//                                                still-live activation. bytes
//                                                is transferred.
//                   {type:'boot-log', msg}       boot progress / kernel log
//                   {type:'boot-error', msg}
//                   {type:'boot-locked'}         two-tab guard (todos/0045):
//                                                another tab holds the boot
//                                                lock — nothing was mounted;
//                                                the page shows retry
//                   {type:'boot-nogpu'}          WebGPU guard (todos/0055):
//                                                no adapter/device in this
//                                                worker — the compositor IS
//                                                WebGPU (no fallback), so
//                                                the boot stops loudly;
//                                                nothing was mounted
//                   {type:'ready', mode}         booted; mode = openWorkspace's
//                   {type:'halt', status}        pid 1 exited
//                   {type:'audio', sab, bufferSize, freq, channels, format}
//                                                the mixer's output ring
//                                                (todos/0017) — play with
//                                                host.js createAudioReceiver
//                   {type:'pointer-lock', wanted}  relative mouse (todos/0018):
//                                                the focused surface wants the
//                                                pointer lock (page arms
//                                                click-to-lock / exits); the
//                                                page reports transitions back
//                                                as a {kind:'lockchange'}
//                                                wm-input event
//                   {type:'cursor', shape}       the effective pointer cursor
//                                                changed (todos/0105) — the
//                                                page sets canvas.style.cursor
//                                                from an SDL_SystemCursor shape
//                                                (-1 = hidden); chrome resize
//                                                cursors overlay app cursors
'use strict';

importScripts('../host.js', '../kernel.js', '../compiler.js', 'os-common.js', 'ksvc.js', 'compositor.js');
try {
  // Optional libc extension (fnmatch/glob/regex — busybox hush needs it).
  // compiler.js's getExtLibMap picks up the EXT_LIB_MAP global it defines.
  importScripts('../libc-ext.js');
} catch (e) { /* absent is fine; cc just lacks the ext headers */ }
// worker globals: BLOCK_FS, runModule (host.js); KERNEL (kernel.js);
// CompilerJS (compiler.js); OS_COMMON (os-common.js)

var kernel = null;
var tty = null;
var kfs = null;        // the kernel's MountFS (drop-file writes; todos/0067)
var wmCanvas = null;   // the desktop OffscreenCanvas (screen-resize target)
var compositor = null; // {scheduleFrame,setFrozen,stats} once wm-canvas
                       // arrives (todos/0169 — the on-demand rAF)
var gpuDevice = null;  // the compositor's WebGPU device (todos/0055 boot guard)
var displayAnnounce = null;   // display-density bridge (set at boot, below)
var post = function (m) { self.postMessage(m); };
var pending = [];   // input that raced the boot
// Deferred CLIP_GET refresh state (the clipboard seam — see onClipRead in
// the Kernel opts below): parked-reader done callbacks sharing one page
// round-trip, the freshness stamp that dedupes back-to-back reads, and the
// timeout backstop that keeps the always-done contract.
var CLIP_FRESH_MS = 300, CLIP_READ_TIMEOUT_MS = 10000;
var clipReadPending = [];
var clipReadTimer = null;
var clipFreshAt = -1e9;
function clipReadSettle() {
  if (clipReadTimer !== null) { clearTimeout(clipReadTimer); clipReadTimer = null; }
  clipFreshAt = Date.now();
  var dones = clipReadPending;
  clipReadPending = [];
  for (var i = 0; i < dones.length; i++) dones[i]();
}
// Host keyboard-scheme auto-detect hint (META-ARROW-KEYBIND.md decision 4).
// os.html reads navigator (or a ?hostkeys= test override) and passes the
// verdict on THIS worker's URL, because startBoot() runs on load — before any
// postMessage could arrive. 'mac' seeds the macos scheme as the fresh-volume
// default; anything else (incl. absent) is a no-op = the baked windows scheme.
var HOST_PLATFORM = (function () {
  try {
    return new URLSearchParams(self.location.search).get('hostkeys') || 'other';
  } catch (e) { return 'other'; }
})();

// Spawn trace (ticket #350): a ?spawntrace=1 page param rides this worker's
// URL (the hostkeys pattern — createWorker runs long before any postMessage
// seam could deliver a flag race-free). Default OFF; when off, the only
// residual cost anywhere is two clock reads at the top of process-worker.js.
var SPAWN_TRACE = (function () {
  try {
    return new URLSearchParams(self.location.search).get('spawntrace') === '1';
  } catch (e) { return false; }
})();
var TRACE_PENDING = Object.create(null);   // pid -> kernel-side stamps
function traceNow() { return performance.timeOrigin + performance.now(); }
// Merge the worker's phase stamps with ours and hand the page one flat
// record; the page merges fragments by pid onto window.__spawnTraces
// (agent probe). Pending entries are kept for the session — trace mode is
// a profiling session, and a fragment can arrive per event (instantiate,
// first output, exit) for one pid.
function traceDone(m) {
  var k = TRACE_PENDING[m.pid] || null;
  post({ type: 'spawn-trace', trace: Object.assign({ pid: m.pid }, k || {}, m.tr) });
}

self.onmessage = function (e) {
  var m = e.data;
  if (!m) return;
  // Two-tab guard (todos/0045): boot-retry must bypass the pending queue —
  // it drives the boot, it can't wait for one.
  if (m.type === 'boot-retry') { startBoot(); return; }
  if (!tty) { pending.push(m); return; }
  if (m.type === 'input') tty.input(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  else if (m.type === 'resize') tty.resize(m.cols | 0, m.rows | 0);
  else if (m.type === 'eof') tty.eof();
  else if (m.type === 'wm-canvas') {
    wmCanvas = m.canvas;
    kernel.wmSetScreen(m.canvas.width, m.canvas.height);
    compositor = OS_COMPOSITOR.startCompositor(kernel, m.canvas, gpuDevice);
  } else if (m.type === 'screen-resize') {
    // Dynamic screen resolution (todos/0023): the page tracks the viewport;
    // the OffscreenCanvas is resized HERE (a transferred canvas can't be
    // resized from the page) and wmSetScreen emits EV_SCREEN + the clamp.
    if (wmCanvas && m.w > 0 && m.h > 0) {
      wmCanvas.width = m.w | 0;
      wmCanvas.height = m.h | 0;
      kernel.wmSetScreen(m.w | 0, m.h | 0);
      if (compositor) compositor.scheduleFrame();   // wake table (todos/0169)
    }
  } else if (m.type === 'wm-input') {
    OS_COMPOSITOR.routeInput(kernel, SDL_WEB, m.ev);
    // Wake table (todos/0169): raw input re-arms the parked rAF even when
    // no kernel state changed — the routed app may only now start drawing.
    if (compositor) compositor.scheduleFrame();
  } else if (m.type === 'drop-file') {
    dropFile(m);
    if (compositor) compositor.scheduleFrame();     // wake table (todos/0169)
  } else if (m.type === 'host-paste-files') {
    // Host file paste (todos/0398): stage + publish the fmt-2 list. The
    // forwarded chord follows on this same FIFO channel and wakes the app.
    hostPasteFiles(m);
  } else if (m.type === 'display-set') {
    displaySet(m.zoom);
  } else if (m.type === 'clipboard') {
    // Host -> gucOS (ticket #79): the page's focus/paste-chord sync read the
    // host clipboard; land it in the kernel slot as fmt 1 (UTF-8 text). An
    // empty read is ignored — never blank a gucOS copy over "host had
    // nothing" (the page filters too; this is the belt to its braces).
    if (typeof m.text === 'string' && m.text) {
      kernel.clipSet(1, new TextEncoder().encode(m.text));
    }
  } else if (m.type === 'clip-read-done') {
    // The page's clip-read refresh settled; any slot update arrived just
    // before this on the same FIFO channel. Wake the parked readers. A
    // done that raced the timeout backstop still stamps freshness — the
    // page really did just read the host clipboard.
    clipReadSettle();
  } else if (m.type === 'compositor-stats') {
    // On-demand-compositor probe (todos/0169): frames/submits/skipped/
    // parks/wakes from the compositor + the kernel's cumulative per-pcb
    // vsync-notify count (the app-worker-wake proof — flat while parked).
    post({ type: 'compositor-stats',
           stats: compositor
             ? Object.assign({ vsyncNotifies: kernel.vsyncNotifyCount() },
                             compositor.stats)
             : null });
  } else if (m.type === 'compositor-freeze') {
    // Synthetic vsync-stop (test-only, todos/0169): the hidden-tab honest
    // pause is not automatable in Playwright — freeze the clock instead
    // and let the test watch every wake counter go flat.
    if (compositor) compositor.setFrozen(!!m.on);
  }
};

// Host-file drop (todos/0067): the page posts each dropped File's name +
// bytes; the kernel writes them under /root/Desktop, where /bin/wm's coarse
// per-second re-read (desk_load) grows an icon with no notify plumbing.
// Direct kernel-side fs write — no process, no fd RPC round-trip. Policy:
// the name is reduced to one sanitized path component, collisions get a
// "-N" suffix before the extension (dropping never overwrites what's
// already there), and payloads over the sanity cap are refused. Feedback
// rides boot-log (the status line + __osLogs — visible on both VTs; the
// tty byte stream stays program-output-clean).
var DROP_DIR = '/root/Desktop';
var DROP_MAX = 128 * 1024 * 1024;   // sanity cap, not a quota
// One path component, sanitized: basename + control-char strip; empty or
// degenerate ('.', '..') collapses to '' — the caller supplies a stand-in.
function sanComp(s) {
  var n = String(s || '').split('/').pop().split('\\').pop()
    .replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (!n || n === '.' || n === '..') ? '' : n;
}
// Collision policy (0067): foo.gb -> foo-1.gb, foo-2.gb, … (lstat, not
// stat — a dangling symlink still owns its name); null after 99.
function uniqName(dir, name) {
  var dot = name.lastIndexOf('.');
  var stem = dot > 0 ? name.slice(0, dot) : name;
  var ext = dot > 0 ? name.slice(dot) : '';
  var final = name;
  for (var i = 1; kfs.lstat(dir + '/' + final) !== null; i++) {
    if (i > 99) return null;
    final = stem + '-' + i + ext;
  }
  return final;
}
// Tree drops (todos/0398): a directory drop's files arrive with a
// tree-relative `rel` — the dropped ROOT is uniquified ONCE per drop
// episode (so a folder never merges into an existing one) and remembered
// here for the episode's remaining files.
var dropEp = { id: -1, roots: null };
function dropFile(m) {
  var note = function (msg) { post({ type: 'boot-log', msg: '[drop] ' + msg }); };
  var bytes = new Uint8Array(m.bytes);
  var comps = String(m.rel || m.name || '').split('/')
    .map(sanComp).filter(function (c) { return c !== ''; });
  if (!comps.length) comps = ['dropped'];
  var name = comps[comps.length - 1];
  if (bytes.length > DROP_MAX) {
    note(name + ': refused (' + bytes.length + ' bytes > ' + DROP_MAX + ' cap)');
    return;
  }
  try {
    kfs.mkdir(DROP_DIR, 0o755);   // self-heal a deleted Desktop (EEXIST is fine)
    var destDir = DROP_DIR;
    if (comps.length > 1) {
      var ep = m.episode | 0;
      if (dropEp.id !== ep) dropEp = { id: ep, roots: {} };
      var root = dropEp.roots[comps[0]];
      if (!root) {
        root = uniqName(DROP_DIR, comps[0]);
        if (!root) { note(comps[0] + ': refused (99 name collisions)'); return; }
        dropEp.roots[comps[0]] = root;
      }
      var dirs = [root].concat(comps.slice(1, -1));
      for (var d = 0; d < dirs.length; d++) {
        destDir += '/' + dirs[d];
        kfs.mkdir(destDir, 0o755);           // EEXIST is fine
      }
      // Inside a freshly-uniquified root the tree's own names can't
      // collide — the leaf writes as-is.
    } else {
      name = uniqName(DROP_DIR, name);
      if (!name) { note(comps[0] + ': refused (99 name collisions)'); return; }
    }
    var path = destDir + '/' + name;
    OS_COMMON.writeFile(kfs, path, bytes, 0o644);
    // Durability (the acceptance's reload-survival): fsync flushes the
    // owning volume's store to OPFS.
    var fd = kfs.open(path, 0, 0);
    if (fd !== null) { kfs.fsync(fd); kfs.close(fd); }
    note(name + ' -> ' + path + ' (' + bytes.length + ' bytes)');
  } catch (e) {
    note(name + ': write failed — ' + String((e && e.message) || e));
  }
}

// Host paste staging (todos/0398 D6): pasted files land in a hidden
// staging dir — WIPED and repopulated per host paste (no collision
// suffixes needed; paste-twice re-pastes the same staged list, copy
// semantics) — and the list is published on the kernel slot as an
// ordinary fmt-2 "copy" file list, so every existing in-OS paste consumer
// (desk_paste, fileman IDM_PASTE, fo_copy's uniquifier) works unchanged.
// Embedder-side clipSet fires no onClipboard (no host echo loop); the
// freshness stamp short-circuits the forwarded chord's clip-read refresh
// (the belt — the page's shadow-text memo is the load-bearing guard).
// Page->worker FIFO lands this BEFORE the forwarded paste chord.
var STAGE_DIR = '/root/.hoststage';
function hostPasteFiles(m) {
  var note = function (msg) { post({ type: 'boot-log', msg: '[paste] ' + msg }); };
  try {
    kfs.mkdir(STAGE_DIR, 0o700);   // EEXIST is fine
    // Wipe: flat by construction — a paste event cannot carry a folder.
    var dh = kfs.opendir(STAGE_DIR);
    if (dh !== null) {
      var old = [];
      for (var ent = kfs.readdir(dh); ent !== null; ent = kfs.readdir(dh))
        if (ent.name !== '.' && ent.name !== '..') old.push(ent.name);
      kfs.closedir(dh);
      for (var i = 0; i < old.length; i++) kfs.unlink(STAGE_DIR + '/' + old[i]);
    }
    var paths = [];
    var files = m.files || [];
    for (var j = 0; j < files.length; j++) {
      var bytes = new Uint8Array(files[j].bytes);
      var name = sanComp(files[j].name) || 'pasted';
      if (bytes.length > DROP_MAX) {
        note(name + ': refused (' + bytes.length + ' bytes > ' + DROP_MAX + ' cap)');
        continue;
      }
      var fin = uniqName(STAGE_DIR, name);   // same-paste dupes only (dir was wiped)
      if (!fin) continue;
      OS_COMMON.writeFile(kfs, STAGE_DIR + '/' + fin, bytes, 0o644);
      paths.push(STAGE_DIR + '/' + fin);
    }
    if (paths.length) {
      kernel.clipSet(2, new TextEncoder().encode('copy\n' + paths.join('\n') + '\n'));
      clipFreshAt = Date.now();
      note(paths.length + ' file(s) staged');
    }
  } catch (e) {
    note('staging failed — ' + String((e && e.message) || e));
  }
}

// Persist the page's zoom control into the display cfgstore — the cfg_set
// delta-write, JS flavor: replace-or-append the ONE `zoom` line in the USER
// layer (duplicates collapse), write a tmp sibling, rename over. Then
// kernel.notifySettled: a direct kfs write bypasses the RPC-level FSW
// choke, so watchers (the displayAnnounce watch above, any process
// FS_WATCH on the path) only see it if the embedder says so — which also
// closes the loop: strip press -> this write -> watch -> display-config
// echo -> page (idempotent). One flow, whoever the writer is.
function displaySet(zoom) {
  if (!/^(auto|[0-9]+(\.[0-9]+)?)$/.test(String(zoom))) return;   // page sends list members only
  var user = '/root/.config/display', tmp = '/root/.config/.display.tmp';
  try {
    kfs.mkdir('/root/.config', 0o755);   // EEXIST is fine
    var text = OS_COMMON.readFileText(kfs, user);
    var out = [], replaced = false;
    (text === null ? [] : text.split('\n')).forEach(function (line) {
      if (/^zoom[ \t]/i.test(line)) {
        if (!replaced) { out.push('zoom\t' + zoom); replaced = true; }
      } else if (line.length) out.push(line);
    });
    if (!replaced) out.push('zoom\t' + zoom);
    OS_COMMON.writeFile(kfs, tmp, out.join('\n') + '\n', 0o644);
    if (kfs.rename(tmp, user) === null)
      throw new Error(kfs._lastError || 'EIO');
    kernel.notifySettled(user);
  } catch (e) {
    post({ type: 'boot-log', msg: '[display] zoom persist failed: ' + String((e && e.message) || e) });
  }
}

function createWorker(procSpec) {
  var k0 = SPAWN_TRACE ? traceNow() : 0;   // spawn trace (#350): before ctor
  var w = new Worker('process-worker.js');
  var k1 = SPAWN_TRACE ? traceNow() : 0;   // ctor returned (async spin-up!)
  var exitCb = null;
  w.postMessage({
    type: 'boot',
    spawnTrace: SPAWN_TRACE,
    pid: procSpec.pid, ppid: procSpec.ppid, pgid: procSpec.pgid,
    path: procSpec.path, argv: procSpec.argv, envp: procSpec.envp,
    cwd: procSpec.cwd, actions: procSpec.actions, flags: procSpec.flags,
    image: procSpec.image,
    module: procSpec.module || null,   // pre-compiled Module (todos/0037)
    kernelPage: procSpec.kernelPage,
    ttySab: procSpec.ttySab || null,
    brokered: !!procSpec.brokered,
    // Read-only volume (todos/0180): { prefix, sab } — the SAB shares.
    ro: procSpec.ro || null,
    // SPSC pipe rings (todos/0181): [{fd, end, sab}] — the SABs share.
    pipeRings: procSpec.pipeRings || null,
  });
  if (SPAWN_TRACE) {
    TRACE_PENDING[procSpec.pid] = {
      path: procSpec.path,
      argv0: (procSpec.argv && procSpec.argv[0]) || '',
      hadModule: !!procSpec.module,
      k0: k0,               // kernel thread: before new Worker
      k1: k1,               // kernel thread: ctor returned
      k2: traceNow(),       // kernel thread: boot message posted
    };
  }
  return {
    postMessage: function (m) { w.postMessage(m); },
    onMessage: function (fn) {
      w.onmessage = function (ev) {
        var d = ev.data;
        // Spawn trace (#350): consume the trace record here — it must not
        // reach kernel.js's process-message handler.
        if (SPAWN_TRACE && d && d.type === 'spawn-trace') { traceDone(d); return; }
        fn(d);
      };
    },
    // Browsers have no worker 'exit' event; an uncaught error in the worker
    // is the observable equivalent of silent death (kernel treats it as
    // termsig SIGSEGV when no 'exited'/'crashed' message preceded it).
    onExit: function (fn) { exitCb = fn; w.onerror = function () { if (exitCb) exitCb(); }; },
    terminate: function () { w.terminate(); },
  };
}

// Two-tab boot guard (todos/0045): two tabs would run two KERNELS — two
// process tables, two compositors, two fd brokers — over the same OPFS
// images; BlockFS's dual-instance coherence does not cover that. A Web Lock
// named after the image pair (so unrelated dev pages on this origin never
// collide) is taken BEFORE any OPFS mount and held for the worker's
// lifetime — the browser releases it when the tab closes, including crashes.
// ifAvailable keeps it non-blocking: the losing tab gets {type:'boot-locked'}
// with NOTHING mounted, and the page offers retry (no steal in v1). The
// winning callback parks on a forever-pending promise — the Web Locks idiom
// for "hold until the agent dies".
var SYS_IMG = 'os-system.v5.img';
var ROOT_IMG = 'os-root.v5.img';
var BOOT_LOCK = 'gucos:' + SYS_IMG + '+' + ROOT_IMG;
function acquireBootLock() {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve(true);   // no Web Locks API — boot unguarded
  }
  return new Promise(function (resolve) {
    navigator.locks.request(BOOT_LOCK, { ifAvailable: true }, function (lock) {
      resolve(!!lock);
      if (lock) return new Promise(function () {});   // hold forever
    }).catch(function () { resolve(false); });
  });
}

// WebGPU boot guard (todos/0055): the compositor IS WebGPU — no Canvas2D
// fallback (a fallback is two compositors, one a permanently undertested
// zombie; decision log logs/2026-07-09/webgpu-mvu-direction.md). Probe the
// full adapter->device chain HERE, before anything mounts, so a browser
// without worker WebGPU gets a LOUD guard screen instead of a desktop that
// quietly degraded. Terminal like boot-error: retry can't conjure a GPU.
async function probeGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    var adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch (e) { return null; }
}

// Open (creating if absent) a raw OPFS-backed byte store.
async function opfsStore(name) {
  var root = await navigator.storage.getDirectory();
  var fh = await root.getFileHandle(name, { create: true });
  var h = await fh.createSyncAccessHandle();
  return new BLOCK_FS.SyncAccessHandleStore(h);
}

// Copy a fetched blob into an OPFS store, superblock LAST: a crash mid-copy
// leaves no magic, so the next boot sees "stale" and re-materializes.
function materializeBlob(store, bytes) {
  store.resize(0);
  if (bytes.length > 256) store.setBytes(256, bytes.subarray(256));
  store.setBytes(0, bytes.subarray(0, Math.min(256, bytes.length)));
  store.flush();
}

async function boot() {
  gpuDevice = await probeGPU();
  if (!gpuDevice) {                // todos/0055: terminal — no lock taken,
    post({ type: 'boot-nogpu' });  // nothing mounted, `booting` stays set
    return;
  }
  if (!(await acquireBootLock())) {
    booting = false;               // let a boot-retry re-enter
    post({ type: 'boot-locked' });
    return;
  }
  post({ type: 'boot-log', msg: 'mounting BlockFS on OPFS…' });
  var manifest = await (await fetch('image.json')).json();
  var seedIo = {
    readAsset: function (name) {
      return fetch(name).then(function (r) {
        if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
        return r.text();
      });
    },
    // bin entries (game data: doom1.wad, ROMs) are repo-relative binaries;
    // seedEntries' chain awaits the promise.
    readBinary: function (p) {
      return fetch('../' + p).then(function (r) {
        if (!r.ok) throw new Error(p + ': HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) { return new Uint8Array(ab); });
    },
    // project entries build repo-relative bin.json trees; the compiler
    // needs a SYNCHRONOUS file reader, so use sync XHR — legal in a
    // worker, and baking is a one-off (cached in the blob afterwards).
    buildProject: function (proj) {
      // Memoize reads INCLUDING misses: include resolution probes several
      // directories per #include across ~40 TUs, which is ~18k lookups for
      // the hush build but only a few hundred distinct paths — uncached,
      // each one is a BLOCKING localhost round trip and first boot spends
      // ~7s in XHR instead of ~1.5s compiling. Safe because the tree can't
      // change mid-bake.
      var xhrCache = new Map();
      return OS_COMMON.buildProject(CompilerJS, proj, function (p) {
        if (xhrCache.has(p)) {
          var hit = xhrCache.get(p);
          if (hit === null) throw new Error(p + ': HTTP 404 (cached)');
          return hit;
        }
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '../' + p, false /* synchronous */);
        xhr.send(null);
        if (xhr.status !== 200) {
          xhrCache.set(p, null);
          throw new Error(p + ': HTTP ' + xhr.status);
        }
        xhrCache.set(p, xhr.responseText);
        return xhr.responseText;
      });
    },
    log: function (m) { post({ type: 'boot-log', msg: m }); },
  };

  // The system blob (todos/0040): a sealed, read-only BlockFS image mounted
  // at /usr. Materialize when the OPFS copy is missing or version-stale
  // ("upgrade = swap the blob"): prefer a prebaked os/os-system.img served
  // beside the page (tools/mkimage.js output — zero compilation on the boot
  // path), else bake in-worker (the no-build-step dev path). New OPFS names
  // orphan the pre-flip os-system.v4.img/os-user.v4.img pair by design
  // (the 0026 precedent).
  var sysStore = await opfsStore(SYS_IMG);
  var sysMode = 'reused';
  if (OS_COMMON.bakedVersion(BLOCK_FS, sysStore) < (manifest.version | 0)) {
    sysMode = null;
    try {
      // manifest.image (todos/0249): a DEPLOY may publish the blob under a
      // content-hashed name (os-system.<sha>.img, immutable cache headers)
      // and names it here via its transformed image.json. The repo manifest
      // carries no `image` field, so every dev/test path (serve.js overlay
      // swaps, boot.js, the fixtures) keeps fetching the fixed name.
      var r = await fetch(manifest.image || 'os-system.img');
      if (r.ok) {
        var blob = new Uint8Array(await r.arrayBuffer());
        var memStore = new BLOCK_FS.MemoryByteStore(blob.length);
        memStore.setBytes(0, blob);
        if (OS_COMMON.bakedVersion(BLOCK_FS, memStore) >= (manifest.version | 0)) {
          post({ type: 'boot-log', msg: 'installing prebaked system image (v' +
            OS_COMMON.bakedVersion(BLOCK_FS, memStore) + ')…' });
          materializeBlob(sysStore, blob);
          sysMode = 'fetched';
        }
      }
    } catch (e) { /* no prebaked blob served — fall through to the bake */ }
    if (!sysMode) {
      await OS_COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, sysStore, manifest, seedIo);
      sysMode = 'baked';
    }
  }
  var sysFs = BLOCK_FS.createV4(sysStore, { readonly: true });
  // Process-side read-only /usr (todos/0180): ONE SAB copy of the sealed
  // system image, shipped to every process worker at spawn — /usr reads
  // (fonts, configs, assets) stop crossing the RPC boundary.
  var roSab = BLOCK_FS.storeToSab(sysStore);

  // The root (writable) volume owns '/' — /etc, /var, /tmp, /root, /dev,
  // /run. Seeded (skeleton + the manifest's `user` section) exactly once,
  // when freshly created; upgrades never write here. (Explicit v3Name so a
  // standalone page's legacy workspace.img on the same origin is never
  // "migrated" into an OS volume — that file has never existed, so the
  // legacy path is inert.)
  var wsRoot = await BLOCK_FS.openWorkspace({ v4Name: ROOT_IMG, v3Name: 'os-root.v3.img' });
  // /proc (todos/0043): a synthetic kernel-rendered volume — the Kernel
  // constructor binds itself to it via the mount table. (Worker-global:
  // the drop-file handler writes through it — todos/0067.)
  kfs = new BLOCK_FS.MountFS({ '/': wsRoot.fs, '/usr': sysFs, '/proc': new KERNEL.ProcFS() });
  if (wsRoot.mode === 'fresh') {
    post({ type: 'boot-log', msg: 'seeding user volume (manifest v' + manifest.version + ')…' });
    OS_COMMON.initRootVolume(kfs);
    await OS_COMMON.seedEntries(kfs, manifest.user, seedIo);
    // Baked packages' `seed` content (gucman content-resource design §3.5):
    // planted from the SEALED BLOB — deliberately NOT from `manifest`, which
    // here is the RAW fetched image.json (no fold ever runs in the browser),
    // so a manifest-side design would silently no-op exactly here.
    var nseed = OS_COMMON.seedBakedSeeds(kfs, function (m) {
      post({ type: 'boot-log', msg: m });
    });
    if (nseed) post({ type: 'boot-log', msg: 'seeded ' + nseed + ' file(s) from baked packages' });
    // Host keyboard-scheme auto-detect (META-ARROW-KEYBIND.md decision 4):
    // a Mac host defaults to the macos scheme (admin layer; user config wins).
    if (OS_COMMON.seedHostKeyScheme(kfs, HOST_PLATFORM))
      post({ type: 'boot-log', msg: 'host keyboard scheme -> macos (Mac host default)' });
  }
  var ccCompile = OS_COMMON.createCcDriver(CompilerJS, kfs);

  // Kernel text service (todos/0275): the ksvc blob from the sealed system
  // image, instantiated synchronously in THIS worker. A throw here is a
  // boot-error (boot()'s catch) — no zombie Canvas2D fallback exists, so a
  // boot that can't render chrome text must not reach the desktop.
  var textService = OS_KSVC.load(kfs, {
    log: function (m) { post({ type: 'boot-log', msg: m }); },
  });

  // The switchable HTTP fetch (ticket #349, NETWORK.md Tier 2.5): OFF —
  // the cfgstore default — is the bound global fetch, byte-identical to
  // passing nothing; ON reroutes transfers through the user-run localhost
  // bridge. Attached to the store layers right after construction, below.
  var netFetch = OS_COMMON.createNetFetch();

  kernel = new KERNEL.Kernel({
    fs: kfs,
    fetch: netFetch,   // #349 — the Tier 2.5 net-bridge wrapper
    textService: textService,   // todos/0275 — compositor + headless text
    roImage: { prefix: '/usr', sab: roSab },   // todos/0180
    vsync: true,   // the compositor rAF calls vsyncTick() (todos/0100)
    createWorker: createWorker,
    loadImage: function (p) { return OS_COMMON.readFileBytes(kfs, p); },
    compile: ccCompile,
    onOutput: function (pid, fd, bytes) { post({ type: 'out', bytes: bytes }); },
    onHalt: function (status) { post({ type: 'halt', status: status }); },
    onPointerLock: function (wanted) { post({ type: 'pointer-lock', wanted: wanted }); },
    onCursor: function (shape) { post({ type: 'cursor', shape: shape }); },
    onAudioStream: function () { audioArm(); },   // pump gate, below
    // gucOS -> host clipboard (ticket #79): a process committed a copy.
    // Only fmt 1 (UTF-8 text) crosses to the host — fmt 2 file lists carry
    // OS-absolute paths that mean nothing outside, and clears never blank
    // the HOST clipboard (an OS-side EmptyClipboard is not host intent).
    onClipboard: function (clip) {
      if (!clip || clip.fmt !== 1) return;
      post({ type: 'clipboard', text: new TextDecoder().decode(clip.bytes) });
    },
    // Deferred CLIP_GET (the clipboard seam): the kernel parked a paste
    // consumer; ask the page to refresh the slot from the host clipboard
    // inside the still-live activation of the gesture that triggered the
    // paste. One page round-trip serves every done that joins while it is
    // in flight, and a completed refresh stays fresh for CLIP_FRESH_MS —
    // SDL_GetClipboardText's size-then-read pair costs ONE round-trip.
    // The timeout backstop keeps the always-done contract even if the
    // page never answers (dead page, wedged permission UI).
    onClipRead: function (done) {
      if (Date.now() - clipFreshAt < CLIP_FRESH_MS) { done(); return; }
      clipReadPending.push(done);
      if (clipReadPending.length > 1) return;   // round-trip already in flight
      post({ type: 'clip-read' });
      clipReadTimer = setTimeout(clipReadSettle, CLIP_READ_TIMEOUT_MS);
    },
    // Egress (todos/0398): the kernel materialized ONE artifact; hand it to
    // the page, buffer TRANSFERRED (up to EGRESS_MAX — never structured-
    // cloned). The page acts inside the still-live transient activation of
    // the menu click that started the chain: anchor download, or the
    // Save-As picker for the 'saveas' disposition.
    onEgress: function (dispo, name, bytes) {
      // The view is normally the whole buffer (the materializer allocates
      // exactly); slice defensively if not, then TRANSFER — an artifact can
      // be EGRESS_MAX-sized and must never be structured-cloned.
      var buf = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
        ? bytes.buffer : bytes.slice().buffer;
      self.postMessage({ type: 'egress', dispo: dispo, name: name, bytes: buf }, [buf]);
    },
    log: function (m) { post({ type: 'boot-log', msg: '[kernel] ' + m }); },
  });
  tty = kernel.createTty({
    output: function (b) { post({ type: 'out', bytes: b instanceof Uint8Array ? b.slice() : Uint8Array.from(b) }); },
    interactiveOut: true,   // xterm IS a human terminal: shells go interactive
  });

  // The display-density bridge (hires-display): the page's VT2 zoom factor
  // is an OS SETTING now — cfgstore `display`, key `zoom` (auto | 0.5 |
  // 0.75 | 1 | 2 | 3), written by the Control Panel Display applet
  // (os/display.h) and by the page's −/+ quick control (the display-set
  // message below). This worker resolves the three-layer per-key overlay
  // (user > admin > baked — the cfg_load3 rule, JS flavor) and posts the
  // effective value to the page: once here (BEFORE 'ready', so the page
  // applies it ahead of the VT2 auto-switch — no boot flash), and again on
  // every settled write to a layer (kernel.watchPath rides the FSW choke,
  // which is what makes an applet radio click reflow the desktop live).
  displayAnnounce = function () {
    var layers = ['/root/.config/display', '/etc/display', '/usr/share/display'];
    var v = null;
    for (var i = 0; i < layers.length && v === null; i++) {
      var text = OS_COMMON.readFileText(kfs, layers[i]);
      if (text === null) continue;
      var lines = text.split('\n');
      for (var j = 0; j < lines.length; j++) {
        var m2 = /^zoom[ \t]+(\S+)/i.exec(lines[j]);   // '#' comments can't match
        if (m2) { v = m2[1].toLowerCase(); break; }
      }
    }
    // zoom: null = no key in any layer (the page keeps its own default),
    // 'auto' = explicit automatic, else the numeric factor.
    post({ type: 'display-config',
           zoom: v === null || v === 'auto' ? v : parseFloat(v) });
  };
  ['/root/.config/display', '/etc/display', '/usr/share/display']
    .forEach(function (p) { kernel.watchPath(p, displayAnnounce); });
  displayAnnounce();

  // The net-bridge toggle rides the same watchPath choke (ticket #349):
  // a settled write to any `net` store layer — the Network applet's
  // checkbox, an /etc/net edit — retargets the NEXT transfer, no reboot.
  OS_COMMON.netFetchAttach(netFetch, kernel, kfs);

  // The WM control plane (todos/0014): the kernel-owned endpoint first, then
  // /bin/wm as a kernel service after pid 1. Failure is non-fatal by design —
  // kernel-chrome is the fallback policy; `wm &` respawns it from the shell.
  kernel.wmServe();

  // The audio mixer (todos/0017): one page-owned output ring, kernel-side
  // mixing on a 20ms pump. The page plays it with host.js's
  // createAudioReceiver (resumed on first user gesture — autoplay policy).
  // The pump is gated on live streams (IDLE-POWER audioPump gate): parked
  // while the stream table is empty, armed by the AUDIO_OPEN hook, and it
  // disarms itself after a pump that observes an empty table — dying
  // streams drain first, and pause/resume is SAB-only, so any table entry
  // keeps it armed (an unpause is otherwise invisible to the kernel).
  var audioOut = kernel.audioInit({});
  post({ type: 'audio', sab: audioOut.sab, bufferSize: audioOut.bufferSize,
         freq: audioOut.freq, channels: audioOut.channels, format: audioOut.format });
  var audioTimer = null;
  function audioArm() {
    if (audioTimer !== null) return;
    audioTimer = setInterval(function () {
      kernel.audioPump();
      if (kernel.audioStreamCount() === 0) { clearInterval(audioTimer); audioTimer = null; }
    }, 20);
  }
  await kernel.boot({
    path: '/bin/sh',
    // "-sh": login shell — sources /etc/profile then ~/.profile (todos/0174)
    argv: ['-sh'],
    envp: ['PATH=/usr/local/bin:/bin', 'HOME=/root', 'TERM=xterm-256color'],
    cwd: '/root',
  });
  await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/usr/local/bin:/bin'] });
  post({ type: 'ready', mode: sysMode + '/' + wsRoot.mode });

  var queued = pending; pending = [];
  queued.forEach(function (m) { self.onmessage({ data: m }); });
}

// Boot entry — also the boot-retry target (todos/0045). `booting` blocks
// double entry (retry clicks while a boot is in flight or after one won);
// only the lock-lost path resets it. A real boot failure stays terminal
// (reload to reboot), as before.
var booting = false;
// Failure text for the boot-error panel. This used to be `e.stack` alone,
// which silently DROPS the message on WebKit: V8 renders stack as
// "Error: <message>\n  at …", but JavaScriptCore's stack is the bare frame
// list. So a real iOS boot failure printed frames only — and the message is
// where the two facts that matter live (WHICH file, WHICH status; see the
// `p + ': HTTP ' + xhr.status` throw in buildProject above), leaving them to
// be reconstructed from line numbers. Lead with the message and append the
// stack only when the engine hasn't already folded it in, so both engines
// render the same thing once and neither duplicates it.
function errText(e) {
  if (!e || typeof e.message !== 'string') return String(e);
  var head = (e.name || 'Error') + ': ' + e.message;
  var stack = e.stack ? String(e.stack) : '';
  if (!stack) return head;
  return stack.indexOf(e.message) >= 0 ? stack : head + '\n' + stack;
}
function startBoot() {
  if (booting || tty) return;
  booting = true;
  boot().catch(function (e) {
    post({ type: 'boot-error', msg: errText(e) });
  });
}
startBoot();
