// os-common.js — logic shared by the OS boot paths (todos/0004) and the
// image baker (todos/0040): os/kernel-worker.js (browser, OPFS store),
// os/boot.js (headless Node, file store) and tools/mkimage.js (offline
// bake). Environment-neutral: plain script, exports via module.exports
// under Node and self.OS_COMMON under a worker (host.js discipline).
//
// Responsibilities:
//   createCcDriver(CompilerJS, kfs)  — the kernel's compile hook: a cc-style
//     argv driver over the compiler library, reading sources from and writing
//     wasm to the kernel's BlockFS. Backs /bin/cc (the __compile RPC).
//   bakeSystemImage(...)             — bake the read-only system volume from
//     os/image.json's `system` section (todos/0040): compiled sources,
//     vendor builds, /usr/local -> /var/local, /usr/share/os-release with
//     the manifest version, then seal. Runs offline (mkimage), or as the
//     boot-time fallback when no current blob exists.
//   seedEntries(kfs, section, io)    — populate paths from a manifest
//     section (dirs + files). Used by the bake (system section, full
//     namespace) and by the virgin-boot user seed (user section).
//   initRootVolume(mfs)              — skeleton for a fresh writable root
//     volume: /etc /var/local/bin /tmp /root /run + /bin -> /usr/bin.
//   bakedVersion(BLOCK_FS, store)    — a blob's VERSION_ID (or -1): the
//     staleness gate for "upgrade = swap the blob".
//   newestBakeInput(...)             — the 0082 input-freshness scan: newest
//     mtime across everything that can change the blob's bytes (toolchain,
//     os/ tree, the manifest's vendor project/bin closure). Node-only.

'use strict';

/* ---- tiny BlockFS conveniences (JS-side, kernel instance) ---- */

var O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;

function readFileBytes(kfs, path) {
  var fd = kfs.open(path, 0 /* O_RDONLY */, 0);
  if (fd === null) return null;
  var st = kfs.fstat(fd);
  if (!st) { kfs.close(fd); return null; }
  var buf = new Uint8Array(st.size);
  var off = 0;
  while (off < buf.length) {
    var n = kfs.read(fd, buf.subarray(off), buf.length - off);
    if (n === null || n === 0) break;
    off += n;
  }
  kfs.close(fd);
  return buf.subarray(0, off);
}

function readFileText(kfs, path) {
  var b = readFileBytes(kfs, path);
  return b === null ? null : new TextDecoder('utf-8').decode(b);
}

function writeFile(kfs, path, data, mode) {
  var bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  var fd = kfs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode === undefined ? 0o644 : mode);
  if (fd === null) throw new Error('writeFile ' + path + ': ' + (kfs._lastError || 'EIO'));
  var off = 0;
  while (off < bytes.length) {
    var n = kfs.write(fd, bytes.subarray(off), bytes.length - off);
    if (n === null) { kfs.close(fd); throw new Error('writeFile ' + path + ': ' + (kfs._lastError || 'EIO')); }
    off += n;
  }
  kfs.close(fd);
}

/* ---- the compile hook: a cc-style driver over the compiler library ----
 *
 * Returns compile(argv, cwd) -> {exitCode, stdout, stderr} — exactly the
 * kernel's opts.compile contract (the __compile RPC behind /bin/cc). Flag
 * surface is the useful subset of the CLI: -o, -I, -D, -g; unknown dash
 * options are ignored (CLI parity). Default output is ./a.out — spawnable
 * directly, since every binary here is a wasm module.
 */
