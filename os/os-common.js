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
   * e.g. the busybox applets all dep on vendor/busybox/libbb-core.json).
   * Diamond deps dedup on normalized path (todos/0079, matching
   * compiler.js's expandProjectJson — no realpath here, XHR context). */
  var seenProjects = {};
  (function expand(p) {
    var key = normalize(p);
    if (seenProjects[key]) return;
    seenProjects[key] = true;
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

/* ---- optional opt-in image overlays (todos/0118) ----
 *
 * An overlay folds a SIBLING-published, prebuilt `overlay@1` manifest's files
 * into the system image at bake time — real C/C++ apps cross-compiled ahead of
 * time by ~git/clang-simplified (cc2wasm), which this repo's compiler.js can't
 * build. This repo is only the CONSUMER: it never runs cc2wasm and never builds
 * anything from the sibling — it reads the published JSON, VERIFIES hashes, and
 * plants bytes. Design + the frozen `overlay@1` contract: todos/0118.
 *
 * Locked decisions (todos/0118, do not relitigate): prebuilt only (never trigger
 * the sibling's build); OFF by default and flag-gated (a base bake with no
 * overlay flag stays byte-identical to today); loud failure (a requested overlay
 * that's missing or fails verification is FATAL — never a quiet degradation);
 * provenance recorded into the image so it's self-describing.
 *
 * Two phases so a bad overlay fails BEFORE the ~minute-long bake:
 *   loadOverlays(specs, oio, requireClean, log)  — read + parse each manifest,
 *     enforce every content rule (schema/id/one-of/provenance/hash/size/mode),
 *     resolve + hash-verify each `bin` payload. Throws (fatal) on any violation;
 *     warns loudly (or fatal under requireClean) on a dirty provenance. Pure over
 *     the injected `oio` hooks — no filesystem knowledge of its own.
 *   plantOverlays(mfs, loaded, log)  — mkdir the dirs, enforce the placement +
 *     conflict rules against the just-seeded base image, write bytes, plant each
 *     overlay's provenance at /usr/share/overlays/<id>.json. Returns a summary
 *     array the caller records into the image identity (os-release OVERLAYS=).
 *
 * oio (Node-only; see nodeOverlayIo): readFile(absPath)->Uint8Array (throws on
 * missing), resolve(a,b)->abs, dirname(p)->dir, sha256(bytes)->lowercase hex.
 * The browser never applies overlays (it fetches a prebaked blob), so os-common
 * stays environment-neutral: the Node fs/path/crypto ride in through oio.
 */
function loadOverlays(specs, oio, requireClean, log) {
  log = log || function () {};
  var loaded = [];
  specs.forEach(function (spec) {
    var raw;
    try {
      raw = oio.readFile(spec.manifestPath);
    } catch (e) {
      throw new Error("overlay '" + spec.id + "' requested but " + spec.manifestPath +
        ' not found — build it in the sibling: `node wasm/tools/mk-overlay.mjs`');
    }
    var m;
    try { m = JSON.parse(new TextDecoder('utf-8').decode(raw)); }
    catch (e) { throw new Error("overlay '" + spec.id + "': " + spec.manifestPath + ' is not valid JSON: ' + e.message); }
    if (m.schema !== 'overlay@1')
      throw new Error("overlay '" + spec.id + "': schema " + JSON.stringify(m.schema) + ' is not "overlay@1"');
    if (m.id !== spec.id)
      throw new Error('overlay id mismatch: ' + spec.manifestPath + ' declares id ' +
        JSON.stringify(m.id) + ' but is applied as ' + JSON.stringify(spec.id));
    var prov = m.provenance;
    if (!prov || typeof prov !== 'object' || !prov.repo || typeof prov.repo !== 'object')
      throw new Error("overlay '" + spec.id + "': provenance.repo is required");
    var dirty = !!(prov.repo.dirty || (prov.compiler && prov.compiler.dirty));
    if (dirty) {
      if (requireClean)
        throw new Error("overlay '" + spec.id + "' was built from a DIRTY tree and --require-clean-overlays is set");
      log('WARNING overlay ' + spec.id + ' built from a DIRTY tree — not reproducible');
    }
    var artifactRoot = oio.resolve(oio.dirname(spec.manifestPath), prov.artifactRoot || '.');
    var files = m.files || {};
    var resolved = [];
    Object.keys(files).forEach(function (p) {
      var entry = files[p];
      if (typeof p !== 'string' || p.charAt(0) !== '/')
        throw new Error("overlay '" + spec.id + "': file path " + JSON.stringify(p) + ' must be absolute');
      if (p !== '/usr' && p.indexOf('/usr/') !== 0)
        throw new Error("overlay '" + spec.id + "': file path " + p + ' must be under /usr');
      var hasBin = entry.bin !== undefined, hasText = entry.text !== undefined, hasLink = entry.link !== undefined;
      if ((hasBin ? 1 : 0) + (hasText ? 1 : 0) + (hasLink ? 1 : 0) !== 1)
        throw new Error("overlay '" + spec.id + "': " + p + ' must have exactly one of "bin" | "text" | "link"');
      if (hasLink) {
        if (typeof entry.link !== 'string' || entry.link.charAt(0) !== '/')
          throw new Error("overlay '" + spec.id + "': " + p + ' "link" must be an absolute symlink target');
        resolved.push({ path: p, link: entry.link, override: !!entry.override });
        return;   // a symlink carries no bytes, mode, or hash
      }
      var mode = parseOverlayMode(entry.mode, p, spec.id);
      var bytes;
      if (hasBin) {
        if (entry.sha256 === undefined || entry.size === undefined)
          throw new Error("overlay '" + spec.id + "': " + p + ' (bin) requires "sha256" and "size"');
        var binPath = oio.resolve(artifactRoot, entry.bin);
        try { bytes = oio.readFile(binPath); }
        catch (e) { throw new Error("overlay '" + spec.id + "': " + p + ' payload ' + entry.bin + ' not found under artifactRoot (' + binPath + ')'); }
        var got = oio.sha256(bytes);
        var want = String(entry.sha256).toLowerCase();
        if (got !== want)
          throw new Error("overlay '" + spec.id + "': " + p + ' sha256 mismatch (declared ' + want + ', computed ' + got + ')');
        if (bytes.length !== (entry.size | 0))
          throw new Error("overlay '" + spec.id + "': " + p + ' size mismatch (declared ' + entry.size + ', actual ' + bytes.length + ')');
      } else {
        if (typeof entry.text !== 'string')
          throw new Error("overlay '" + spec.id + "': " + p + ' "text" must be a string');
        bytes = new TextEncoder().encode(entry.text);
      }
      resolved.push({ path: p, bytes: bytes, mode: mode, override: !!entry.override });
    });
    loaded.push({ id: spec.id, provenance: prov, dirty: dirty, dirs: m.dirs || [], files: resolved });
  });
  return loaded;
}

function parseOverlayMode(mode, p, id) {
  if (mode === undefined) return p.indexOf('/usr/bin/') === 0 ? 0o755 : 0o644;
  var m = parseInt(String(mode), 8);
  if (isNaN(m)) throw new Error("overlay '" + id + "': " + p + ' has a bad octal mode ' + JSON.stringify(mode));
  return m;
}

function ensureDirPath(mfs, dir) {
  var cur = '';
  dir.split('/').forEach(function (seg) {
    if (!seg) return;
    cur += '/' + seg;
    if (mfs.stat(cur) === null) mfs.mkdir(cur, 0o755);
  });
}

function plantOverlays(mfs, loaded, log) {
  log = log || function () {};
  var claimed = {};   // path -> overlay id (cross-overlay conflict guard)
  var summaries = [];
  loaded.forEach(function (ov) {
    ov.dirs.forEach(function (d) {
      if (typeof d !== 'string' || (d !== '/usr' && d.indexOf('/usr/') !== 0))
        throw new Error("overlay '" + ov.id + "': dir " + JSON.stringify(d) + ' must be under /usr');
      ensureDirPath(mfs, d);
    });
    var total = 0;
    ov.files.forEach(function (f) {
      var parent = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
      if (mfs.stat(parent) === null)
        throw new Error("overlay '" + ov.id + "': parent " + parent + ' of ' + f.path +
          ' is not a base dir or listed in the overlay\'s "dirs"');
      if (claimed[f.path])
        throw new Error('overlay path conflict: ' + f.path + " planted by both '" +
          claimed[f.path] + "' and '" + ov.id + "'");
      if (mfs.stat(f.path) !== null && !f.override)
        throw new Error("overlay '" + ov.id + "': " + f.path +
          ' already exists in the base image (set "override": true to replace)');
      if (f.link !== undefined) {
        if (mfs.lstat(f.path) !== null) mfs.unlink(f.path);   // "override" replaces a base entry
        mfs.symlink(f.link, f.path);
      } else {
        writeFile(mfs, f.path, f.bytes, f.mode);
      }
      claimed[f.path] = ov.id;
      total += (f.bytes ? f.bytes.length : 0);
    });
    ensureDirPath(mfs, '/usr/share/overlays');
    writeFile(mfs, '/usr/share/overlays/' + ov.id + '.json',
      JSON.stringify(ov.provenance, null, 2) + '\n', 0o644);
    var short = (ov.provenance.repo && ov.provenance.repo.commitShort) || '?';
    var producer = ov.provenance.producer || '?';
    log('overlay ' + ov.id + ': ' + ov.files.length + ' files, ' +
      (total / (1 << 20)).toFixed(1) + ' MiB, ' + producer + '@' + short +
      ' (' + (ov.dirty ? 'DIRTY' : 'clean') + ')');
    summaries.push({ id: ov.id, files: ov.files.length, bytes: total, commitShort: short, dirty: ov.dirty });
  });
  return summaries;
}

/* Build the Node-side overlay io from injected modules (keeps os-common
 * environment-neutral; only mkimage.js/boot.js — both Node — call this). */
function nodeOverlayIo(fsMod, pathMod, cryptoMod) {
  return {
    readFile: function (p) { return new Uint8Array(fsMod.readFileSync(p)); },
    resolve: function (a, b) { return pathMod.resolve(a, b); },
    dirname: function (p) { return pathMod.dirname(p); },
    sha256: function (bytes) { return cryptoMod.createHash('sha256').update(bytes).digest('hex'); },
  };
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
  // Overlays (todos/0118): read + verify BEFORE the ~minute-long bake so a bad
  // flag fails fast. Off by default — an empty/absent io.overlays leaves the
  // base bake byte-identical to today (no overlay dirs, files, provenance, or
  // os-release OVERLAYS line are written).
  var overlaySpecs = io.overlays || [];
  var loadedOverlays = overlaySpecs.length
    ? loadOverlays(overlaySpecs, io.overlayIo, !!io.requireCleanOverlays, log)
    : [];
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
    var applied = loadedOverlays.length ? plantOverlays(mfs, loadedOverlays, log) : [];
    var rel = 'NAME=gucOS\nPRETTY_NAME="gucOS (groundupcoder OS)"\n' +
      'VERSION_ID=' + (manifest.version | 0) + '\n';
    if (applied.length) {
      // Additive image identity: a base blob and a +overlay blob are
      // distinguishable at boot/CI even though bakedVersion (VERSION_ID) is
      // authoritative for the base. Companion carries the reproducibility keys.
      rel += 'OVERLAYS=' + applied.map(function (a) { return a.id; }).join(',') + '\n';
      writeFile(mfs, '/usr/share/os-release.overlays',
        JSON.stringify(applied.map(function (a) {
          return { id: a.id, commitShort: a.commitShort, dirty: a.dirty };
        })) + '\n');
    }
    writeFile(mfs, '/usr/share/os-release', rel);
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

/* The overlay set a blob was baked with (its /usr/share/os-release OVERLAYS=
 * line — bakeSystemImage writes it only when overlays were applied), as a
 * SORTED array of ids, or [] for a base blob / anything unreadable. This is
 * the second axis of image identity (todos/0118): a base blob and a
 * +clang-apps blob share a VERSION_ID but differ here, so a freshness gate
 * that folds overlays in must compare this against the DESIRED set (serve.js
 * --clang, todos/0141) — not just the version. */
function bakedOverlays(BLOCK_FS, store) {
  try {
    var fs = BLOCK_FS.createV4(store, { readonly: true });
    var t = readFileText(fs, '/share/os-release');
    if (t === null) return [];
    var m = /(?:^|\n)OVERLAYS=([^\n]*)/.exec(t);
    if (!m) return [];
    return m[1].split(',').filter(function (s) { return s; }).sort();
  } catch (e) {
    return [];
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
  loadOverlays: loadOverlays,
  plantOverlays: plantOverlays,
  nodeOverlayIo: nodeOverlayIo,
  bakedVersion: bakedVersion,
  bakedOverlays: bakedOverlays,
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
