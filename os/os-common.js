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
//   checkManifestRefs(manifest)      — the #434 referential-integrity
//     check every bake runs first: a baked launcher/menu entry/symlink/
//     config seed referencing a command or path absent from the image
//     being built fails the bake loudly.
//   seedEntries(kfs, section, io)    — populate paths from a manifest
//     section (dirs + files). Used by the bake (system section, full
//     namespace) and by the virgin-boot user seed (user section).
//   seedBakedSeeds(kfs, log)         — the virgin-root pass for the gucman
//     `seed` content resource kind: plant every baked package's declared
//     content into /root, skip-if-exists, driven entirely by the sealed blob
//     (never by the manifest — see its block for why).
//   initRootVolume(mfs)              — skeleton for a fresh writable root
//     volume: /etc /var/local/bin /tmp /root /run + /bin -> /usr/bin.
//   bakedVersion(BLOCK_FS, store)    — a blob's VERSION_ID (or -1): the
//     staleness gate for "upgrade = swap the blob".
//   projectExternalDirs(proj, dir)   — the directories a project's sources/
//     includes/srcRoots reach OUTSIDE its own dir (todos/0354): the half of
//     a project's input closure that `deps` recursion does not reach.
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
    // Standard OS install locations for system headers and require-able
    // sources (Lane A of the source-lib design): the admin tier
    // (/usr/local/*, writable) precedes the baked tier (/usr/*, sealed) —
    // the PATH/cfgstore convention. Builtin headers/sources still ALWAYS
    // beat these ambient dirs; only an explicit -I may shadow a builtin.
    pp.systemIncludePaths = ['/usr/local/include', '/usr/include'];
    pp.sourcePaths = ['/usr/local/src', '/usr/src'];
    // Physical TU paths (Lane B2, amending the design's §1.5 premise): kfs
    // collapses '..' LEXICALLY before its walk (host.js _walkPath —
    // logical, not physical), so a TU compiled under its VISIBLE tier path
    // (/usr/src/win32/gdi32.c, a symlink-farm entry) would mis-resolve its
    // own '..'-relative includes ("../fontcore.h" -> /usr/src/fontcore.h,
    // ENOENT — never entering the symlink). The realpath hook makes
    // parseAllUnits compile every TU under its PHYSICAL path
    // (/usr/opt/win32/src/win32/gdi32.c), inside the payload's real tree
    // where lexical == physical. realpathPhysical exists on BlockFS,
    // MountFS and RemoteFS alike (todos/0263).
    pp.realpath = function (p) { return kfs.realpathPhysical(p); };

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
  var srcRootDirs = {};   // ns -> normalized dir (conflicting-remap gate)
  (function expand(p) {
    var key = normalize(p);
    if (seenProjects[key]) return;
    seenProjects[key] = true;
    var dir = p.slice(0, p.lastIndexOf('/'));
    var proj = JSON.parse(readHostFile(p));
    (proj.deps || []).forEach(function (d) { expand(normalize(dir + '/' + d)); });
    (proj.includes || []).forEach(function (inc) { pp.includePaths.push(normalize(dir + '/' + inc)); });
    /* srcRoots (Lane A): {"<ns>": "<dir-relative-to-json>"} registers a
     * source-root namespace for FS-resolved __require_source names —
     * 'ns/file.c' resolves to <dir>/file.c and path-identity-dedups against
     * explicitly listed TUs. Diamond deps re-declaring the same ns -> same
     * dir no-op; a conflicting remap of the namespace throws. */
    Object.keys(proj.srcRoots || {}).forEach(function (ns) {
      if (!/^[A-Za-z0-9._-]+$/.test(ns))
        throw new Error('buildProject ' + projPath + ': invalid srcRoot namespace "' + ns + '"');
      var mapped = normalize(dir + '/' + proj.srcRoots[ns]);
      if (srcRootDirs[ns] !== undefined) {
        if (srcRootDirs[ns] !== mapped)
          throw new Error('buildProject ' + projPath + ': conflicting srcRoot remap of "' + ns +
            '": ' + srcRootDirs[ns] + ' vs ' + mapped);
        return;
      }
      srcRootDirs[ns] = mapped;
      pp.sourceRoots.push({ prefix: ns, dir: mapped });
    });
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

/* ---- the virgin-root baked-seed pass (gucman `seed` design §3.5) ----
 *
 * seedBakedSeeds(kfs, log) -> number of files planted. Runs ONCE, on a
 * freshly created root volume, immediately after seedEntries(manifest.user):
 * every package folded into the sealed blob (os-release PACKAGES=, the fat
 * image's identity axis) whose /usr/opt/<name>/control.json declares `seed`
 * gets its content copied into /root, skip-if-exists per node so the
 * manifest's own user entries always win.
 *
 * It reads EVERYTHING from the mounted blob, which is why it is here and not
 * a fold into manifest.user: boot.js seeds from the FOLDED manifest but
 * kernel-worker.js seeds from the RAW FETCHED image.json (kernel-worker.js
 * :379/:481), so a manifest-side design passes every headless test and
 * silently no-ops in every browser (design §0.4/§8.2). Blob-driven, this is
 * version-locked and identical in both embedders by construction.
 *
 * A virgin root means everything is absent, so skip-if-exists is the only
 * policy this walk needs — the full additive merge engine (fo_merge) lives
 * in C, where the reconcile that "copies them over again if missing" runs.
 * The small duplication is deliberate: the alternative is spawning a process
 * during kernel-side seeding, before the process machinery is up. */
function seedBakedSeeds(kfs, log) {
  log = log || function () {};
  var rel = readFileText(kfs, '/usr/share/os-release');
  if (rel === null) return 0;
  var m = /(^|\n)PACKAGES=([^\n]*)/.exec(rel);
  var names = m ? m[2].split(',').filter(Boolean) : [];
  var planted = 0;
  names.forEach(function (name) {
    var root = '/usr/opt/' + name;
    var text = readFileText(kfs, root + '/control.json');
    if (text === null) return;                    // not a seed-bearing fold
    var control;
    try { control = JSON.parse(text); } catch (e) {
      log('  ' + root + '/control.json is not valid JSON — skipped');
      return;
    }
    if (!control || typeof control.seed !== 'object' || control.seed === null) return;
    var seed = validateSeedShape(control.seed, 'baked package ' + JSON.stringify(name));
    Object.keys(seed).forEach(function (dest) {
      var parts = ('/root/' + dest).split('/');
      var cur = '';
      for (var i = 1; i < parts.length - 1; i++) {     // mkdir -p the parent chain
        cur += '/' + parts[i];
        if (kfs.lstat(cur) === null) kfs.mkdir(cur, 0o755);
      }
      var n = plantSeedNode(kfs, root + '/' + seed[dest], '/root/' + dest);
      if (n) log('  /root/' + dest + ' (' + n + ' file(s) seeded from ' + name + ')');
      planted += n;
    });
  });
  return planted;
}

/* One skip-if-exists copy node (file / symlink / directory-merge). Returns
 * the number of FILES planted. */
function plantSeedNode(kfs, src, dst) {
  var S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
  var ss = kfs.lstat(src);
  if (ss === null) return 0;
  var ds = kfs.lstat(dst);
  var srcDir = (ss.mode & S_IFMT) === S_IFDIR;
  if (ds !== null) {
    // Present: the user's (or the manifest's) node always wins. Two dirs
    // still merge additively, so a package can add into a seeded folder.
    if (!srcDir || (ds.mode & S_IFMT) !== S_IFDIR) return 0;
  } else if (srcDir) {
    kfs.mkdir(dst, ss.mode & 0o777);
  } else if ((ss.mode & S_IFMT) === S_IFLNK) {
    var buf = new Uint8Array(1024);
    var n = kfs.readlink(src, buf, buf.length);
    if (n === null || n <= 0) return 0;
    kfs.symlink(new TextDecoder('utf-8').decode(buf.subarray(0, n)), dst);
    return 1;
  } else {
    var bytes = readFileBytes(kfs, src);
    if (bytes === null) return 0;
    writeFile(kfs, dst, bytes, ss.mode & 0o777);
    return 1;
  }
  var planted = 0;
  var dh = kfs.opendir(src);
  if (dh === null) return 0;
  var kids = [];
  for (var e; (e = kfs.readdir(dh)) !== null;)
    if (e.name !== '.' && e.name !== '..') kids.push(e.name);
  kfs.closedir(dh);
  kids.sort().forEach(function (nm) {
    planted += plantSeedNode(kfs, src + '/' + nm, dst + '/' + nm);
  });
  return planted;
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

/* ---- optional packages folded back into the bake (gucman Slice 1) ----
 *
 * gucman (the package manager) pulls optional apps OUT of the baked /usr
 * blob into runtime-installable packages under packages/<name>.json (file
 * entries use the same vocab as image.json; bin/openwith/menu are the
 * declarative surface gucman plants at install time). A plain bake is the
 * MINIMAL image (the deploy artifact); dev/test bakes fold the packages
 * back in with --packages=all so the existing estate sees the same /usr it
 * always did (the todos/0118 overlay precedent: opt-in, identity-recorded).
 *
 * Baked-mode layout (derived mechanically from the package definition — no
 * per-package special cases): the package tree plants under
 * /usr/opt/<name>/, each bin command becomes /usr/bin/<cmd> ->
 * /usr/opt/<name>/<rel>, each menu entry becomes
 * /usr/share/menu/<group>/<entry> -> /usr/bin/<cmd>, each openwith key
 * appends "<ext>\t/bin/<cmd>" to the baked /usr/share/openwith seed, and
 * each `commands` claim (todos/0338) is spliced AHEAD of the baked
 * /usr/share/cmdalt body as "<name>\t/bin/<cmd>" — the exact shapes these
 * entries had when they lived in image.json. The installed-mode twin
 * (gucman install) is /opt/<name> + /usr/local/bin/<cmd> + /etc/menu +
 * /etc/openwith + /etc/cmdalt.
 *
 * The folded set is recorded in os-release as PACKAGES=<a,b,...> — the
 * second identity axis (bakedPackages, mirroring bakedOverlays): a minimal
 * blob and a fat blob share a VERSION_ID, so freshness gates that want a
 * specific set must compare it, not just the version. Node-only (reads
 * packages/ from the repo), like newestBakeInput. */
/* opts (all optional):
 *   packagesDir : the directory to enumerate (default rootDir/packages) — a
 *                 test seam; the shipping callers always pass rootDir.
 *   producers   : an array of native-sibling producer names ('clang',
 *                 'rust', …) whose GATED definitions to include. A gated
 *                 def carries `requires: "native-sibling:<producer>"` (the
 *                 *-clang / *-rust packages; todos/0416) and is included
 *                 iff its producer is in this list. DEFAULT []: gated defs
 *                 are EXCLUDED from every default enumeration. This one
 *                 choke point is what keeps "base gucOS ships with NO
 *                 clang and NO Rust" true by CONSTRUCTION rather than by
 *                 convention (CLANG-CPP-EPIC Part II §7, RUST.md §3 rule
 *                 5): mkpkg-no-flag, foldPackages('all') (→ serve.js's fat
 *                 image, boot.js --packages=all,
 *                 tests/lib/image-fixture.js) all go through the default
 *                 path and never see a gated package; only an explicit
 *                 mkpkg --clang / --rust / producers opt-in includes them.
 * A def is "gated" iff it declares a non-empty `requires` — determined by
 * parsing each json (cheap; packages/ is a handful of small files). A
 * malformed def is NOT excluded (its breakage must surface loudly downstream
 * in buildPackage/foldPackages, not vanish silently from the base image).
 * A gated def whose `requires` does not parse as native-sibling:<p>, or
 * names a producer outside the list, stays excluded here — mkpkg's gate
 * validation is where an unknown `requires` value fails LOUDLY. */
function listPackages(fsMod, pathMod, rootDir, opts) {
  opts = opts || {};
  var dir = opts.packagesDir || pathMod.join(rootDir, 'packages');
  var producers = opts.producers || [];
  var names = [];
  try {
    fsMod.readdirSync(dir).forEach(function (f) {
      if (!/\.json$/.test(f)) return;
      var name = f.slice(0, -5);
      var req;
      try { req = JSON.parse(fsMod.readFileSync(pathMod.join(dir, f), 'utf-8')).requires; }
      catch (e) { req = undefined; }   // malformed → not excluded; fails loud downstream
      if (req !== undefined && req !== null && req !== '') {
        var p = nativeSiblingProducer(req);
        if (p === null || producers.indexOf(p) < 0) return;
      }
      names.push(name);
    });
  } catch (e) { /* no packages/ dir — nothing to fold */ }
  return names.sort();
}

/* The ONE parser of the gate value (todos/0416): `requires:
 * "native-sibling:<producer>"` names the sibling repository that produces
 * the package's prebuilt payloads — "clang" (clang-simplified) or "rust"
 * (gucos-rust). One field carries both the gate and the routing: a
 * separate `producer` field could disagree with `requires`, and every
 * reader would have to check both. Returns the producer name, or null when
 * the value is not a native-sibling gate. */
function nativeSiblingProducer(req) {
  if (typeof req !== 'string') return null;
  var PREFIX = 'native-sibling:';
  if (req.slice(0, PREFIX.length) !== PREFIX) return null;
  var p = req.slice(PREFIX.length);
  return p.length ? p : null;
}

function validRelPath(rel) {
  if (typeof rel !== 'string' || !rel.length || rel.charAt(0) === '/') return false;
  var parts = rel.split('/');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '' || parts[i] === '.' || parts[i] === '..') return false;
  }
  return true;
}

/* ---- `tree` manifest entries (win32 source-lib design §3.2) ----
 *
 * listTreeFiles(fsMod, pathMod, rootDir, entry, label) -> sorted array of
 * tree-relative file paths for a `{"tree": "<repo-relative dir>",
 * "exclude": [glob, ...]}` package-file entry — the recursive-directory-copy
 * vocabulary that spares a definition ~120 hand-listed entries per vendored
 * source tree. Rules (mirroring gucman's tar_validate): dotfiles/dotdirs
 * are ALWAYS excluded; symlinks are REFUSED loudly (payloads carry files
 * and dirs only); `exclude` globs match tree-relative paths (`*`/`?` stay
 * within a path component, `**` crosses them) and a glob matching a
 * directory prunes its whole subtree. Dirs derive from the file paths, so
 * an empty directory does not ride.
 *
 * Node-only BY CONSTRUCTION: tree entries are expanded where packages are
 * expanded — mkpkg's assembleTree and foldPackages below — which never run
 * in the browser worker (the in-worker fallback bake uses the raw minimal
 * manifest), so the XHR reader's inability to enumerate directories is
 * never hit. The SAME enumeration drives the freshness scans
 * (newestBakeInput here, mkpkg's newestPkgInput), so "what's in the
 * payload" and "what makes it stale" agree by construction. */
function treeGlobRe(glob) {
  var re = '';
  for (var i = 0; i < glob.length; i++) {
    var ch = glob.charAt(i);
    if (ch === '*') {
      if (glob.charAt(i + 1) === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function listTreeFiles(fsMod, pathMod, rootDir, entry, label) {
  if (!validRelPath(entry.tree))
    throw new Error(label + ': tree must be a repo-relative directory path');
  if (entry.exclude !== undefined && !Array.isArray(entry.exclude))
    throw new Error(label + ': exclude must be an array of globs');
  var excludes = (entry.exclude || []).map(function (g) {
    if (typeof g !== 'string' || !g.length)
      throw new Error(label + ': bad exclude glob ' + JSON.stringify(g));
    return treeGlobRe(g);
  });
  var excluded = function (rel) {
    for (var i = 0; i < excludes.length; i++) if (excludes[i].test(rel)) return true;
    return false;
  };
  var rootAbs = pathMod.join(rootDir, entry.tree);
  var st;
  try { st = fsMod.lstatSync(rootAbs); } catch (e) { st = null; }
  if (!st || !st.isDirectory())
    throw new Error(label + ': tree dir ' + entry.tree + ' is not a directory');
  var files = [];
  (function walk(rel) {
    var abs = rel ? pathMod.join(rootAbs, rel) : rootAbs;
    fsMod.readdirSync(abs).sort().forEach(function (nm) {
      if (nm.charAt(0) === '.') return;                    // dotfiles never ride
      var crel = rel ? rel + '/' + nm : nm;
      if (excluded(crel)) return;
      var cst = fsMod.lstatSync(pathMod.join(abs, nm));
      if (cst.isSymbolicLink())
        throw new Error(label + ': ' + entry.tree + '/' + crel +
          ' is a symlink — tree payloads carry files and dirs only');
      if (cst.isDirectory()) walk(crel);
      else if (cst.isFile()) files.push(crel);
      else throw new Error(label + ': ' + entry.tree + '/' + crel + ' has an unsupported file type');
    });
  })('');
  return files;
}

/* ---- mechanical `<name>-sources` companion packages (todos #407) ----
 *
 * sourcePackageDefs(fsMod, pathMod, rootDir, opts) -> sorted array of
 * { name, parent, kind, def, inputs }: an in-memory package definition per
 * SOURCE-BEARING unit, derived by ONE rule with no per-package hand edits.
 *
 * The units, both derivations through the same closure:
 *   kind 'package' — every packages/<p>.json (ungated; a native-sibling
 *     package's source lives in the producer repo, which publishes only
 *     binaries) that has at least one `project`/`c` files entry. Name
 *     <p>-sources, version = the parent's version.
 *   kind 'image' — every os/image.json system file built from source
 *     (`project`/`c` entries — /usr/bin/gcode et al). Name = the installed
 *     basename minus any extension + '-sources', version = the image
 *     version. A unit whose name a 'package' unit already claims is the
 *     same software twice — the package derivation wins.
 *
 * The payload is the COMPILE CLOSURE, mirrored at repo-relative paths:
 * every project json reached through `deps`, every listed source, every
 * `hdrs` file, and every header under every declared include dir. Chosen
 * over "the project's directory" so a project rooted in a shared dir
 * (os/wm.json; gucman's includes '..') cannot drag a whole tree in, and
 * over "no deps" so an app split across projects (netsurf's 12-source
 * bin.json over its 360-source core) stays complete. Packages with no
 * compilable entry (fonts, netsurf-demos, win32 — itself a source
 * package already) get NO unit: there is no "source code for the binary"
 * to carry. Every def declares srclib:{src:{<parent>:'.'}} — the payload
 * root as the source namespace — landing the tree at
 * /usr/local/src/<parent>/<repo-relative path> on install (the writable
 * srclib tier; /usr is the sealed image volume, so an install-time plant
 * under /usr/src is impossible by design — that path is the fold's).
 *
 * Node-only, and deliberately NOT part of listPackages: the -sources set
 * ships exclusively through the package repo (tools/mkpkg.js), so the
 * baked image, the fold, and boot.js --packages never see it and the
 * published blob cannot grow a byte by construction. `inputs` names the
 * repo-relative files whose CONTENT this synthesis read (the parent def /
 * os/image.json) for mkpkg's freshness scan; the closure files themselves
 * ride in the def as `bin` entries and are scanned as such. */
function sourcePackageDefs(fsMod, pathMod, rootDir, opts) {
  opts = opts || {};
  var pkgDir = opts.packagesDir || pathMod.join(rootDir, 'packages');
  var manifest = opts.imageManifest ||
    JSON.parse(fsMod.readFileSync(pathMod.join(rootDir, 'os', 'image.json'), 'utf-8'));
  var HDR_RE = /\.(h|hh|hpp|inc|def)$/i;
  var NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

  // The compile closure of one unit's root entries, as a sorted list of
  // repo-relative file paths.
  function closureOf(roots, label) {
    var files = {}, seenProj = {};
    function addFile(rel) { files[rel] = true; }
    function walkHeaders(dirRel) {
      var abs = pathMod.join(rootDir, dirRel);
      var ents;
      try { ents = fsMod.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
      ents.forEach(function (e) {
        if (e.name.charAt(0) === '.') return;
        if (e.isDirectory()) walkHeaders(dirRel + '/' + e.name);
        else if (e.isFile() && HDR_RE.test(e.name)) addFile(dirRel + '/' + e.name);
      });
    }
    function addProject(rel) {
      var n = normalizeRelPath(rel);
      if (seenProj[n]) return;
      seenProj[n] = true;
      var text;
      try { text = fsMod.readFileSync(pathMod.join(rootDir, n), 'utf-8'); }
      catch (e) { throw new Error(label + ': project ' + n + ' is unreadable (' + e.message + ')'); }
      addFile(n);
      var dir = n.slice(0, n.lastIndexOf('/'));
      var proj = JSON.parse(text);
      (proj.sources || []).forEach(function (s) { addFile(normalizeRelPath(dir + '/' + s)); });
      (proj.includes || []).forEach(function (inc) { walkHeaders(normalizeRelPath(dir + '/' + inc)); });
      (proj.deps || []).forEach(function (d) { addProject(dir + '/' + d); });
    }
    roots.forEach(function (entry) {
      if (entry.project !== undefined) addProject(entry.project);
      if (entry.c !== undefined) {
        addFile(normalizeRelPath('os/' + entry.c));
        (entry.hdrs || []).forEach(function (h) { addFile(normalizeRelPath('os/' + h)); });
      }
    });
    var out = Object.keys(files).sort();
    out.forEach(function (rel) {
      if (!validRelPath(rel))
        throw new Error(label + ': closure path ' + JSON.stringify(rel) + ' escapes the repo');
    });
    return out;
  }

  function makeUnit(parent, kind, version, roots, inputs, what) {
    var name = parent + '-sources';
    var label = "sources unit '" + name + "'";
    if (!NAME_RE.test(name))
      throw new Error(label + ': derived name is not a valid package name');
    var closure = closureOf(roots, label);
    if (!closure.length) throw new Error(label + ': empty source closure');
    var files = {};
    closure.forEach(function (rel) { files[rel] = { bin: rel }; });
    var srcns = {};
    srcns[parent] = '.';
    return {
      name: name,
      parent: parent,
      kind: kind,
      inputs: inputs,
      def: {
        name: name,
        version: version,
        summary: 'Source code for ' + what + ' — mechanical -sources companion, readable at /usr/local/src/' + parent,
        minBase: 0,
        files: files,
        srclib: { src: srcns },
      },
    };
  }

  var units = {};   // name -> unit; 'package' derivation wins over 'image'

  listPackages(fsMod, pathMod, rootDir, { packagesDir: pkgDir }).forEach(function (p) {
    var def;
    try { def = JSON.parse(fsMod.readFileSync(pathMod.join(pkgDir, p + '.json'), 'utf-8')); }
    catch (e) { return; }   // malformed → fails loud in buildPackage, not here
    var roots = [];
    Object.keys(def.files || {}).sort().forEach(function (rel) {
      var entry = def.files[rel];
      if (entry && (entry.project !== undefined || entry.c !== undefined)) roots.push(entry);
    });
    if (!roots.length) return;   // no compilable entry — no source to carry
    var u = makeUnit(p, 'package', String(def.version), roots,
      ['packages/' + p + '.json'], "the '" + p + "' package v" + def.version);
    units[u.name] = u;
  });

  Object.keys((manifest.system || {}).files || {}).sort().forEach(function (imgPath) {
    var entry = manifest.system.files[imgPath];
    if (!entry || (entry.project === undefined && entry.c === undefined)) return;
    var parent = imgPath.slice(imgPath.lastIndexOf('/') + 1).replace(/\.[A-Za-z0-9]+$/, '');
    if (units[parent + '-sources']) return;   // same software, packaged — package wins
    var u = makeUnit(parent, 'image', String(manifest.version | 0), [entry],
      ['os/image.json'], imgPath + ' (base image v' + (manifest.version | 0) + ')');
    units[u.name] = u;
  });

  // A -sources name colliding with a DECLARED package is a repo bug — the
  // synthesis must never silently shadow (or be shadowed by) a real def.
  listPackages(fsMod, pathMod, rootDir, { packagesDir: pkgDir, producers: ['clang', 'rust'] })
    .forEach(function (p) {
      if (units[p])
        throw new Error("sources synthesis: derived package '" + p +
          "' collides with the declared packages/" + p + '.json — rename one');
    });

  return Object.keys(units).sort().map(function (n) { return units[n]; });
}

/* ---- the `srclib` package section (win32 source-lib design §3.1) ----
 *
 * Shape validation shared by mkpkg (which also checks the mapped dirs
 * against the ASSEMBLED payload and copies the section into control.json)
 * and foldPackages (which checks them against the folded manifest and
 * plants the baked twin of gucman's install plant). Returns
 * { include: [payload-relative dir, ...], src: { ns: payload-relative dir } }.
 * Namespaces are `[a-z0-9_-]+`: builtin require names carry no '/', so
 * namespaced names (`<ns>/<file>.c`) can never collide with them.
 * A src dir of '.' names the PAYLOAD ROOT (todos #407): the mechanical
 * `-sources` packages mount their whole repo-mirroring payload as the
 * namespace, so the tree is browsable (and require-able) at
 * /usr/local/src/<name> without an artificial nesting dir. */
function validateSrclibShape(srclib, label) {
  if (typeof srclib !== 'object' || srclib === null || Array.isArray(srclib))
    throw new Error(label + ': srclib must be an object');
  Object.keys(srclib).forEach(function (k) {
    if (k !== 'include' && k !== 'src')
      throw new Error(label + ': srclib has an unknown key ' + JSON.stringify(k));
  });
  var include = srclib.include || [];
  if (!Array.isArray(include))
    throw new Error(label + ': srclib.include must be an array of payload-relative dirs');
  include.forEach(function (dir) {
    if (!validRelPath(dir))
      throw new Error(label + ': bad srclib include dir ' + JSON.stringify(dir));
  });
  var src = srclib.src || {};
  if (typeof src !== 'object' || src === null || Array.isArray(src))
    throw new Error(label + ': srclib.src must be a { namespace: payload-relative dir } map');
  Object.keys(src).forEach(function (ns) {
    if (!/^[a-z0-9_-]+$/.test(ns))
      throw new Error(label + ": srclib namespace '" + ns + "' must match [a-z0-9_-]+");
    if (src[ns] !== '.' && !validRelPath(src[ns]))
      throw new Error(label + ': bad srclib src dir ' + JSON.stringify(src[ns]) + " for namespace '" + ns + "'");
  });
  return { include: include, src: src };
}

/* ---- the `seed` package section (gucman content-resource design §1) ----
 *
 * `seed` is the CONTENT resource kind: `{ "<dest under /root>": "<payload-
 * relative src>" }`, planted by COPY (never a symlink — the user owns the
 * bytes afterwards and may edit them) with the additive desktop-defaults
 * semantics. Shape validation is shared by mkpkg (build time), foldPackages
 * (bake time — the fold is the pre-bake definition linter) and gucman
 * (install time, in C: the engine never trusts a payload). All three enforce
 * the SAME rules, restated in os/gucman/gucman.c's gm_safe_seed_rel:
 *
 *   1. dest is a relative path under /root — no absolute, no empty/"."/".."
 *      components (validRelPath).
 *   2. NO dest component may start with '.' (design §2.1, the load-bearing
 *      line): hidden user config is where planting a merely-ABSENT file
 *      changes system behavior — ~/.config/openwith is the highest cfgstore
 *      layer, ~/.win32reg the registry hive, ~/.recycle the trash store.
 *      One rule excises that whole channel, and it matches the convention
 *      that dotfiles never ride a payload (listTreeFiles, mkpkg's tar).
 *   3. src is payload-relative (same rules, dots allowed — it is package
 *      territory) and must name something in the ASSEMBLED payload; the
 *      caller cross-checks that against its own file set.
 *   4. No dest may sit INSIDE another dest: dest is the identity, so two
 *      entries writing one destination tree are malformed by construction.
 *      (Literal duplicate keys can't survive JSON.parse — last one wins —
 *      so the enforceable form of "one entry per dest" is this containment
 *      check.)
 *
 * Returns the map with dests SORTED, so control.json bytes and plant order
 * are deterministic. */
function validateSeedShape(seed, label) {
  if (typeof seed !== 'object' || seed === null || Array.isArray(seed))
    throw new Error(label + ': seed must be an object mapping "<dest under /root>" -> "<payload-relative src>"');
  var dests = Object.keys(seed).sort();
  var out = {};
  dests.forEach(function (dest) {
    if (!validRelPath(dest))
      throw new Error(label + ': seed dest ' + JSON.stringify(dest) +
        ' must be a relative path under /root (no absolute, empty, "." or ".." components)');
    dest.split('/').forEach(function (seg) {
      if (seg.charAt(0) === '.')
        throw new Error(label + ': seed dest ' + JSON.stringify(dest) +
          ' has a dot-prefixed component — a package never seeds hidden user config' +
          ' (~/.config/openwith, ~/.win32reg, ~/.recycle …; design §2.1)');
    });
    var src = seed[dest];
    if (typeof src !== 'string' || !validRelPath(src))
      throw new Error(label + ': seed ' + JSON.stringify(dest) + ' -> ' + JSON.stringify(src) +
        ' must name a payload-relative file or directory');
    out[dest] = src;
  });
  for (var i = 0; i < dests.length; i++) {
    for (var j = 0; j < dests.length; j++) {
      if (i !== j && dests[j].lastIndexOf(dests[i] + '/', 0) === 0)
        throw new Error(label + ': seed dest ' + JSON.stringify(dests[j]) + ' is inside ' +
          JSON.stringify(dests[i]) + ' — one seed entry per destination tree');
    }
  }
  return out;
}

/* The ONE control.json producer, shared by tools/mkpkg.js (the payload's
 * top-level member) and foldPackages (the baked twin planted at
 * /usr/opt/<name>/control.json). Same object, same key order, same
 * serialization — so the manifest a package INSTALLS and the manifest the
 * sealed blob carries for the same definition can never drift.
 *
 * Shape-validating sections (srclib, seed) are validated here; the caller
 * additionally cross-checks their payload references, which only it can see
 * (mkpkg against the assembled tar members, foldPackages against the folded
 * system section). */
function packageControl(pkg, label) {
  var control = {
    name: pkg.name,
    version: pkg.version,
    summary: pkg.summary || '',
    bin: pkg.bin || {},
    openwith: pkg.openwith || {},
    commands: pkg.commands || {},
    menu: pkg.menu || [],
    fonts: pkg.fonts || [],
  };
  if (pkg.desktop !== undefined) control.desktop = pkg.desktop;   // §5: absent = ineligible
  if (pkg.srclib !== undefined) {
    var sl = validateSrclibShape(pkg.srclib, label);
    control.srclib = { include: sl.include, src: sl.src };
  }
  if (pkg.seed !== undefined) control.seed = validateSeedShape(pkg.seed, label);
  return control;
}

function packageControlText(pkg, label) {
  return JSON.stringify(packageControl(pkg, label), null, 2) + '\n';
}

/* `control.json` at the payload root is RESERVED: it is the package's own
 * manifest (gucman materializes the verified one there at install, the fold
 * bakes its twin), so a definition claiming that path would let a payload
 * forge the manifest desktop-defaults reads back. Refused by both builders. */
function checkReservedPackageFiles(pkg, label) {
  if ((pkg.files || {})['control.json'] !== undefined)
    throw new Error(label + ': control.json is reserved at the payload root (it is the package manifest)');
}

/* ---- the require-block drift gate (source-lib design §4.4, Lane B2) ----
 *
 * The hand-written __require_source blocks in the win32 veneer WILL drift
 * from the lib.json truth without a tripwire. Given a repo-relative text
 * reader (string|null), cross-checks:
 *   - os/win32/include/windows.h's require set == lib.json ∪ menucore.json
 *     sources, as win32/<basename> (§4.1)
 *   - os/win32/menucore.h's require set == menucore.json sources (§4.1 —
 *     the menucore-only in-OS link set)
 *   - os/win32/gdi32.c's require set == vendor/freetype/lib.json sources,
 *     as freetype/<shim basename> (§4.2 — vendor knowledge stays with its
 *     consumer)
 *   - os/win32/include/gdiplusflat.h's require set == gdiplus.json sources,
 *     and os/win32/gdiplus.c's == the four decoder lib.jsons' sources
 *     (ticket #94 — the same §4.1/§4.2 pair, for the gdiplus component)
 *   - packages/win32.json SHIPS every veneer source under src/win32/ (the
 *     payload half — todos/0387). A require block can only name what the
 *     package actually plants: `0370` added listview.c to lib.json but to
 *     neither list, and the two halves fail in different places — the
 *     missing require is a loud mkpkg refusal, the missing PAYLOAD file
 *     builds fine host-side and dies IN-OS at the first `#include
 *     <windows.h>` (unresolvable required source -> every win32 app stops
 *     compiling). One direction only: files the payload ships that no
 *     lib.json source backs are deliberate (wwinmain.c, the headers).
 * Returns an array of human-readable mismatch strings (empty = in sync).
 * Callers fail LOUD: tools/mkpkg.js refuses to build the win32 package,
 * tools/win32ports.js fails its run and its --check (the kernel-suite
 * tripwire). */
function win32RequireDriftErrors(readText) {
  function mustRead(relPath) {
    var text = readText(relPath);
    if (text === null || text === undefined)
      throw new Error('require-drift gate: cannot read ' + relPath);
    return text;
  }
  function requiresOf(relPath) {
    var out = [], re = /^__require_source\("([^"]+)"\);/gm, m;
    var text = mustRead(relPath);
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }
  function sourcesOf(relPath, ns) {
    return (JSON.parse(mustRead(relPath)).sources || []).map(function (s) {
      return ns + '/' + s.replace(/^.*\//, '');
    });
  }
  function diff(label, actual, expected) {
    var errs = [], a = {}, e = {};
    actual.forEach(function (n) { a[n] = true; });
    expected.forEach(function (n) { e[n] = true; });
    expected.forEach(function (n) {
      if (!a[n]) errs.push(label + ' is missing __require_source("' + n + '") (require-block drift, design §4.4)');
    });
    actual.forEach(function (n) {
      if (!e[n]) errs.push(label + ' has a stray __require_source("' + n + '") no lib.json source backs (require-block drift, design §4.4)');
    });
    return errs;
  }
  // packages/win32.json's `files` map keys the payload by its own layout;
  // the veneer TUs live under src/win32/ (srclib's {win32: src/win32} tier).
  function shippedOf(relPath) {
    var files = JSON.parse(mustRead(relPath)).files || {}, pre = 'src/win32/';
    return Object.keys(files)
      .filter(function (k) { return k.slice(0, pre.length) === pre; })
      .map(function (k) { return 'win32/' + k.slice(pre.length); });
  }
  function unshipped(label, shipped, expected) {
    var s = {};
    shipped.forEach(function (n) { s[n] = true; });
    return expected.filter(function (n) { return !s[n]; }).map(function (n) {
      return label + ' does not ship "src/' + n + '", which the veneer requires'
        + ' (require-block drift, design §4.4)';
    });
  }
  var veneer = sourcesOf('os/win32/lib.json', 'win32')
    .concat(sourcesOf('os/win32/menucore.json', 'win32'));
  /* gdiplus (ticket #94) is the third split component, on the menucore
   * pattern: gdiplusflat.h names its own TU (§4.1) and gdiplus.c names
   * its four vendor decoders (§4.2). It is NOT part of `veneer` — no
   * windows.h consumer should pull an image decoder — but packages/
   * win32.json must still SHIP it, so it joins the payload half. */
  var gdiplus = sourcesOf('os/win32/gdiplus.json', 'win32');
  var gdiplusVendor = sourcesOf('vendor/libpng/lib.json', 'png')
    .concat(sourcesOf('vendor/zlib/lib.json', 'z'))
    .concat(sourcesOf('vendor/libjpeg/lib.json', 'jpeg'))
    .concat(sourcesOf('vendor/netsurf/libnsgif/lib.json', 'nsgif'))
    .concat(sourcesOf('vendor/netsurf/libnsbmp/lib.json', 'nsbmp'));
  return diff('os/win32/include/windows.h',
      requiresOf('os/win32/include/windows.h'), veneer)
    .concat(unshipped('packages/win32.json',
      shippedOf('packages/win32.json'), veneer.concat(gdiplus)))
    .concat(diff('os/win32/menucore.h',
      requiresOf('os/win32/menucore.h'), sourcesOf('os/win32/menucore.json', 'win32')))
    .concat(diff('os/win32/include/gdiplusflat.h',
      requiresOf('os/win32/include/gdiplusflat.h'), gdiplus))
    .concat(diff('os/win32/gdiplus.c',
      requiresOf('os/win32/gdiplus.c'), gdiplusVendor))
    .concat(diff('os/win32/gdi32.c',
      requiresOf('os/win32/gdi32.c'), sourcesOf('vendor/freetype/lib.json', 'freetype')));
}

/* which: 'all' | array of names | [] (fold nothing). Returns
 * { manifest, names } — `manifest` is a deep copy with the packages folded
 * into the system section and `packagesBaked` set (which bakeSystemImage
 * records as the os-release PACKAGES= line); with an empty fold the input
 * manifest is returned untouched. Throws on unknown names and on any
 * malformed package definition (loud, before a ~minute-long bake — the
 * overlay discipline).
 *
 * opts.packagesDir overrides where definitions are read from (default
 * <rootDir>/packages) — the listPackages seam, exposed so a test can bake
 * and boot a throwaway definition without writing into the repo's packages/
 * dir, which is a bake input AND a shared mkpkg input for every other
 * concurrently running test. */
function foldPackages(fsMod, pathMod, rootDir, manifest, which, opts) {
  opts = opts || {};
  var pkgDir = opts.packagesDir || pathMod.join(rootDir, 'packages');
  var avail = listPackages(fsMod, pathMod, rootDir, { packagesDir: pkgDir });
  var names = which === 'all' ? avail : (which || []).slice().sort();
  names.forEach(function (n) {
    if (avail.indexOf(n) < 0)
      throw new Error("unknown package '" + n + "' (declared in packages/: " + (avail.join(', ') || 'none') + ')');
  });
  if (!names.length) return { manifest: manifest, names: [] };
  var m = JSON.parse(JSON.stringify(manifest));
  m.system = m.system || {};
  m.system.dirs = m.system.dirs || [];
  m.system.files = m.system.files || {};
  var dirSeen = {};
  m.system.dirs.forEach(function (d) { dirSeen[d] = true; });
  function pushDir(d) {
    if (!dirSeen[d]) { dirSeen[d] = true; m.system.dirs.push(d); }
  }
  function claim(pkgName, p, entry) {
    if (m.system.files[p])
      throw new Error("package '" + pkgName + "': " + p + ' conflicts with an existing image entry');
    m.system.files[p] = entry;
  }
  var cmdaltClaims = '';   // todos/0338: folded `commands` claims, spliced below
  names.forEach(function (name) {
    var pkg = JSON.parse(fsMod.readFileSync(
      pathMod.join(pkgDir, name + '.json'), 'utf-8'));
    if (pkg.name !== name)
      throw new Error('packages/' + name + '.json declares name ' + JSON.stringify(pkg.name));
    checkReservedPackageFiles(pkg, "package '" + name + "'");
    var bin = pkg.bin || {};
    var base = '/usr/opt/' + name;
    pushDir('/usr/opt');
    pushDir(base);
    Object.keys(pkg.files || {}).sort().forEach(function (rel) {
      if (!validRelPath(rel))
        throw new Error("package '" + name + "': bad file path " + JSON.stringify(rel));
      var entry = pkg.files[rel];
      if (entry.link !== undefined)
        throw new Error("package '" + name + "': " + rel + ' — link entries are not supported in packages (v1 tar+gzip payloads carry files and dirs only)');
      if (entry.tree !== undefined) {
        // Recursive directory copy (§3.2): one `bin` (repo-relative bytes)
        // entry per enumerated file; dirs derive from the file paths.
        var treeFiles = listTreeFiles(fsMod, pathMod, rootDir, entry,
          "package '" + name + "': " + rel);
        treeFiles.forEach(function (tf) {
          var tparts = (rel + '/' + tf).split('/'), tcur = base;
          for (var ti = 0; ti < tparts.length - 1; ti++) { tcur += '/' + tparts[ti]; pushDir(tcur); }
          claim(name, base + '/' + rel + '/' + tf, { bin: entry.tree + '/' + tf });
        });
        return;
      }
      var parts = rel.split('/'), cur = base;
      for (var i = 0; i < parts.length - 1; i++) { cur += '/' + parts[i]; pushDir(cur); }
      claim(name, base + '/' + rel, entry);
    });
    if (pkg.srclib !== undefined) {
      // The baked twin of gucman's srclib install plant (§3.1): both
      // visible tiers are symlink farms over the payload — per TOP-LEVEL
      // entry for include dirs (files or subdirs, so a freetype/ header
      // tree rides as one link), one link per source namespace. /usr/include
      // and /usr/src join the system dir set the moment any folded package
      // carries srclib; collisions across packages are claim()'s loud throw.
      var sl = validateSrclibShape(pkg.srclib, "package '" + name + "'");
      sl.include.forEach(function (dir) {
        var payloadDir = base + '/' + dir;
        if (!dirSeen[payloadDir])
          throw new Error("package '" + name + "': srclib include dir " + dir + ' is not in the payload');
        pushDir('/usr/include');
        var tops = {};
        Object.keys(m.system.files).forEach(function (p) {
          if (p.lastIndexOf(payloadDir + '/', 0) === 0)
            tops[p.slice(payloadDir.length + 1).split('/')[0]] = true;
        });
        Object.keys(tops).sort().forEach(function (t) {
          claim(name, '/usr/include/' + t, { link: payloadDir + '/' + t });
        });
      });
      Object.keys(sl.src).sort().forEach(function (ns) {
        var payloadDir = sl.src[ns] === '.' ? base : base + '/' + sl.src[ns];
        if (!dirSeen[payloadDir])
          throw new Error("package '" + name + "': srclib src dir " + sl.src[ns] + ' is not in the payload');
        pushDir('/usr/src');
        claim(name, '/usr/src/' + ns, { link: payloadDir });
      });
    }
    Object.keys(bin).sort().forEach(function (cmd) {
      var rel = bin[cmd];
      if (!(pkg.files || {})[rel])
        throw new Error("package '" + name + "': bin " + cmd + ' -> ' + rel + ' names no package file');
      claim(name, '/usr/bin/' + cmd, { link: base + '/' + rel });
    });
    (pkg.menu || []).forEach(function (me) {
      if (!validRelPath(me.group) || me.group.indexOf('/') >= 0 ||
          !validRelPath(me.entry) || me.entry.indexOf('/') >= 0 || !bin[me.cmd])
        throw new Error("package '" + name + "': bad menu entry " + JSON.stringify(me));
      pushDir('/usr/share/menu/' + me.group);
      claim(name, '/usr/share/menu/' + me.group + '/' + me.entry, { link: '/usr/bin/' + me.cmd });
    });
    Object.keys(pkg.openwith || {}).sort().forEach(function (ext) {
      var cmd = pkg.openwith[ext];
      if (!bin[cmd])
        throw new Error("package '" + name + "': openwith " + ext + ' -> ' + cmd + ' names no bin command');
      var ow = m.system.files['/usr/share/openwith'];
      if (!ow || ow.content === undefined)
        throw new Error('folding package openwith keys needs an inline-content /usr/share/openwith seed');
      ow.content += ext + '\t/bin/' + cmd + '\n';
    });
    // `commands` (todos/0338): the package CLAIMS a dispatched command name.
    // The runtime twin is gucman APPENDING the same key+value line to
    // /etc/cmdalt, which outranks the baked suggestion — so the folded
    // claims are collected here and spliced in AHEAD of the baked
    // /usr/share/cmdalt body below, keeping the fat bake and a real install
    // resolving identically (first line for a key wins; append-not-replace
    // is what gives the picker its candidate set).
    Object.keys(pkg.commands || {}).sort().forEach(function (name2) {
      var cmd = pkg.commands[name2];
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name2))   // gm_valid_name's alphabet
        throw new Error("package '" + name + "': commands key " + JSON.stringify(name2) + ' is not a command name');
      if (!bin[cmd])
        throw new Error("package '" + name + "': commands " + name2 + ' -> ' + cmd + ' names no bin command');
      cmdaltClaims += name2 + '\t/bin/' + cmd + '\n';
    });
    // `fonts` (fallback-chain faces, Unicode Phase D) deliberately do NOT
    // fold: they never lived in the baked /usr (nothing for the fat image
    // to restore), they'd add tens of MB to every dev/test image fetch,
    // and — /usr being read-only while the /etc fallback layer CONCATS
    // ahead of the baked one — a folded face could never be removed, so
    // the no-package tofu state (a real deploy state) would be untestable
    // on the fat fixture. Install/remove is fully exercisable on any
    // image via gucman's /etc/fonts/fallback delta. Validate loudly here
    // (the fold is still the pre-bake definition linter), plant nothing.
    (pkg.fonts || []).forEach(function (rel) {
      if (!(pkg.files || {})[rel])
        throw new Error("package '" + name + "': fonts " + rel + ' names no package file');
    });
    // `seed` (the content resource kind, design §1.3 layer 2): validate the
    // shape and cross-check every src against the FOLDED payload. The seeds
    // themselves are NOT folded into the manifest's `user` section — that
    // route was checked and rejected (§0.4/§8.2: the browser seeds fresh
    // roots from the RAW fetched image.json, so folded user entries work
    // headless and silently no-op in every real browser). They are planted
    // instead from the blob, by seedBakedSeeds at first boot and by
    // desktop-defaults' phase 3 afterwards — both driven by the control.json
    // claimed below, which is version-locked to the blob by construction.
    if (pkg.seed !== undefined) {
      var seed = validateSeedShape(pkg.seed, "package '" + name + "'");
      Object.keys(seed).forEach(function (dest) {
        var abs = base + '/' + seed[dest];
        if (!m.system.files[abs] && !dirSeen[abs])
          throw new Error("package '" + name + "': seed " + dest + ' -> ' + seed[dest] +
            ' is not in the payload');
      });
    }
    // The package's own manifest, baked beside its payload — the twin of the
    // /opt/<name>/control.json a gucman install materializes. Byte-identical
    // to the payload's copy (one packageControl producer), which is what
    // lets desktop-defaults read installed and built-in packages through the
    // SAME code path (design §5).
    claim(name, base + '/control.json',
      { content: packageControlText(pkg, "package '" + name + "'") });
  });
  if (cmdaltClaims) {
    var ca = m.system.files['/usr/share/cmdalt'];
    if (!ca || ca.content === undefined)
      throw new Error('folding package commands claims needs an inline-content /usr/share/cmdalt seed');
    ca.content = cmdaltClaims + ca.content;
  }
  m.packagesBaked = names;
  return { manifest: m, names: names };
}

/* ---- the baked Desktop-defaults rendering (source-lib design §6.1, Lane D) ----
 *
 * foldDesktopDefaults(manifest) -> manifest' — a PURE transform (no fs, no
 * clock; it runs inside bakeSystemImage, which the browser worker's
 * fallback bake also calls): every `user.dirs` entry under /root/Desktop
 * and every `user.files` entry under /root/Desktop/ gains a TWIN system
 * entry at /usr/share/desktop/default/<rel>. The manifest stays the single
 * author-side truth; the sealed blob carries a rendered copy version-locked
 * to it, which /usr/bin/desktop-defaults (os/deskdefaults.c) re-applies
 * ADDITIVELY onto the live Desktop. Entries ride verbatim (deep-copied):
 * links stay links (absolute /usr/bin targets), launcher scripts and deck
 * data keep their kinds, modes and `optional` semantics. The Recycle Bin
 * is not in the manifest, so it never enters the default set (wm.c's
 * ensure_recycle stays its owner); non-Desktop user seeds (doom1.wad,
 * roms, /etc/profile) are naturally outside the prefix filter. With no
 * user Desktop entries the input manifest is returned untouched (the
 * foldPackages empty-fold identity rule). */
function foldDesktopDefaults(manifest) {
  var PRE = '/root/Desktop';
  var BASE = '/usr/share/desktop/default';
  var user = manifest.user || {};
  var underPrefix = function (p) { return p.lastIndexOf(PRE + '/', 0) === 0; };
  var dirs = (user.dirs || []).filter(function (d) {
    return d === PRE || underPrefix(d);
  });
  var fileKeys = Object.keys(user.files || {}).filter(underPrefix).sort();
  if (!dirs.length && !fileKeys.length) return manifest;
  var m = JSON.parse(JSON.stringify(manifest));
  m.system = m.system || {};
  m.system.dirs = m.system.dirs || [];
  m.system.files = m.system.files || {};
  var dirSeen = {};
  m.system.dirs.forEach(function (d) { dirSeen[d] = true; });
  function pushDir(d) {
    if (!dirSeen[d]) { dirSeen[d] = true; m.system.dirs.push(d); }
  }
  var twin = function (p) { return BASE + p.slice(PRE.length); };
  pushDir('/usr/share');
  pushDir('/usr/share/desktop');
  pushDir(BASE);
  // user.dirs is parent-before-child (seedEntries mkdirs in order) — the
  // twins inherit that; file parents derive too, so a file whose parent
  // dir the manifest forgot to list still bakes.
  dirs.forEach(function (d) { if (d !== PRE) pushDir(twin(d)); });
  fileKeys.forEach(function (p) {
    var t = twin(p);
    var parts = t.slice(BASE.length + 1).split('/'), cur = BASE;
    for (var i = 0; i < parts.length - 1; i++) { cur += '/' + parts[i]; pushDir(cur); }
    if (m.system.files[t])
      throw new Error('foldDesktopDefaults: ' + t + ' conflicts with an existing image entry');
    m.system.files[t] = JSON.parse(JSON.stringify(user.files[p]));
  });
  return m;
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

/* ---- manifest referential integrity (ticket #434) ----
 *
 * v223 shipped three Desktop launchers invoking `sameboy` after #417/#418
 * moved that binary out of the baked set — dead icons on a clean first
 * boot. An un-bake is a GRAPH EDIT: every launcher script, menu entry,
 * symlink and config seed is an edge, and removing a node must fail the
 * BUILD while an edge still points at it. checkManifestRefs is that check:
 * pure (no fs, no clock), run by bakeSystemImage on every bake path
 * (mkimage, boot.js, the in-worker fallback) BEFORE the expensive
 * seed/compile work, over the manifest it was handed — so a minimal bake
 * is checked against the minimal namespace and a --packages fold against
 * the folded one, which is exactly the per-shape answer that would have
 * caught v223.
 *
 * The namespace is the manifest itself (system+user dirs/files/links,
 * parents implied) plus what the boot plants outside it: the root skeleton
 * (initRootVolume), /bin -> /usr/bin, /usr/local -> /var/local, and
 * /usr/share/os-release. `optional` entries count as present — they are
 * data (ROMs), and the honest gap when their asset is missing is the
 * seed-time skip log, not a build refusal.
 *
 * What is checked — and the lines that keep the result RAGGED (a checker
 * that flags everything is a matcher bug, the #434 negative controls):
 *   - `link` entries: the target must resolve (through /bin, /usr/local
 *     and manifest links; hop-capped).
 *   - `content` entries starting with `#!`: the interpreter must resolve,
 *     and the body is scanned as shell. COMMAND-POSITION words must
 *     resolve — bare words on the boot PATH (/usr/local/bin:/bin),
 *     absolute words only when they sit in SEALED territory (/usr, /bin):
 *     an absolute path under /opt, /root, /var, /tmp is runtime state
 *     (the cpython launcher's installed-prefix probe) and is never
 *     checked. Absolute-path ARGUMENTS follow the same territory rule
 *     (the Demos entries' deck files must be baked; a /tmp scratch path
 *     is nobody's business). Shell keywords are structure, not commands;
 *     builtins and data-arg commands ([/test/echo/...) are never resolved
 *     and their args never path-checked — `[ -f /usr/include/png.h ]` is
 *     an honest ABSENCE probe (the minesweeper sample) and must not be
 *     flagged; wrappers (exec/command/env/term/...) pass through to the
 *     wrapped command; `sh -c "…"` recurses into the quoted body; any
 *     `$…`/backtick/glob token is dynamic — statically unknowable, so
 *     skipped, never guessed at.
 *   - the openwith and sounds-scheme seeds: their values are commands /
 *     WAV paths that must be baked (same dead-reference class as a
 *     launcher). The cmdalt seed is EXEMPT by design: its values name
 *     PACKAGES (`python  cpython-clang` is a role suggestion), and an
 *     unresolvable pick is cmdalt's specified loud-127-with-a-named-fix
 *     path (todos/0338), not a dead icon.
 *
 * Returns an array of error strings (empty = clean); bakeSystemImage
 * throws on any. Exported for the tests/host/test_manifest_refs.js legs.
 */
function checkManifestRefs(manifest) {
  var errs = [];

  /* -- the namespace: manifest paths + the out-of-manifest plants -- */
  var nodes = {};   // path -> {kind: 'file'|'dir'|'link', target}
  function addImplicitParents(p) {
    var i = p.lastIndexOf('/');
    while (i > 0) {
      p = p.slice(0, i);
      if (!nodes[p]) nodes[p] = { kind: 'dir' };
      i = p.lastIndexOf('/');
    }
  }
  function addNode(p, node) { nodes[p] = node; addImplicitParents(p); }
  ['/', '/etc', '/var', '/var/local', '/var/local/bin', '/tmp', '/root',
   '/run', '/dev', '/usr'].forEach(function (d) { nodes[d] = { kind: 'dir' }; });
  addNode('/bin', { kind: 'link', target: '/usr/bin' });          // initRootVolume
  addNode('/usr/local', { kind: 'link', target: '/var/local' });  // bakeSystemImage
  addNode('/usr/share/os-release', { kind: 'file' });
  ['system', 'user'].forEach(function (sec) {
    var s = manifest[sec] || {};
    (s.dirs || []).forEach(function (d) { addNode(d, { kind: 'dir' }); });
    var files = s.files || {};
    Object.keys(files).forEach(function (p) {
      var e = files[p];
      addNode(p, e.link !== undefined ? { kind: 'link', target: e.link }
                                      : { kind: 'file' });
    });
  });

  function normalizePath(p) {
    var out = [];
    p.split('/').forEach(function (seg) {
      if (seg === '' || seg === '.') return;
      if (seg === '..') { out.pop(); return; }
      out.push(seg);
    });
    return '/' + out.join('/');
  }
  // Resolve through links (hop-capped); null when the walk leaves the
  // namespace. Follows a final-component link too — a link's TARGET is
  // the reference under test.
  function resolvePath(p) {
    var hops = 0;
    p = normalizePath(p);
    for (;;) {
      var comps = p === '/' ? [] : p.slice(1).split('/');
      var cur = '', redirected = false;
      for (var i = 0; i < comps.length; i++) {
        cur += '/' + comps[i];
        var n = nodes[cur];
        if (!n) return null;
        if (n.kind === 'link') {
          if (++hops > 8) return null;   // cycle / silly chain
          var t = n.target.charAt(0) === '/' ? n.target
            : cur.slice(0, cur.lastIndexOf('/') + 1) + n.target;
          var rest = comps.slice(i + 1).join('/');
          p = normalizePath(rest ? t + '/' + rest : t);
          redirected = true;
          break;
        }
      }
      if (!redirected) return comps.length ? nodes[p] : nodes['/'];
    }
  }
  // The boot PATH every launcher context shares (hush login PATH; wm.c's
  // children get /bin, a strict subset — checking the superset can only
  // under-flag /usr/local/bin, which is EMPTY at first boot anyway).
  function resolveCommand(word) {
    if (word.charAt(0) === '/') return resolvePath(word);
    if (word.indexOf('/') >= 0) return { kind: 'relative' };  // cwd-dependent
    return resolvePath('/usr/local/bin/' + word) || resolvePath('/bin/' + word);
  }
  // Sealed territory: immutable at runtime, so an absolute reference into
  // it either resolves in THIS image or never will.
  var RO_PREFIX = /^\/(usr|bin)(\/|$)/;

  /* -- shell scanning -- */
  var mkset = function (s) {
    var o = {}; s.split(' ').forEach(function (w) { o[w] = true; }); return o;
  };
  // Structure words: never commands; command position continues after them.
  var KEYWORDS = mkset('if then else elif fi while until do done esac in ! { }');
  // hush builtins + commands whose arguments are data or honest absence
  // probes — the command itself is not a reference and its args are never
  // path-checked ([ -f X ] asks; a dangling launcher target asserts).
  var NO_CHECK = mkset('cd set export local read readonly return exit shift ' +
    'trap umask unset wait eval source . : true false break continue echo ' +
    'printf test [ type ulimit getopts hash kill alias');
  // Wrappers: the NEXT word is again a command. 'cmd' entries are real
  // binaries that must themselves resolve; 'builtin' entries are shell.
  var PASS_THROUGH = { exec: 'builtin', command: 'builtin', time: 'builtin',
                       env: 'cmd', nohup: 'cmd', term: 'cmd', xargs: 'cmd' };

  // One line -> tokens: {word, dyn, quoted, glob} or {op}. Minimal POSIX
  // quoting; a `#` starting an unquoted word comments the rest of the line.
  function tokenizeShellLine(line) {
    var toks = [], i = 0, n = line.length;
    while (i < n) {
      var c = line.charAt(i);
      if (c === ' ' || c === '\t') { i++; continue; }
      var two = line.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>' || two === '2>') {
        toks.push({ op: two }); i += 2; continue;
      }
      if (';|&()<>'.indexOf(c) >= 0) { toks.push({ op: c }); i++; continue; }
      var word = '', dyn = false, quoted = false, glob = false, started = i;
      while (i < n) {
        c = line.charAt(i);
        if (c === "'") {
          quoted = true; i++;
          while (i < n && line.charAt(i) !== "'") { word += line.charAt(i); i++; }
          i++; continue;
        }
        if (c === '"') {
          quoted = true; i++;
          while (i < n && line.charAt(i) !== '"') {
            var q = line.charAt(i);
            if (q === '$' || q === '`') dyn = true;
            if (q === '\\' && i + 1 < n) { i++; word += line.charAt(i); i++; continue; }
            word += q; i++;
          }
          i++; continue;
        }
        if (' \t;|&()<>'.indexOf(c) >= 0) break;
        if (c === '#' && i === started && !quoted) return toks;  // comment
        if (c === '$' || c === '`') dyn = true;
        if (c === '*' || c === '?' || c === '~') glob = true;
        if (c === '\\' && i + 1 < n) { i++; word += line.charAt(i); i++; continue; }
        word += c; i++;
      }
      toks.push({ word: word, dyn: dyn, quoted: quoted, glob: glob });
    }
    return toks;
  }

  function scanShellLine(line, where) {
    var toks = tokenizeShellLine(line);
    // mode: how the current command's ARGUMENTS are treated.
    var cmdPos = true, mode = 'check', skipNext = false;
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k];
      if (tk.op !== undefined) {
        if (tk.op === '>' || tk.op === '>>' || tk.op === '<' || tk.op === '2>') {
          skipNext = true;        // redirection target: created, not referenced
          continue;
        }
        cmdPos = true; mode = 'check'; skipNext = false;
        continue;
      }
      if (skipNext) { skipNext = false; continue; }
      var w = tk.word;
      if (w === '') continue;
      if (cmdPos) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;   // VAR=… prefix
        if (tk.dyn) { mode = 'skip'; cmdPos = false; continue; }  // "$0" etc.
        if (KEYWORDS[w]) continue;
        if (w === 'for' || w === 'case') { mode = 'skip'; cmdPos = false; continue; }
        if (w.charAt(0) === '-') continue;                  // wrapper flag (env -i)
        cmdPos = false;
        if (PASS_THROUGH[w]) {
          if (PASS_THROUGH[w] === 'cmd' && !resolveCommand(w))
            errs.push(where + ": command '" + w + "' is not in the image");
          cmdPos = true;
          continue;
        }
        if (NO_CHECK[w]) { mode = 'skip'; continue; }
        if (w === 'sh' || w === '/bin/sh' || w === '/usr/bin/sh') { mode = 'sh'; continue; }
        if (tk.glob) { mode = 'skip'; continue; }
        if (w.charAt(0) === '/') {
          if (RO_PREFIX.test(w) && !resolvePath(w))
            errs.push(where + ": command '" + w + "' is not in the image");
          mode = 'check';
          continue;
        }
        if (w.indexOf('/') >= 0) { mode = 'skip'; continue; }  // ./built-at-runtime
        if (!resolveCommand(w))
          errs.push(where + ": command '" + w +
            "' not found on PATH (/usr/local/bin:/bin) in the image");
        mode = 'check';
        continue;
      }
      // argument position
      if (mode === 'skip') continue;
      if (mode === 'sh') { if (w === '-c') mode = 'shbody'; continue; }
      if (mode === 'shbody') {
        if (!tk.dyn) scanShellText(w, where + ' [sh -c]');
        mode = 'skip';
        continue;
      }
      if (tk.dyn || tk.glob) continue;
      if (w.charAt(0) === '/' && RO_PREFIX.test(w) && !resolvePath(w))
        errs.push(where + ": path '" + w + "' is not in the image");
    }
  }
  function scanShellText(text, where) {
    text.split('\n').forEach(function (line) { scanShellLine(line, where); });
  }
  function scanScript(imgPath, content) {
    var nl = content.indexOf('\n');
    var shebang = (nl < 0 ? content : content.slice(0, nl)).slice(2);
    var interp = shebang.split(/[ \t]+/).filter(function (s) { return s; })[0];
    if (interp && !resolvePath(interp))
      errs.push(imgPath + ": interpreter '" + interp + "' is not in the image");
    if (nl >= 0) scanShellText(content.slice(nl + 1), imgPath);
  }

  /* -- the reference sweep -- */
  ['system', 'user'].forEach(function (sec) {
    var files = (manifest[sec] || {}).files || {};
    Object.keys(files).sort().forEach(function (p) {
      var e = files[p];
      if (e.link !== undefined && !resolvePath(e.link))
        errs.push(p + ": link target '" + e.link + "' is not in the image");
      if (typeof e.content === 'string' && e.content.slice(0, 2) === '#!')
        scanScript(p, e.content);
    });
  });

  // Config seeds whose VALUES are references (per-store grammar; a manifest
  // without the seed — the tiny test manifests — simply has nothing to check).
  var sysFiles = (manifest.system || {}).files || {};
  function seedLines(p) {
    var e = sysFiles[p];
    if (!e || typeof e.content !== 'string') return [];
    return e.content.split('\n').filter(function (l) {
      return l && l.charAt(0) !== '#';
    });
  }
  seedLines('/usr/share/openwith').forEach(function (l) {
    var m = /^(\S+)[ \t]+(\S+)/.exec(l);
    if (!m) return;
    var cmd = m[2];
    if (!(cmd.charAt(0) === '/' ? resolvePath(cmd) : resolveCommand(cmd)))
      errs.push("/usr/share/openwith: '" + m[1] + "' opens with '" + cmd +
        "', which is not in the image");
  });
  seedLines('/usr/share/sounds/scheme').forEach(function (l) {
    var m = /^(\S+)[ \t]+(\S+)/.exec(l);
    if (!m || m[1] === 'mute' || m[2] === 'none') return;
    if (!resolvePath(m[2]))
      errs.push("/usr/share/sounds/scheme: event '" + m[1] + "' plays '" +
        m[2] + "', which is not in the image");
  });
  // /usr/share/cmdalt: deliberately NOT checked — see the block comment.

  return errs;
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
  // Referential integrity FIRST (ticket #434): a dangling launcher/menu/
  // symlink reference fails the bake loudly before any expensive work.
  // Pre-foldDesktopDefaults on purpose — the default-Desktop twins are
  // verbatim copies, so checking them too would only duplicate errors.
  var refErrs = checkManifestRefs(manifest);
  if (refErrs.length)
    throw new Error('manifest referential-integrity check failed (#434 — a baked ' +
      'entry references something not in this image):\n  ' + refErrs.join('\n  '));
  // The default-Desktop rendering (§6.1) folds here — the ONE bake choke
  // point, so mkimage/boot.js/the in-worker fallback bake all agree.
  manifest = foldDesktopDefaults(manifest);
  // Overlays (todos/0118): read + verify BEFORE the ~minute-long bake so a bad
  // flag fails fast. Off by default — an empty/absent io.overlays leaves the
  // base bake byte-identical to today (no overlay dirs, files, provenance, or
  // os-release OVERLAYS line are written).
  var overlaySpecs = io.overlays || [];
  var loadedOverlays = overlaySpecs.length
    ? loadOverlays(overlaySpecs, io.overlayIo, !!io.requireCleanOverlays, log)
    : [];
  if (sysStore.size() >= 256) sysStore.setBytes(0, new Uint8Array(256)); // force format
  // Deterministic bake clock (todos/0249): every inode a/m/c/btime in the
  // sealed blob comes from BlockFS._now(); with the wall clock two bakes of
  // an identical tree differ → different sha256 → the deploy's
  // content-hashed image name churns on every rebuild. Stamp everything
  // with ONE manifest-version-derived instant instead: unchanged tree →
  // unchanged version → byte-identical blob, and a higher version always
  // stamps later than a lower one (an upgraded /usr never looks older than
  // its predecessor). BAKE-ONLY — live volumes keep the real Date.now()
  // (createV4's default); the throwaway tmpRoot gets it too so the whole
  // bake namespace shares one clock. Epoch base: gucOS's own era, so ls -l
  // in-OS reads as an obviously synthetic 2026 stamp, not 1970.
  var bakeEpochMs = Date.UTC(2026, 0, 1) + (manifest.version | 0) * 1000;
  var bakeClock = function () { return bakeEpochMs; };
  var sys = BLOCK_FS.createV4(sysStore, { noDevNodes: true, clock: bakeClock });
  var tmpRoot = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(1 << 20), { noDevNodes: true, clock: bakeClock });
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
    if (manifest.packagesBaked && manifest.packagesBaked.length) {
      // Second identity axis (see foldPackages): a fat and a minimal blob
      // share a VERSION_ID; gates that want a specific set read this back
      // through bakedPackages.
      rel += 'PACKAGES=' + manifest.packagesBaked.join(',') + '\n';
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

/* The package set a blob was baked with (its os-release PACKAGES= line —
 * written only when foldPackages folded any in), as a SORTED array of
 * names, or [] for a minimal blob / anything unreadable. The packages twin
 * of bakedOverlays. */
function bakedPackages(BLOCK_FS, store) {
  try {
    var fs = BLOCK_FS.createV4(store, { readonly: true });
    var t = readFileText(fs, '/share/os-release');
    if (t === null) return [];
    var m = /(?:^|\n)PACKAGES=([^\n]*)/.exec(t);
    if (!m) return [];
    return m[1].split(',').filter(function (s) { return s; }).sort();
  } catch (e) {
    return [];
  }
}

/* normalizeRelPath("a/b/../c") -> "a/c" — buildProject's rule, hoisted so
 * the freshness scans resolve a project's dep/source/include paths exactly
 * the way the builder does. */
function normalizeRelPath(p) {
  var out = [];
  p.split('/').forEach(function (seg) {
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (seg !== '.') out.push(seg);
  });
  return out.join('/');
}

/* ---- a project's out-of-directory inputs (todos/0354) ----
 *
 * projectExternalDirs(proj, dir) -> [repo-relative dir, ...]
 * The directories a bin.json/lib.json at `dir` pulls bake inputs from that
 * lie OUTSIDE `dir` itself. buildProject expands a project through five
 * path-bearing keys — `deps` (recursed as projects) plus `sources`,
 * `includes`, `srcRoots` and `-I` compilerArgs — but the freshness scans
 * only ever enrolled `deps` and the project's own directory. A source
 * reached from a foreign tree was therefore in NEITHER set: the five
 * seeded consumers of `vendor/cjson/cJSON.c` list it under `sources`, so
 * editing it changed five baked binaries while every gate read the blob
 * fresh — a silent no-op edit, the exact failure 0082 exists to prevent.
 *
 * DIRECTORIES, not files, even for a `sources` entry: that is the
 * granularity the rest of the scan already uses, and for the same reason —
 * a quoted include resolves beside its source (cJSON.c's cJSON.h), so file
 * granularity would leave the identical false green one header away.
 * Paths at or under `dir` are dropped: the caller walks that tree already.
 * Over-invalidation stays the cheap direction. */
function projectExternalDirs(proj, dir) {
  if (!dir) return [];   // a project at the repo root: the caller walks everything
  var out = [], seen = {};
  function addDir(d) {
    if (d === dir || d.indexOf(dir + '/') === 0) return;
    if (seen[d]) return;
    seen[d] = true;
    out.push(d);
  }
  function resolve(p) { return normalizeRelPath(dir + '/' + p); }
  (proj.sources || []).forEach(function (s) {
    var n = resolve(s), i = n.lastIndexOf('/');
    addDir(i < 0 ? '' : n.slice(0, i));
  });
  (proj.includes || []).forEach(function (inc) { addDir(resolve(inc)); });
  Object.keys(proj.srcRoots || {}).forEach(function (ns) { addDir(resolve(proj.srcRoots[ns])); });
  (proj.compilerArgs || []).forEach(function (a) {
    if (a.lastIndexOf('-I', 0) === 0) addDir(resolve(a.substring(2)));
  });
  return out;
}

/* ---- bake-input freshness (todos/0082) ----
 *
 * newestBakeInput(fsMod, pathMod, rootDir, manifest) -> { mtimeMs, path }
 * The newest mtime across everything that can change the system blob's
 * bytes: compiler.js + host.js (the toolchain), the os/ tree (manifest,
 * bake logic, every seeded source/header), and the manifest system
 * section's closure — each `project` bin.json expanded through its deps
 * with the whole project directory walked (dir-granular on purpose:
 * quoted includes resolve beside their sources) and every directory its
 * sources/includes/srcRoots reach OUTSIDE that dir walked too
 * (projectExternalDirs, todos/0354) — plus each `bin` blob.
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
  var normalize = normalizeRelPath;   // "a/b/../c" -> "a/c" (buildProject's rule)
  function addProject(rel) {   // repo-relative bin.json/lib.json path
    var n = normalize(rel);
    if (seenProjects[n]) return;
    seenProjects[n] = true;
    var dir = n.slice(0, n.lastIndexOf('/'));
    walk(pathMod.join(rootDir, dir), null);
    var proj;
    try { proj = JSON.parse(fsMod.readFileSync(pathMod.join(rootDir, n), 'utf-8')); } catch (e) { return; }
    (proj.deps || []).forEach(function (d) { addProject(dir + '/' + d); });
    // `deps` was never the only way in (todos/0354): sources/includes/
    // srcRoots reaching outside the project dir are bake inputs too. The
    // os root keeps its runtime-only skip list wherever it is reached from
    // (gucman's `includes: [".."]`), so this can't enrol os.html.
    projectExternalDirs(proj, dir).forEach(function (d) {
      walk(pathMod.join(rootDir, d), d === 'os' ? BAKE_INPUT_SKIP : null);
    });
  }
  statFile(pathMod.join(rootDir, 'compiler.js'));
  statFile(pathMod.join(rootDir, 'host.js'));
  walk(pathMod.join(rootDir, 'os'), BAKE_INPUT_SKIP);
  // Package definitions are bake inputs whenever packages fold in (a fat
  // fixture must restale on a packages/*.json edit); scanned unconditionally
  // — over-invalidating a minimal bake is the cheap direction.
  walk(pathMod.join(rootDir, 'packages'), null);
  // ...and so are the SOURCES those definitions build: since the 0262
  // split a packaged app's project tree (vendor/...) is no longer in the
  // manifest closure below, so without this an mgp.c edit leaves a fat
  // fixture 'fresh' (found by the ticket #75 consumer red run). Same
  // over-invalidation rule: scanned unconditionally.
  var pkgDir = pathMod.join(rootDir, 'packages');
  var pkgNames = [];
  try { pkgNames = fsMod.readdirSync(pkgDir).filter(function (n) { return /\.json$/.test(n); }); } catch (e) {}
  pkgNames.forEach(function (n) {
    var pj;
    try { pj = JSON.parse(fsMod.readFileSync(pathMod.join(pkgDir, n), 'utf-8')); } catch (e) { return; }
    var pf = pj.files || {};
    Object.keys(pf).forEach(function (fp) {
      if (pf[fp].project !== undefined) addProject(pf[fp].project);
      if (pf[fp].bin !== undefined) statFile(pathMod.join(rootDir, pf[fp].bin));
      // `tree` entries: the SAME enumeration that expands the payload
      // drives the freshness scan, so they agree by construction.
      if (pf[fp].tree !== undefined) {
        var tfs;
        try { tfs = listTreeFiles(fsMod, pathMod, rootDir, pf[fp], n + ': ' + fp); }
        catch (e) { return; }   // malformed → fails loud in the fold, not here
        tfs.forEach(function (tf) { statFile(pathMod.join(rootDir, pf[fp].tree, tf)); });
      }
    });
  });
  // Scan the manifest AS BAKED: foldDesktopDefaults twins the user
  // Desktop set into the system section, so its `bin` blobs (deck/mgp
  // data) are blob bytes now — the scan and the bake agree by
  // construction (the listTreeFiles rule).
  var baked = foldDesktopDefaults(manifest);
  var files = (baked.system && baked.system.files) || {};
  Object.keys(files).forEach(function (fp) {
    var entry = files[fp];
    if (entry.project !== undefined) addProject(entry.project);
    if (entry.bin !== undefined) statFile(pathMod.join(rootDir, entry.bin));
  });
  return newest;
}

/* ---- package-input freshness (the 0082 idea, scoped to one package) ----
 *
 * newestPkgInput(fsMod, pathMod, rootDir, name, pkg, opts) -> { mtimeMs, path }
 * mkpkg's twin of newestBakeInput: the newest mtime across everything that
 * can change ONE package's payload bytes — the toolchain (compiler.js —
 * buildProject/createCcDriver; this file — packageControl/listTreeFiles/
 * seedEntries; tools/mkpkg.js — tar/control encoding), the definition, and
 * each file entry's closure (project dirs through deps AND external
 * sources/includes — projectExternalDirs, todos/0354 — plus `bin` blobs,
 * os/-relative `c`/`text` assets, `tree` enumerations, and a native
 * sibling's overlay manifest). Deliberately NARROW — the os/ tree at large
 * is not an input, so unrelated OS work doesn't force a package recompile
 * in the dev loop. Node-only (statSync), like newestBakeInput.
 *
 * opts (all optional):
 *   pkgDir        — abs dir holding <name>.json (the definition file); a
 *                   synthesized def has none and names its derivation
 *                   inputs via extraInputs instead
 *   extraInputs   — repo-relative paths statted as inputs
 *   overlayPathFor— (producer) -> abs overlay.json path, or null; drives
 *                   nativeApp/nativeFile freshness
 *
 * Extracted from tools/mkpkg.js (todos/0363) so the red control in
 * tests/host/test_bakeinput_sources.js can point it at a synthetic tree —
 * that test carries one leg per input class above plus the narrow-scope
 * pin; a new entry kind added here needs a leg there. */
function newestPkgInput(fsMod, pathMod, rootDir, name, pkg, opts) {
  opts = opts || {};
  var osDir = pathMod.join(rootDir, 'os');
  var newest = { mtimeMs: 0, path: null };
  var seenDirs = {}, seenProjects = {};
  function statFile(p) {
    var st;
    try { st = fsMod.statSync(p); } catch (e) { return; }
    if (st.isFile() && st.mtimeMs > newest.mtimeMs) { newest.mtimeMs = st.mtimeMs; newest.path = p; }
  }
  function walk(dir) {
    var real;
    try { real = fsMod.realpathSync(dir); } catch (e) { return; }
    if (seenDirs[real]) return;
    seenDirs[real] = true;
    var ents;
    try { ents = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      if (e.name.charAt(0) === '.') return;
      if (e.isDirectory()) walk(pathMod.join(dir, e.name));
      else if (!/\.(img|md)$/.test(e.name)) statFile(pathMod.join(dir, e.name));
    });
  }
  var normalize = normalizeRelPath;   // "a/b/../c" -> "a/c" (buildProject's rule)
  function addProject(rel) {
    var n = normalize(rel);
    if (seenProjects[n]) return;
    seenProjects[n] = true;
    var dir = n.slice(0, n.lastIndexOf('/'));
    walk(pathMod.join(rootDir, dir));
    var proj;
    try { proj = JSON.parse(fsMod.readFileSync(pathMod.join(rootDir, n), 'utf-8')); } catch (e) { return; }
    (proj.deps || []).forEach(function (d) { addProject(dir + '/' + d); });
    // Same hole as newestBakeInput's (todos/0354): a source/include reaching
    // outside the project dir is an input `deps` recursion never sees. This
    // does NOT widen the narrow scope above — no packaged project's external
    // dirs reach the os/ tree at large (they are freetype/libpng/os/win32,
    // all already walked as deps today).
    projectExternalDirs(proj, dir).forEach(function (d) { walk(pathMod.join(rootDir, d)); });
  }
  statFile(pathMod.join(rootDir, 'compiler.js'));
  statFile(pathMod.join(rootDir, 'tools', 'mkpkg.js'));
  statFile(pathMod.join(rootDir, 'os', 'os-common.js'));
  if (opts.pkgDir) statFile(pathMod.join(opts.pkgDir, name + '.json'));
  // A synthesized -sources def has no packages/ file; its derivation inputs
  // (the parent def / os/image.json) are named by the synthesis instead.
  (opts.extraInputs || []).forEach(function (rel) { statFile(pathMod.join(rootDir, rel)); });
  var files = pkg.files || {};
  Object.keys(files).forEach(function (rel) {
    var entry = files[rel];
    if (entry.project !== undefined) addProject(entry.project);
    if (entry.bin !== undefined) statFile(pathMod.join(rootDir, entry.bin));
    if (entry.text !== undefined) statFile(pathMod.join(osDir, entry.text));
    if (entry.c !== undefined) {
      statFile(pathMod.join(osDir, entry.c));
      (entry.hdrs || []).forEach(function (h) { statFile(pathMod.join(osDir, h)); });
    }
    // `tree` entries: the SAME enumeration that expands the payload drives
    // the freshness scan (a changed source anywhere under the tree dir
    // marks the package stale).
    if (entry.tree !== undefined) {
      var tfs;
      try { tfs = listTreeFiles(fsMod, pathMod, rootDir, entry, rel); }
      catch (e) { return; }   // malformed → fails loud in the build, not here
      tfs.forEach(function (tf) { statFile(pathMod.join(rootDir, entry.tree, tf)); });
    }
    // A nativeApp/nativeFile payload's freshness is its producer's overlay
    // manifest's mtime — re-publishing overlay.json (new sha256s)
    // re-materializes the package.
    if (entry.nativeApp !== undefined || entry.nativeFile !== undefined) {
      var producer = nativeSiblingProducer(pkg.requires);
      var op = (producer !== null && opts.overlayPathFor) ? opts.overlayPathFor(producer) : null;
      if (op) statFile(op);
    }
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

/* ---- host keyboard-scheme auto-detect (META-ARROW-KEYBIND.md decision 4) ----
 * On a Mac HOST, default the keyboard scheme to `macos` so ⌘←/→ line-nav and
 * ⌘↑/↓ doc-nav (with tiling relocated to Ctrl+Alt+arrow — keys.h) are the
 * out-of-box idiom, instead of a Control Panel visit. `platform` is the host
 * hint ('mac' | anything else) supplied by the two boot paths: os/boot.js's
 * --host-platform flag and os/kernel-worker.js's navigator probe. Non-'mac'
 * is a NO-OP — `windows` is the baked /usr/share/keys default, so every
 * non-Mac host (and every headless/test boot with no hint) is byte-identical
 * to before.
 *
 * The seed writes ONLY the admin layer /etc/keys, and only when no `scheme`
 * is already set there. Two properties fall out:
 *   - Auto-detect sets the DEFAULT, not the choice: ~/.config/keys (the layer
 *     the ctlpanel Keyboard applet's ks_set writes) is a HIGHER cfgstore
 *     overlay, so a manual override always wins at resolution time — we don't
 *     even consult it here.
 *   - Idempotent: a prior seed or a hand-edited admin scheme is never
 *     clobbered, so re-running it (and the every-fresh-boot call site) is safe.
 * Called on a freshly-created root volume (the 0040 seed-once contract).
 * Returns true iff it wrote the seed. */
function seedHostKeyScheme(kfs, platform) {
  if (platform !== 'mac') return false;
  var existing = readFileText(kfs, '/etc/keys');
  // A non-commented `scheme` line already present -> respect it (admin choice
  // or a prior seed); '#'-prefixed lines are comments and don't count.
  if (existing !== null && /^[ \t]*scheme[ \t]/im.test(existing)) return false;
  if (kfs.stat('/etc') === null) kfs.mkdir('/etc', 0o755);
  var body = existing === null ? '' : existing;
  if (body && body[body.length - 1] !== '\n') body += '\n';
  body += 'scheme\tmacos\n';
  writeFile(kfs, '/etc/keys', body, 0o644);
  return true;
}

/* ---- persisted host verdict (ticket #96 / todos/0432) ----
 * /run/host-platform records the per-boot host hint ('mac' | 'other') so
 * in-OS consumers can read it — first user is keys.h's implicit host-native
 * paste row (⌘V pastes on a Mac host regardless of the in-OS scheme, which
 * is what rescues a stale pre-v138 windows-scheme root volume). Written
 * EVERY boot by both boot paths (os/kernel-worker.js, os/boot.js): /run is
 * per-boot state, not config — no layering, no user override, and
 * deliberately NOT the seedHostKeyScheme fresh-root gate (recording a fact
 * is not choosing a scheme; the scheme seed stays gated). */
function writeHostPlatform(kfs, platform) {
  if (kfs.stat('/run') === null) kfs.mkdir('/run', 0o755);
  writeFile(kfs, '/run/host-platform',
            (platform === 'mac' ? 'mac' : 'other') + '\n', 0o644);
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

/* ---- network bridge fetch (ticket #349; todos/NETWORK.md Tier 2.5) ----
 *
 * The kernel's HTTP transport runs whatever fetch the embedder hands it
 * (KERNEL.md "HTTP transport"). Tier 2.5 makes that fetch SWITCHABLE at
 * runtime: an OS setting — cfgstore `net`, keys `bridge` (on|off, default
 * off) and `url` (default http://127.0.0.1:8199) — reroutes every transfer
 * through tools/net-bridge.js, a localhost proxy the user runs themselves.
 * In the browser that lifts the platform's CORS gate (the bridge fetches
 * with the user's native network identity); headless honours the same
 * setting so the two embedders never diverge.
 *
 * Shape: createNetFetch() returns the wrapper to pass as Kernel({fetch});
 * netFetchAttach(netFetch, kernel, kfs) resolves the store and watches its
 * three layers so an applet checkbox click retargets the NEXT transfer
 * with no reboot (the displayAnnounce watchPath pattern in
 * os/kernel-worker.js — the JS resolver below must keep matching
 * os/netcfg.h's cfg_find semantics: per-key overlay, user > admin > baked,
 * case-insensitive keys, '#' comments). In-flight transfers keep the path
 * they started on.
 *
 * OFF is byte-identical to today: the wrapper tail-calls the bound global
 * fetch with the caller's exact arguments. ON, the request is re-posted to
 * the bridge (target URL/method/headers in x-guc-* headers, body verbatim)
 * and the bridge's ENCAPSULATED reply (x-guc-status/x-guc-headers + the
 * streamed body) is unwrapped into the {status, headers, body} shape the
 * kernel consumes. Errno ruling (recorded in NETWORK.md Tier 2.5):
 * `fetch: null` / no capability stays ENOSYS; a bridge that is configured
 * ON but not answering is a transport-REACHABILITY failure = ENETUNREACH,
 * pinned on the rejection as err.errno (kernel.js honours the string). A
 * bridge-level policy refusal (403) is EACCES; an upstream failure the
 * bridge reports (502) stays EIO with the upstream's error text, matching
 * direct-fetch connect-failure semantics. */

var NET_LAYERS = ['/root/.config/net', '/etc/net', '/usr/share/net'];
var NET_DEFAULT_URL = 'http://127.0.0.1:8199';

/* Resolve the effective net config from the kfs store layers. */
function netConfig(kfs) {
  var cfg = { on: false, url: NET_DEFAULT_URL };
  var seen = { bridge: false, url: false };
  for (var i = 0; i < NET_LAYERS.length; i++) {
    var text = readFileText(kfs, NET_LAYERS[i]);
    if (text === null) continue;
    var lines = text.split('\n');
    for (var j = 0; j < lines.length; j++) {
      var m = /^(bridge|url)[ \t]+(\S+)/i.exec(lines[j]);   // '#' comments can't match
      if (!m) continue;
      var key = m[1].toLowerCase();
      if (seen[key]) continue;                              // higher layer already won
      seen[key] = true;
      if (key === 'bridge') cfg.on = m[2].toLowerCase() === 'on';
      else cfg.url = m[2];
    }
  }
  return cfg;
}

function createNetFetch(baseFetch) {
  var base = baseFetch !== undefined ? baseFetch
    : (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!base) return null;   // no fetch at all: the embedder passes null -> ENOSYS, as ever
  var state = { on: false, url: NET_DEFAULT_URL };

  function errnoErr(errno, msg) {
    var e = new Error(msg);
    e.errno = errno;
    return e;
  }

  function bridgeFetch(url, init) {
    init = init || {};
    // The encapsulation puts url/method/headers into HTTP header VALUES,
    // which fetch caps at Latin-1 — one char past 0xFF and base() rejects
    // the whole request, which the old code then blamed on the bridge
    // (ticket #393). Make the hop transparent instead: the URL normalizes
    // to its ASCII serialization (percent-encoded path/query, punycoded
    // host — the same bytes direct fetch puts on the wire), and the header
    // JSON ASCII-escapes everything past 0x7F with JSON's own \uXXXX
    // mechanism, which the bridge's JSON.parse reverses losslessly
    // (astral pairs included). What remains invalid is reported as OUR
    // input being invalid (EINVAL naming the value), never as the bridge.
    var target;
    try { target = new URL(url + '').href; }
    catch (e) {
      return Promise.reject(errnoErr('EINVAL', 'net bridge: invalid target url '
        + JSON.stringify(url + '') + ' (' + ((e && e.message) || 'unparsable') + ')'));
    }
    var method = (init.method || 'GET') + '';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) {
      return Promise.reject(errnoErr('EINVAL',
        'net bridge: invalid HTTP method ' + JSON.stringify(method)));
    }
    var hdrJson = JSON.stringify(init.headers || []).replace(/[\u0080-\uffff]/g, function (c) {
      return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
    var h = {
      'x-guc-url': target,
      'x-guc-method': method,
      'x-guc-headers': hdrJson,
    };
    var binit = { method: 'POST', headers: h, redirect: 'error' };
    if (init.body) binit.body = init.body;
    if (init.signal) binit.signal = init.signal;
    var bridgeUrl = state.url.replace(/\/+$/, '') + '/fetch';
    return base(bridgeUrl, binit).then(function (resp) {
      var upStatus = resp.headers.get('x-guc-status');
      if (resp.status === 200 && upStatus !== null) {
        var pairs = [];
        try { pairs = JSON.parse(resp.headers.get('x-guc-headers') || '[]'); } catch (e) {}
        // #359: the bridge ships the upstream's post-redirect final URL as
        // its own x-guc-final-url response header (CORS-exposed); mirror it
        // as .url so the kernel sees the Response shape in both modes. A
        // pre-#359 bridge yields null — fall back to the request url.
        return {
          status: parseInt(upStatus, 10),
          url: resp.headers.get('x-guc-final-url') || (url + ''),
          headers: { forEach: function (cb) {
            for (var i = 0; i < pairs.length; i++) cb(pairs[i][1] + '', pairs[i][0] + '');
          } },
          body: resp.body,
        };
      }
      // Bridge-level answer (never carries x-guc-status): policy or failure.
      // The bridge ANSWERED, so it is emphatically not "unreachable" — name
      // the real status so the reader can tell a refused request from a
      // dead bridge at a glance (ticket #393).
      return resp.text().catch(function () { return ''; }).then(function (t) {
        var tail = t ? ' — ' + t.slice(0, 300) : '';
        var e;
        if (resp.status === 502) {
          // The bridge proxied the request and the UPSTREAM fetch failed;
          // EIO with the upstream's error text matches direct-fetch
          // connect-failure semantics (the NETWORK.md Tier 2.5 ruling).
          e = errnoErr('EIO', 'net bridge: upstream fetch failed (HTTP 502 from a running bridge)' + tail);
        } else if (resp.status === 200) {
          // 200 without the x-guc-status encapsulation: something answered
          // at the bridge url, but not the bridge protocol.
          e = new Error('net bridge: ' + state.url + ' answered 200 without x-guc-status'
            + ' — is the `net` url setting really pointing at tools/net-bridge.js?');
        } else {
          e = new Error('net bridge: the bridge at ' + state.url
            + ' is RUNNING but answered HTTP ' + resp.status + tail);
          if (resp.status === 403) e.errno = 'EACCES';
        }
        throw e;
      });
    }, function (err) {
      // The fetch to the BRIDGE ITSELF failed — nothing answered (connection
      // refused, no listener, DNS). Anything the bridge answers, however
      // unhappy, resolves and is labelled with its real status above; only
      // genuine transport failure earns "unreachable"/ENETUNREACH (#393 —
      // the old handler branded EVERY rejection a dead bridge).
      if (err && err.name === 'AbortError') throw err;   // close(2) abort, not reachability
      if (err && typeof err.errno === 'string') throw err;  // already honestly labelled
      // Node's fetch buries the useful part (connect ECONNREFUSED ...) in
      // err.cause; the top-level message is a bare "fetch failed".
      var why = (err && err.cause && err.cause.message) || (err && err.message) || 'fetch failed';
      var e = new Error('net bridge unreachable at ' + state.url + ' ('
        + why + ') — is tools/net-bridge.js running?');
      e.errno = 'ENETUNREACH';
      throw e;
    });
  }

  function netFetch(url, init) {
    return state.on ? bridgeFetch(url, init) : base(url, init);
  }
  netFetch._state = state;      // netFetchAttach writes; tests may read
  return netFetch;
}

/* Resolve now and keep resolving on every settled write to a layer (the
 * kernel.watchPath FSW choke — what makes the Control Panel applet's
 * checkbox retarget live). Safe to call with netFetch null (no fetch). */
function netFetchAttach(netFetch, kernel, kfs) {
  if (!netFetch) return;
  var resolve = function () {
    var cfg = netConfig(kfs);
    netFetch._state.on = cfg.on;
    netFetch._state.url = cfg.url;
  };
  NET_LAYERS.forEach(function (p) { kernel.watchPath(p, resolve); });
  resolve();
}

/* ---- environment exports (host.js discipline) ---- */
var OS_COMMON = {
  createCcDriver: createCcDriver,
  buildProject: buildProject,
  seedEntries: seedEntries,
  seedBakedSeeds: seedBakedSeeds,
  bakeSystemImage: bakeSystemImage,
  loadOverlays: loadOverlays,
  plantOverlays: plantOverlays,
  nodeOverlayIo: nodeOverlayIo,
  listPackages: listPackages,
  nativeSiblingProducer: nativeSiblingProducer,
  foldPackages: foldPackages,
  foldDesktopDefaults: foldDesktopDefaults,
  checkManifestRefs: checkManifestRefs,
  listTreeFiles: listTreeFiles,
  sourcePackageDefs: sourcePackageDefs,
  validateSrclibShape: validateSrclibShape,
  validateSeedShape: validateSeedShape,
  packageControl: packageControl,
  packageControlText: packageControlText,
  checkReservedPackageFiles: checkReservedPackageFiles,
  win32RequireDriftErrors: win32RequireDriftErrors,
  bakedVersion: bakedVersion,
  bakedOverlays: bakedOverlays,
  bakedPackages: bakedPackages,
  normalizeRelPath: normalizeRelPath,
  projectExternalDirs: projectExternalDirs,
  newestBakeInput: newestBakeInput,
  newestPkgInput: newestPkgInput,
  initRootVolume: initRootVolume,
  seedHostKeyScheme: seedHostKeyScheme,
  writeHostPlatform: writeHostPlatform,
  NodeFileStore: NodeFileStore,
  readFileBytes: readFileBytes,
  readFileText: readFileText,
  writeFile: writeFile,
  createNetFetch: createNetFetch,
  netFetchAttach: netFetchAttach,
  netConfig: netConfig,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OS_COMMON;
} else if (typeof self !== 'undefined') {
  self.OS_COMMON = OS_COMMON;
}