function createCcDriver(CompilerJS, kfs) {
  return function compile(argv, cwd) {
    var err = '';
    var writeErr = function (s) { err += s; };
    var abs = function (p) {
      if (typeof p !== 'string' || !p.length) return p;
      return p.charCodeAt(0) === 47 ? p : (cwd === '/' ? '' : cwd) + '/' + p;
    };

    var pp = CompilerJS.createDefaultPPRegistry();
    pp.fileReader = function (filePath) { return readFileText(kfs, abs(filePath)); };

    var outputFile = 'a.out';
    var sources = [];
    var compilerOptions = { requireSources: [], backend: 'default' };
    var warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: true };
    for (var i = 1; i < argv.length; i++) {
      var a = argv[i];
      if (a === '-o') { outputFile = argv[++i]; }
      else if (a.lastIndexOf('-I', 0) === 0) { pp.includePaths.push(abs(a.substring(2))); }
      else if (a.lastIndexOf('-D', 0) === 0) {
        var def = a.substring(2), eq = def.indexOf('=');
        if (eq >= 0) pp.defines.set(def.substring(0, eq), def.substring(eq + 1));
        else pp.defines.set(def, '1');
      }
      else if (a === '-g' || a === '-g1') { compilerOptions.emitNames = true; }
      else if (a.charCodeAt(0) === 45) { /* ignore unknown options, like the CLI */ }
      else sources.push(abs(a));
    }
    if (!sources.length) {
      return { exitCode: 1, stdout: '', stderr: 'usage: cc [-o out] [-Ipath] [-Dname[=val]] file.c...\n' };
    }

    // parseAllUnits reads the top-level sources through its `fs` parameter
    // (includes go through pp.fileReader); give it the BlockFS-backed shim.
    var fsShim = {
      readFileSync: function (p) {
        var t = readFileText(kfs, p);
        if (t === null) throw new Error('cc: ' + p + ': No such file');
        return t;
      },
    };
    try {
      var units = CompilerJS.parseAllUnits(fsShim, pp, sources, {
        warningFlags: warningFlags, compilerOptions: compilerOptions, writeErr: writeErr,
      });
      var linkResult = CompilerJS.linkTranslationUnits(units, compilerOptions);
      if (linkResult.errors.length > 0) {
        for (var li = 0; li < linkResult.errors.length; li++) {
          var le = linkResult.errors[li];
          writeErr('Link error: ' + le.message + '\n');
          if (le.locations) le.locations.forEach(function (loc) {
            if (loc && loc.filename) writeErr('  at ' + loc.filename + ':' + loc.line + '\n');
          });
        }
        return { exitCode: 1, stdout: '', stderr: err };
      }
      var wasm = CompilerJS.generateCode(units, outputFile, {
        compilerOptions: compilerOptions,
        warningFlags: warningFlags,
        writeErr: writeErr,
        fatalExit: function (code) { var e = new Error('fatal'); e.__ccExit = code | 0; throw e; },
      });
      writeFile(kfs, abs(outputFile), wasm, 0o755);
      return { exitCode: 0, stdout: '', stderr: err };
    } catch (e) {
      var code = (e && e.__ccExit !== undefined) ? e.__ccExit : 1;
      // Diagnostics already flowed through writeErr; add the message only if
      // nothing did (unexpected throw).
      if (!err) err = 'cc: ' + ((e && e.message) || String(e)) + '\n';
      return { exitCode: code, stdout: '', stderr: err };
    }
  };
}

/* ---- building a vendored bin.json project at seed time ----
 *
 * The manifest's `project` entries (busybox hush) are multi-file builds of
 * repo-relative bin.json projects, compiled by the CompilerJS library over
 * a synchronous host-file reader: fs.readFileSync under Node, synchronous
 * XHR in the kernel worker (legal in workers, and seeding is a boot-time
 * one-off). Returns the wasm bytes.
 */
