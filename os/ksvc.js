// ksvc.js — loader/wrapper for the kernel service blob (todos/0275;
// design: todos/0275-kernel-text-service-design.md §5/§6).
//
// OS_KSVC.load(kfs, {log}) reads /usr/lib/ksvc.wasm through the kernel's
// MountFS, instantiates it synchronously IN the kernel's thread over an
// EXPLICIT minimal read-only import env (written out here, not generated,
// not borrowed from runModule — the kernel service boundary is
// deliberately narrower than a process: read-only fs, no write path, no
// processes, no signals, no timers), and returns the text-service handle
// the kernel + compositor call. THROWS on any failure — a boot that can't
// render chrome text is a boot error, never a degraded desktop (§11).
//
// Environment-neutral: module.exports under Node (os/boot.js),
// self.OS_KSVC under importScripts (os/kernel-worker.js).

(function () {
  'use strict';

  var KSVC_PATH = '/usr/lib/ksvc.wasm';
  var KSVC_ABI = 1;

  // Write-intent open flags, refused with EROFS before reaching kfs — the
  // service is read-only by construction, on EVERY volume (design §5.2).
  var O_WRITE_INTENT = 0x1 | 0x2 | 0x40 | 0x200 | 0x400;
  //                   WRONLY RDWR  CREAT  TRUNC  APPEND

  // kfs error name -> the compiler libc's errno numbers (verified against
  // compiler.js's errno block: ENOENT 2, EIO 5, EBADF 9, EACCES 13,
  // EINVAL 22, EROFS 30).
  var ERRNO = { ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EINVAL: 22, EROFS: 30 };

  function load(kfs, opts) {
    var log = (opts && opts.log) || function () {};

    var bytes = readFileBytes(kfs, KSVC_PATH);
    if (!bytes) throw new Error('ksvc: cannot read ' + KSVC_PATH +
      ' (' + (kfs._lastError || 'ENOENT') + ')');
    var wmod = new WebAssembly.Module(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    var instance = null;
    var mem = function () { return instance.exports.memory; };
    // Fresh views per call — memory.grow detaches old ArrayBuffers.
    var u8 = function () { return new Uint8Array(mem().buffer); };
    var dv = function () { return new DataView(mem().buffer); };
    function readCStr(p) {
      var b = u8(), e = p;
      while (b[e]) e++;
      var s = b.subarray(p, e);
      return typeof TextDecoder !== 'undefined'
        ? new TextDecoder().decode(s) : Buffer.from(s).toString('utf8');
    }
    function setErrno(name) {
      instance.exports.__errno_set(ERRNO[name] || ERRNO.EIO);
    }
    // Loud trap: the spike proved none of these fire on the live path; a
    // future capability that pulls one for real promotes it CONSCIOUSLY.
    var trap = function (name) {
      return function () {
        throw new Error('ksvc env: ' + name +
          ' is not part of the kernel service surface');
      };
    };

    var env = {
      __open_impl: function (p, flags, mode) {
        if (flags & O_WRITE_INTENT) { setErrno('EROFS'); return -1; }
        var fd = kfs.open(readCStr(p), flags | 0, mode | 0);
        if (fd === null) { setErrno(kfs._lastError); return -1; }
        return fd;
      },
      read: function (fd, buf, n) {
        var got = kfs.read(fd, new Uint8Array(mem().buffer, buf, n), n);
        if (got === null) { setErrno(kfs._lastError); return -1; }
        return got;
      },
      close: function (fd) {
        var r = kfs.close(fd);
        if (r === null) { setErrno(kfs._lastError); return -1; }
        return 0;
      },
      lseek: function (fd, off, wh) {
        var r = kfs.lseek(fd, Number(off), wh);
        if (r === null) { setErrno(kfs._lastError); return -1n; }
        return BigInt(r);
      },
      access: function (p, m) {
        var r = kfs.access(readCStr(p), m | 0);
        if (r === null) { setErrno(kfs._lastError); return -1; }
        return 0;
      },
      // fd 1/2 only: FreeType/libc error chatter becomes boot-log lines.
      write: function (fd, buf, n) {
        if (fd !== 1 && fd !== 2) {
          throw new Error('ksvc env: write to fd ' + fd +
            ' (only stdout/stderr log forwarding is served)');
        }
        var s = typeof TextDecoder !== 'undefined'
          ? new TextDecoder().decode(u8().subarray(buf, buf + n))
          : Buffer.from(u8().subarray(buf, buf + n)).toString('utf8');
        log('[ksvc] ' + s.replace(/\n+$/, ''));
        return n;
      },
      // The compiler's printf family is host-implemented; the only live
      // format on the ksvc path is fc_load's bounded "%s" copy. Mini-
      // formatter: %s/%d/%u/%x/%c/%% — loud throw on anything else
      // (design §5.3). va_list ABI (spike-verified): ap points at a u32
      // slot holding the varargs base; args are consecutive 4-byte slots.
      vsnprintf: function (buf, size, fmtp, app) {
        var fmt = readCStr(fmtp);
        var d = dv();
        var va = d.getUint32(app, true);
        var out = '';
        for (var i = 0; i < fmt.length; i++) {
          var ch = fmt[i];
          if (ch !== '%') { out += ch; continue; }
          var conv = fmt[++i];
          if (conv === '%') { out += '%'; continue; }
          var arg = d.getUint32(va, true); va += 4;
          if (conv === 's') out += readCStr(arg);
          else if (conv === 'd') out += String(arg | 0);
          else if (conv === 'u') out += String(arg >>> 0);
          else if (conv === 'x') out += (arg >>> 0).toString(16);
          else if (conv === 'c') out += String.fromCharCode(arg & 0xFF);
          else throw new Error('ksvc env: vsnprintf fmt "%' + conv + '" unsupported');
        }
        var enc = typeof TextEncoder !== 'undefined'
          ? new TextEncoder().encode(out) : Uint8Array.from(Buffer.from(out));
        var n = Math.min(enc.length, size > 0 ? size - 1 : 0);
        if (size > 0) { u8().set(enc.subarray(0, n), buf); u8()[buf + n] = 0; }
        return enc.length;
      },
      getpid: function () { return 0; },
      // Time: trivial real impls — nothing on the text path reads them,
      // but time is harmless and honest.
      __time_now: function () { return BigInt(Math.floor(Date.now() / 1000)); },
      __clock: function () { return Math.floor(
        (typeof performance !== 'undefined' ? performance.now() : Date.now())); },
      __clock_ns_hi: function () { return 0; },
      __clock_ns_lo: function () { return 0; },
      __timezone_offset: function () { return 0; },
      // Everything else is OUTSIDE the kernel service surface (§5.2).
      remove: trap('remove'), mkdir: trap('mkdir'), pipe: trap('pipe'),
      __spawn: trap('__spawn'), __spawn_wait: trap('__spawn_wait'),
      __spawn_kill: trap('__spawn_kill'), __exit: trap('__exit'),
      __vsscanf_impl: trap('__vsscanf_impl'),
      __strtod_impl: trap('__strtod_impl'), __strtof_impl: trap('__strtof_impl'),
      __on_sigdisp: trap('__on_sigdisp'), __on_sigmask: trap('__on_sigmask'),
      __sig_pause: trap('__sig_pause'),
      __setitimer: trap('__setitimer'), __getitimer: trap('__getitimer'),
    };

    instance = new WebAssembly.Instance(wmod, { c: env });
    var E = instance.exports;
    var abi = E.ksvc_abi();
    if (abi !== KSVC_ABI) {
      throw new Error('ksvc: ABI mismatch (blob ' + abi + ', wrapper ' + KSVC_ABI +
        ') — stale image pairing with newer kernel JS?');
    }
    var rc = E.ksvc_init();
    if (rc !== 0) {
      throw new Error('ksvc: ksvc_init failed (' + rc + ')' +
        (rc === -2 ? ' — no mono face at /etc/fonts/mono.ttf or /usr/share/fonts/mono.ttf' : ''));
    }

    var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    function stage(text) {
      var b = encoder ? encoder.encode(String(text))
                      : Uint8Array.from(Buffer.from(String(text)));
      var p = E.ksvc_buf(b.length);
      if (!p && b.length) throw new Error('ksvc: ksvc_buf OOM (' + b.length + ')');
      u8().set(b, p);
      return { ptr: p, len: b.length };
    }

    // The wrapper is a dumb boundary: no JS-side caching here — callers
    // (compositor labelFor, kernel _blitLabel) own their caches.
    return {
      measure: function (text, px, flags) {
        var t = stage(text);
        return E.ksvc_text_measure(t.ptr, t.len, px | 0, flags | 0);
      },
      // -> { w, h, bytes }: bytes is a Uint8Array VIEW into blob memory
      // (fresh per call), w*h*4 RGBA straight alpha, VALID UNTIL THE NEXT
      // render() — consume immediately (writeTexture / blit), never store.
      render: function (text, px, maxW, rgba, flags) {
        var t = stage(text);
        var p = E.ksvc_text_render(t.ptr, t.len, px | 0, Math.ceil(maxW), rgba >>> 0, flags | 0);
        if (!p) throw new Error('ksvc: ksvc_text_render failed (OOM?)');
        var d = dv();
        var w = d.getInt32(p, true), h = d.getInt32(p + 4, true);
        return { w: w, h: h, bytes: new Uint8Array(mem().buffer, p + 16, w * h * 4) };
      },
    };
  }

  // readFileBytes: whole-file read over the kfs open/read/close surface
  // (mirrors os-common.js readFileBytes; duplicated so ksvc.js has no
  // load-order dependency on OS_COMMON inside the worker).
  function readFileBytes(kfs, path) {
    var fd = kfs.open(path, 0, 0);
    if (fd === null) return null;
    var chunks = [], total = 0;
    for (;;) {
      var buf = new Uint8Array(65536);
      var n = kfs.read(fd, buf, buf.length);
      if (n === null) { kfs.close(fd); return null; }
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
      total += n;
    }
    kfs.close(fd);
    var out = new Uint8Array(total), off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  var OS_KSVC = { load: load, KSVC_PATH: KSVC_PATH, KSVC_ABI: KSVC_ABI };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OS_KSVC;
  } else if (typeof self !== 'undefined') {
    self.OS_KSVC = OS_KSVC;
  }
})();