function buildProject(CompilerJS, projPath, readHostFile) {
  var err = '';
  var writeErr = function (s) { err += s; };

  var pp = CompilerJS.createDefaultPPRegistry();
  var sources = [];
  var compilerOptions = { requireSources: [], backend: 'default' };
  /* Normalize "a/b/../c" -> "a/c" so dep-relative paths stay readable in
   * errors and stable as XHR URLs. */
  function normalize(p) {
    var parts = p.split('/'), out = [];
    parts.forEach(function (seg) {
      if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
      else if (seg !== '.') out.push(seg);
    });
    return out.join('/');
  }
  /* Expand a bin.json, depth-first over its deps (type "lib" projects —
   * e.g. the busybox applets all dep on vendor/busybox/libbb-core.json). */
  (function expand(p) {
    var dir = p.slice(0, p.lastIndexOf('/'));
    var proj = JSON.parse(readHostFile(p));
    (proj.deps || []).forEach(function (d) { expand(normalize(dir + '/' + d)); });
    (proj.includes || []).forEach(function (inc) { pp.includePaths.push(normalize(dir + '/' + inc)); });
    (proj.compilerArgs || []).forEach(function (a) {
      if (a.lastIndexOf('-D', 0) === 0) {
        var def = a.substring(2), eq = def.indexOf('=');
        if (eq >= 0) pp.defines.set(def.substring(0, eq), def.substring(eq + 1));
        else pp.defines.set(def, '1');
      } else if (a.lastIndexOf('-I', 0) === 0) {
        pp.includePaths.push(normalize(dir + '/' + a.substring(2)));
      } else if (a === '--allow-old-c') {
        // Same expansion as the cc driver's flag (quake's 1996 C).
        compilerOptions.allowImplicitInt = true;
        compilerOptions.allowEmptyParams = true;
        compilerOptions.allowKnRDefinitions = true;
        compilerOptions.allowImplicitFunctionDecl = true;
      } else if (a === '--gc-spill-locals') {
        // Same as the CLI flag (micropython's precise-GC root scanning).
        compilerOptions.gcSpillLocals = true;
      } else if (a === '--allow-zero-length-arrays') {
        // Same as the CLI flag (sameboy's GB_SECTION end markers).
        compilerOptions.allowZeroLengthArrays = true;
      } else {
        throw new Error('buildProject ' + projPath + ': unsupported compilerArg ' + a);
      }
    });
    (proj.sources || []).forEach(function (s) { sources.push(normalize(dir + '/' + s)); });
  })(projPath);
  pp.fileReader = function (fp) {
    try { return readHostFile(fp); } catch (e) { return null; }
  };
  var fsShim = { readFileSync: function (p) { return readHostFile(p); } };
  var warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: true };
  var units;
  try {
    units = CompilerJS.parseAllUnits(fsShim, pp, sources, {
      warningFlags: warningFlags, compilerOptions: compilerOptions, writeErr: writeErr,
    });
  } catch (e) {
    throw new Error('buildProject ' + projPath + ' failed:\n' + (err || e.message));
  }
  var linkResult = CompilerJS.linkTranslationUnits(units, compilerOptions);
  if (linkResult.errors.length > 0) {
    linkResult.errors.forEach(function (e) { writeErr('Link error: ' + e.message + '\n'); });
    throw new Error('buildProject ' + projPath + ' failed:\n' + err);
  }
  return CompilerJS.generateCode(units, 'a.wasm', {
    compilerOptions: compilerOptions,
    warningFlags: warningFlags,
    writeErr: writeErr,
    fatalExit: function (code) { throw new Error('buildProject ' + projPath + ' fatal (' + code + '):\n' + err); },
  });
}

/* ---- manifest-section seeding ----
 *
 * section (os/image.json `system` or `user`): { dirs: [...], files: { "/path": entry } }
 *   entry.c       — asset name of a C source; compiled to a wasm binary at /path
 *   entry.hdrs    — (with entry.c) asset names of local headers the source
 *                   quotes-includes; staged beside it for the compile
 *   entry.text    — asset name of a raw text file; copied verbatim to /path
 *   entry.content — inline string; written verbatim to /path (one-liners
 *                   like the /usr/share/menu command entries, todos/0028)
 *   entry.bin     — REPO-relative binary file; copied verbatim to /path
 *                   (game data: doom1.wad, gameboy ROMs — needs io.readBinary)
 *   entry.optional — (with entry.bin) a missing asset logs a skip instead of
 *                   failing the boot: for assets that are deliberately NOT
 *                   in the repo (the gameboy ROMs are gitignored), so other
 *                   checkouts still boot — minus that file
 *   entry.project — REPO-relative bin.json path; multi-file build via
 *                   buildProject (needs io.buildProject)
 *   entry.link    — symlink target; /path becomes a symlink to it (the
 *                   coreutils applet names all point at /usr/bin/coreutils)
 * io: { readAsset(name) -> Promise<string>, compile(argv, cwd), log(msg),
 *       buildProject(projPath) -> wasm bytes,
 *       readBinary(repoPath) -> Uint8Array | Promise<Uint8Array> }
 *   (readAsset is fetch() in the browser, fs.readFile under Node — both
 *   relative to the os/ directory; readBinary is repo-relative like
 *   project entries.)
 *
 * No version gate here (todos/0040): the system section is baked into the
 * sealed blob (whose /usr/share/os-release carries the version — the
 * staleness check happens BEFORE the bake), and the user section seeds
 * exactly once, onto a freshly formatted root volume. The old
 * /etc/.image-version re-seed dance is gone — upgrades never rewrite user
 * territory.
 */
function seedEntries(kfs, section, io) {
  if (!section) return Promise.resolve(false);
  var log = io.log || function () {};
  (section.dirs || []).forEach(function (d) {
    if (kfs.stat(d) === null) kfs.mkdir(d, 0o755);
  });
  var names = Object.keys(section.files || {});
  var chain = Promise.resolve();
  names.forEach(function (path) {
    var entry = section.files[path];
    chain = chain.then(function () {
      if (entry.text !== undefined) {
        return Promise.resolve(io.readAsset(entry.text)).then(function (text) {
          writeFile(kfs, path, text, entry.mode);
          log('  ' + path + ' (from ' + entry.text + ')');
        });
      }
      if (entry.content !== undefined) {
        writeFile(kfs, path, entry.content, entry.mode);
        log('  ' + path + ' (inline, ' + entry.content.length + ' bytes)');
        return undefined;
      }
      if (entry.bin !== undefined) {
        // Wrap the call itself so a synchronous throw (Node's readFileSync
        // ENOENT) lands in the same rejection path as an async fetch 404.
        return Promise.resolve().then(function () {
          return io.readBinary(entry.bin);
        }).then(function (bytes) {
          writeFile(kfs, path, bytes, entry.mode);
          log('  ' + path + ' (binary ' + entry.bin + ', ' + bytes.length + ' bytes)');
        }, function (e) {
          if (!entry.optional) throw e;
          log('  ' + path + ' SKIPPED (optional; ' + ((e && e.message) || e) + ')');
        });
      }
      if (entry.project !== undefined) {
        var wasm = io.buildProject(entry.project);
        writeFile(kfs, path, wasm, 0o755);
        log('  ' + path + ' (built ' + entry.project + ', ' + wasm.length + ' bytes)');
        return undefined;
      }
      if (entry.link !== undefined) {
        if (kfs.lstat(path) !== null) kfs.unlink(path);   // re-seed overwrites
        kfs.symlink(entry.link, path);
        log('  ' + path + ' -> ' + entry.link);
        return undefined;
      }
      if (entry.c !== undefined) {
        var assets = [entry.c].concat(entry.hdrs || []);
        return Promise.all(assets.map(function (a) {
          return Promise.resolve(io.readAsset(a));
        })).then(function (srcs) {
          // Stage the source in the image, compile it there, clean up. The
          // compiler (and its diagnostics) see real image paths. Local
          // headers stage under their own names beside the source (quoted
          // includes resolve relative to the including file's directory).
          var staged = '/etc/.seed-' + entry.c.replace(/[^A-Za-z0-9._-]/g, '_');
          writeFile(kfs, staged, srcs[0]);
          var hdrPaths = (entry.hdrs || []).map(function (hname, i) {
            var hp = '/etc/' + hname.replace(/[^A-Za-z0-9._-]/g, '_');
            writeFile(kfs, hp, srcs[i + 1]);
            return hp;
          });
          var r = io.compile(['cc', staged, '-o', path], '/');
          kfs.unlink(staged);
          hdrPaths.forEach(function (hp) { kfs.unlink(hp); });
          if (r.exitCode !== 0) {
            throw new Error('seeding ' + path + ' from ' + entry.c + ' failed:\n' + r.stderr);
          }
          log('  ' + path + ' (compiled ' + entry.c + ')');
        });
      }
      throw new Error('image.json: ' + path + ': entry needs "c", "text", "content", "bin", "project" or "link"');
    });
  });
  return chain.then(function () {
    kfs.flush && kfs.flush();
    return true;
  });
}

/* ---- baking the read-only system image (todos/0040) ----
 *
 * Bakes manifest.system into sysStore as a sealed, independently mountable
 * BlockFS v4 blob whose root is the /usr subtree (bin/, share/, local).
 * The bake replays the runtime mount layout — a throwaway in-memory root
 * volume at '/', the target volume at '/usr' — so manifest paths, symlink
 * targets, and cc diagnostics are all full-namespace, and the compile
 * staging area (/etc) lands on the throwaway volume. Ends by planting
 * /usr/local -> /var/local (the admin's escape into writable territory)
 * and /usr/share/os-release (VERSION_ID=<manifest.version> — the blob's
 * own version, read back by bakedVersion), then seals the store
 * (superblock hash — fsck_v4 flags any post-bake mutation).
 *
 * sysStore must not hold a live filesystem worth keeping: the superblock
 * is zeroed first so the bake always formats fresh. Async (compiles run
 * synchronously, the seal is WebCrypto). io: readAsset/readBinary/
 * buildProject/log — compile is created here, over the bake namespace.
 */
function bakeSystemImage(BLOCK_FS, CompilerJS, sysStore, manifest, io) {
  var log = io.log || function () {};
  log('baking system image (manifest v' + manifest.version + ')');
  if (sysStore.size() >= 256) sysStore.setBytes(0, new Uint8Array(256)); // force format
  var sys = BLOCK_FS.createV4(sysStore, { noDevNodes: true });
  var tmpRoot = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(1 << 20), { noDevNodes: true });
  var mfs = new BLOCK_FS.MountFS({ '/': tmpRoot, '/usr': sys });
  mfs.mkdir('/etc', 0o755);   // seedEntries' compile staging area (throwaway)
  var bakeIo = {
    readAsset: io.readAsset,
    readBinary: io.readBinary,
    buildProject: io.buildProject,
    log: log,
    compile: createCcDriver(CompilerJS, mfs),
  };
  return seedEntries(mfs, manifest.system, bakeIo).then(function () {
    mfs.symlink('/var/local', '/usr/local');
    writeFile(mfs, '/usr/share/os-release',
      'NAME=gucOS\nPRETTY_NAME="gucOS (groundupcoder OS)"\n' +
      'VERSION_ID=' + (manifest.version | 0) + '\n');
    sysStore.flush && sysStore.flush();
    return BLOCK_FS.sealVolume(sysStore);
  });
}

/* The version a blob was baked with (its /usr/share/os-release — blob-root
 * path /share/os-release), or -1 for anything that isn't a complete baked
 * system image (empty store, wrong format, half-written copy). -1 means
 * "re-materialize": fetch/copy a current blob, or fall back to baking. */
function bakedVersion(BLOCK_FS, store) {
  try {
    var fs = BLOCK_FS.createV4(store, { readonly: true });
    var t = readFileText(fs, '/share/os-release');
    if (t === null) return -1;
    var m = /(?:^|\n)VERSION_ID=(\d+)/.exec(t);
    return m ? parseInt(m[1], 10) : -1;
  } catch (e) {
    return -1;   // readonly mount refuses unformatted/non-v4 stores
  }
}

/* ---- bake-input freshness (todos/0082) ----
 *
 * newestBakeInput(fsMod, pathMod, rootDir, manifest) -> { mtimeMs, path }
 * The newest mtime across everything that can change the system blob's
 * bytes: compiler.js + host.js (the toolchain), the os/ tree (manifest,
 * bake logic, every seeded source/header), and the manifest system
 * section's closure — each `project` bin.json expanded through its deps
 * with the whole project directory walked (dir-granular on purpose:
 * quoted includes resolve beside their sources), plus each `bin` blob.
 * Node-only (statSync), like NodeFileStore.
 *
 * A blob or fixture whose mtime is older than this is STALE no matter
 * what version it carries — the 0082 gate: a same-version blob baked
 * before an uncommitted compiler.js edit must never be silently reused.
 * Bakers stamp the blob's mtime with the bake START time (an input
 * edited mid-bake may or may not be reflected, so it must read newer).
 *
 * Deliberately excluded (can't change blob bytes): *.img (the images
 * themselves), *.md, dotfiles, and os/'s runtime-only files (os.html,
 * boot.js, the workers, the compositor). Directory granularity
 * over-invalidates — "when in doubt, re-bake" is the cheap direction. */
var BAKE_INPUT_SKIP = {
  'os.html': 1, 'boot.js': 1, 'kernel-worker.js': 1,
  'process-worker.js': 1, 'compositor.js': 1,
};
function newestBakeInput(fsMod, pathMod, rootDir, manifest) {
  var newest = { mtimeMs: 0, path: null };
  var seenDirs = {}, seenProjects = {};
  function statFile(p) {
    var st;
    try { st = fsMod.statSync(p); } catch (e) { return; }
    if (st.isFile() && st.mtimeMs > newest.mtimeMs) {
      newest.mtimeMs = st.mtimeMs;
      newest.path = p;
    }
  }
  function walk(dir, skipNames) {
    var real;
    try { real = fsMod.realpathSync(dir); } catch (e) { return; }
    if (seenDirs[real]) return;
    seenDirs[real] = true;
    var ents;
    try { ents = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      if (e.name.charAt(0) === '.') return;
      if (skipNames && skipNames[e.name]) return;
      if (e.isDirectory()) walk(pathMod.join(dir, e.name), null);
      // .img.tmp-<pid> is mkimage's atomic-rename temp (a bake OUTPUT):
      // one left behind by a killed bake would read as an ever-newer
      // "input" and make the published image perpetually stale.
      else if (!/\.(img|md)$/.test(e.name) && !/\.img\.tmp-\d+$/.test(e.name)) statFile(pathMod.join(dir, e.name));
    });
  }
  function normalize(p) {   // "a/b/../c" -> "a/c" (buildProject's rule)
    var out = [];
    p.split('/').forEach(function (seg) {
      if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
      else if (seg !== '.') out.push(seg);
    });
    return out.join('/');
  }
  function addProject(rel) {   // repo-relative bin.json/lib.json path
    var n = normalize(rel);
    if (seenProjects[n]) return;
    seenProjects[n] = true;
    var dir = n.slice(0, n.lastIndexOf('/'));
    walk(pathMod.join(rootDir, dir), null);
    var proj;
    try { proj = JSON.parse(fsMod.readFileSync(pathMod.join(rootDir, n), 'utf-8')); } catch (e) { return; }
    (proj.deps || []).forEach(function (d) { addProject(dir + '/' + d); });
  }
  statFile(pathMod.join(rootDir, 'compiler.js'));
  statFile(pathMod.join(rootDir, 'host.js'));
  walk(pathMod.join(rootDir, 'os'), BAKE_INPUT_SKIP);
  var files = (manifest.system && manifest.system.files) || {};
  Object.keys(files).forEach(function (fp) {
    var entry = files[fp];
    if (entry.project !== undefined) addProject(entry.project);
    if (entry.bin !== undefined) statFile(pathMod.join(rootDir, entry.bin));
  });
  return newest;
}

/* Skeleton for a freshly formatted root (writable) volume: the structural
 * dirs every boot expects — /etc (user overrides only; EMPTY on a virgin
 * boot by design), /var/local/bin (the admin's PATH head), /tmp, /root,
 * /run — plus the merged-usr /bin -> /usr/bin symlink. /dev comes from
 * ensureDevNodes (the root volume mounts WITH dev nodes now). Idempotent;
 * runs through the full MountFS namespace. */
function initRootVolume(mfs) {
  ['/etc', '/var', '/var/local', '/var/local/bin', '/tmp', '/root', '/run']
    .forEach(function (d) {
      if (mfs.stat(d) === null) mfs.mkdir(d, 0o755);
    });
  if (mfs.lstat('/bin') === null) mfs.symlink('/usr/bin', '/bin');
}

/* ---- NodeFileStore: the ByteStore interface over a plain file ----
 * The headless twin of host.js's SyncAccessHandleStore (OPFS). Takes the
 * caller's `fs` module so this file stays environment-neutral (os/boot.js
 * and tools/mkimage.js pass require('fs'); the browser never calls it). */
function NodeFileStore(fsMod, filePath, fresh) {
  if (fresh) { try { fsMod.unlinkSync(filePath); } catch (e) {} }
  this._fs = fsMod;
  this._fd = fsMod.openSync(filePath, fsMod.existsSync(filePath) ? 'r+' : 'w+');
  this._tmp4 = new Uint8Array(4);
  this._tmpDV = new DataView(this._tmp4.buffer);
}
NodeFileStore.prototype.getUint32 = function (off) {
  this._tmp4.fill(0);
  this._fs.readSync(this._fd, this._tmp4, 0, 4, off);
  return this._tmpDV.getUint32(0, true);
};
NodeFileStore.prototype.setUint32 = function (off, val) {
  this._tmpDV.setUint32(0, val, true);
  this._fs.writeSync(this._fd, this._tmp4, 0, 4, off);
};
NodeFileStore.prototype.getBytes = function (off, len) {
  var buf = new Uint8Array(len);
  if (len > 0) this._fs.readSync(this._fd, buf, 0, len, off);
  return buf;
};
NodeFileStore.prototype.setBytes = function (off, data) {
  if (data.length > 0) this._fs.writeSync(this._fd, data, 0, data.length, off);
};
NodeFileStore.prototype.size = function () { return this._fs.fstatSync(this._fd).size; };
NodeFileStore.prototype.resize = function (newSize) { this._fs.ftruncateSync(this._fd, newSize); };
NodeFileStore.prototype.flush = function () { this._fs.fsyncSync(this._fd); };
NodeFileStore.prototype.close = function () { this._fs.closeSync(this._fd); };

/* ---- environment exports (host.js discipline) ---- */
var OS_COMMON = {
  createCcDriver: createCcDriver,
  buildProject: buildProject,
  seedEntries: seedEntries,
  bakeSystemImage: bakeSystemImage,
  bakedVersion: bakedVersion,
  newestBakeInput: newestBakeInput,
  initRootVolume: initRootVolume,
  NodeFileStore: NodeFileStore,
  readFileBytes: readFileBytes,
  readFileText: readFileText,
  writeFile: writeFile,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OS_COMMON;
} else if (typeof self !== 'undefined') {
  self.OS_COMMON = OS_COMMON;
}
