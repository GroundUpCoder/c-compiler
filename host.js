#!/usr/bin/env node

const ENV_KEY = "c";

// 64-bit lseek marshalling. With off_t widened to `long long`, the lseek import
// crosses the wasm boundary as i64: its offset argument arrives as a BigInt and
// its result MUST be returned as a BigInt (a plain number throws at the boundary).
// This wraps a number-returning lseek impl — converting the BigInt offset to a
// Number on the way in (file positions are < 2^53, so lossless) and the numeric
// result (newPos, or -1 on error) to a BigInt on the way out.
function wrapLseekI64(impl) {
  return function (fd, offset, whence) {
    return BigInt(impl.call(this, fd, Number(offset), whence));
  };
}

// ByteQueue — the ONE stream byte buffer for stdin/pipe paths (CD28).
// A chunk deque: whole Uint8Array chunks in, subarray/set copies out (the
// kernel.js ring idiom) — O(1) amortized per byte on both sides. This
// replaced the plain-array push-per-byte + splice(0,n) buffers, whose
// drain shifted the whole tail every read → O(n²) on bulk input.
// `length` mirrors Array#length so `.length > 0` readiness checks read
// identically at every former call site.
function ByteQueue() {
  this._chunks = []; // Uint8Array chunks, FIFO
  this._head = 0;    // consumed bytes of _chunks[0]
  this.length = 0;   // total bytes queued
}
// Append a chunk (Uint8Array/Buffer or plain array of byte values). Always
// COPIES: callers push views over wasm memory, which the writer may reuse
// (and memory.buffer detaches on grow) — the queue must own its bytes.
ByteQueue.prototype.push = function (chunk) {
  if (chunk.length === 0) return;
  this._chunks.push(chunk instanceof Uint8Array ? new Uint8Array(chunk)
                                                : Uint8Array.from(chunk));
  this.length += chunk.length;
};
// Copy up to n bytes into dst (a Uint8Array, from offset 0); returns the
// count actually copied — min(n, queued), the callers' clamp.
ByteQueue.prototype.read = function (dst, n) {
  var want = Math.min(n, this.length), got = 0;
  while (got < want) {
    var front = this._chunks[0];
    var take = Math.min(front.length - this._head, want - got);
    dst.set(front.subarray(this._head, this._head + take), got);
    got += take;
    this._head += take;
    if (this._head === front.length) { this._chunks.shift(); this._head = 0; }
  }
  this.length -= got;
  return got;
};

/**
 * @typedef {object} NodeFS
 * @property {function(string, number, number): number} openSync
 * @property {function(number): void} closeSync
 * @property {function(number, Uint8Array, number, number, number): number} readSync
 * @property {function(number, Uint8Array, number, number, number): number} writeSync
 * @property {function(number): {size: number}} fstatSync
 * @property {function(string): void} unlinkSync
 * @property {function(string, string): void} renameSync
 * @property {function(string, object): void} mkdirSync
 * @property {{O_CREAT: number, O_EXCL: number, O_TRUNC: number, O_APPEND: number}} constants
 */

/**
 * @typedef {object} RuntimeContext
 * @property {function(number): string} readString - Read null-terminated string from WASM memory.
 * @property {function(number): function} createVaReader - Create a varargs reader for the given va_args pointer.
 * @property {function(object): void} setErrno - Set errno from a Node.js error object.
 * @property {function(string): void} setErrnoName - Set errno by POSIX name (e.g. 'ENOENT').
 * @property {function(): WebAssembly.Memory} getMemory - Return the WASM memory (thunk).
 * @property {function(): WebAssembly.Table} getIndirectFunctionTable - Return the WASM indirect function table.
 * @property {function(Uint8Array): void} [writeOut] - Write to stdout.
 * @property {function(Uint8Array): void} [writeErr] - Write to stderr.
 * @property {function(number): Promise<Uint8Array|null>} [requestStdin] - Request stdin data (up to N bytes).
 */

/**
 * @typedef {object} RunModuleOptions
 * @property {Uint8Array | ArrayBuffer} [bytes] - The WASM module bytes.
 * @property {WebAssembly.Module} [module] - A pre-compiled Module (todos/0037:
 *   the kernel compiles read-only-volume binaries once and structured-clones
 *   the Module into each process worker). C-flavor only — ss modules need
 *   `bytes` (different compile options). One of bytes/module is required.
 * @property {string[]} [args] - Command-line arguments for the C program's argv.
 */

/**
 * @typedef {object} SDLWindow
 * @property {function(string, function): void} on - Register an event listener.
 * @property {function(): void} destroy - Destroy the window.
 * @property {function(number, number, number, string, Buffer): void} render - Render pixel data.
 * @property {function(string): void} setTitle - Set the window title.
 */

/**
 * @typedef {object} SDLLib
 * @property {{createWindow: function({title: string, width: number, height: number}): SDLWindow}} video
 */

/**
 * Create file-system WASM imports backed by a Node.js fs module.
 * @param {object} options
 * @param {NodeFS} options.fs - Node.js fs module (or compatible subset).
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createFileSystem({ fs, ctx }) {
  const { readString, createVaReader, setErrno, setErrnoName, getMemory, writeOut, writeErr } = ctx;

  /* POSIX fd table: entries for fds 0/1/2 (stdin/stdout/stderr) */
  const fdTable = [
    { nativeFd: 0, position: null, isStdin: true },  /* fd 0 = stdin  (not seekable) */
    { nativeFd: 1, position: null, isStdout: true }, /* fd 1 = stdout (not seekable) */
    { nativeFd: 2, position: null, isStderr: true }, /* fd 2 = stderr (not seekable) */
  ];
  const stdinBuf = new ByteQueue();
  let stdinEOF = false;
  let stdinWaiters = [];
  let stdinListening = false;
  function ensureStdinListening() {
    if (stdinListening || typeof process === 'undefined' || !process.stdin) return;
    stdinListening = true;
    process.stdin.on('data', (chunk) => {
      stdinBuf.push(chunk);
      for (const w of stdinWaiters) w();
      stdinWaiters = [];
    });
    process.stdin.on('end', () => {
      stdinEOF = true;
      for (const w of stdinWaiters) w();
      stdinWaiters = [];
    });
    process.stdin.resume();
  }

  function allocFd(entry) {
    for (let i = 3; i < fdTable.length; i++) {
      if (fdTable[i] === null) {
        fdTable[i] = entry;
        return i;
      }
    }
    fdTable.push(entry);
    return fdTable.length - 1;
  }

  function translateOpenFlags(flags) {
    /* Access mode is bottom 2 bits: 0=RDONLY, 1=WRONLY, 2=RDWR */
    const access = flags & 3;
    let nodeFlags = access; /* O_RDONLY=0, O_WRONLY=1, O_RDWR=2 are the same */
    if (flags & 0x40) nodeFlags |= fs.constants.O_CREAT;
    if (flags & 0x80) nodeFlags |= fs.constants.O_EXCL;
    if (flags & 0x200) nodeFlags |= fs.constants.O_TRUNC;
    if (flags & 0x400) nodeFlags |= fs.constants.O_APPEND;
    return nodeFlags;
  }

  /* Wake readers parked on an empty pipe (the pipe-aware read patch at
     the bottom of this function): called whenever bytes arrive or an
     end's last duplicate closes. */
  function pipeWake(pipe) {
    if (!pipe.waiters || pipe.waiters.length === 0) return;
    const ws = pipe.waiters;
    pipe.waiters = [];
    for (const w of ws) w();
  }

  /* O_APPEND resync-failure recovery: write's post-commit EOF fstat can
     throw AFTER writeSync landed the bytes. The write still reports its
     committed count (returning -1 there invited a caller retry — duplicate
     append) and marks the entry positionUnknown. Every consumer of
     entry.position calls this first: lazily re-fstat (an append fd's
     tracked position is EOF-synced by definition, so a transient failure
     self-heals), else fail loud with that errno (false) — never a silently
     stale offset. Distinct from the position === null "not seekable"
     sentinel, which would wrongly turn a regular file into a pipe-shaped
     fd (ESPIPE seeks, unpositioned reads). */
  function ensurePosition(entry) {
    if (!entry.positionUnknown) return true;
    try {
      entry.position = fs.fstatSync(entry.nativeFd).size;
      entry.positionUnknown = false;
      return true;
    } catch (e) {
      setErrno(e);
      return false;
    }
  }

  /* Directory handle table for opendir/readdir/closedir */
  const dirTable = [];
  const dirEncoder = new TextEncoder();

  function allocDirHandle(entry) {
    for (let i = 0; i < dirTable.length; i++) {
      if (dirTable[i] === null) {
        dirTable[i] = entry;
        return i;
      }
    }
    dirTable.push(entry);
    return dirTable.length - 1;
  }

  async function readImpl(fd, buf_ptr, count) {
    if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
    /* POSIX: a zero-length read returns 0 IMMEDIATELY. It must never park
       on stdinWaiters (a feature-probe read(fd, buf, 0) would otherwise
       hang until unrelated input) or touch the buffer pointer. */
    if (count === 0) return 0;
    const memory = getMemory();
    const buf = new Uint8Array(memory.buffer, buf_ptr, count);
    const entry = fdTable[fd];
    try {
      let n;
      if (entry.isStdin) {
        ensureStdinListening();
        if (stdinBuf.length === 0 && !stdinEOF) {
          await new Promise(resolve => { stdinWaiters.push(resolve); });
        }
        return stdinBuf.read(buf, count);
      } else if (entry.position === null) {
        if (entry.nativeFd === undefined) throw new Error("read: fd " + fd + " has no nativeFd");
        n = fs.readSync(entry.nativeFd, buf);
      } else {
        if (!ensurePosition(entry)) return -1;
        n = fs.readSync(entry.nativeFd, buf, 0, count, entry.position);
        entry.position += n;
      }
      return n;
    } catch (e) {
      setErrno(e);
      return -1;
    }
  }

  /* Helper to write struct stat fields into WASM memory at buf_ptr.
     Must match the 64-bit libc `struct stat` layout (compiler.js, <sys/stat.h>),
     verified by tests/unit/stdlib/stat_layout. 120 bytes; st_size/st_blocks and
     all timestamps are i64 (setBigInt64). 32-bit fields first, then 8-aligned:
     dev(0) ino(4) mode(8) nlink(12) rdev(16) uid(20) gid(24) blksize(28)
     size(32) blocks(40) atime(48) mtime(56) ctime(64)
     atim.sec(72) atim.nsec(80) mtim.sec(88) mtim.nsec(96) ctim.sec(104) ctim.nsec(112) */
  function writeStatBuf(buf_ptr, st) {
    const memory = getMemory();
    const view = new DataView(memory.buffer);
    let mode = 0;
    if (st.isFile()) mode = 0o100000;
    else if (st.isDirectory()) mode = 0o040000;
    else if (st.isSymbolicLink()) mode = 0o120000;
    mode |= (st.mode & 0o7777);
    const size = st.size || 0;
    const at = Math.floor((st.atimeMs || 0) / 1000);
    const mt = Math.floor((st.mtimeMs || 0) / 1000);
    const ct = Math.floor((st.ctimeMs || 0) / 1000);
    view.setUint32(buf_ptr + 0, 0, true);                              /* st_dev */
    view.setUint32(buf_ptr + 4, st.ino || 0, true);                    /* st_ino */
    view.setUint32(buf_ptr + 8, mode, true);                           /* st_mode */
    view.setUint32(buf_ptr + 12, st.nlink || 1, true);                 /* st_nlink */
    view.setUint32(buf_ptr + 16, 0, true);                             /* st_rdev */
    view.setUint32(buf_ptr + 20, 0, true);                             /* st_uid (single-user) */
    view.setUint32(buf_ptr + 24, 0, true);                             /* st_gid */
    view.setInt32(buf_ptr + 28, 4096, true);                           /* st_blksize */
    view.setBigInt64(buf_ptr + 32, BigInt(size), true);                /* st_size */
    view.setBigInt64(buf_ptr + 40, BigInt(Math.ceil(size / 512)), true); /* st_blocks (512B) */
    view.setBigInt64(buf_ptr + 48, BigInt(at), true);                  /* st_atime */
    view.setBigInt64(buf_ptr + 56, BigInt(mt), true);                  /* st_mtime */
    view.setBigInt64(buf_ptr + 64, BigInt(ct), true);                  /* st_ctime */
    /* POSIX-2008 nanosecond timespecs: sub-second part from the Node ms times. */
    view.setBigInt64(buf_ptr + 72, BigInt(at), true); view.setInt32(buf_ptr + 80, ((st.atimeMs || 0) % 1000) * 1e6, true);   /* st_atim */
    view.setBigInt64(buf_ptr + 88, BigInt(mt), true); view.setInt32(buf_ptr + 96, ((st.mtimeMs || 0) % 1000) * 1e6, true);   /* st_mtim */
    view.setBigInt64(buf_ptr + 104, BigInt(ct), true); view.setInt32(buf_ptr + 112, ((st.ctimeMs || 0) % 1000) * 1e6, true); /* st_ctim */
  }

  const result = {
    [ENV_KEY]: {
      __open_impl: function (path_ptr, flags, mode) {
        const path = readString(path_ptr);
        const nodeFlags = translateOpenFlags(flags);
        if (!mode) mode = 0o666;
        let fd;
        try {
          fd = fs.openSync(path, nodeFlags, mode);
        } catch (e) {
          setErrno(e);
          return -1;
        }
        const entry = { nativeFd: fd, position: 0 };
        if (flags & 0x400) { /* O_APPEND */
          entry.append = true;
          try {
            const stat = fs.fstatSync(fd);
            entry.position = stat.size;
          } catch (e) {
            /* Swallowing this left position = 0: an "append" fd that
               reads/seeks from offset 0 — silent wrong data. Fail the
               open instead. */
            setErrno(e);
            try { fs.closeSync(fd); } catch (e2) { /* fd already dead */ }
            return -1;
          }
        }
        return allocFd(entry);
      },
      close: function (fd) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        const entry = fdTable[fd];
        if (entry.isStdin || entry.isStdout || entry.isStderr) {
          /* POSIX allows closing std fds. Drop the table entry (further
             use is EBADF) without closing the host process's streams.
             A dup2'd FILE entry on fd 0/1/2 falls through and closes
             normally (todos/0034). */
          fdTable[fd] = null;
          return 0;
        }
        /* dup'd fds alias one entry; only close the native fd with the
           last alias. */
        if (entry.refs && entry.refs > 1) {
          entry.refs--;
          fdTable[fd] = null;
          return 0;
        }
        try {
          fs.closeSync(entry.nativeFd);
        } catch (e) {
          setErrno(e);
          return -1;
        }
        fdTable[fd] = null;
        return 0;
      },
      read: function () { /* placeholder — replaced after pipe patching */ },
      write: function (fd, buf_ptr, count) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        const entry = fdTable[fd];
        /* Route by the ENTRY, not the fd number: a dup2'd file on fd 1/2
           must hit the file, and a `2>&1`-style alias of the default
           stderr entry must keep hitting the console. split(1) re-points
           fd 1 at each output part — the first program to do so here
           (todos/0034; readImpl's isStdin check is the same pattern). */
        if (entry.isStdout || entry.isStderr) {
          const memory = getMemory();
          const buf = new Uint8Array(memory.buffer, buf_ptr, count);
          if (entry.isStdout) {
            writeOut(buf);
          } else {
            writeErr(buf);
          }
          return count;
        }
        const memory = getMemory();
        const buf = new Uint8Array(memory.buffer, buf_ptr, count);
        try {
          let n;
          if (entry.append) {
            /* O_APPEND: every write lands at current EOF, regardless of any
               seek. The fd was opened with O_APPEND, so an unpositioned
               write lets the kernel append; resync our position to EOF. */
            n = fs.writeSync(entry.nativeFd, buf, 0, count);
            try {
              entry.position = fs.fstatSync(entry.nativeFd).size;
              entry.positionUnknown = false;
            } catch (e2) {
              /* The bytes are COMMITTED — reporting -1 now tells the caller
                 the write failed and invites a retry (duplicate append).
                 Keep the success; the tracked position is UNKNOWN until
                 ensurePosition resyncs it or fails loud. */
              entry.positionUnknown = true;
            }
          } else {
            if (!ensurePosition(entry)) return -1;
            n = fs.writeSync(entry.nativeFd, buf, 0, count, entry.position);
            if (entry.position !== null) entry.position += n;
          }
          return n;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      lseek: wrapLseekI64(function (fd, offset, whence) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        const entry = fdTable[fd];
        if (entry.position === null) { setErrnoName('ESPIPE'); return -1; }
        let newPos;
        switch (whence) {
          case 0: /* SEEK_SET */
            newPos = offset;
            break;
          case 1: /* SEEK_CUR */
            if (!ensurePosition(entry)) return -1;
            newPos = entry.position + offset;
            break;
          case 2: /* SEEK_END */
            try {
              const stat = fs.fstatSync(entry.nativeFd);
              newPos = stat.size + offset;
            } catch (e) {
              setErrno(e);
              return -1;
            }
            break;
          default:
            setErrnoName('EINVAL');
            return -1;
        }
        if (newPos < 0) { setErrnoName('EINVAL'); return -1; }
        entry.position = newPos;
        entry.positionUnknown = false; /* a completed seek IS a known position */
        return newPos;
      }),
      mkdir: function (path_ptr, mode) {
        const path = readString(path_ptr);
        try {
          fs.mkdirSync(path, { mode: mode, recursive: false });
        } catch (e) {
          setErrno(e);
          return -1;
        }
        return 0;
      },
      ftruncate: function (fd, length) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try {
          fs.ftruncateSync(fdTable[fd].nativeFd, Number(length));
          return 0;
        } catch (e) { setErrno(e); return -1; }
      },
      readlink: function (path_ptr, buf_ptr, bufsize) {
        const path = readString(path_ptr);
        try {
          const target = fs.readlinkSync(path);
          const memory = getMemory();
          const buf = new Uint8Array(memory.buffer, buf_ptr, bufsize);
          const enc = new TextEncoder().encode(target);
          const n = Math.min(enc.length, bufsize);
          for (let i = 0; i < n; i++) buf[i] = enc[i];
          return n;
        } catch (e) { setErrno(e); return -1; }
      },
      fsync: function (fd) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try { fs.fsyncSync(fdTable[fd].nativeFd); return 0; }
        catch (e) { setErrno(e); return -1; }
      },
      fdatasync: function (fd) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try { fs.fdatasyncSync(fdTable[fd].nativeFd); return 0; }
        catch (e) { setErrno(e); return -1; }
      },
      sleep: new WebAssembly.Suspending(async function (seconds) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        return 0;
      }),
      link: function (old_ptr, new_ptr) {
        try {
          fs.linkSync(readString(old_ptr), readString(new_ptr));
          return 0;
        } catch (e) { setErrno(e); return -1; }
      },
      symlink: function (target_ptr, link_ptr) {
        try {
          fs.symlinkSync(readString(target_ptr), readString(link_ptr));
          return 0;
        } catch (e) { setErrno(e); return -1; }
      },
      chmod: function (path_ptr, mode) {
        try { fs.chmodSync(readString(path_ptr), mode); return 0; }
        catch (e) { setErrno(e); return -1; }
      },
      fchmod: function (fd, mode) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try { fs.fchmodSync(fdTable[fd].nativeFd, mode); return 0; }
        catch (e) { setErrno(e); return -1; }
      },
      realpath: function (path_ptr, resolved_ptr) {
        try {
          const r = fs.realpathSync(readString(path_ptr));
          if (resolved_ptr === 0) {
            // Caller passed NULL → glibc-style, allocate via alloca-equivalent.
            // We can't return a heap pointer easily; for SQLite's usage, the
            // caller always passes a buffer (PATH_MAX). NULL is unsupported.
            setErrnoName('EINVAL');
            return 0;
          }
          const enc = new TextEncoder().encode(r);
          const memory = getMemory();
          const buf = new Uint8Array(memory.buffer, resolved_ptr, enc.length + 1);
          for (let i = 0; i < enc.length; i++) buf[i] = enc[i];
          buf[enc.length] = 0;
          return resolved_ptr;
        } catch (e) { setErrno(e); return 0; }
      },
      remove: function (path_ptr) {
        const path = readString(path_ptr);
        try {
          fs.unlinkSync(path);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      rename: function (oldpath_ptr, newpath_ptr) {
        const oldpath = readString(oldpath_ptr);
        const newpath = readString(newpath_ptr);
        try {
          fs.renameSync(oldpath, newpath);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      __opendir: function (path_ptr) {
        const path = readString(path_ptr);
        try {
          const dir = fs.opendirSync(path);
          return allocDirHandle({ native: dir, dotState: 0 });
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      __readdir: function (handle, dirent_ptr) {
        if (handle < 0 || handle >= dirTable.length || !dirTable[handle]) {
          setErrnoName('EBADF');
          return -1;
        }
        const memory = getMemory();
        const view = new DataView(memory.buffer);
        const bytes = new Uint8Array(memory.buffer);
        const dirEntry = dirTable[handle];

        /* Synthesize "." and ".." (Node.js opendirSync doesn't return them) */
        if (dirEntry.dotState < 2) {
          const dotName = dirEntry.dotState === 0 ? "." : "..";
          dirEntry.dotState++;
          view.setInt32(dirent_ptr + 0, 0, true);  /* d_ino */
          view.setInt32(dirent_ptr + 4, 4, true);   /* d_type = DT_DIR */
          for (let i = 0; i < dotName.length; i++) {
            bytes[dirent_ptr + 8 + i] = dotName.charCodeAt(i);
          }
          bytes[dirent_ptr + 8 + dotName.length] = 0;
          return 0;
        }

        let entry;
        try {
          entry = dirEntry.native.readSync();
        } catch (e) {
          setErrno(e);
          return -1;
        }
        if (!entry) return -1;
        /* struct dirent layout: d_ino(4) d_type(4) d_name(256) */
        view.setInt32(dirent_ptr + 0, 0, true);  /* d_ino */
        let dtype = 0; /* DT_UNKNOWN */
        if (entry.isFile()) dtype = 8;        /* DT_REG */
        else if (entry.isDirectory()) dtype = 4;  /* DT_DIR */
        else if (entry.isSymbolicLink()) dtype = 10; /* DT_LNK */
        view.setInt32(dirent_ptr + 4, dtype, true);  /* d_type */
        /* Write d_name at offset 8, max 255 chars + null */
        const nameBytes = dirEncoder.encode(entry.name);
        const nameLen = Math.min(nameBytes.length, 255);
        for (let i = 0; i < nameLen; i++) {
          bytes[dirent_ptr + 8 + i] = nameBytes[i];
        }
        bytes[dirent_ptr + 8 + nameLen] = 0;
        return 0;
      },
      __closedir: function (handle) {
        if (handle < 0 || handle >= dirTable.length || !dirTable[handle]) {
          setErrnoName('EBADF');
          return -1;
        }
        try {
          dirTable[handle].native.closeSync();
        } catch (e) {
          setErrno(e);
          dirTable[handle] = null;
          return -1;
        }
        dirTable[handle] = null;
        return 0;
      },
      stat: function (path_ptr, buf_ptr) {
        const path = readString(path_ptr);
        try {
          const st = fs.statSync(path);
          writeStatBuf(buf_ptr, st);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      lstat: function (path_ptr, buf_ptr) {
        const path = readString(path_ptr);
        try {
          const st = fs.lstatSync(path);
          writeStatBuf(buf_ptr, st);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      fstat: function (fd, buf_ptr) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try {
          const st = fs.fstatSync(fdTable[fd].nativeFd);
          writeStatBuf(buf_ptr, st);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      getcwd: function (buf_ptr, size) {
        try {
          const cwd = process.cwd();
          const encoder = new TextEncoder();
          const encoded = encoder.encode(cwd);
          if (encoded.length + 1 > size) {
            setErrnoName('ERANGE');
            return 0;
          }
          const memory = getMemory();
          const bytes = new Uint8Array(memory.buffer);
          for (let i = 0; i < encoded.length; i++) {
            bytes[buf_ptr + i] = encoded[i];
          }
          bytes[buf_ptr + encoded.length] = 0;
          return buf_ptr;
        } catch (e) {
          setErrno(e);
          return 0;
        }
      },
      chdir: function (path_ptr) {
        const path = readString(path_ptr);
        try {
          process.chdir(path);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      access: function (path_ptr, mode) {
        const path = readString(path_ptr);
        try {
          fs.accessSync(path, mode);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      /* set atime/mtime (seconds) by path; backs utimes()/utime()/utimensat().
         atime/mtime arrive as i64 BigInts (time_t) — Number() for the fs API. */
      __utime: function (path_ptr, atime, mtime) {
        const path = readString(path_ptr);
        try {
          fs.utimesSync(path, Number(atime), Number(mtime));
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      /* set atime/mtime (seconds) by fd; backs futimes()/futimens() */
      __futime: function (fd, atime, mtime) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try {
          fs.futimesSync(fdTable[fd].nativeFd, Number(atime), Number(mtime));
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      rmdir: function (path_ptr) {
        const path = readString(path_ptr);
        try {
          fs.rmdirSync(path);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      unlink: function (path_ptr) {
        const path = readString(path_ptr);
        try {
          fs.unlinkSync(path);
          return 0;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      pipe: function (pipefd_ptr) {
        /* Create an in-memory pipe: two fds sharing a buffer. Each end is
           reference-counted so a dup'd end closes only when the LAST
           duplicate is closed. */
        const pipe = { buffer: new ByteQueue(), closed: { read: false, write: false },
                       refs: { read: 1, write: 1 }, waiters: [] };
        const readFd = allocFd({ type: 'pipe', pipe: pipe, pipeEnd: 'read', position: null });
        const writeFd = allocFd({ type: 'pipe', pipe: pipe, pipeEnd: 'write', position: null });
        const memory = getMemory();
        const view = new DataView(memory.buffer);
        view.setInt32(pipefd_ptr, readFd, true);
        view.setInt32(pipefd_ptr + 4, writeFd, true);
        return 0;
      },
      // AF_UNIX sockets (todos/0008) need the brokered kernel — this plain
      // Node-fs env has no process kernel, so the family links but ENOSYSes.
      __sock_socket: function () { setErrnoName('ENOSYS'); return -1; },
      __sock_bind: function () { setErrnoName('ENOSYS'); return -1; },
      __sock_listen: function () { setErrnoName('ENOSYS'); return -1; },
      __sock_accept: function () { setErrnoName('ENOSYS'); return -1; },
      __sock_connect: function () { setErrnoName('ENOSYS'); return -1; },
      __sock_pair: function () { setErrnoName('ENOSYS'); return -1; },
      __sock_shutdown: function () { setErrnoName('ENOSYS'); return -1; },
      dup: function (oldfd) {
        if (oldfd < 0 || oldfd >= fdTable.length || !fdTable[oldfd]) { setErrnoName('EBADF'); return -1; }
        const entry = fdTable[oldfd];
        /* For pipe fds, share the same pipe object and refcount the end */
        if (entry.type === 'pipe') {
          entry.pipe.refs[entry.pipeEnd]++;
          return allocFd({ type: 'pipe', pipe: entry.pipe, pipeEnd: entry.pipeEnd, position: null });
        }
        /* POSIX: dup'd fds share one open file description — including the
           file offset. Alias the same entry object and refcount it so the
           native fd is only closed when the last alias closes. */
        entry.refs = (entry.refs || 1) + 1;
        return allocFd(entry);
      },
      // libc fcntl arrives as __fcntl3 (see fcntl.h): only the dup
      // commands act here; everything else reports success (locking is
      // meaningless single-user — the SQLite convention).
      __fcntl3: function (fd, cmd, arg) {
        if (cmd === 0 || cmd === 1030) {   /* F_DUPFD / F_DUPFD_CLOEXEC */
          if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
          let newfd = Math.max(0, arg | 0);
          while (newfd < fdTable.length && fdTable[newfd]) newfd++;
          while (fdTable.length <= newfd) fdTable.push(null);
          const entry = fdTable[fd];
          if (entry.type === 'pipe') {
            entry.pipe.refs[entry.pipeEnd]++;
            fdTable[newfd] = { type: 'pipe', pipe: entry.pipe, pipeEnd: entry.pipeEnd, position: null };
          } else {
            entry.refs = (entry.refs || 1) + 1;
            fdTable[newfd] = entry;
          }
          return newfd;
        }
        return 0;
      },
      dup2: function (oldfd, newfd) {
        if (oldfd < 0 || oldfd >= fdTable.length || !fdTable[oldfd]) { setErrnoName('EBADF'); return -1; }
        if (newfd < 0) { setErrnoName('EBADF'); return -1; }
        if (oldfd === newfd) return newfd;
        /* Close newfd if open. The default std entries are never
           closeSync'd (host streams); a dup2'd FILE entry sitting on
           fd 1/2 is — split(1) re-points fd 1 per output part and
           would otherwise leak a native fd each time (todos/0034). */
        if (newfd < fdTable.length && fdTable[newfd]) {
          const entry = fdTable[newfd];
          if (entry.type === 'pipe') {
            if (--entry.pipe.refs[entry.pipeEnd] <= 0) {
              entry.pipe.closed[entry.pipeEnd] = true;
              pipeWake(entry.pipe);
            }
          } else if (entry.nativeFd !== undefined
                     && !(entry.isStdin || entry.isStdout || entry.isStderr)) {
            if (entry.refs && entry.refs > 1) entry.refs--;
            else try { fs.closeSync(entry.nativeFd); } catch (e) { }
          }
          fdTable[newfd] = null;
        }
        /* Extend table if needed */
        while (fdTable.length <= newfd) fdTable.push(null);
        const src = fdTable[oldfd];
        if (src.type === 'pipe') {
          src.pipe.refs[src.pipeEnd]++;
          fdTable[newfd] = { type: 'pipe', pipe: src.pipe, pipeEnd: src.pipeEnd, position: null };
        } else {
          /* Same shared-description semantics as dup. */
          src.refs = (src.refs || 1) + 1;
          fdTable[newfd] = src;
        }
        return newfd;
      },
      isatty: function (fd) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return 0; }
        if (fd <= 2) {
          /* Report the real TTY-ness of the underlying stream — piped or
             redirected std fds are not ttys. */
          const stream = fd === 0 ? process.stdin : fd === 1 ? process.stdout : process.stderr;
          if (stream && stream.isTTY) return 1;
        }
        setErrnoName('ENOTTY');
        return 0;
      },
      __tcgetattr: function (fd, iflag_ptr, oflag_ptr, cflag_ptr, lflag_ptr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        const mem = new DataView(getMemory().buffer);
        mem.setInt32(iflag_ptr, termiosState.iflag, true);
        mem.setInt32(oflag_ptr, termiosState.oflag, true);
        mem.setInt32(cflag_ptr, termiosState.cflag, true);
        mem.setInt32(lflag_ptr, termiosState.lflag, true);
        return 0;
      },
      __tcsetattr: function (fd, actions, iflag, oflag, cflag, lflag) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        const wasCanon = !!(termiosState.lflag & 0x100);
        const isCanon = !!(lflag & 0x100);
        termiosState.iflag = iflag;
        termiosState.oflag = oflag;
        termiosState.cflag = cflag;
        termiosState.lflag = lflag;
        if (typeof process !== 'undefined' && process.stdin && typeof process.stdin.setRawMode === 'function') {
          if (wasCanon && !isCanon) process.stdin.setRawMode(true);
          else if (!wasCanon && isCanon) process.stdin.setRawMode(false);
        }
        return 0;
      },
      // Full-struct termios (new binaries; the CLI's real terminal): same
      // termiosState + real setRawMode switching as the legacy pair above.
      // Layout: 4×u32 flags, cc[20]@16, speeds@36/40.
      __tty_getattr: function (fd, tPtr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        const mem = new DataView(getMemory().buffer);
        mem.setUint32(tPtr, termiosState.iflag >>> 0, true);
        mem.setUint32(tPtr + 4, termiosState.oflag >>> 0, true);
        mem.setUint32(tPtr + 8, termiosState.cflag >>> 0, true);
        mem.setUint32(tPtr + 12, termiosState.lflag >>> 0, true);
        const bytes = new Uint8Array(getMemory().buffer);
        const cc = termiosState.cc || [4, 0, 0, 127, 0, 21, 0, 0, 3, 28, 26, 0, 17, 19, 0, 0, 1, 0, 0, 0];
        for (let ci = 0; ci < 20; ci++) bytes[tPtr + 16 + ci] = cc[ci] | 0;
        mem.setUint32(tPtr + 36, 0, true);
        mem.setUint32(tPtr + 40, 0, true);
        return 0;
      },
      __tty_setattr: function (fd, actions, tPtr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        const mem = new DataView(getMemory().buffer);
        const bytes = new Uint8Array(getMemory().buffer);
        const wasCanon = !!(termiosState.lflag & 0x100);
        termiosState.iflag = mem.getUint32(tPtr, true);
        termiosState.oflag = mem.getUint32(tPtr + 4, true);
        termiosState.cflag = mem.getUint32(tPtr + 8, true);
        termiosState.lflag = mem.getUint32(tPtr + 12, true);
        termiosState.cc = Array.from(bytes.subarray(tPtr + 16, tPtr + 36));
        const isCanon = !!(termiosState.lflag & 0x100);
        if (typeof process !== 'undefined' && process.stdin && typeof process.stdin.setRawMode === 'function') {
          if (wasCanon && !isCanon) process.stdin.setRawMode(true);
          else if (!wasCanon && isCanon) process.stdin.setRawMode(false);
        }
        return 0;
      },
      __tty_getpgrp: function (fd) { void fd; setErrnoName('ENOTTY'); return -1; },
      __tty_setpgrp: function (fd, pgid) { void fd; void pgid; setErrnoName('ENOTTY'); return -1; },
      __ioctl_tiocgwinsz: function (fd, rows_ptr, cols_ptr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        const mem = new DataView(getMemory().buffer);
        mem.setInt32(rows_ptr, process.stdout.rows || 24, true);
        mem.setInt32(cols_ptr, process.stdout.columns || 80, true);
        return 0;
      },
      // Ptys need a kernel (todos/0020); the CLI runtime has none.
      __openpty: function (m_ptr, s_ptr) { void m_ptr; void s_ptr; setErrnoName('ENOSYS'); return -1; },
      __ioctl_tiocswinsz: function (fd, rows, cols) { void fd; void rows; void cols; setErrnoName('ENOTTY'); return -1; },
      usleep: new WebAssembly.Suspending(async function (usec) {
        await new Promise(resolve => setTimeout(resolve, usec / 1000));
        return 0;
      }),
      __nanosleep: new WebAssembly.Suspending(async function (sec, nsec) {
        const ms = sec * 1000 + nsec / 1e6;
        await new Promise(resolve => setTimeout(resolve, Math.max(1, ms)));
        return 0;
      }),
      __select_impl: new WebAssembly.Suspending(async function (nfds, readfds_ptr, writefds_ptr, exceptfds_ptr, timeout_sec, timeout_usec, has_timeout) {
        ensureStdinListening();
        const mem = new DataView(getMemory().buffer);
        const FDS_WORDS = 2;
        function readBits(ptr) {
          if (!ptr) return null;
          const bits = [];
          for (let i = 0; i < FDS_WORDS; i++) bits.push(mem.getInt32(ptr + i * 4, true));
          return bits;
        }
        function writeBits(ptr, bits) {
          if (!ptr) return;
          for (let i = 0; i < FDS_WORDS; i++) mem.setInt32(ptr + i * 4, bits[i], true);
        }
        function isBitSet(bits, fd) { return bits && (bits[fd >> 5] & (1 << (fd & 31))) !== 0; }
        function checkFds() {
          const rIn = readBits(readfds_ptr), wIn = readBits(writefds_ptr), eIn = readBits(exceptfds_ptr);
          const rOut = rIn ? [0, 0] : null, wOut = wIn ? [0, 0] : null, eOut = eIn ? [0, 0] : null;
          let count = 0;
          for (let fd = 0; fd < nfds && fd < 64; fd++) {
            if (fd >= fdTable.length || !fdTable[fd]) continue;
            const entry = fdTable[fd];
            if (rIn && isBitSet(rIn, fd)) {
              let ready = false;
              if (entry.type === 'pipe') {
                ready = entry.pipe.buffer.length > 0 || entry.pipe.closed.write;
              } else if (entry.isStdin) {
                ready = stdinBuf.length > 0 || stdinEOF;
              } else if (entry.position !== null) {
                ready = true;
              }
              if (ready) { rOut[fd >> 5] |= (1 << (fd & 31)); count++; }
            }
            if (wIn && isBitSet(wIn, fd)) {
              let ready = false;
              if (entry.type === 'pipe') {
                ready = !entry.pipe.closed.read;
              } else {
                ready = true;
              }
              if (ready) { wOut[fd >> 5] |= (1 << (fd & 31)); count++; }
            }
          }
          return { count, rOut, wOut, eOut };
        }
        function writeResult(r) {
          writeBits(readfds_ptr, r.rOut);
          writeBits(writefds_ptr, r.wOut);
          writeBits(exceptfds_ptr, r.eOut);
          return r.count;
        }
        const result = checkFds();
        if (result.count > 0 || (has_timeout && timeout_sec === 0 && timeout_usec === 0)) {
          return writeResult(result);
        }
        const deadline = has_timeout ? Date.now() + timeout_sec * 1000 + timeout_usec / 1000 : Infinity;
        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return writeResult(checkFds());
          await new Promise(resolve => {
            const timer = setTimeout(resolve, Math.min(remaining, 50));
            stdinWaiters.push(() => { clearTimeout(timer); resolve(); });
          });
          const r2 = checkFds();
          if (r2.count > 0) return writeResult(r2);
        }
      }),
    },
  };

  const termiosState = { iflag: 0x100, oflag: 0x1, cflag: 0xB00, lflag: 0x188 };

  /* Patch read/write/close to handle pipe fds and async stdin */
  const origWrite = result[ENV_KEY].write;
  const origClose = result[ENV_KEY].close;

  result[ENV_KEY].read = new WebAssembly.Suspending(async function (fd, buf_ptr, count) {
    if (fd >= 0 && fd < fdTable.length && fdTable[fd] && fdTable[fd].type === 'pipe') {
      /* POSIX: a zero-length read returns 0 IMMEDIATELY — even on an empty
         pipe with a live writer. Entering the wait loop here parked the
         reader until an unrelated write/close (regression on the CD5
         blocking fix). */
      if (count === 0) return 0;
      const entry = fdTable[fd];
      const pipe = entry.pipe;
      while (pipe.buffer.length === 0) {
        if (pipe.closed.write) return 0; /* EOF: writers gone, buffer drained */
        /* Writer still open: BLOCK until data arrives or the write end
           closes (the readImpl stdin pattern — pipeWake resolves us).
           Returning 0 here was a spurious EOF: a reader racing its
           writer silently truncated the stream (the 0171 bug class). */
        await new Promise(resolve => { pipe.waiters.push(resolve); });
      }
      const memory = getMemory();
      const dest = new Uint8Array(memory.buffer, buf_ptr, count);
      return pipe.buffer.read(dest, count);
    }
    return readImpl(fd, buf_ptr, count);
  });

  result[ENV_KEY].write = function (fd, buf_ptr, count) {
    if (fd >= 0 && fd < fdTable.length && fdTable[fd] && fdTable[fd].type === 'pipe') {
      const entry = fdTable[fd];
      const pipe = entry.pipe;
      if (pipe.closed.read) { setErrnoName('EPIPE'); return -1; }
      const memory = getMemory();
      const src = new Uint8Array(memory.buffer, buf_ptr, count);
      pipe.buffer.push(src); /* ByteQueue copies — src is a wasm-memory view */
      pipeWake(pipe);
      return count;
    }
    return origWrite(fd, buf_ptr, count);
  };

  result[ENV_KEY].close = function (fd) {
    if (fd >= 0 && fd < fdTable.length && fdTable[fd] && fdTable[fd].type === 'pipe') {
      const entry = fdTable[fd];
      /* Per-end refcount: the end closes when its LAST duplicate goes. */
      if (--entry.pipe.refs[entry.pipeEnd] <= 0) {
        entry.pipe.closed[entry.pipeEnd] = true;
        pipeWake(entry.pipe); /* parked readers must see EOF, not hang */
      }
      fdTable[fd] = null;
      return 0;
    }
    return origClose(fd);
  };

  return result;
}

// =========================================================================
// BLOCK_FS — synchronous block filesystem backed by a single OPFS file
// =========================================================================
//
// All filesystem operations are synchronous after init(). The filesystem
// stores everything inside one OPFS file using a single
// FileSystemSyncAccessHandle — no JSPI needed.  This is the iOS / Safari
// path where WebAssembly.Suspending is not available.
//
// Allocator: TLSF (Two-Level Segregated Fit), ported from the WASM malloc
// implementation in compiler.js.  O(1) alloc / free, good fragmentation
// behaviour, bounded metadata.
//
// Layout inside the backing store:
//   Offset 0:       Superblock (256 B)
//   Offset 256:     TLSF metadata (2048 B: bitmaps + free-list heads)
//   Offset 2304:    TLSF managed pool
//                     Inode table extent (first TLSF allocation, growable)
//                     Root dir extent
//                     File / directory extents ...
//
// Each file / directory is a single contiguous extent allocated via TLSF.
// The inode stores (extent_offset, extent_capacity, data_size).  File
// growth that exceeds extent_capacity triggers a TLSF realloc which may
// move the extent.
//
// Inode format (32 bytes):
//   [ 0: 4] extent_offset   uint32   TLSF ptr to data extent, 0 = none
//   [ 4: 8] extent_capacity uint32   allocated size of data extent
//   [ 8:12] data_size       uint32   logical file size
//   [12:14] mode            uint16   S_IFREG|0644 or S_IFDIR|0755
//   [14:16] nlink           uint16   directory-entry refcount
//   [16:20] mtime           uint32   epoch seconds (data last modified)
//   [20:24] ctime           uint32   epoch seconds (inode last changed)
//   [24:28] btime           uint32   epoch seconds (creation; 0 = unknown)
//   [28:32] atime           uint32   epoch seconds (access, relatime; 0 = unknown)
//
// btime+atime occupy what were the uid/gid (24:28) and reserved (28:32) bytes.
// BlockFS is single-user (root only, uid/gid always 0), so ownership is fixed
// at 0 and those 8 bytes carry timestamps instead — no inode growth, no format
// migration. Pre-existing images have these bytes zeroed, so old files read as
// atime/btime = 0 ("unknown"), which is the correct sentinel.
//
// Directory entry format (variable-length, stored in dir extent):
//   [ 0: 4] inode_id        uint32
//   [ 4: 6] name_len        uint16
//   [ 6:6+N] name           uint8[N]   (sorted by name for binary search)
//
// Exports (attached to self / module.exports for testing):
//   BLOCK_FS.init(opfsName)     → Promise<BlockFS>  (production)
//   BLOCK_FS.create(byteStore)  → BlockFS            (tests, sync)
//   BLOCK_FS.MemoryByteStore                          (test constructor)
//   BLOCK_FS.TLSFAllocator                            (test constructor)

var BLOCK_FS = (function () {
  'use strict';

  // -------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------
  var SUPERBLOCK_SIZE = 256;
  var TLSF_META_SIZE = 2048;
  var TLSF_POOL_OFFSET = SUPERBLOCK_SIZE + TLSF_META_SIZE; // 2304

  var INODE_SIZE = 32;
  var INITIAL_INODE_CAPACITY = 64;

  var MAGIC = 0x424C4B46; // "BLKF"
  var VERSION = 3;

  var S_IFMT = 0o170000;
  var S_IFDIR = 0o040000;
  var S_IFCHR = 0o020000;
  var S_IFREG = 0o100000;
  var S_IFLNK = 0o120000;
  var S_IFSOCK = 0o140000;
  var SYMLOOP_MAX = 40;     // symlink-following hop cap → ELOOP
  var DEFAULT_DIR_MODE = 0o40755;
  var DEFAULT_FILE_MODE = 0o100644;

  // /dev character devices (v4 only — they live in the inode's dedicated rdev
  // field). Device numbers use the traditional 16-bit makedev (major<<8|minor),
  // matching <sys/sysmacros.h> in the bundled libc, with Linux's mem-device
  // minors so major()/minor() in programs report the familiar numbers.
  function makedev(ma, mi) { return ((ma & 0xfff) << 8) | (mi & 0xff); }
  var DEV_NULL = makedev(1, 3);
  var DEV_ZERO = makedev(1, 5);
  var DEV_FULL = makedev(1, 7);
  var DEV_RANDOM = makedev(1, 8);
  var DEV_URANDOM = makedev(1, 9);

  // ---- Superblock field offsets ----
  var SB_MAGIC = 0, SB_VERSION = 4, SB_FLAGS = 8;
  var SB_TLSF_POOL_OFFSET = 12, SB_TLSF_POOL_SIZE = 16;
  var SB_INODE_TBL_EXTENT = 20, SB_INODE_TBL_CAP = 24;
  var SB_NEXT_INODE_ID = 28, SB_ROOT_INODE = 32;
  var SB_RESERVED = 36;

  // ---- Inode field offsets ----
  var INO_EXTENT_OFFSET = 0, INO_EXTENT_CAP = 4, INO_DATA_SIZE = 8;
  var INO_MODE = 12, INO_NLINK = 14;
  var INO_MTIME = 16, INO_CTIME = 20;
  // btime/atime reuse the former uid/gid (24) + reserved (28) bytes — see the
  // inode-format note above. Single-user, so uid/gid are not stored at all.
  var INO_BTIME = 24, INO_ATIME = 28;

  // ---- TLSF constants (matching compiler.js WASM malloc) ----
  var FREE_BIT = 1, PREV_FREE_BIT = 2, FLAG_BITS = 3;
  var BLOCK_OVERHEAD = 8, MIN_BLOCK_SIZE = 16, BLOCK_ALIGN = 8;
  var SL_LOG2 = 4, SL_COUNT = 16;
  var FL_SHIFT = 4, FL_MAX = 32;
  var FL_COUNT = FL_MAX - FL_SHIFT + 1; // 29
  var FREE_BLOCK_OVERHEAD = BLOCK_OVERHEAD + 8; // 16: header + free list ptrs

  // =================================================================
  // ByteStore — random-access byte-addressable backing store
  // =================================================================

  // For tests: backed by an ArrayBuffer.
  function MemoryByteStore(initialSize) {
    initialSize = initialSize || 65536;
    var buf = new ArrayBuffer(initialSize);
    this._u8 = new Uint8Array(buf);
    this._dv = new DataView(buf);
  }
  MemoryByteStore.prototype.getUint32 = function (off) {
    return this._dv.getUint32(off, true);
  };
  MemoryByteStore.prototype.setUint32 = function (off, val) {
    this._dv.setUint32(off, val, true);
  };
  MemoryByteStore.prototype.getBytes = function (off, len) {
    return this._u8.slice(off, off + len);
  };
  MemoryByteStore.prototype.setBytes = function (off, data) {
    this._u8.set(data, off);
  };
  MemoryByteStore.prototype.size = function () {
    return this._u8.byteLength;
  };
  MemoryByteStore.prototype.resize = function (newSize) {
    if (newSize <= this._u8.byteLength) return;
    var old = this._u8;
    var buf = new ArrayBuffer(newSize);
    this._u8 = new Uint8Array(buf);
    this._dv = new DataView(buf);
    this._u8.set(old);
  };
  // No backing store — writes are already in the ArrayBuffer.
  MemoryByteStore.prototype.flush = function () {};

  // For production: backed by a FileSystemSyncAccessHandle.
  function SyncAccessHandleStore(handle) {
    this._h = handle;
    this._tmp4 = new Uint8Array(4);
    this._tmpDV = new DataView(this._tmp4.buffer);
  }
  SyncAccessHandleStore.prototype.getUint32 = function (off) {
    this._h.read(this._tmp4, { at: off });
    return this._tmpDV.getUint32(0, true);
  };
  SyncAccessHandleStore.prototype.setUint32 = function (off, val) {
    this._tmpDV.setUint32(0, val, true);
    this._h.write(this._tmp4, { at: off });
  };
  SyncAccessHandleStore.prototype.getBytes = function (off, len) {
    var buf = new Uint8Array(len);
    if (len > 0) this._h.read(buf, { at: off });
    return buf;
  };
  SyncAccessHandleStore.prototype.setBytes = function (off, data) {
    if (data.length > 0) this._h.write(data, { at: off });
  };
  SyncAccessHandleStore.prototype.size = function () {
    return this._h.getSize();
  };
  SyncAccessHandleStore.prototype.resize = function (newSize) {
    this._h.truncate(newSize);
  };
  // Force buffered writes to durable storage. OPFS write() does NOT guarantee
  // durability until flush() — without this, acknowledged writes can be lost
  // on a tab crash / kill.
  SyncAccessHandleStore.prototype.flush = function () {
    this._h.flush();
  };

  // Wraps a store so every write throws — used to mount the legacy v3 image as a
  // strictly read-only "view" (the toggle), so it can never be mutated.
  function ReadOnlyStore(inner) { this._i = inner; }
  ReadOnlyStore.prototype.getUint32 = function (o) { return this._i.getUint32(o); };
  ReadOnlyStore.prototype.getBytes = function (o, l) { return this._i.getBytes(o, l); };
  ReadOnlyStore.prototype.size = function () { return this._i.size(); };
  ReadOnlyStore.prototype.setUint32 = function () { throw new Error('EROFS: read-only filesystem'); };
  ReadOnlyStore.prototype.setBytes = function () { throw new Error('EROFS: read-only filesystem'); };
  ReadOnlyStore.prototype.resize = function () { throw new Error('EROFS: read-only filesystem'); };
  ReadOnlyStore.prototype.flush = function () {};

  // Read-only store over a SharedArrayBuffer — the process-side view of the
  // sealed system volume (todos/0180): the kernel embedder copies the baked
  // image into ONE SAB at boot (storeToSab below) and every process worker
  // mounts it locally (createV4 {readonly:true}), so reads under the
  // read-only mount prefix never cross the RPC boundary. Immutable by
  // contract (KERNEL.md single-writer rule): the copy completes before any
  // worker sees the SAB and nothing ever writes it, so plain non-atomic
  // reads are coherent. getBytes returns COPIES — TextDecoder (directory
  // name decode) rejects SharedArrayBuffer-backed views, and callers may
  // hold results across ops.
  function SabByteStore(sab) {
    this._u8 = new Uint8Array(sab);
    this._dv = new DataView(sab);
  }
  SabByteStore.prototype.getUint32 = function (off) {
    return this._dv.getUint32(off, true);
  };
  SabByteStore.prototype.getBytes = function (off, len) {
    var out = new Uint8Array(len);
    out.set(this._u8.subarray(off, off + len));
    return out;
  };
  SabByteStore.prototype.size = function () { return this._u8.byteLength; };
  SabByteStore.prototype.setUint32 = function () { throw new Error('EROFS: read-only filesystem'); };
  SabByteStore.prototype.setBytes = function () { throw new Error('EROFS: read-only filesystem'); };
  SabByteStore.prototype.resize = function () { throw new Error('EROFS: read-only filesystem'); };
  SabByteStore.prototype.flush = function () {};

  // Copy a store's whole image into a SharedArrayBuffer (chunked so the
  // copy never transiently doubles the image in one getBytes allocation).
  function storeToSab(store) {
    var n = store.size();
    var sab = new SharedArrayBuffer(n);
    var out = new Uint8Array(sab);
    var CHUNK = 8 << 20;
    for (var off = 0; off < n; off += CHUNK) {
      out.set(store.getBytes(off, Math.min(CHUNK, n - off)), off);
    }
    return sab;
  }

  // =================================================================
  // TLSFAllocator — O(1) segregated-fit allocator
  // =================================================================
  //
  // Block header (8 bytes for used blocks, 16 bytes for free blocks):
  //   [0:4]  size_and_flags  uint32  bits[31:3]=block_size/8, bit0=FREE, bit1=PREV_FREE
  //   [4:8]  prev_phys       uint32  previous physical block offset (for coalescing)
  //   Free blocks additionally store at payload offset:
  //     [8:12]  next_free    uint32  (free-list next)
  //     [12:16] prev_free    uint32  (free-list prev)
  //
  // Metadata region (inside the store, at metaOffset):
  //   [0:4]    fl_bitmap
  //   [4:112]  sl_bitmap[FL_COUNT]
  //   [112:1840] free_heads[FL_COUNT * SL_COUNT]
  //   [1840:1844] pool_start
  //   [1844:1848] pool_end (allocated pool end, may grow)
  //   [1848:1852] last_block

  var META_FL_BITMAP = 0;
  var META_SL_BITMAP = 4;
  var META_FREE_HEADS = META_SL_BITMAP + FL_COUNT * 4; // 112
  var META_POOL_START = META_FREE_HEADS + FL_COUNT * SL_COUNT * 4; // 1840
  var META_POOL_END = META_POOL_START + 4; // 1844
  var META_LAST_BLOCK = META_POOL_END + 4; // 1848

  function TLSFAllocator(store, metaOffset, poolSize) {
    this._s = store;
    this._meta = metaOffset;
    this._init(poolSize);
  }

  TLSFAllocator.prototype._readMeta32 = function (off) {
    return this._s.getUint32(this._meta + off);
  };
  TLSFAllocator.prototype._writeMeta32 = function (off, val) {
    this._s.setUint32(this._meta + off, val);
  };

  TLSFAllocator.prototype._blockSize = function (block) {
    return (this._s.getUint32(block) & ~FLAG_BITS) >>> 0;
  };
  TLSFAllocator.prototype._blockSetSize = function (block, size) {
    var flags = this._s.getUint32(block) & FLAG_BITS;
    this._s.setUint32(block, (size & ~FLAG_BITS) | flags);
  };
  TLSFAllocator.prototype._blockIsFree = function (block) {
    return (this._s.getUint32(block) & FREE_BIT) !== 0;
  };
  TLSFAllocator.prototype._blockPrevIsFree = function (block) {
    return (this._s.getUint32(block) & PREV_FREE_BIT) !== 0;
  };
  TLSFAllocator.prototype._blockPrevPhys = function (block) {
    return this._s.getUint32(block + 4);
  };
  TLSFAllocator.prototype._blockSetPrevPhys = function (block, prev) {
    this._s.setUint32(block + 4, prev);
  };
  TLSFAllocator.prototype._blockNextPhys = function (block) {
    return block + this._blockSize(block);
  };
  TLSFAllocator.prototype._blockGetNextFree = function (block) {
    return this._s.getUint32(block + 8);
  };
  TLSFAllocator.prototype._blockSetNextFree = function (block, nf) {
    this._s.setUint32(block + 8, nf);
  };
  TLSFAllocator.prototype._blockGetPrevFree = function (block) {
    return this._s.getUint32(block + 12);
  };
  TLSFAllocator.prototype._blockSetPrevFree = function (block, pf) {
    this._s.setUint32(block + 12, pf);
  };

  TLSFAllocator.prototype._clz32 = function (x) {
    return Math.clz32(x);
  };
  TLSFAllocator.prototype._ctz32 = function (x) {
    if (x === 0) return 32;
    return 31 - Math.clz32(x & -x);
  };

  // mapping_insert: floor mapping (used for insert)
  TLSFAllocator.prototype._mappingInsert = function (size, out) {
    if (size < (1 << (FL_SHIFT + 1))) {
      out[0] = 0;
      out[1] = ((size - MIN_BLOCK_SIZE) >>> 3) & (SL_COUNT - 1);
    } else {
      var t = 31 - this._clz32(size);
      out[1] = ((size >>> (t - SL_LOG2)) & (SL_COUNT - 1));
      out[0] = t - FL_SHIFT;
    }
  };

  // mapping_search: ceiling mapping (used for search — rounds up)
  TLSFAllocator.prototype._mappingSearch = function (size, out) {
    var sz = size;
    // SEARCH_ROUND = size + 2^(floor(log2(size)) - SL_LOG2) - 1
    if (sz >= (1 << (FL_SHIFT + 1))) {
      var t = 31 - this._clz32(sz);
      // Plain number arithmetic — a `>>> 0` here wrapped near-2^32 sizes to a
      // tiny class, handing out a massively undersized block (cross-file
      // extent corruption). Mirrors the TLSF64 allocator's approach.
      sz = sz + Math.pow(2, t - SL_LOG2) - 1;
    }
    if (sz >= 0x100000000) {
      // Rounded size doesn't fit the 32-bit class table — no free block on a
      // v3 pool (capped below 4 GiB) can satisfy it. Signal "beyond all
      // classes"; malloc turns this into a clean allocation failure (ENOSPC).
      out[0] = FL_COUNT; out[1] = 0;
      return;
    }
    // Fall through to mapping_insert
    this._mappingInsert(sz, out);
  };

  TLSFAllocator.prototype._insertFreeBlock = function (block) {
    var flsl = [0, 0];
    var sz = this._blockSize(block);
    this._mappingInsert(sz, flsl);
    var fl = flsl[0], sl = flsl[1];

    var head = this._readMeta32(META_FREE_HEADS + (fl * SL_COUNT + sl) * 4);
    this._blockSetNextFree(block, head);
    this._blockSetPrevFree(block, 0);
    if (head) this._blockSetPrevFree(head, block);
    this._writeMeta32(META_FREE_HEADS + (fl * SL_COUNT + sl) * 4, block);

    this._writeMeta32(META_FL_BITMAP,
      this._readMeta32(META_FL_BITMAP) | (1 << fl));
    var slMap = this._readMeta32(META_SL_BITMAP + fl * 4);
    this._writeMeta32(META_SL_BITMAP + fl * 4, slMap | (1 << sl));
  };

  TLSFAllocator.prototype._removeFreeBlock = function (block) {
    var flsl = [0, 0];
    var sz = this._blockSize(block);
    this._mappingInsert(sz, flsl);
    var fl = flsl[0], sl = flsl[1];

    var nf = this._blockGetNextFree(block);
    var pf = this._blockGetPrevFree(block);

    // Sanity: verify list integrity (like the C code does)
    if (nf && this._blockGetPrevFree(nf) !== block) {
      throw new Error('TLSF: corrupted free list (next->prev != cur)');
    }
    if (pf && this._blockGetNextFree(pf) !== block) {
      throw new Error('TLSF: corrupted free list (prev->next != cur)');
    }

    if (nf) this._blockSetPrevFree(nf, pf);
    if (pf) this._blockSetNextFree(pf, nf);
    else {
      this._writeMeta32(META_FREE_HEADS + (fl * SL_COUNT + sl) * 4, nf);
      if (!nf) {
        var slMap = this._readMeta32(META_SL_BITMAP + fl * 4);
        slMap = (slMap & ~(1 << sl)) >>> 0;
        this._writeMeta32(META_SL_BITMAP + fl * 4, slMap);
        if (!slMap) {
          var flMap = this._readMeta32(META_FL_BITMAP);
          this._writeMeta32(META_FL_BITMAP,
            (flMap & ~(1 << fl)) >>> 0);
        }
      }
    }
  };

  TLSFAllocator.prototype._findSuitableBlock = function (flsl) {
    var fl = flsl[0], sl = flsl[1];
    var slMap = this._readMeta32(META_SL_BITMAP + fl * 4);
    slMap = (slMap & (~0 << sl)) >>> 0;
    if (!slMap) {
      var flMap = this._readMeta32(META_FL_BITMAP);
      flMap = (flMap & (~0 << (fl + 1))) >>> 0;
      if (!flMap) return 0;
      fl = this._ctz32(flMap);
      slMap = this._readMeta32(META_SL_BITMAP + fl * 4);
    }
    sl = this._ctz32(slMap);
    flsl[0] = fl; flsl[1] = sl;
    return this._readMeta32(META_FREE_HEADS + (fl * SL_COUNT + sl) * 4);
  };

  TLSFAllocator.prototype._mergePrev = function (block) {
    if (this._blockPrevIsFree(block)) {
      var prev = this._blockPrevPhys(block);
      this._removeFreeBlock(prev);
      var newSize = this._blockSize(prev) + this._blockSize(block);
      var flags = this._s.getUint32(prev) & FLAG_BITS;
      this._s.setUint32(prev, flags | newSize);
      // Update prev_phys of next physical block
      var next = this._blockNextPhys(prev);
      var poolEnd = this._readMeta32(META_POOL_END);
      if (next < poolEnd) this._blockSetPrevPhys(next, prev);
      if (block === this._readMeta32(META_LAST_BLOCK))
        this._writeMeta32(META_LAST_BLOCK, prev);
      block = prev;
    }
    return block;
  };

  TLSFAllocator.prototype._mergeNext = function (block) {
    var next = this._blockNextPhys(block);
    var poolEnd = this._readMeta32(META_POOL_END);
    if (next < poolEnd && this._blockIsFree(next)) {
      this._removeFreeBlock(next);
      var newSize = this._blockSize(block) + this._blockSize(next);
      var flags = this._s.getUint32(block) & FLAG_BITS;
      this._s.setUint32(block, flags | newSize);
      // Update prev_phys of block after next
      var after = this._blockNextPhys(block);
      if (after < poolEnd) this._blockSetPrevPhys(after, block);
      if (next === this._readMeta32(META_LAST_BLOCK))
        this._writeMeta32(META_LAST_BLOCK, block);
    }
    return block;
  };

  TLSFAllocator.prototype._splitBlock = function (block, needed) {
    var remainderSize = this._blockSize(block) - needed;
    if (remainderSize >= MIN_BLOCK_SIZE) {
      // Resize current block
      var flags = this._s.getUint32(block) & FLAG_BITS;
      this._s.setUint32(block, flags | needed);
      // Create remainder block
      var rem = block + needed;
      this._s.setUint32(rem, remainderSize | FREE_BIT);
      this._blockSetPrevPhys(rem, block);
      // Update next block's prev_phys
      var next = rem + remainderSize;
      var poolEnd = this._readMeta32(META_POOL_END);
      if (next < poolEnd) this._blockSetPrevPhys(next, rem);
      if (block === this._readMeta32(META_LAST_BLOCK))
        this._writeMeta32(META_LAST_BLOCK, rem);
      this._insertFreeBlock(rem);
      // Set PREV_FREE on successor
      next = this._blockNextPhys(block);
      if (next < poolEnd) {
        this._s.setUint32(next, this._s.getUint32(next) | PREV_FREE_BIT);
      }
    }
  };

  TLSFAllocator.prototype._blockMarkUsed = function (block) {
    this._s.setUint32(block, this._s.getUint32(block) & ~FREE_BIT);
    var next = this._blockNextPhys(block);
    var poolEnd = this._readMeta32(META_POOL_END);
    if (next < poolEnd)
      this._s.setUint32(next, this._s.getUint32(next) & ~PREV_FREE_BIT);
  };

  TLSFAllocator.prototype._blockMarkFree = function (block) {
    this._s.setUint32(block, this._s.getUint32(block) | FREE_BIT);
    var next = this._blockNextPhys(block);
    var poolEnd = this._readMeta32(META_POOL_END);
    if (next < poolEnd)
      this._s.setUint32(next, this._s.getUint32(next) | PREV_FREE_BIT);
  };

  TLSFAllocator.prototype._growPool = function (needed) {
    var poolStart = this._readMeta32(META_POOL_START);
    var poolEnd = this._readMeta32(META_POOL_END);
    var lastBlock = this._readMeta32(META_LAST_BLOCK);

    var newEnd = poolEnd + needed;
    // Pool metadata uses uint32 — cap at 4 GiB to prevent wrap
    if (newEnd > 0xFFFF0000) return 0;
    // Ensure the store is large enough
    if (newEnd > this._s.size()) {
      try {
        this._s.resize(newEnd + 65536);
      } catch (e) {
        return 0;
      }
    }

    var block = poolEnd;
    var blockSz = newEnd - poolEnd;

    // Round up so mapping_search can find this block. Plain number arithmetic
    // (like TLSF64) — a `>>> 0` here wrapped near-2^32 sizes to a tiny block.
    if (blockSz >= (1 << (FL_SHIFT + 1))) {
      var t = 31 - this._clz32(blockSz);
      blockSz = blockSz + Math.pow(2, t - SL_LOG2) - 1;
    }
    // Round up to alignment (mod arithmetic, not `&` — no 32-bit truncation)
    blockSz = blockSz + (BLOCK_ALIGN - 1); blockSz = blockSz - (blockSz % BLOCK_ALIGN);
    newEnd = poolEnd + blockSz;
    // Re-check the 4 GiB pool cap after rounding
    if (newEnd > 0xFFFF0000) return 0;

    // Re-check store size after rounding
    if (newEnd > this._s.size()) {
      try {
        this._s.resize(newEnd);
      } catch (e) {
        return 0; // resize failed (disk full or store cap)
      }
    }

    this._s.setUint32(block, blockSz | FREE_BIT);
    this._blockSetPrevPhys(block, lastBlock);
    this._writeMeta32(META_POOL_END, newEnd);

    // If last block is free, merge
    if (lastBlock && this._blockIsFree(lastBlock)) {
      // Set PREV_FREE bit so merge_prev works
      this._s.setUint32(block, this._s.getUint32(block) | PREV_FREE_BIT);
      this._writeMeta32(META_LAST_BLOCK, block);
      block = this._mergePrev(block);
    } else {
      this._writeMeta32(META_LAST_BLOCK, block);
    }

    this._insertFreeBlock(block);
    return 1;
  };

  TLSFAllocator.prototype._adjustRequest = function (size) {
    var adj = size + BLOCK_OVERHEAD;
    if (adj < MIN_BLOCK_SIZE) adj = MIN_BLOCK_SIZE;
    adj = (adj + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
    return adj >>> 0;
  };

  TLSFAllocator.prototype.malloc = function (size) {
    if (size === 0) return 0;
    if (size > 0xFFFFFF00) return 0;

    var adjusted = this._adjustRequest(size);

    var flsl = [0, 0];
    this._mappingSearch(adjusted, flsl);
    if (flsl[0] >= FL_COUNT) {
      // Rounded search size is beyond every class the 32-bit table can hold —
      // unfulfillable on a v3 pool. Fail cleanly (callers map this to ENOSPC).
      return 0;
    }

    var block = this._findSuitableBlock(flsl);
    if (!block) {
      if (!this._growPool(adjusted)) return 0;
      this._mappingSearch(adjusted, flsl);
      block = this._findSuitableBlock(flsl);
      if (!block) return 0;
    }

    this._removeFreeBlock(block);
    this._splitBlock(block, adjusted);
    this._blockMarkUsed(block);

    return block + BLOCK_OVERHEAD; // return payload pointer
  };

  TLSFAllocator.prototype.free = function (ptr) {
    if (!ptr) return;

    var block = ptr - BLOCK_OVERHEAD;
    var poolStart = this._readMeta32(META_POOL_START);
    var poolEnd = this._readMeta32(META_POOL_END);

    // Bounds check
    if (block < poolStart || block >= poolEnd) {
      throw new Error('TLSF: free() on pointer outside pool');
    }
    // Double-free check
    if (this._blockIsFree(block)) {
      throw new Error('TLSF: double free detected');
    }

    this._blockMarkFree(block);
    block = this._mergePrev(block);
    block = this._mergeNext(block);
    this._insertFreeBlock(block);
  };

  TLSFAllocator.prototype.realloc = function (ptr, newSize) {
    if (!ptr) return this.malloc(newSize);
    if (newSize === 0) { this.free(ptr); return 0; }
    // Reject sizes malloc itself would reject.
    if (newSize > 0xFFFFFF00) return 0;

    var block = ptr - BLOCK_OVERHEAD;
    var oldPayload = this._blockSize(block) - BLOCK_OVERHEAD;

    // If new size fits in current block, keep it
    if (newSize <= oldPayload) return ptr;

    // Grow in place by absorbing the next physical block when it is free and
    // the combined size satisfies the request; avoids the malloc+copy+free
    // round-trip. Mirrors the reference TLSF tlsf_realloc.
    var adjusted = this._adjustRequest(newSize);
    var next = this._blockNextPhys(block);
    if (next < this._readMeta32(META_POOL_END) && this._blockIsFree(next) &&
        this._blockSize(block) + this._blockSize(next) >= adjusted) {
      this._mergeNext(block);
      this._splitBlock(block, adjusted);
      this._blockMarkUsed(block);
      return ptr;
    }

    // Allocate new, copy, free old
    var newPtr = this.malloc(newSize);
    if (!newPtr) return 0;
    var src = this._s.getBytes(ptr, oldPayload);
    this._s.setBytes(newPtr, src);
    this.free(ptr);
    return newPtr;
  };

  TLSFAllocator.prototype.calloc = function (count, size) {
    if (size !== 0 && count > 0xFFFFFF00 / size) return 0;
    var total = count * size;
    var ptr = this.malloc(total);
    if (ptr) {
      var zeroes = new Uint8Array(total);
      this._s.setBytes(ptr, zeroes);
    }
    return ptr;
  };

  // ---- Test / debug ----
  TLSFAllocator.prototype.blockSize = function (ptr) {
    return this._blockSize(ptr - BLOCK_OVERHEAD) - BLOCK_OVERHEAD;
  };
  TLSFAllocator.prototype.blockIsFree = function (ptr) {
    return this._blockIsFree(ptr - BLOCK_OVERHEAD);
  };
  TLSFAllocator.prototype.metadataSize = function () {
    return TLSF_META_SIZE;
  };
  TLSFAllocator.prototype.freeBlockCount = function () {
    var count = 0;
    var poolStart = this._readMeta32(META_POOL_START);
    var poolEnd = this._readMeta32(META_POOL_END);
    var block = poolStart;
    while (block < poolEnd) {
      if (this._blockIsFree(block)) count++;
      block = this._blockNextPhys(block);
    }
    return count;
  };
  TLSFAllocator.prototype.totalFreeBytes = function () {
    var total = 0;
    var poolStart = this._readMeta32(META_POOL_START);
    var poolEnd = this._readMeta32(META_POOL_END);
    var block = poolStart;
    while (block < poolEnd) {
      if (this._blockIsFree(block))
        total += this._blockSize(block) - BLOCK_OVERHEAD;
      block = this._blockNextPhys(block);
    }
    return total;
  };

  TLSFAllocator.prototype._init = function (poolSize) {
    // poolSize == 0: load existing metadata from store without zeroing
    if (poolSize === 0) return;

    var poolStart = TLSF_POOL_OFFSET;
    var storeSize = this._s.size();
    var actualPoolSize = storeSize - poolStart;
    if (actualPoolSize < poolSize) {
      this._s.resize(poolStart + poolSize);
      actualPoolSize = poolSize;
    }

    // Zero metadata
    for (var i = 0; i < TLSF_META_SIZE; i += 4) {
      this._writeMeta32(i, 0);
    }
    this._writeMeta32(META_POOL_START, poolStart);
    this._writeMeta32(META_POOL_END, poolStart + actualPoolSize);
    this._writeMeta32(META_LAST_BLOCK, 0);

    // Create initial free block
    var block = poolStart;
    this._s.setUint32(block, actualPoolSize | FREE_BIT);
    this._blockSetPrevPhys(block, 0);
    this._writeMeta32(META_LAST_BLOCK, block);

    // Update next block's prev_phys (none — at the end)
    // prev_block set to PREV_FREE_BIT for the first block's successor
    // (no successor since this is the only block; poolEnd marks boundary)

    this._insertFreeBlock(block);
  };

  // =================================================================
  // TLSF64Allocator — 64-bit copy of TLSFAllocator (BLOCK_FS v4)
  // =================================================================
  //
  // Same O(1) segregated-fit algorithm as TLSFAllocator, widened to 64-bit
  // offsets/sizes so the pool can exceed 4 GiB. The v3 allocator + ByteStores are
  // untouched (v3 stays frozen). Design notes:
  //   - Offsets/sizes are plain JS numbers (exact to 2^53 ≈ 9 PB, far beyond any
  //     real image), persisted as lo/hi uint32 pairs via _get64/_set64. No BigInt.
  //   - JS bitwise ops are 32-bit, so the size_and_flags word is ARITHMETIC:
  //     word = size + flags (size is 8-aligned so its low 2 bits are free for the
  //     FREE|PREV_FREE flags); size = word - (word % 4), flags = word % 4. Bitwise
  //     is still used on the small flag value and on the 32-bit free-list bitmaps.
  //   - FL_MAX64 = 35 → FL_COUNT64 = 32, so fl_bitmap fits one 32-bit word; the
  //     top size-class absorbs everything larger (coarser fit only for >32 GiB
  //     blocks). Shifts at the fl=31 boundary use a guarded maskGE().
  //
  // Block header (16 bytes used, 32 bytes free):
  //   [0:8]   size_and_flags  u64
  //   [8:16]  prev_phys       u64
  //   Free blocks add: [16:24] next_free u64, [24:32] prev_free u64
  // Metadata (at metaOffset): fl_bitmap u32; sl_bitmap[FL_COUNT64] u32 each;
  //   free_heads[FL_COUNT64*SL_COUNT] u64 each; pool_start/pool_end/last_block u64.

  var BLOCK_OVERHEAD64 = 16, MIN_BLOCK_SIZE64 = 32;
  var FL_MAX64 = 35, FL_COUNT64 = FL_MAX64 - FL_SHIFT + 1; // 32
  var TLSF_META_SIZE64 = 8192;
  var TLSF_POOL_OFFSET64 = SUPERBLOCK_SIZE + TLSF_META_SIZE64; // 8448

  var M64_FL_BITMAP = 0;
  var M64_SL_BITMAP = 4;
  var M64_FREE_HEADS = M64_SL_BITMAP + FL_COUNT64 * 4;             // 132
  var M64_POOL_START = M64_FREE_HEADS + FL_COUNT64 * SL_COUNT * 8; // 4228
  var M64_POOL_END = M64_POOL_START + 8;                          // 4236
  var M64_LAST_BLOCK = M64_POOL_END + 8;                          // 4244

  function _maskGE(n) { return n >= 32 ? 0 : ((~0 << n) >>> 0); } // bits [n..31]

  function TLSF64Allocator(store, metaOffset, poolSize) {
    this._s = store;
    this._meta = metaOffset;
    this._init(poolSize);
  }

  TLSF64Allocator.prototype._get64 = function (off) {
    return this._s.getUint32(off) + this._s.getUint32(off + 4) * 0x100000000;
  };
  TLSF64Allocator.prototype._set64 = function (off, v) {
    this._s.setUint32(off, v >>> 0);
    this._s.setUint32(off + 4, Math.floor(v / 0x100000000));
  };
  TLSF64Allocator.prototype._readMeta32 = function (off) { return this._s.getUint32(this._meta + off); };
  TLSF64Allocator.prototype._writeMeta32 = function (off, val) { this._s.setUint32(this._meta + off, val); };
  TLSF64Allocator.prototype._readMeta64 = function (off) { return this._get64(this._meta + off); };
  TLSF64Allocator.prototype._writeMeta64 = function (off, val) { this._set64(this._meta + off, val); };
  TLSF64Allocator.prototype._freeHead = function (fl, sl) { return this._readMeta64(M64_FREE_HEADS + (fl * SL_COUNT + sl) * 8); };
  TLSF64Allocator.prototype._setFreeHead = function (fl, sl, v) { this._writeMeta64(M64_FREE_HEADS + (fl * SL_COUNT + sl) * 8, v); };

  // size_and_flags is arithmetic: word = size + flags.
  TLSF64Allocator.prototype._getFlags = function (block) { return this._get64(block) % 4; };
  TLSF64Allocator.prototype._setFlags = function (block, flags) {
    var w = this._get64(block);
    this._set64(block, (w - (w % 4)) + (flags & FLAG_BITS));
  };
  TLSF64Allocator.prototype._blockSize = function (block) {
    var w = this._get64(block);
    return w - (w % 4);
  };
  TLSF64Allocator.prototype._blockSetSize = function (block, size) {
    this._set64(block, size + (this._get64(block) % 4));
  };
  TLSF64Allocator.prototype._blockIsFree = function (block) { return (this._getFlags(block) & FREE_BIT) !== 0; };
  TLSF64Allocator.prototype._blockPrevIsFree = function (block) { return (this._getFlags(block) & PREV_FREE_BIT) !== 0; };
  TLSF64Allocator.prototype._blockPrevPhys = function (block) { return this._get64(block + 8); };
  TLSF64Allocator.prototype._blockSetPrevPhys = function (block, prev) { this._set64(block + 8, prev); };
  TLSF64Allocator.prototype._blockNextPhys = function (block) { return block + this._blockSize(block); };
  TLSF64Allocator.prototype._blockGetNextFree = function (block) { return this._get64(block + 16); };
  TLSF64Allocator.prototype._blockSetNextFree = function (block, nf) { this._set64(block + 16, nf); };
  TLSF64Allocator.prototype._blockGetPrevFree = function (block) { return this._get64(block + 24); };
  TLSF64Allocator.prototype._blockSetPrevFree = function (block, pf) { this._set64(block + 24, pf); };

  TLSF64Allocator.prototype._ctz32 = function (x) {
    if (x === 0) return 32;
    return 31 - Math.clz32(x & -x);
  };
  // floor(log2(x)) for 1 <= x < 2^53.
  TLSF64Allocator.prototype._fls = function (x) {
    if (x >= 0x100000000) return 32 + (31 - Math.clz32(Math.floor(x / 0x100000000)));
    return 31 - Math.clz32(x);
  };

  TLSF64Allocator.prototype._mappingInsert = function (size, out) {
    if (size < (1 << (FL_SHIFT + 1))) {
      out[0] = 0;
      out[1] = Math.floor((size - MIN_BLOCK_SIZE64) / 8) & (SL_COUNT - 1);
    } else {
      var t = this._fls(size);
      var fl = t - FL_SHIFT;
      var sl = Math.floor(size / Math.pow(2, t - SL_LOG2)) & (SL_COUNT - 1);
      if (fl >= FL_COUNT64) { fl = FL_COUNT64 - 1; sl = SL_COUNT - 1; } // top class absorbs the rest
      out[0] = fl; out[1] = sl;
    }
  };

  TLSF64Allocator.prototype._mappingSearch = function (size, out) {
    var sz = size;
    if (sz >= (1 << (FL_SHIFT + 1))) {
      var t = this._fls(sz);
      sz = sz + Math.pow(2, t - SL_LOG2) - 1; // round up (arithmetic — may exceed 2^32)
    }
    this._mappingInsert(sz, out);
  };

  TLSF64Allocator.prototype._insertFreeBlock = function (block) {
    var flsl = [0, 0];
    this._mappingInsert(this._blockSize(block), flsl);
    var fl = flsl[0], sl = flsl[1];
    var head = this._freeHead(fl, sl);
    this._blockSetNextFree(block, head);
    this._blockSetPrevFree(block, 0);
    if (head) this._blockSetPrevFree(head, block);
    this._setFreeHead(fl, sl, block);
    this._writeMeta32(M64_FL_BITMAP, this._readMeta32(M64_FL_BITMAP) | (1 << fl));
    this._writeMeta32(M64_SL_BITMAP + fl * 4, this._readMeta32(M64_SL_BITMAP + fl * 4) | (1 << sl));
  };

  TLSF64Allocator.prototype._removeFreeBlock = function (block) {
    var flsl = [0, 0];
    this._mappingInsert(this._blockSize(block), flsl);
    var fl = flsl[0], sl = flsl[1];
    var nf = this._blockGetNextFree(block);
    var pf = this._blockGetPrevFree(block);
    if (nf && this._blockGetPrevFree(nf) !== block) throw new Error('TLSF64: corrupted free list (next->prev != cur)');
    if (pf && this._blockGetNextFree(pf) !== block) throw new Error('TLSF64: corrupted free list (prev->next != cur)');
    if (nf) this._blockSetPrevFree(nf, pf);
    if (pf) this._blockSetNextFree(pf, nf);
    else {
      this._setFreeHead(fl, sl, nf);
      if (!nf) {
        var slMap = (this._readMeta32(M64_SL_BITMAP + fl * 4) & ~(1 << sl)) >>> 0;
        this._writeMeta32(M64_SL_BITMAP + fl * 4, slMap);
        if (!slMap) this._writeMeta32(M64_FL_BITMAP, (this._readMeta32(M64_FL_BITMAP) & ~(1 << fl)) >>> 0);
      }
    }
  };

  TLSF64Allocator.prototype._findSuitableBlock = function (flsl) {
    var fl = flsl[0], sl = flsl[1];
    var slMap = (this._readMeta32(M64_SL_BITMAP + fl * 4) & _maskGE(sl)) >>> 0;
    if (!slMap) {
      var flMap = (this._readMeta32(M64_FL_BITMAP) & _maskGE(fl + 1)) >>> 0;
      if (!flMap) return 0;
      fl = this._ctz32(flMap);
      slMap = this._readMeta32(M64_SL_BITMAP + fl * 4);
    }
    sl = this._ctz32(slMap);
    flsl[0] = fl; flsl[1] = sl;
    return this._freeHead(fl, sl);
  };

  TLSF64Allocator.prototype._mergePrev = function (block) {
    if (this._blockPrevIsFree(block)) {
      var prev = this._blockPrevPhys(block);
      this._removeFreeBlock(prev);
      var newSize = this._blockSize(prev) + this._blockSize(block);
      this._set64(prev, newSize + this._getFlags(prev));
      var next = this._blockNextPhys(prev);
      var poolEnd = this._readMeta64(M64_POOL_END);
      if (next < poolEnd) this._blockSetPrevPhys(next, prev);
      if (block === this._readMeta64(M64_LAST_BLOCK)) this._writeMeta64(M64_LAST_BLOCK, prev);
      block = prev;
    }
    return block;
  };

  TLSF64Allocator.prototype._mergeNext = function (block) {
    var next = this._blockNextPhys(block);
    var poolEnd = this._readMeta64(M64_POOL_END);
    if (next < poolEnd && this._blockIsFree(next)) {
      this._removeFreeBlock(next);
      var newSize = this._blockSize(block) + this._blockSize(next);
      this._set64(block, newSize + this._getFlags(block));
      var after = this._blockNextPhys(block);
      if (after < poolEnd) this._blockSetPrevPhys(after, block);
      if (next === this._readMeta64(M64_LAST_BLOCK)) this._writeMeta64(M64_LAST_BLOCK, block);
    }
    return block;
  };

  TLSF64Allocator.prototype._splitBlock = function (block, needed) {
    var remainderSize = this._blockSize(block) - needed;
    if (remainderSize >= MIN_BLOCK_SIZE64) {
      this._set64(block, needed + this._getFlags(block));
      var rem = block + needed;
      this._set64(rem, remainderSize + FREE_BIT);
      this._blockSetPrevPhys(rem, block);
      var next = rem + remainderSize;
      var poolEnd = this._readMeta64(M64_POOL_END);
      if (next < poolEnd) this._blockSetPrevPhys(next, rem);
      if (block === this._readMeta64(M64_LAST_BLOCK)) this._writeMeta64(M64_LAST_BLOCK, rem);
      this._insertFreeBlock(rem);
      next = this._blockNextPhys(block);
      if (next < poolEnd) this._setFlags(next, this._getFlags(next) | PREV_FREE_BIT);
    }
  };

  TLSF64Allocator.prototype._blockMarkUsed = function (block) {
    this._setFlags(block, this._getFlags(block) & ~FREE_BIT);
    var next = this._blockNextPhys(block);
    if (next < this._readMeta64(M64_POOL_END)) this._setFlags(next, this._getFlags(next) & ~PREV_FREE_BIT);
  };
  TLSF64Allocator.prototype._blockMarkFree = function (block) {
    this._setFlags(block, this._getFlags(block) | FREE_BIT);
    var next = this._blockNextPhys(block);
    if (next < this._readMeta64(M64_POOL_END)) this._setFlags(next, this._getFlags(next) | PREV_FREE_BIT);
  };

  TLSF64Allocator.prototype._growPool = function (needed) {
    var poolEnd = this._readMeta64(M64_POOL_END);
    var lastBlock = this._readMeta64(M64_LAST_BLOCK);
    var newEnd = poolEnd + needed;
    if (newEnd > 0x1FFFFFFFFFFFFF) return 0; // stay well under 2^53
    if (newEnd > this._s.size()) {
      try { this._s.resize(newEnd + 65536); } catch (e) { return 0; }
    }
    var block = poolEnd;
    var blockSz = newEnd - poolEnd;
    if (blockSz >= (1 << (FL_SHIFT + 1))) {
      var t = this._fls(blockSz);
      blockSz = blockSz + Math.pow(2, t - SL_LOG2) - 1;
    }
    blockSz = blockSz + (BLOCK_ALIGN - 1); blockSz = blockSz - (blockSz % BLOCK_ALIGN);
    newEnd = poolEnd + blockSz;
    if (newEnd > this._s.size()) {
      try { this._s.resize(newEnd); } catch (e) { return 0; }
    }
    this._set64(block, blockSz + FREE_BIT);
    this._blockSetPrevPhys(block, lastBlock);
    this._writeMeta64(M64_POOL_END, newEnd);
    if (lastBlock && this._blockIsFree(lastBlock)) {
      this._setFlags(block, this._getFlags(block) | PREV_FREE_BIT);
      this._writeMeta64(M64_LAST_BLOCK, block);
      block = this._mergePrev(block);
    } else {
      this._writeMeta64(M64_LAST_BLOCK, block);
    }
    this._insertFreeBlock(block);
    return 1;
  };

  TLSF64Allocator.prototype._adjustRequest = function (size) {
    var adj = size + BLOCK_OVERHEAD64;
    if (adj < MIN_BLOCK_SIZE64) adj = MIN_BLOCK_SIZE64;
    adj = adj + (BLOCK_ALIGN - 1);
    return adj - (adj % BLOCK_ALIGN);
  };

  TLSF64Allocator.prototype.malloc = function (size) {
    if (size === 0) return 0;
    if (size > 0xFFFFFFFFFFFF) return 0; // ~2^48 single-allocation cap
    var adjusted = this._adjustRequest(size);
    var flsl = [0, 0];
    this._mappingSearch(adjusted, flsl);
    if (flsl[0] >= FL_COUNT64) {
      if (!this._growPool(adjusted)) return 0;
      this._mappingSearch(adjusted, flsl);
    }
    var block = this._findSuitableBlock(flsl);
    if (!block) {
      if (!this._growPool(adjusted)) return 0;
      this._mappingSearch(adjusted, flsl);
      block = this._findSuitableBlock(flsl);
      if (!block) return 0;
    }
    this._removeFreeBlock(block);
    this._splitBlock(block, adjusted);
    this._blockMarkUsed(block);
    return block + BLOCK_OVERHEAD64;
  };

  TLSF64Allocator.prototype.free = function (ptr) {
    if (!ptr) return;
    var block = ptr - BLOCK_OVERHEAD64;
    var poolStart = this._readMeta64(M64_POOL_START);
    var poolEnd = this._readMeta64(M64_POOL_END);
    if (block < poolStart || block >= poolEnd) throw new Error('TLSF64: free() on pointer outside pool');
    if (this._blockIsFree(block)) throw new Error('TLSF64: double free detected');
    this._blockMarkFree(block);
    block = this._mergePrev(block);
    block = this._mergeNext(block);
    this._insertFreeBlock(block);
  };

  TLSF64Allocator.prototype.realloc = function (ptr, newSize) {
    if (!ptr) return this.malloc(newSize);
    if (newSize === 0) { this.free(ptr); return 0; }
    if (newSize > 0xFFFFFFFFFFFF) return 0;
    var block = ptr - BLOCK_OVERHEAD64;
    var oldPayload = this._blockSize(block) - BLOCK_OVERHEAD64;
    if (newSize <= oldPayload) return ptr;
    // Grow in place by absorbing the next physical block when it is free and
    // the combined size satisfies the request; avoids the malloc+copy+free
    // round-trip. Mirrors the reference TLSF tlsf_realloc.
    var adjusted = this._adjustRequest(newSize);
    var next = this._blockNextPhys(block);
    if (next < this._readMeta64(M64_POOL_END) && this._blockIsFree(next) &&
        this._blockSize(block) + this._blockSize(next) >= adjusted) {
      this._mergeNext(block);
      this._splitBlock(block, adjusted);
      this._blockMarkUsed(block);
      return ptr;
    }
    var newPtr = this.malloc(newSize);
    if (!newPtr) return 0;
    this._s.setBytes(newPtr, this._s.getBytes(ptr, oldPayload));
    this.free(ptr);
    return newPtr;
  };

  TLSF64Allocator.prototype.calloc = function (count, size) {
    if (size !== 0 && count > 0xFFFFFFFFFFFF / size) return 0;
    var total = count * size;
    var ptr = this.malloc(total);
    if (ptr) this._s.setBytes(ptr, new Uint8Array(total));
    return ptr;
  };

  // ---- Test / debug (mirror TLSFAllocator) ----
  TLSF64Allocator.prototype.blockSize = function (ptr) { return this._blockSize(ptr - BLOCK_OVERHEAD64) - BLOCK_OVERHEAD64; };
  TLSF64Allocator.prototype.blockIsFree = function (ptr) { return this._blockIsFree(ptr - BLOCK_OVERHEAD64); };
  TLSF64Allocator.prototype.metadataSize = function () { return TLSF_META_SIZE64; };
  TLSF64Allocator.prototype.freeBlockCount = function () {
    var count = 0, poolEnd = this._readMeta64(M64_POOL_END), block = this._readMeta64(M64_POOL_START);
    while (block < poolEnd) { if (this._blockIsFree(block)) count++; block = this._blockNextPhys(block); }
    return count;
  };
  TLSF64Allocator.prototype.totalFreeBytes = function () {
    var total = 0, poolEnd = this._readMeta64(M64_POOL_END), block = this._readMeta64(M64_POOL_START);
    while (block < poolEnd) { if (this._blockIsFree(block)) total += this._blockSize(block) - BLOCK_OVERHEAD64; block = this._blockNextPhys(block); }
    return total;
  };

  TLSF64Allocator.prototype._init = function (poolSize) {
    if (poolSize === 0) return; // load existing metadata without zeroing
    var poolStart = TLSF_POOL_OFFSET64;
    var storeSize = this._s.size();
    var actualPoolSize = storeSize - poolStart;
    if (actualPoolSize < poolSize) { this._s.resize(poolStart + poolSize); actualPoolSize = poolSize; }
    actualPoolSize = actualPoolSize - (actualPoolSize % BLOCK_ALIGN);
    for (var i = 0; i < TLSF_META_SIZE64; i += 4) this._writeMeta32(i, 0);
    this._writeMeta64(M64_POOL_START, poolStart);
    this._writeMeta64(M64_POOL_END, poolStart + actualPoolSize);
    this._writeMeta64(M64_LAST_BLOCK, 0);
    var block = poolStart;
    this._set64(block, actualPoolSize + FREE_BIT);
    this._blockSetPrevPhys(block, 0);
    this._writeMeta64(M64_LAST_BLOCK, block);
    this._insertFreeBlock(block);
  };

  // =================================================================
  // InodeTable — flat array of inodes, stored in a TLSF extent
  // =================================================================

  function InodeTable(alloc) {
    this._alloc = alloc;
    this._store = alloc._s; // direct store access for efficiency
    // No cached extent/capacity: the superblock (SB_INODE_TBL_EXTENT/CAP) is the
    // single source of truth, read THROUGH the store on every access. This keeps
    // multiple live BlockFS instances over one store coherent (e.g. a concurrent
    // headless runner + the workspace owner) — a stale cache would otherwise read
    // inodes at the wrong offset after the table grows/relocates.
  }

  InodeTable.prototype.init = function (initialCapacity) {
    initialCapacity = initialCapacity || INITIAL_INODE_CAPACITY;
    var byteSize = initialCapacity * INODE_SIZE;
    var extent = this._alloc.malloc(byteSize);
    if (!extent) throw new Error('InodeTable: initial alloc failed');
    this._store.setUint32(SB_INODE_TBL_EXTENT, extent);
    this._store.setUint32(SB_INODE_TBL_CAP, initialCapacity);
    // Zero the table
    var zeroes = new Uint8Array(byteSize);
    this._store.setBytes(extent, zeroes);
    return extent;
  };

  InodeTable.prototype.load = function (extent, capacity) {
    // No-op: the superblock is the source of truth (read-through). Retained for
    // the mount call site.
  };

  InodeTable.prototype.capacity = function () { return this._store.getUint32(SB_INODE_TBL_CAP); };
  InodeTable.prototype.extent = function () { return this._store.getUint32(SB_INODE_TBL_EXTENT); };

  InodeTable.prototype.read = function (inoId) {
    if (inoId >= this.capacity()) return null;
    var off = this.extent() + inoId * INODE_SIZE;
    // Read fields individually
    return {
      extentOffset: this._store.getUint32(off + INO_EXTENT_OFFSET),
      extentCapacity: this._store.getUint32(off + INO_EXTENT_CAP),
      dataSize: this._store.getUint32(off + INO_DATA_SIZE),
      mode: this._store.getUint32(off + INO_MODE) & 0xFFFF, // read as uint32, mask
      nlink: this._store.getUint32(off + INO_MODE) >>> 16,
      mtime: this._store.getUint32(off + INO_MTIME),
      ctime: this._store.getUint32(off + INO_CTIME),
      btime: this._store.getUint32(off + INO_BTIME),
      atime: this._store.getUint32(off + INO_ATIME)
    };
  };

  InodeTable.prototype.write = function (inoId, ino) {
    if (inoId >= this.capacity()) return false;
    var off = this.extent() + inoId * INODE_SIZE;
    this._store.setUint32(off + INO_EXTENT_OFFSET, ino.extentOffset);
    this._store.setUint32(off + INO_EXTENT_CAP, ino.extentCapacity);
    this._store.setUint32(off + INO_DATA_SIZE, ino.dataSize);
    this._store.setUint32(off + INO_MODE,
      (ino.mode & 0xFFFF) | ((ino.nlink & 0xFFFF) << 16));
    this._store.setUint32(off + INO_MTIME, ino.mtime);
    this._store.setUint32(off + INO_CTIME, ino.ctime);
    this._store.setUint32(off + INO_BTIME, ino.btime || 0);
    this._store.setUint32(off + INO_ATIME, ino.atime || 0);
    return true;
  };

  InodeTable.prototype.grow = function (newCapacity) {
    var oldExtent = this.extent();
    var oldCapacity = this.capacity();
    var byteSize = newCapacity * INODE_SIZE;
    var newExtent = this._alloc.malloc(byteSize);
    if (!newExtent) return false;
    // Copy old table
    var oldBytes = this._store.getBytes(oldExtent, oldCapacity * INODE_SIZE);
    this._store.setBytes(newExtent, oldBytes);
    // Zero new portion
    var zeroes = new Uint8Array((newCapacity - oldCapacity) * INODE_SIZE);
    this._store.setBytes(newExtent + oldCapacity * INODE_SIZE, zeroes);
    // Free old extent
    this._alloc.free(oldExtent);
    // Persist new location/size to the superblock (the source of truth).
    this._store.setUint32(SB_INODE_TBL_EXTENT, newExtent);
    this._store.setUint32(SB_INODE_TBL_CAP, newCapacity);
    return true;
  };

  // =================================================================
  // InodeTable128 — v4 inode table: 128-byte inodes, 64-bit fields, ms times
  // =================================================================
  //
  // Parallel to InodeTable (v3 32-byte). Same read-through design (the v4
  // superblock is the source of truth for extent/capacity). Inode layout:
  //   [0:2] mode u16  [2:4] nlink u16  [4:8] flags u32
  //   [8:16] extent_offset u64  [16:24] extent_capacity u64  [24:32] data_size u64
  //   [32:40] mtime  [40:48] ctime  [48:56] atime  [56:64] btime   (i64 ms each)
  //   [64:68] rdev u32 (reserved for /dev)  [68:128] reserved (uid/gid/gen/…)
  // v4 superblock: 64-bit inode-table extent at 16; capacity at 24; next-inode-id
  // (28) and root (32) share v3's offsets, so _allocInode/_createRootDir are
  // format-agnostic.

  var INODE_SIZE_V4 = 128;
  var I4_MODE = 0, I4_EXTENT_OFF = 8, I4_EXTENT_CAP = 16, I4_DATA_SIZE = 24;
  var I4_MTIME = 32, I4_CTIME = 40, I4_ATIME = 48, I4_BTIME = 56, I4_RDEV = 64;
  var SB4_INODE_EXTENT = 16, SB4_INODE_CAP = 24; // 64-bit extent / 32-bit cap

  function InodeTable128(alloc) { this._alloc = alloc; this._store = alloc._s; }
  InodeTable128.prototype._g64 = function (off) {
    return this._store.getUint32(off) + this._store.getUint32(off + 4) * 0x100000000;
  };
  InodeTable128.prototype._s64 = function (off, v) {
    this._store.setUint32(off, v >>> 0);
    this._store.setUint32(off + 4, Math.floor(v / 0x100000000));
  };
  InodeTable128.prototype.init = function (initialCapacity) {
    initialCapacity = initialCapacity || INITIAL_INODE_CAPACITY;
    var extent = this._alloc.malloc(initialCapacity * INODE_SIZE_V4);
    if (!extent) throw new Error('InodeTable128: initial alloc failed');
    this._s64(SB4_INODE_EXTENT, extent);
    this._store.setUint32(SB4_INODE_CAP, initialCapacity);
    this._store.setBytes(extent, new Uint8Array(initialCapacity * INODE_SIZE_V4));
    return extent;
  };
  InodeTable128.prototype.load = function () {}; // superblock is the source of truth
  InodeTable128.prototype.capacity = function () { return this._store.getUint32(SB4_INODE_CAP); };
  InodeTable128.prototype.extent = function () { return this._g64(SB4_INODE_EXTENT); };
  // Read/write the whole 128-byte inode in ONE store op. The store may be a
  // SyncAccessHandle where each getUint32/setUint32 is a separate (slow) OPFS
  // syscall — reading the 10+ fields individually cost ~10 syscalls per inode
  // access, and inodes are touched constantly (walk, lookup, free). A single
  // getBytes/setBytes over a local DataView keeps the exact byte layout while
  // collapsing that to one syscall.
  function _dv64(dv, off) {
    return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
  }
  function _dvSet64(dv, off, v) {
    dv.setUint32(off, v >>> 0, true);
    dv.setUint32(off + 4, Math.floor(v / 0x100000000), true);
  }
  InodeTable128.prototype.read = function (inoId) {
    if (inoId >= this.capacity()) return null;
    var off = this.extent() + inoId * INODE_SIZE_V4;
    var buf = this._store.getBytes(off, INODE_SIZE_V4);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var modeWord = dv.getUint32(I4_MODE, true);
    return {
      mode: modeWord & 0xFFFF,
      nlink: (modeWord >>> 16) & 0xFFFF,
      extentOffset: _dv64(dv, I4_EXTENT_OFF),
      extentCapacity: _dv64(dv, I4_EXTENT_CAP),
      dataSize: _dv64(dv, I4_DATA_SIZE),
      mtime: _dv64(dv, I4_MTIME),
      ctime: _dv64(dv, I4_CTIME),
      atime: _dv64(dv, I4_ATIME),
      btime: _dv64(dv, I4_BTIME),
      rdev: dv.getUint32(I4_RDEV, true)
    };
  };
  InodeTable128.prototype.write = function (inoId, ino) {
    if (inoId >= this.capacity()) return false;
    var off = this.extent() + inoId * INODE_SIZE_V4;
    var buf = new Uint8Array(INODE_SIZE_V4);
    var dv = new DataView(buf.buffer);
    dv.setUint32(I4_MODE, (ino.mode & 0xFFFF) | ((ino.nlink & 0xFFFF) << 16), true);
    _dvSet64(dv, I4_EXTENT_OFF, ino.extentOffset);
    _dvSet64(dv, I4_EXTENT_CAP, ino.extentCapacity);
    _dvSet64(dv, I4_DATA_SIZE, ino.dataSize);
    _dvSet64(dv, I4_MTIME, ino.mtime);
    _dvSet64(dv, I4_CTIME, ino.ctime);
    _dvSet64(dv, I4_ATIME, ino.atime);
    _dvSet64(dv, I4_BTIME, ino.btime || 0);
    dv.setUint32(I4_RDEV, ino.rdev || 0, true);
    this._store.setBytes(off, buf);
    return true;
  };
  InodeTable128.prototype.grow = function (newCapacity) {
    var oldExtent = this.extent(), oldCapacity = this.capacity();
    var newExtent = this._alloc.malloc(newCapacity * INODE_SIZE_V4);
    if (!newExtent) return false;
    this._store.setBytes(newExtent, this._store.getBytes(oldExtent, oldCapacity * INODE_SIZE_V4));
    this._store.setBytes(newExtent + oldCapacity * INODE_SIZE_V4,
      new Uint8Array((newCapacity - oldCapacity) * INODE_SIZE_V4));
    this._alloc.free(oldExtent);
    this._s64(SB4_INODE_EXTENT, newExtent);
    this._store.setUint32(SB4_INODE_CAP, newCapacity);
    return true;
  };

  // ---- Format descriptors: pin the per-version pieces BlockFS varies on ----
  // v3 reproduces the original behavior exactly (so v3 stays byte-identical).
  var FMT_V3 = {
    version: 3, timeScale: 1, poolOffset: TLSF_POOL_OFFSET,
    poolEnd: function (a) { return a._readMeta32(META_POOL_END); }
  };
  var FMT_V4 = {
    version: 4, timeScale: 1000, poolOffset: TLSF_POOL_OFFSET64,
    poolEnd: function (a) { return a._readMeta64(M64_POOL_END); }
  };

  // =================================================================
  // Directory helpers — operate on a directory inode's data extent
  // =================================================================

  // Directory entry wire format:
  //   [0:4] inode_id  uint32
  //   [4:6] name_len  uint16
  //   [6:6+N] name    uint8[N]
  // Entries are sorted by name (strcmp order) in the data extent.

  var DIR_ENT_HEADER = 6;

  var _encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  var _decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;

  function encodeStr(s) {
    return _encoder.encode(s);
  }
  function decodeStr(buf) {
    return _decoder.decode(buf);
  }

  // Read the whole used portion of a directory extent in ONE store op. Over a
  // SyncAccessHandle each field read is an OPFS syscall, so the old per-field
  // readDirEnt made every scan O(N) syscalls and a full directory walk O(N^2).
  // Reading the extent once and parsing entries from the local buffer collapses
  // each scan to a single syscall. Returns { buf, dv } (dv little-endian over buf).
  function readDirExtent(store, extentBase, extentSize) {
    var buf = store.getBytes(extentBase, extentSize);
    return { buf: buf, dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength) };
  }

  // Parse a directory entry at `offset` from an already-read extent buffer.
  function parseDirEnt(buf, dv, offset, extentSize) {
    if (offset + DIR_ENT_HEADER > extentSize) return null;
    var inoId = dv.getUint32(offset, true);
    // nameLen is a 2-byte field; read exactly 2 bytes so the read stays within
    // the (extent-sized) buffer even when only the 6-byte header remains.
    var nameLen = dv.getUint16(offset + 4, true);
    if (offset + DIR_ENT_HEADER + nameLen > extentSize) return null;
    var nameBytes = buf.subarray(offset + 6, offset + 6 + nameLen);
    return { inodeId: inoId, nameLen: nameLen, name: decodeStr(nameBytes) };
  }

  // Scan the directory for an entry with the given name.
  // Returns { inodeId, offset: offset within extent of this entry } or null.
  function dirLookup(store, extentBase, extentSize, name) {
    // Binary search — entries are sorted by name.
    // Directory entries are variable-length, so we use a two-pass approach:
    // first collect entry offsets, then binary search. The whole extent is read
    // once up front so the scan is a single syscall, not one per entry.
    var ext = readDirExtent(store, extentBase, extentSize);
    var offsets = [];
    var pos = 0;
    while (pos < extentSize) {
      var ent = parseDirEnt(ext.buf, ext.dv, pos, extentSize);
      if (!ent) break;
      if (ent.inodeId !== 0) offsets.push(pos); // skip deleted entries
      pos += DIR_ENT_HEADER + ent.nameLen;
    }

    var lo = 0, hi = offsets.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      var e = parseDirEnt(ext.buf, ext.dv, offsets[mid], extentSize);
      if (!e) break;
      if (e.name === name) return { inodeId: e.inodeId, offset: offsets[mid] };
      if (e.name < name) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  // Find the insertion point for `name` in sorted order.
  // Returns the byte offset where the entry should be inserted.
  function dirFindInsertPos(store, extentBase, extentSize, name) {
    var ext = readDirExtent(store, extentBase, extentSize);
    var target = 0;
    var pos = 0;
    while (pos < extentSize) {
      var ent = parseDirEnt(ext.buf, ext.dv, pos, extentSize);
      if (!ent) break;
      if (ent.inodeId !== 0 && ent.name >= name) break;
      target = pos + DIR_ENT_HEADER + ent.nameLen;
      pos += DIR_ENT_HEADER + ent.nameLen;
    }
    return target;
  }

  // Write a directory entry at `offset` within the dir extent.
  function dirWriteEnt(store, extentBase, offset, inodeId, name) {
    var nameBytes = encodeStr(name);
    store.setUint32(extentBase + offset, inodeId);
    // Write nameLen as 2 bytes at offset+4.  We cannot use setUint32 here
    // because it writes 4 bytes and would corrupt byte offset+6 which may
    // already hold data from a shifted entry (see dirInsert).
    var lenBuf = new Uint8Array(2);
    lenBuf[0] = nameBytes.length & 0xFF;
    lenBuf[1] = (nameBytes.length >> 8) & 0xFF;
    store.setBytes(extentBase + offset + 4, lenBuf);
    store.setBytes(extentBase + offset + 6, nameBytes);
  }

  // Insert a directory entry, maintaining sort order.
  // Returns true on success. The caller must ensure the extent has room.
  function dirInsert(store, extentBase, extentSize, inodeId, name) {
    var nameBytes = encodeStr(name);
    var entSize = DIR_ENT_HEADER + nameBytes.length;
    var insertPos = dirFindInsertPos(store, extentBase, extentSize, name);

    // Shift data after insertPos to make room
    if (insertPos < extentSize) {
      var tail = store.getBytes(extentBase + insertPos,
        extentSize - insertPos);
      store.setBytes(extentBase + insertPos + entSize, tail);
    }
    dirWriteEnt(store, extentBase, insertPos, inodeId, name);
    return insertPos;
  }

  // Remove a directory entry by name. Returns the old inodeId or 0.
  function dirRemove(store, extentBase, extentSize, name) {
    var found = dirLookup(store, extentBase, extentSize, name);
    if (!found) return 0;
    // Read the entry to get its full size
    var ext = readDirExtent(store, extentBase, extentSize);
    var ent = parseDirEnt(ext.buf, ext.dv, found.offset, extentSize);
    if (!ent) return 0;
    var entSize = DIR_ENT_HEADER + ent.nameLen;
    // Shift subsequent data back (reuse the buffer we already read).
    var tailStart = found.offset + entSize;
    if (tailStart < extentSize) {
      store.setBytes(extentBase + found.offset,
        ext.buf.subarray(tailStart, extentSize));
    }
    return found.inodeId;
  }

  // List all non-deleted entries in a directory.
  function dirList(store, extentBase, extentSize) {
    var ext = readDirExtent(store, extentBase, extentSize);
    var result = [];
    var pos = 0;
    while (pos < extentSize) {
      var ent = parseDirEnt(ext.buf, ext.dv, pos, extentSize);
      if (!ent) break;
      if (ent.inodeId !== 0) result.push({ name: ent.name, inodeId: ent.inodeId });
      pos += DIR_ENT_HEADER + ent.nameLen;
    }
    return result;
  }

  // =================================================================
  // BlockFS — the filesystem proper
  // =================================================================

  function BlockFS(store, alloc, inodeTable, rootIno, sbFormat, fmt) {
    this._s = store;           // ByteStore
    this._alloc = alloc;       // TLSFAllocator / TLSF64Allocator
    this._inodes = inodeTable; // InodeTable / InodeTable128
    this._fmt = fmt || FMT_V3; // version-specific bits (FMT_V3 = original behavior)
    this._rootIno = rootIno;   // root inode ID (always 1)
    // next free inode ID lives in the superblock (SB_NEXT_INODE_ID), read
    // THROUGH the store so concurrent live instances don't both hand out the
    // same id. _createRootDir() seeds it to 2 on a fresh format.
    this._sbFormat = sbFormat; // true if freshly formatted

    this._lastError = '';
    this._cwd = '/';
    // Read-only volume (todos/0040): every mutating op returns EROFS, atime
    // bumps and the /dev self-heal are suppressed. Set by createV4's
    // opts.readonly (which also wraps the store in ReadOnlyStore as a
    // backstop) and by the migration source / legacy-view paths.
    this._readonly = false;
    // Mount hooks (todos/0026), wired by MountFS when this volume is one of
    // several in a mount table. _mountOwns(fullPath) -> volume-relative path
    // if this volume owns it, else null; null hook = standalone volume
    // (symlink walk behavior unchanged — the single-volume fast path).
    this._mountPrefix = '/';
    this._mountOwns = null;
    this._stdinBuffer = new ByteQueue();
    this._stdinEOF = false;
    // Optional live-stdin SAB ring (main-thread producer → this worker
    // consumer). Null unless wired by setStdinSab()/toWasmEnv(). See the
    // "Live interactive stdin" block below for the layout.
    this._stdinSab = null;
    this._stdinCtrl = null;
    this._stdinRing = null;
    // Optional owner-brokered pipe transport (the embedder injects it via
    // toWasmEnv ctx). When set, pipe() and the pipe paths of read/write/close/
    // dup/dup2 delegate to the OWNER so the two ends of one pipe can live in
    // different BlockFS instances (different workers) — the spawn-pipeline case.
    // Null → the in-memory pipe fallback (single instance: Node CLI, emitted
    // pages). The broker is { pipeCreate, pipeRead, pipeWrite, pipeClose,
    // pipeRef }; ends are 0=read, 1=write.
    this._pipeBroker = null;
    // The three default console entries — the ONLY place `console: true` is
    // set. Console routing is a POSITIVE capability (code-debt CD27): the
    // stdio fast paths (close/read/write below, toWasmEnv's fd-1/2 write
    // import, __select_impl's stdin scan) test `entry.console === true`,
    // never the absence of type/inoId — so a foreign backend's entry (or a
    // forgotten one) can never be mistaken for the console; absence means
    // "not console", the safe default. dup/dup2/F_DUPFD share the entry
    // object (_dupEntry), so the marker survives hush's fd-save dance.
    this._fdTable = [
      { console: true, position: null }, // 0 = stdin
      { console: true, position: null }, // 1 = stdout
      { console: true, position: null }, // 2 = stderr
    ];
    this._dirTable = [];
    // Open-reference counts (inoId -> number of fd-table slots holding it).
    // POSIX unlink-while-open: an inode whose last hard link is removed is
    // reclaimed only when the last open fd releases it (_dropLink/_inoUnref).
    // This is IN-MEMORY, PER-INSTANCE state — nothing persisted, so the
    // on-disk format is unchanged. Limitation: fd tables are per-instance and
    // there is no cross-instance mechanism for them (unlike broker pipes), so
    // an unlink in one live instance while ANOTHER instance holds the file
    // open still frees it — same behavior as before this fix.
    this._openInodes = new Map();

    // If freshly formatted, create the root directory
    if (sbFormat) {
      this._createRootDir();
    }
  }

  BlockFS.prototype._now = function () {
    // Date.now() is fine here — this is sync code in a worker. Returns the inode's
    // native storage unit: seconds (v3) or milliseconds (v4, timeScale 1000).
    return this._fmt.timeScale === 1 ? Math.floor(Date.now() / 1000) : Date.now();
  };

  BlockFS.prototype._setErr = function (name) {
    this._lastError = name;
    return null;
  };

  BlockFS.prototype._readSuperblock = function () {
    return {
      magic: this._s.getUint32(SB_MAGIC),
      version: this._s.getUint32(SB_VERSION),
      flags: this._s.getUint32(SB_FLAGS),
      tlsfPoolOffset: this._s.getUint32(SB_TLSF_POOL_OFFSET),
      tlsfPoolSize: this._s.getUint32(SB_TLSF_POOL_SIZE),
      inodeTblExtent: this._s.getUint32(SB_INODE_TBL_EXTENT),
      inodeTblCap: this._s.getUint32(SB_INODE_TBL_CAP),
      nextInodeId: this._s.getUint32(SB_NEXT_INODE_ID),
      rootInode: this._s.getUint32(SB_ROOT_INODE)
    };
  };

  BlockFS.prototype._writeSuperblock = function () {
    this._s.setUint32(SB_MAGIC, MAGIC);
    this._s.setUint32(SB_VERSION, this._fmt.version);
    this._s.setUint32(SB_FLAGS, 0);
    if (this._fmt.version === 3) {
      // v3 layout (unchanged): 32-bit pool + inode-table fields.
      this._s.setUint32(SB_TLSF_POOL_OFFSET, TLSF_POOL_OFFSET);
      var poolEnd = 0;
      try { poolEnd = this._alloc._readMeta32(META_POOL_END); } catch (e) { poolEnd = 0; }
      this._s.setUint32(SB_TLSF_POOL_SIZE, poolEnd - TLSF_POOL_OFFSET);
      this._s.setUint32(SB_INODE_TBL_EXTENT, this._inodes.extent());
      this._s.setUint32(SB_INODE_TBL_CAP, this._inodes.capacity());
    }
    // v4: the inode-table extent/cap are 64-bit and owned by InodeTable128
    // (SB4_*); the pool metadata lives in the TLSF64 meta region. Magic/version/
    // flags/root are the only superblock fields written here.
    // SB_NEXT_INODE_ID (28) and SB_ROOT_INODE (32) share offsets across formats.
    this._s.setUint32(SB_ROOT_INODE, this._rootIno);
  };

  BlockFS.prototype._createRootDir = function () {
    // Root inode (inode 1)
    var rootNow = this._now();
    var rootIno = {
      extentOffset: 0, extentCapacity: 0, dataSize: 0,
      mode: DEFAULT_DIR_MODE, nlink: 1,
      mtime: rootNow, ctime: rootNow,
      btime: rootNow, atime: rootNow
    };
    // Allocate a small initial extent for the root directory
    var rootExtent = this._alloc.malloc(256);
    if (!rootExtent) throw new Error('BlockFS: root dir alloc failed');
    rootIno.extentOffset = rootExtent;
    rootIno.extentCapacity = 256;
    rootIno.dataSize = 0;

    this._inodes.write(1, rootIno);
    this._s.setUint32(SB_NEXT_INODE_ID, 2);
  };

  // Allocate a new inode with initial state.
  BlockFS.prototype._allocInode = function (mode) {
    var inoId = this._s.getUint32(SB_NEXT_INODE_ID);
    if (inoId >= this._inodes.capacity()) {
      // Grow inode table (grow() persists the new extent/cap to the superblock)
      if (!this._inodes.grow(this._inodes.capacity() * 2)) {
        return this._setErr('ENOSPC');
      }
    }
    // Persist nextInodeId to the superblock (read-through) so reloads and other
    // live instances never reuse an inode id.
    this._s.setUint32(SB_NEXT_INODE_ID, inoId + 1);
    var now = this._now();
    var ino = {
      extentOffset: 0, extentCapacity: 0, dataSize: 0,
      mode: mode, nlink: 0,
      mtime: now, ctime: now,
      btime: now, atime: now
    };
    this._inodes.write(inoId, ino);
    return inoId;
  };

  // Free an inode and its data extent.
  BlockFS.prototype._freeInode = function (inoId) {
    var ino = this._inodes.read(inoId);
    if (!ino) return;
    if (ino.extentOffset) this._alloc.free(ino.extentOffset);
    // Zero the inode slot
    this._inodes.write(inoId, {
      extentOffset: 0, extentCapacity: 0, dataSize: 0,
      mode: 0, nlink: 0, mtime: 0, ctime: 0, btime: 0, atime: 0
    });
  };

  // ---- Open-reference counting (see _openInodes in the constructor) ----
  BlockFS.prototype._inoRef = function (inoId) {
    this._openInodes.set(inoId, (this._openInodes.get(inoId) || 0) + 1);
  };
  BlockFS.prototype._inoUnref = function (inoId) {
    var n = (this._openInodes.get(inoId) || 0) - 1;
    if (n > 0) { this._openInodes.set(inoId, n); return; }
    this._openInodes.delete(inoId);
    // Last close of an unlinked-but-open file reclaims it now.
    var ino = this._inodes.read(inoId);
    if (ino && ino.mode !== 0 && ino.nlink <= 0) this._freeInode(inoId);
  };

  // Drop one hard link from an inode (its dirent must already be removed):
  // reclaim the inode + data extent only when the last link is gone AND no
  // open fd in this instance still references it (POSIX unlink-while-open;
  // the last close reclaims it via _inoUnref).
  BlockFS.prototype._dropLink = function (inoId, ino) {
    ino.nlink--;
    if (ino.nlink <= 0 && !this._openInodes.get(inoId)) {
      this._freeInode(inoId);
    } else {
      ino.ctime = this._now(); // link-count change updates ctime
      this._inodes.write(inoId, ino);
    }
  };

  // Duplicate an fd-table entry (shared by dup(), dup2() and fcntl F_DUPFD).
  // Pipe ends are reference-counted — broker-side for owner-brokered pipes,
  // per-end refs for in-memory ones — so closing one duplicate doesn't close
  // the end. Plain file/dev entries are shared (same object, same position,
  // like POSIX dup) and bump the inode's open-reference count.
  BlockFS.prototype._dupEntry = function (entry) {
    if (entry.type === 'pipe') {
      if (entry.pipeId !== undefined && this._pipeBroker) {
        this._pipeBroker.pipeRef(entry.pipeId, entry.pipeEnd === 'write' ? 1 : 0);
        return { type: 'pipe', pipeId: entry.pipeId, pipeEnd: entry.pipeEnd, position: null };
      }
      entry.pipe.refs[entry.pipeEnd]++;
      return { type: 'pipe', pipe: entry.pipe, pipeEnd: entry.pipeEnd, position: null };
    }
    if (entry.inoId !== undefined) this._inoRef(entry.inoId);
    return entry;
  };

  // Release one fd-table reference to an entry (shared by close() and the
  // implicit close inside dup2()). A pipe end closes when its last duplicate
  // goes; a file drops one open-reference (possibly reclaiming an unlinked
  // inode).
  BlockFS.prototype._releaseEntry = function (entry) {
    if (entry.type === 'pipe') {
      // A pipe end on ANY fd (incl. 0/1/2 after dup2 — the pipeline case) must
      // release its ref so the peer sees EOF/EPIPE.
      if (entry.pipeId !== undefined && this._pipeBroker) {
        this._pipeBroker.pipeClose(entry.pipeId, entry.pipeEnd === 'write' ? 1 : 0);
      } else if (--entry.pipe.refs[entry.pipeEnd] <= 0) {
        entry.pipe.closed[entry.pipeEnd] = true;
      }
      return;
    }
    if (entry.inoId !== undefined) this._inoUnref(entry.inoId);
  };

  // Get the inode for a path. Returns { inoId, ino } or null.
  // Walk a path to its inode, following symbolic links along the way. With
  // noFollowFinal=true the LAST component is not followed (for lstat/readlink/
  // unlink/rename, which act on the link itself). A symlink component is
  // resolved by splicing its target into the path and restarting from root,
  // bounded by SYMLOOP_MAX hops (→ ELOOP). Note: '..' is collapsed lexically by
  // _resolvePath before the walk (logical, not physical — like realpath sans -P).
  BlockFS.prototype._walkPath = function (path, noFollowFinal) {
    if (!this._mountOwns) return this._walkHops(path, !!noFollowFinal, 0);
    // Mounted volume (todos/0026): a symlink target that leaves this volume
    // makes _walkHops throw a __mountEscape. Tag it with the path THIS
    // top-level walk was given (__mountFrom) so MountFS can tell which of an
    // operation's path arguments (or which parent-dir walk) escaped, rewrite
    // it, and retry on the owning volume. All BlockFS path ops resolve every
    // component through _walkPath before mutating anything, so an escape
    // aborts the operation with no partial state.
    try {
      return this._walkHops(path, !!noFollowFinal, 0);
    } catch (e) {
      if (e && e.__mountEscape && e.__mountFrom === undefined) {
        e.__mountFrom = this._resolvePath(path);
      }
      throw e;
    }
  };
  BlockFS.prototype._walkHops = function (path, noFollowFinal, hops) {
    var resolved = this._resolvePath(path);
    if (resolved === '/') {
      var ri = this._inodes.read(this._rootIno);
      return ri ? { inoId: this._rootIno, ino: ri } : null;
    }
    var parts = resolved.split('/').filter(function (p) { return p; });
    var inoId = this._rootIno;
    for (var i = 0; i < parts.length; i++) {
      var dirIno = this._inodes.read(inoId);
      if (!dirIno || (dirIno.mode & S_IFMT) !== S_IFDIR) return null;
      if (!dirIno.extentOffset) return null;
      var found = dirLookup(this._s, dirIno.extentOffset,
        dirIno.dataSize, parts[i]);
      if (!found) return null;
      var childId = found.inodeId;
      var childIno = this._inodes.read(childId);
      if (!childIno) return null;
      var isLast = (i === parts.length - 1);
      if ((childIno.mode & S_IFMT) === S_IFLNK && !(isLast && noFollowFinal)) {
        if (hops >= SYMLOOP_MAX) return this._setErr('ELOOP');
        var tlen = childIno.dataSize;
        var target = (childIno.extentOffset && tlen > 0)
          ? decodeStr(this._s.getBytes(childIno.extentOffset, tlen)) : '';
        if (!target) return null;                 // empty/dangling target
        var dirPath = '/' + parts.slice(0, i).join('/');
        var rest = parts.slice(i + 1).join('/');
        if (this._mountOwns) {
          // Mounted volume (todos/0026): resolve the target in the FULL
          // namespace. Absolute targets are full-namespace by convention;
          // relative ones are joined under this volume's mount prefix so a
          // '..' can climb over the mount root. If the result still belongs
          // to this volume, strip back to volume-relative and keep walking
          // (the single-volume fast path); otherwise throw the escape for
          // MountFS to re-walk on the owning volume.
          var pfx = this._mountPrefix === '/' ? '' : this._mountPrefix;
          var full = target.charAt(0) === '/'
            ? target + (rest ? '/' + rest : '')
            : pfx + (dirPath === '/' ? '' : dirPath) + '/' + target + (rest ? '/' + rest : '');
          full = this._resolvePath(full);   // lexical collapse, full namespace
          var relNext = this._mountOwns(full);
          if (relNext === null) {
            var esc = new Error('mount escape to ' + full);
            esc.__mountEscape = full;
            throw esc;
          }
          return this._walkHops(relNext, noFollowFinal, hops + 1);
        }
        var next = target.charAt(0) === '/'
          ? target + (rest ? '/' + rest : '')
          : (dirPath === '/' ? '' : dirPath) + '/' + target + (rest ? '/' + rest : '');
        return this._walkHops(next, noFollowFinal, hops + 1);
      }
      inoId = childId;
    }
    var ino = this._inodes.read(inoId);
    return ino ? { inoId: inoId, ino: ino } : null;
  };

  // Allocate or grow a data extent for an inode.
  BlockFS.prototype._growExtent = function (ino, neededSize) {
    if (!ino.extentOffset) {
      // First allocation
      var allocSize = Math.max(neededSize, 256);
      var ext = this._alloc.malloc(allocSize);
      if (!ext) return this._setErr('ENOSPC');
      ino.extentOffset = ext;
      ino.extentCapacity = allocSize;
      return ext;
    }
    if (neededSize <= ino.extentCapacity) return ino.extentOffset;
    // Grow: double below 256 MiB, then linear +256 MiB to avoid
    // massive reallocs that would blow past the 4 GiB pool ceiling.
    var newCap;
    if (ino.extentCapacity >= 256 * 1024 * 1024) {
      newCap = Math.max(ino.extentCapacity + 256 * 1024 * 1024, neededSize);
    } else {
      newCap = Math.max(ino.extentCapacity * 2, neededSize);
    }
    var newExt = this._alloc.realloc(ino.extentOffset, newCap);
    if (!newExt) return this._setErr('ENOSPC');
    ino.extentOffset = newExt;
    ino.extentCapacity = newCap;
    return newExt;
  };

  // Shrink extent if significantly larger than needed.
  BlockFS.prototype._shrinkExtent = function (ino) {
    if (!ino.extentOffset) return;
    // Only shrink if less than 25% utilized and at least 1KB
    if (ino.dataSize < ino.extentCapacity / 4 &&
        ino.extentCapacity > 1024) {
      var newCap = Math.max(ino.dataSize, 256);
      var newExt = this._alloc.realloc(ino.extentOffset, newCap);
      if (newExt) {
        ino.extentOffset = newExt;
        ino.extentCapacity = newCap;
      }
      // If realloc fails, keep old extent — it's fine
    }
  };

  BlockFS.prototype._resolvePath = function (path) {
    if (path.length > 0 && path[0] !== '/') {
      path = this._cwd + (this._cwd.endsWith('/') ? '' : '/') + path;
    }
    var parts = path.split('/');
    var resolved = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') continue;
      if (parts[i] === '..') { resolved.pop(); continue; }
      resolved.push(parts[i]);
    }
    return '/' + resolved.join('/');
  };

  // ---- FD table ----
  BlockFS.prototype._allocFd = function (entry) {
    for (var i = 3; i < this._fdTable.length; i++) {
      if (this._fdTable[i] === null) {
        this._fdTable[i] = entry; return i;
      }
    }
    this._fdTable.push(entry);
    return this._fdTable.length - 1;
  };

  // ---- Dir handle table ----
  BlockFS.prototype._allocDirHandle = function (entry) {
    for (var i = 0; i < this._dirTable.length; i++) {
      if (this._dirTable[i] === null) {
        this._dirTable[i] = entry; return i;
      }
    }
    this._dirTable.push(entry);
    return this._dirTable.length - 1;
  };

  // ---- Public API ----

  BlockFS.prototype.open = function (path, flags, mode) {
    var create = !!(flags & 0x40);
    var trunc = !!(flags & 0x200);
    var append = !!(flags & 0x400);
    var excl = !!(flags & 0x80);

    var resolved = this._resolvePath(path);
    var w = this._walkPath(resolved);

    // Read-only volume (todos/0040): any write-intent open is EROFS. AFTER
    // the walk: a path that resolves out of this volume via a symlink
    // (/usr/local -> /var/local) must escape to the owning volume, not fail
    // here. (RO volumes carry no /dev, so there is no device-write
    // exception to make.)
    if (this._readonly && ((flags & 3) !== 0 || create || trunc || append))
      return this._setErr('EROFS');

    if (w) {
      // Exists
      if ((w.ino.mode & S_IFMT) === S_IFDIR) return this._setErr('EISDIR');
      if (excl && create) return this._setErr('EEXIST');
      // A socket node (todos/0008 rendezvous) is not open()able — POSIX ENXIO.
      if ((w.ino.mode & S_IFMT) === S_IFSOCK) return this._setErr('ENXIO');
      if ((w.ino.mode & S_IFMT) === S_IFCHR) {
        // Character device: no data extent, O_TRUNC is a no-op. I/O is
        // dispatched by device number, not by reading/writing the (absent)
        // extent. Keep inoId so fstat() returns the S_IFCHR inode + rdev.
        this._inoRef(w.inoId);
        return this._allocFd({
          type: 'dev', dev: w.ino.rdev || 0,
          inoId: w.inoId, position: 0, path: resolved
        });
      }
      if (trunc) {
        if (w.ino.extentOffset) {
          this._alloc.free(w.ino.extentOffset);
        }
        w.ino.extentOffset = 0;
        w.ino.extentCapacity = 0;
        w.ino.dataSize = 0;
        w.ino.mtime = this._now();
        this._inodes.write(w.inoId, w.ino);
      }
    } else {
      // Doesn't exist
      if (!create) return this._setErr('ENOENT');

      // Verify parent is a directory
      var parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
      var pw = this._walkPath(parentPath);
      if (!pw) return this._setErr('ENOENT');
      if ((pw.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');

      var fileName = resolved.substring(resolved.lastIndexOf('/') + 1);
      // Honor the caller's create mode — seeded /bin binaries want their
      // 0755 to survive into ls -l. The single-user system has a fixed 022
      // umask, applied here (there is no per-process umask in the fs), so
      // fopen's 0666 lands as the traditional 0644. A falsy mode means
      // "default": the fs RPC turns an absent mode into 0.
      var createMode = mode ? (S_IFREG | (mode & ~0o022 & 0o7777)) : DEFAULT_FILE_MODE;
      var inoId = this._allocInode(createMode);
      if (inoId === null) return -1; // errno already set

      // Write inode
      var newIno = this._inodes.read(inoId);

      // Add entry to parent directory
      if (!pw.ino.extentOffset) {
        var pe = this._growExtent(pw.ino, 256);
        if (pe === null) { this._freeInode(inoId); return -1; }
      }
      var entSize = DIR_ENT_HEADER + encodeStr(fileName).length;
      if (pw.ino.dataSize + entSize > pw.ino.extentCapacity) {
        if (this._growExtent(pw.ino, pw.ino.dataSize + entSize) === null) {
          this._freeInode(inoId); return -1;
        }
      }
      dirInsert(this._s, pw.ino.extentOffset, pw.ino.dataSize, inoId, fileName);
      pw.ino.dataSize += entSize;
      pw.ino.mtime = this._now();
      pw.ino.nlink++;
      this._inodes.write(pw.inoId, pw.ino);

      newIno.nlink = 1;
      this._inodes.write(inoId, newIno);
      w = { inoId: inoId, ino: newIno };
    }

    var position = append ? w.ino.dataSize : 0;
    this._inoRef(w.inoId);
    var fd = this._allocFd({
      inoId: w.inoId, position: position, append: append, path: resolved
    });
    return fd;
  };

  BlockFS.prototype.close = function (fd) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    // Closing a never-redirected stdin/stdout/stderr is a no-op that keeps the
    // slot for the console path (the prior behavior). A real (file/dev/pipe)
    // entry on any fd, including a redirected 0/1/2, is closed normally.
    if (fd < 3 && entry.console === true) return 0;
    this._releaseEntry(entry);
    this._fdTable[fd] = null;
    return 0;
  };

  BlockFS.prototype.read = function (fd, buf, count) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];

    if (entry.type === 'pipe') {
      if (entry.pipeId !== undefined && this._pipeBroker) {
        // Owner-brokered: may BLOCK (the broker parks this worker on Atomics.wait
        // until a writer in another instance delivers). 0-length = EOF.
        var got = this._pipeBroker.pipeRead(entry.pipeId, count);
        for (var pk = 0; pk < got.length; pk++) buf[pk] = got[pk];
        return got.length;
      }
      // Same-instance (non-brokered): reader and writer live in THIS one
      // synchronous, JSPI-free context, so blocking for a live writer (the
      // CD5 fail-loud treatment above) could never let that writer run — a
      // structural deadlock. 0-on-empty is the ONLY correct behavior here;
      // this is a deliberate exemption from CD5, not a spurious EOF.
      var pipe = entry.pipe;
      if (pipe.buffer.length === 0) return 0;
      return pipe.buffer.read(buf, count);
    }
    if (entry.type === 'dev') return this._readDev(entry, buf, count);
    if (entry.console === true) {
      // stdin — drain any pre-buffered bytes first (Node CLI setStdin path),
      // then block on the live-stdin sab ring if one is wired (interactive
      // page), else return 0 (EOF) as before.
      if (this._stdinBuffer.length > 0) {
        return this._stdinBuffer.read(buf, count);
      }
      if (this._stdinSab) return this._readStdinSab(buf, count);
      return 0;
    }
    if (entry.inoId === undefined) return this._setErr('EBADF');

    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');
    if (!ino.extentOffset || entry.position >= ino.dataSize) return 0;

    var available = ino.dataSize - entry.position;
    var n = Math.min(count, available);
    if (n <= 0) return 0;

    var data = this._s.getBytes(ino.extentOffset + entry.position, n);
    for (var j = 0; j < n; j++) buf[j] = data[j];
    entry.position += n;

    // relatime: bump atime only when it predates the last data/metadata change
    // (and only if a whole second has actually elapsed, to avoid same-second
    // write thrash on the single OPFS handle). Mirrors Linux's default mount.
    // Suppressed on a read-only mount (this._readonly) so the migration source is
    // never written — it stays the byte-for-byte rollback.
    if (!this._readonly && (ino.atime <= ino.mtime || ino.atime <= ino.ctime)) {
      var t = this._now();
      if (t > ino.atime) {
        ino.atime = t;
        this._inodes.write(entry.inoId, ino);
      }
    }
    return n;
  };

  BlockFS.prototype.write = function (fd, buf, count) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd]) {
      // Default stdout/stderr with no real entry → swallow (handled externally).
      if (fd === 1 || fd === 2) return count;
      return this._setErr('EBADF');
    }
    var entry = this._fdTable[fd];

    // Default (non-redirected) stdout/stderr go to the console (handled
    // externally). A dup2'd pipe/file/dev entry on fd 1/2 falls through so the
    // redirection actually takes effect.
    if ((fd === 1 || fd === 2) && entry.console === true) {
      return count;
    }

    if (entry.type === 'pipe') {
      if (entry.pipeId !== undefined && this._pipeBroker) {
        var w = this._pipeBroker.pipeWrite(entry.pipeId, buf.subarray(0, count));
        if (w < 0) return this._setErr('EPIPE');
        return w;
      }
      if (entry.pipe.closed.read) return this._setErr('EPIPE');
      entry.pipe.buffer.push(buf.subarray(0, count)); // ByteQueue copies
      return count;
    }
    if (entry.type === 'dev') return this._writeDev(entry, buf, count);
    if (entry.inoId === undefined) return this._setErr('EBADF');
    // Belt-and-braces: open() can't hand out a writable fd on a readonly
    // volume, but write() doesn't check the open mode, so guard here too.
    if (this._readonly) return this._setErr('EROFS');

    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');

    var writePos = entry.append ? ino.dataSize : entry.position;
    var newEnd = writePos + count;

    if (newEnd > ino.extentCapacity) {
      if (this._growExtent(ino, newEnd) === null) return this._setErr('ENOSPC');
      // _growExtent updated ino in-place — use the modified object directly.
      // No re-read from table: the table still has the old extent values;
      // we persist the update below via _inodes.write().
    }

    // POSIX hole semantics: a write past EOF must make the gap between the
    // old dataSize and the write position read back as zeros. Extents are
    // recycled by the allocator, so without this the hole exposes whatever a
    // deleted file left there (data disclosure). Same mechanism as
    // ftruncate()'s zero-fill-on-extend.
    if (writePos > ino.dataSize) {
      this._s.setBytes(ino.extentOffset + ino.dataSize,
        new Uint8Array(writePos - ino.dataSize));
    }

    this._s.setBytes(ino.extentOffset + writePos, buf.subarray(0, count));

    if (newEnd > ino.dataSize) ino.dataSize = newEnd;
    var wnow = this._now();
    ino.mtime = wnow;
    ino.ctime = wnow; // a write changes the inode (size/mtime) → ctime too
    this._inodes.write(entry.inoId, ino);

    entry.position = newEnd;
    return count;
  };

  BlockFS.prototype.lseek = function (fd, offset, whence) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    if (entry.position === null) return this._setErr('ESPIPE');
    if (entry.inoId === undefined) return this._setErr('EBADF');

    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');

    var newPos;
    switch (whence) {
      case 0: newPos = offset; break;
      case 1: newPos = entry.position + offset; break;
      case 2: newPos = ino.dataSize + offset; break;
      default: return this._setErr('EINVAL');
    }
    if (newPos < 0) return this._setErr('EINVAL');
    entry.position = newPos;
    return newPos;
  };

  BlockFS.prototype.mkdir = function (path, mode) {
    var resolved = this._resolvePath(path);
    if (this._walkPath(resolved)) return this._setErr('EEXIST');

    var parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    var dirName = resolved.substring(resolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');
    if ((pw.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');

    var inoId = this._allocInode(DEFAULT_DIR_MODE);
    if (inoId === null) return -1;

    // Allocate initial directory extent
    var dirExt = this._alloc.malloc(256);
    if (!dirExt) { this._freeInode(inoId); return this._setErr('ENOSPC'); }

    var ino = this._inodes.read(inoId);
    ino.extentOffset = dirExt;
    ino.extentCapacity = 256;
    ino.dataSize = 0;
    ino.nlink = 1;
    this._inodes.write(inoId, ino);

    // Add entry to parent
    var entSize = DIR_ENT_HEADER + encodeStr(dirName).length;
    if (!pw.ino.extentOffset ||
        pw.ino.dataSize + entSize > pw.ino.extentCapacity) {
      if (this._growExtent(pw.ino,
          (pw.ino.dataSize || 0) + Math.max(entSize, 256)) === null) {
        this._freeInode(inoId); return this._setErr('ENOSPC');
      }
    }
    dirInsert(this._s, pw.ino.extentOffset,
      pw.ino.dataSize || 0, inoId, dirName);
    pw.ino.dataSize = (pw.ino.dataSize || 0) + entSize;
    pw.ino.mtime = this._now();
    pw.ino.nlink++;
    this._inodes.write(pw.inoId, pw.ino);

    return 0;
  };

  // mknod(path, mode, dev) — create a node. Used for /dev character devices:
  // like the open()-create path but with no data extent; the device number
  // lives in the inode's rdev field. v4 only (v3 inodes have no rdev field).
  BlockFS.prototype.mknod = function (path, mode, dev) {
    var resolved = this._resolvePath(path);
    if (this._walkPath(resolved)) return this._setErr('EEXIST');
    var parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');
    if ((pw.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');

    var name = resolved.substring(resolved.lastIndexOf('/') + 1);
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');
    var inoId = this._allocInode(mode);
    if (inoId === null) return -1;
    var ino = this._inodes.read(inoId);
    ino.nlink = 1;
    ino.rdev = dev >>> 0;
    this._inodes.write(inoId, ino);

    // Insert the dirent in the parent (grow its extent as needed).
    var entSize = DIR_ENT_HEADER + encodeStr(name).length;
    if (!pw.ino.extentOffset ||
        pw.ino.dataSize + entSize > pw.ino.extentCapacity) {
      if (this._growExtent(pw.ino,
          (pw.ino.dataSize || 0) + Math.max(entSize, 256)) === null) {
        this._freeInode(inoId); return this._setErr('ENOSPC');
      }
    }
    dirInsert(this._s, pw.ino.extentOffset, pw.ino.dataSize || 0, inoId, name);
    pw.ino.dataSize = (pw.ino.dataSize || 0) + entSize;
    pw.ino.mtime = this._now();
    pw.ino.nlink++;
    this._inodes.write(pw.inoId, pw.ino);
    return 0;
  };

  // Character-device reads, keyed by device number (set up by mknod / open).
  BlockFS.prototype._readDev = function (entry, buf, count) {
    switch (entry.dev) {
      case DEV_NULL: return 0;                 // always at EOF
      case DEV_ZERO:
      case DEV_FULL:                           // reads as zeros; only writes differ
        for (var i = 0; i < count; i++) buf[i] = 0;
        return count;
      case DEV_RANDOM:
      case DEV_URANDOM: {
        // crypto.getRandomValues fills at most 65536 bytes per call.
        var off = 0;
        while (off < count) {
          var n = Math.min(65536, count - off);
          globalThis.crypto.getRandomValues(buf.subarray(off, off + n));
          off += n;
        }
        return count;
      }
      default: return 0;
    }
  };

  // Character-device writes: /dev/full fails with ENOSPC; the rest discard.
  BlockFS.prototype._writeDev = function (entry, buf, count) {
    if (entry.dev === DEV_FULL) return this._setErr('ENOSPC');
    return count;
  };

  // Idempotently create /dev and its character-device nodes — self-healing,
  // like the app's /root and /tmp. Called on every v4 mount; a no-op once they
  // exist, and skipped on a read-only mount.
  BlockFS.prototype.ensureDevNodes = function () {
    if (this._readonly) return;
    if (!this.stat('/dev')) this.mkdir('/dev', 0o755);
    var nodes = [
      ['/dev/null', DEV_NULL], ['/dev/zero', DEV_ZERO], ['/dev/full', DEV_FULL],
      ['/dev/random', DEV_RANDOM], ['/dev/urandom', DEV_URANDOM]
    ];
    for (var i = 0; i < nodes.length; i++) {
      if (!this.stat(nodes[i][0])) this.mknod(nodes[i][0], S_IFCHR | 0o666, nodes[i][1]);
    }
  };

  BlockFS.prototype.rmdir = function (path) {
    var resolved = this._resolvePath(path);
    var w = this._walkPath(resolved);
    if (!w) return this._setErr('ENOENT');
    if ((w.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');

    // Check if directory is empty
    if (w.ino.extentOffset && w.ino.dataSize > 0) {
      var entries = dirList(this._s, w.ino.extentOffset, w.ino.dataSize);
      if (entries.length > 0) return this._setErr('ENOTEMPTY');
    }

    var parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    var dirName = resolved.substring(resolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');

    dirRemove(this._s, pw.ino.extentOffset, pw.ino.dataSize, dirName);
    // Note: we don't shrink the parent directory extent — dirRemove shifts
    // data to fill the gap, but dataSize still needs adjustment.
    pw.ino.dataSize -= DIR_ENT_HEADER + encodeStr(dirName).length;
    pw.ino.mtime = this._now();
    pw.ino.nlink--;
    this._inodes.write(pw.inoId, pw.ino);

    this._freeInode(w.inoId);
    return 0;
  };

  BlockFS.prototype.unlink = function (path) {
    var resolved = this._resolvePath(path);
    var w = this._walkPath(resolved, true);   // remove the link itself, not its target
    if (!w) return this._setErr('ENOENT');
    if ((w.ino.mode & S_IFMT) === S_IFDIR) return this._setErr('EPERM');

    var parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    var fileName = resolved.substring(resolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');

    dirRemove(this._s, pw.ino.extentOffset, pw.ino.dataSize, fileName);
    pw.ino.dataSize -= DIR_ENT_HEADER + encodeStr(fileName).length;
    pw.ino.mtime = this._now();
    pw.ino.nlink--;
    this._inodes.write(pw.inoId, pw.ino);

    // Drop one reference to the file; only reclaim the inode (and its data
    // extent) when the last hard link is gone AND no fd still has it open
    // (POSIX unlink-while-open — the last close reclaims it).
    this._dropLink(w.inoId, w.ino);
    return 0;
  };

  BlockFS.prototype.remove = BlockFS.prototype.unlink; // alias

  BlockFS.prototype.rename = function (oldPath, newPath) {
    var oldResolved = this._resolvePath(oldPath);
    var newResolved = this._resolvePath(newPath);
    if (oldResolved === newResolved) return 0;

    var oldW = this._walkPath(oldResolved, true);   // rename the link itself, not its target
    if (!oldW) return this._setErr('ENOENT');

    var oldParentPath = oldResolved.substring(0, oldResolved.lastIndexOf('/')) || '/';
    var oldName = oldResolved.substring(oldResolved.lastIndexOf('/') + 1);
    var oldPW = this._walkPath(oldParentPath);
    if (!oldPW) return this._setErr('ENOENT');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');

    var newParentPath = newResolved.substring(0,
      newResolved.lastIndexOf('/')) || '/';
    var newName = newResolved.substring(newResolved.lastIndexOf('/') + 1);

    // Pre-flight every failure we can detect BEFORE touching the source
    // dirent, so those paths need no rollback (a prior version restored the
    // source on some failure paths but forgot on others, orphaning it).
    var newPW = this._walkPath(newParentPath);
    if (!newPW) return this._setErr('ENOENT');
    if ((newPW.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');

    var newW = this._walkPath(newResolved, true);   // the target name itself
    if (newW) {
      // POSIX: if oldpath and newpath are links to the same inode, rename
      // does nothing and succeeds — neither entry is removed.
      if (newW.inoId === oldW.inoId) return 0;
      if ((newW.ino.mode & S_IFMT) === S_IFDIR &&
          newW.ino.extentOffset && newW.ino.dataSize > 0) {
        var ent = dirList(this._s, newW.ino.extentOffset, newW.ino.dataSize);
        if (ent.length > 0) return this._setErr('ENOTEMPTY');
      }
    }

    // Remove old directory entry
    dirRemove(this._s, oldPW.ino.extentOffset, oldPW.ino.dataSize, oldName);
    oldPW.ino.dataSize -= DIR_ENT_HEADER + encodeStr(oldName).length;
    oldPW.ino.mtime = this._now();
    oldPW.ino.nlink--;
    this._inodes.write(oldPW.inoId, oldPW.ino);

    // If the target exists, unlink it: drop one hard link — the inode lives
    // on if it has other links or is still held open (rename-over-open).
    if (newW) {
      var tpw = this._walkPath(newParentPath); // re-walk: dir changed above
      if (tpw) {
        dirRemove(this._s, tpw.ino.extentOffset, tpw.ino.dataSize, newName);
        tpw.ino.dataSize -= DIR_ENT_HEADER + encodeStr(newName).length;
        tpw.ino.mtime = this._now();
        tpw.ino.nlink--;
        this._inodes.write(tpw.inoId, tpw.ino);
      }
      var tIno = this._inodes.read(newW.inoId); // re-read (walk data is stale)
      if (tIno) this._dropLink(newW.inoId, tIno);
    }

    // Add new entry pointing to the old inode. Re-walk the new parent — the
    // removals above may have rewritten it (same-directory rename).
    newPW = this._walkPath(newParentPath);
    var entSize = DIR_ENT_HEADER + encodeStr(newName).length;
    if (!newPW ||
        ((!newPW.ino.extentOffset ||
          newPW.ino.dataSize + entSize > newPW.ino.extentCapacity) &&
         this._growExtent(newPW.ino,
           (newPW.ino.dataSize || 0) + Math.max(entSize, 256)) === null)) {
      // Restore the source dirent (re-walk: its parent may have changed too)
      var rpw = this._walkPath(oldParentPath);
      if (rpw) {
        var oldEntSize = DIR_ENT_HEADER + encodeStr(oldName).length;
        if ((rpw.ino.extentOffset &&
             rpw.ino.dataSize + oldEntSize <= rpw.ino.extentCapacity) ||
            this._growExtent(rpw.ino,
              (rpw.ino.dataSize || 0) + Math.max(oldEntSize, 256)) !== null) {
          dirInsert(this._s, rpw.ino.extentOffset,
            rpw.ino.dataSize || 0, oldW.inoId, oldName);
          rpw.ino.dataSize = (rpw.ino.dataSize || 0) + oldEntSize;
          rpw.ino.nlink++;
          this._inodes.write(rpw.inoId, rpw.ino);
        }
      }
      return this._setErr(newPW ? 'ENOSPC' : 'ENOENT');
    }
    dirInsert(this._s, newPW.ino.extentOffset,
      newPW.ino.dataSize || 0, oldW.inoId, newName);
    newPW.ino.dataSize = (newPW.ino.dataSize || 0) + entSize;
    newPW.ino.mtime = this._now();
    newPW.ino.nlink++;
    this._inodes.write(newPW.inoId, newPW.ino);
    return 0;
  };

  // Build the stat struct from a walk result. Native unit -> whole seconds +
  // sub-second nanoseconds. v3 stores seconds (nsec always 0); v4 stores ms
  // (nsec = ms-remainder * 1e6), which lets build tools distinguish writes
  // within the same second.
  BlockFS.prototype._statOf = function (w) {
    var sc = this._fmt.timeScale, ns = 1e9 / sc;
    var i = w.ino;
    return {
      ino: w.inoId, mode: i.mode, size: i.dataSize,
      mtime: Math.floor(i.mtime / sc), ctime: Math.floor(i.ctime / sc),
      atime: Math.floor(i.atime / sc), btime: Math.floor(i.btime / sc),
      mtimeNsec: (i.mtime % sc) * ns, ctimeNsec: (i.ctime % sc) * ns,
      atimeNsec: (i.atime % sc) * ns, btimeNsec: (i.btime % sc) * ns,
      nlink: i.nlink, rdev: i.rdev || 0, uid: 0, gid: 0
    };
  };
  BlockFS.prototype.stat = function (path) {
    var w = this._walkPath(this._resolvePath(path));        // follows symlinks
    if (!w) return this._lastError === 'ELOOP' ? null : this._setErr('ENOENT');
    return this._statOf(w);
  };

  // immutableKey (todos/0037) — a stable content-identity token for `path`,
  // or null. Non-null ONLY for a regular file on a READ-ONLY volume: its
  // contents cannot change for this mount's lifetime, so the token needs no
  // generation counter. The kernel keys its compiled-wasm-Module cache on
  // this (mutable binaries — e.g. a fresh `cc -o a.out` — return null and
  // keep the compile-per-spawn path, so the cache can never serve stale
  // code). The inode id dedupes path aliases: /bin/ls and /usr/bin/ls (and
  // every coreutils applet symlink) share one key.
  BlockFS.prototype.immutableKey = function (path) {
    if (!this._readonly) return null;
    var st = this.stat(path);
    if (!st || (st.mode & S_IFMT) !== S_IFREG) return null;
    return this._mountPrefix + ':' + st.ino;
  };

  BlockFS.prototype.lstat = function (path) {
    var w = this._walkPath(this._resolvePath(path), true);  // the link itself
    if (!w) return this._lastError === 'ELOOP' ? null : this._setErr('ENOENT');
    return this._statOf(w);
  };

  BlockFS.prototype.fstat = function (fd) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    if (entry.inoId === undefined) {
      // stdin/stdout/stderr — return S_IFCHR
      return { ino: 0, mode: 0o020600, size: 0, mtime: 0, ctime: 0,
               atime: 0, btime: 0, nlink: 1, uid: 0, gid: 0 };
    }
    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');
    var sc = this._fmt.timeScale, ns = 1e9 / sc;
    return {
      ino: entry.inoId, mode: ino.mode, size: ino.dataSize,
      mtime: Math.floor(ino.mtime / sc), ctime: Math.floor(ino.ctime / sc),
      atime: Math.floor(ino.atime / sc), btime: Math.floor(ino.btime / sc),
      mtimeNsec: (ino.mtime % sc) * ns, ctimeNsec: (ino.ctime % sc) * ns,
      atimeNsec: (ino.atime % sc) * ns, btimeNsec: (ino.btime % sc) * ns,
      nlink: ino.nlink, rdev: ino.rdev || 0, uid: 0, gid: 0
    };
  };

  // statfs() — filesystem-level capacity, the basis for `df`.
  //
  // Bytes are authoritative: `totalBytes` is the usable data region (the TLSF
  // pool), `freeBytes` the allocator's own free total. Single-user, no quotas,
  // so "free" and "available" are the same number. `blockSize` (4 KiB) plus the
  // *Blocks fields are a conventional df-style presentation derived from the
  // byte figures — BlockFS is a byte allocator, not block-structured, so the
  // bytes are the truth and the blocks are rounded-down views of them.
  // `storeSize` is the whole image (pool + superblock + TLSF meta + inode
  // table); it's >= totalBytes because not all of the image is file-data space.
  BlockFS.prototype.statfs = function () {
    var BSIZE = 4096;
    var alloc = this._alloc;
    var poolStart, poolEnd;
    try { poolStart = alloc._readMeta32(META_POOL_START); } catch (e) { poolStart = TLSF_POOL_OFFSET; }
    try { poolEnd = alloc._readMeta32(META_POOL_END); } catch (e) { poolEnd = poolStart; }
    var totalBytes = poolEnd - poolStart;
    var freeBytes = alloc.totalFreeBytes();
    if (freeBytes > totalBytes) freeBytes = totalBytes;
    var usedBytes = totalBytes - freeBytes;

    // Inodes: capacity is the table size; count the live (mode != 0) entries.
    var totalInodes = this._inodes.capacity();
    var usedInodes = 0;
    var nextInodeId = this._s.getUint32(SB_NEXT_INODE_ID);
    for (var i = 1; i < nextInodeId; i++) {
      var ino = this._inodes.read(i);
      if (ino && ino.mode !== 0) usedInodes++;
    }

    return {
      blockSize: BSIZE,
      totalBytes: totalBytes,
      freeBytes: freeBytes,
      usedBytes: usedBytes,
      totalBlocks: Math.floor(totalBytes / BSIZE),
      freeBlocks: Math.floor(freeBytes / BSIZE),
      usedBlocks: Math.floor(usedBytes / BSIZE),
      totalInodes: totalInodes,
      usedInodes: usedInodes,
      freeInodes: totalInodes - usedInodes,
      storeSize: this._s.size(),
      nameMax: 255
    };
  };

  BlockFS.prototype.opendir = function (path) {
    var w = this._walkPath(this._resolvePath(path));
    if (!w) return this._setErr('ENOENT');
    if ((w.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');
    return this._allocDirHandle({
      inoId: w.inoId, pos: 0, dotState: 0
    });
  };

  BlockFS.prototype.readdir = function (handle) {
    if (handle < 0 || handle >= this._dirTable.length ||
        !this._dirTable[handle]) return this._setErr('EBADF');
    var dirEntry = this._dirTable[handle];

    // Synthesize "." and ".."
    if (dirEntry.dotState < 2) {
      var dotName = dirEntry.dotState === 0 ? '.' : '..';
      dirEntry.dotState++;
      return {
        ino: 0, type: 4, name: dotName // DT_DIR
      };
    }

    // Snapshot the directory listing once (cached on the handle), not on every
    // readdir call: dirList scans the whole extent, so recomputing it per entry
    // makes a full enumeration O(N^2) — pathological over a SyncAccessHandle
    // where each field read is an OPFS syscall. POSIX already leaves concurrent
    // add/remove during iteration unspecified, so a per-open snapshot is fine.
    var entries = dirEntry.entries;
    if (!entries) {
      var ino = this._inodes.read(dirEntry.inoId);
      if (!ino || !ino.extentOffset) return null;
      entries = dirEntry.entries = dirList(this._s, ino.extentOffset, ino.dataSize);
    }
    if (dirEntry.pos >= entries.length) return null; // end of directory

    var ent = entries[dirEntry.pos];
    dirEntry.pos++;
    var entIno = this._inodes.read(ent.inodeId);
    var dtype = entIno && (entIno.mode & S_IFMT) === S_IFDIR ? 4 : 8;
    return { ino: ent.inodeId, type: dtype, name: ent.name };
  };

  BlockFS.prototype.closedir = function (handle) {
    if (handle < 0 || handle >= this._dirTable.length ||
        !this._dirTable[handle]) return this._setErr('EBADF');
    this._dirTable[handle] = null;
    return 0;
  };

  BlockFS.prototype.getcwd = function () {
    return this._cwd;
  };

  BlockFS.prototype.chdir = function (path) {
    var resolved = this._resolvePath(path);
    var w = this._walkPath(resolved);
    if (!w) return this._setErr('ENOENT');
    if ((w.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');
    this._cwd = resolved;
    return 0;
  };

  BlockFS.prototype.access = function (path, mode) {
    var w = this._walkPath(this._resolvePath(path));
    if (!w) return this._setErr('ENOENT');
    return 0;
  };

  BlockFS.prototype.pipe = function () {
    if (this._pipeBroker) {
      // Owner-brokered: the pipe object lives in the owner; both ends start in
      // THIS instance (ref-counted there) and may be dup2'd / inherited.
      var id = this._pipeBroker.pipeCreate();
      var rFd = this._allocFd({ type: 'pipe', pipeId: id, pipeEnd: 'read', position: null });
      var wFd = this._allocFd({ type: 'pipe', pipeId: id, pipeEnd: 'write', position: null });
      return [rFd, wFd];
    }
    // Per-end reference counts so dup'd ends close only when the LAST
    // duplicate goes (see _dupEntry/_releaseEntry). In-memory only.
    var pipe = { buffer: new ByteQueue(), closed: { read: false, write: false },
                 refs: { read: 1, write: 1 } };
    var readFd = this._allocFd({
      type: 'pipe', pipe: pipe, pipeEnd: 'read', position: null
    });
    var writeFd = this._allocFd({
      type: 'pipe', pipe: pipe, pipeEnd: 'write', position: null
    });
    return [readFd, writeFd];
  };

  // AF_UNIX sockets (todos/0008) exist only under the brokered kernel —
  // the in-process fs has no second process to talk to, so the whole
  // family is ENOSYS here. RemoteFS overrides these with kernel RPCs;
  // toWasmEnv dispatches via `this.`, so both transports share the env.
  BlockFS.prototype.sockSocket = function () { return this._setErr('ENOSYS'); };
  BlockFS.prototype.sockBind = function () { return this._setErr('ENOSYS'); };
  BlockFS.prototype.sockListen = function () { return this._setErr('ENOSYS'); };
  BlockFS.prototype.sockAccept = function () { return this._setErr('ENOSYS'); };
  BlockFS.prototype.sockConnect = function () { return this._setErr('ENOSYS'); };
  BlockFS.prototype.sockPair = function () { return this._setErr('ENOSYS'); };
  BlockFS.prototype.sockShutdown = function () { return this._setErr('ENOSYS'); };
  // FS_WATCH (ticket #75) exists only under the brokered kernel — the
  // in-process fs has no second process whose mutations could be watched.
  // RemoteFS overrides this with the FS_WATCH_OPEN RPC (the sock pattern).
  BlockFS.prototype.fsWatch = function () { return this._setErr('ENOSYS'); };

  BlockFS.prototype.dup = function (oldfd) {
    if (oldfd < 0 || oldfd >= this._fdTable.length || !this._fdTable[oldfd])
      return this._setErr('EBADF');
    return this._allocFd(this._dupEntry(this._fdTable[oldfd]));
  };

  BlockFS.prototype.dup2 = function (oldfd, newfd) {
    if (oldfd < 0 || oldfd >= this._fdTable.length || !this._fdTable[oldfd])
      return this._setErr('EBADF');
    if (newfd < 0) return this._setErr('EBADF');
    if (oldfd === newfd) return newfd;
    if (newfd < this._fdTable.length && this._fdTable[newfd] !== null) {
      // Implicit close of newfd — releases a pipe-end/inode ref it held.
      this._releaseEntry(this._fdTable[newfd]);
      this._fdTable[newfd] = null;
    }
    while (this._fdTable.length <= newfd) this._fdTable.push(null);
    this._fdTable[newfd] = this._dupEntry(this._fdTable[oldfd]);
    return newfd;
  };

  BlockFS.prototype.isatty = function (fd) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd]) return 0;
    if (fd <= 2) return 1;
    return 0;
  };

  // fsync(fd)/fdatasync(fd) — durability. The store is one handle, so
  // flush() is whole-image (allowed: fsync may flush more than requested).
  // No fd validation, matching the historical env behavior: stdio and
  // freshly-dup'd fds all land here and must not fail.
  BlockFS.prototype.fsync = function (fd) {
    this._s.flush();
    return 0;
  };

  // ftruncate(fd, size) — truncate or extend an open file.
  BlockFS.prototype.ftruncate = function (fd, size) {
    if (this._readonly) return this._setErr('EROFS');
    if (size < 0) return this._setErr('EINVAL');
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    if (entry.inoId === undefined) return this._setErr('EBADF');

    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');

    if (size > ino.extentCapacity) {
      if (this._growExtent(ino, size) === null) return this._setErr('ENOSPC');
    } else if (size < ino.dataSize && size > 0 &&
               size < ino.extentCapacity / 4) {
      // Shrink extent if significantly smaller than capacity
      var newExt = this._alloc.realloc(ino.extentOffset, Math.max(size, 256));
      if (newExt) { ino.extentOffset = newExt; ino.extentCapacity = Math.max(size, 256); }
    }

    // Zero-fill if extending
    if (size > ino.dataSize && ino.extentOffset) {
      var zeroLen = size - ino.dataSize;
      var zeroes = new Uint8Array(zeroLen);
      this._s.setBytes(ino.extentOffset + ino.dataSize, zeroes);
    }

    ino.dataSize = size;
    ino.mtime = this._now();
    this._inodes.write(entry.inoId, ino);

    // Clamp fd position if past new EOF
    if (entry.position > size) entry.position = size;

    return 0;
  };

  // chmod(path, mode) — change file mode bits.
  BlockFS.prototype.chmod = function (path, mode) {
    var w = this._walkPath(this._resolvePath(path));
    if (!w) return this._setErr('ENOENT');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');
    w.ino.mode = (w.ino.mode & S_IFMT) | (mode & 0o7777);
    w.ino.ctime = this._now();
    this._inodes.write(w.inoId, w.ino);
    return 0;
  };

  // fchmod(fd, mode) — change mode on an open file.
  BlockFS.prototype.fchmod = function (fd, mode) {
    if (this._readonly) return this._setErr('EROFS');
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    if (entry.inoId === undefined) return this._setErr('EBADF');
    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');
    ino.mode = (ino.mode & S_IFMT) | (mode & 0o7777);
    ino.ctime = this._now();
    this._inodes.write(entry.inoId, ino);
    return 0;
  };

  // utime(path, atime, mtime) — set access/modification times (seconds).
  // Setting times is a metadata change, so ctime is bumped to now.
  BlockFS.prototype.utime = function (path, atime, mtime) {
    var w = this._walkPath(this._resolvePath(path));
    if (!w) return this._setErr('ENOENT');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');
    var sc = this._fmt.timeScale; // seconds (ABI) -> native unit
    w.ino.atime = atime !== undefined ? atime * sc : this._now();
    w.ino.mtime = mtime !== undefined ? mtime * sc : this._now();
    w.ino.ctime = this._now();
    this._inodes.write(w.inoId, w.ino);
    return 0;
  };

  // futime(fd, atime, mtime) — like utime() but on an open fd.
  BlockFS.prototype.futime = function (fd, atime, mtime) {
    if (this._readonly) return this._setErr('EROFS');
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    if (entry.inoId === undefined) return this._setErr('EINVAL'); /* std stream */
    var ino = this._inodes.read(entry.inoId);
    if (!ino) return this._setErr('EBADF');
    var sc = this._fmt.timeScale; // seconds (ABI) -> native unit
    ino.atime = atime !== undefined ? atime * sc : this._now();
    ino.mtime = mtime !== undefined ? mtime * sc : this._now();
    ino.ctime = this._now();
    this._inodes.write(entry.inoId, ino);
    return 0;
  };

  // link(oldPath, newPath) — create a hard link.
  BlockFS.prototype.link = function (oldPath, newPath) {
    var oldW = this._walkPath(this._resolvePath(oldPath));
    if (!oldW) return this._setErr('ENOENT');
    if ((oldW.ino.mode & S_IFMT) === S_IFDIR) return this._setErr('EPERM');

    var newResolved = this._resolvePath(newPath);
    if (this._walkPath(newResolved)) return this._setErr('EEXIST');

    var parentPath = newResolved.substring(0, newResolved.lastIndexOf('/')) || '/';
    var fileName = newResolved.substring(newResolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');
    if ((pw.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');

    var entSize = DIR_ENT_HEADER + encodeStr(fileName).length;
    if (!pw.ino.extentOffset ||
        pw.ino.dataSize + entSize > pw.ino.extentCapacity) {
      if (this._growExtent(pw.ino,
          (pw.ino.dataSize || 0) + Math.max(entSize, 256)) === null)
        return this._setErr('ENOSPC');
    }
    dirInsert(this._s, pw.ino.extentOffset,
      pw.ino.dataSize || 0, oldW.inoId, fileName);
    pw.ino.dataSize = (pw.ino.dataSize || 0) + entSize;
    pw.ino.mtime = this._now();
    pw.ino.nlink++; // new dir entry — keep the parent's entry count consistent
                    // with open()/mkdir() (and balanced by unlink()).
    this._inodes.write(pw.inoId, pw.ino);

    oldW.ino.nlink++;
    oldW.ino.ctime = this._now(); // link-count change updates ctime
    this._inodes.write(oldW.inoId, oldW.ino);
    return 0;
  };

  // symlink(target, linkPath) — create a symbolic link.
  // Stores the target path as the symlink inode's data.
  BlockFS.prototype.symlink = function (target, linkPath) {
    var linkResolved = this._resolvePath(linkPath);
    if (this._walkPath(linkResolved, true)) return this._setErr('EEXIST');

    var parentPath = linkResolved.substring(0, linkResolved.lastIndexOf('/')) || '/';
    var linkName = linkResolved.substring(linkResolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');
    if ((pw.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');
    // EROFS only after the walks: an escaping path retries on its owner.
    if (this._readonly) return this._setErr('EROFS');

    var inoId = this._allocInode(S_IFLNK | 0o777);
    if (inoId === null) return -1;

    var targetBytes = encodeStr(target);
    var ino = this._inodes.read(inoId);
    if (this._growExtent(ino, targetBytes.length) === null) {
      this._freeInode(inoId); return this._setErr('ENOSPC');
    }
    this._s.setBytes(ino.extentOffset, targetBytes);
    ino.dataSize = targetBytes.length;
    ino.nlink = 1;
    this._inodes.write(inoId, ino);

    var entSize = DIR_ENT_HEADER + encodeStr(linkName).length;
    if (!pw.ino.extentOffset ||
        pw.ino.dataSize + entSize > pw.ino.extentCapacity) {
      if (this._growExtent(pw.ino,
          (pw.ino.dataSize || 0) + Math.max(entSize, 256)) === null) {
        this._freeInode(inoId); return this._setErr('ENOSPC');
      }
    }
    dirInsert(this._s, pw.ino.extentOffset,
      pw.ino.dataSize || 0, inoId, linkName);
    pw.ino.dataSize = (pw.ino.dataSize || 0) + entSize;
    pw.ino.mtime = this._now();
    pw.ino.nlink++; // new dir entry — same convention as open()/mkdir()/
                    // mknod()/link()/rename(), balanced by unlink()
    this._inodes.write(pw.inoId, pw.ino);
    return 0;
  };

  // readlink(path, buf, bufsize) — read symlink target into buf.
  BlockFS.prototype.readlink = function (path, buf, bufsize) {
    var w = this._walkPath(this._resolvePath(path), true);   // the link itself
    if (!w) return this._setErr('ENOENT');
    if ((w.ino.mode & S_IFMT) !== S_IFLNK) return this._setErr('EINVAL'); // not a symlink
    if (!w.ino.extentOffset || w.ino.dataSize === 0) return 0;
    var n = Math.min(w.ino.dataSize, bufsize);
    var data = this._s.getBytes(w.ino.extentOffset, n);
    for (var i = 0; i < n; i++) buf[i] = data[i];
    return n;
  };

  // realpath(3) — canonical path with EVERY symlink component resolved (POSIX
  // PHYSICAL resolution; the lexical _resolvePath above is only "realpath -s").
  // Walks one component at a time against lstat/readlink: a symlink is expanded
  // in place — an absolute target restarts from root, a relative one splices
  // against the link's already-resolved parent — while '.'/'..' collapse
  // PHYSICALLY (a '..' following a symlink refers to the target's parent, not
  // the link's). Every component INCLUDING the last must exist (glibc realpath /
  // Node fs.realpathSync semantics — the standalone-host oracle at the top of
  // this file); a missing one is ENOENT, a symlink cycle ELOOP. Returns the
  // canonical string, or null with _lastError set. Shared by BlockFS and MountFS
  // (both expose lstat/readlink/getcwd); RemoteFS routes to the kernel's copy of
  // this over ONE FS_REALPATH RPC, so a brokered realpath is never a per-
  // component RPC storm. (todos/0263)
  function physicalRealpath(fs, input) {
    fs._lastError = null;
    if (typeof input !== 'string' || input.length === 0) { fs._lastError = 'ENOENT'; return null; }
    if (input.charAt(0) !== '/') {
      var cwd = fs.getcwd();
      input = (cwd === '/' ? '' : cwd) + '/' + input;
    }
    var resolved = [];            // canonical (symlink-free) path components
    var rest = input.split('/');  // components still to process, front-to-back
    var idx = 0, links = 0;
    while (idx < rest.length) {
      var comp = rest[idx++];
      if (comp === '' || comp === '.') continue;
      if (comp === '..') { resolved.pop(); continue; }
      var candidate = '/' + resolved.concat([comp]).join('/');
      var st = fs.lstat(candidate);
      if (st === null) { if (!fs._lastError) fs._lastError = 'ENOENT'; return null; }
      if ((st.mode & S_IFMT) !== S_IFLNK) { resolved.push(comp); continue; }
      if (++links > SYMLOOP_MAX) { fs._lastError = 'ELOOP'; return null; }
      var lbuf = new Uint8Array(4096);
      var n = fs.readlink(candidate, lbuf, lbuf.length);
      if (n === null || n < 0) { if (!fs._lastError) fs._lastError = 'EIO'; return null; }
      var target = decodeStr(lbuf.subarray(0, n));
      if (target.charAt(0) === '/') resolved = [];   // absolute target: restart at root
      rest = target.split('/').concat(rest.slice(idx));
      idx = 0;
    }
    return '/' + resolved.join('/');
  }
  BlockFS.prototype.realpathPhysical = function (path) { return physicalRealpath(this, path); };

  // fcntl F_DUPFD — duplicate fd, allocating >= minfd.
  BlockFS.prototype.fcntl_dupfd = function (oldfd, minfd) {
    if (oldfd < 0 || oldfd >= this._fdTable.length || !this._fdTable[oldfd])
      return this._setErr('EBADF');
    if (minfd < 0) minfd = 0;
    var entry = this._fdTable[oldfd];

    while (this._fdTable.length <= minfd) this._fdTable.push(null);
    var newfd = -1;
    for (var i = minfd; i < this._fdTable.length; i++) {
      if (this._fdTable[i] === null) { newfd = i; break; }
    }
    if (newfd < 0) {
      this._fdTable.push(null);
      newfd = this._fdTable.length - 1;
    }

    this._fdTable[newfd] = this._dupEntry(entry);
    return newfd;
  };

  // =================================================================
  // WASM import adapter
  // =================================================================

  // Write a stat buffer into WASM memory. Matches the 64-bit struct stat layout
  // (see <sys/stat.h> / writeStatBuf in the Node backend, verified by
  // tests/unit/stdlib/stat_layout): 120 bytes, i64 size/blocks/times.
  function writeStatBuf(memory, bufPtr, st) {
    var view = new DataView(memory.buffer);
    var size = st.size || 0;
    view.setUint32(bufPtr + 0, 0, true);              // st_dev
    view.setUint32(bufPtr + 4, st.ino, true);         // st_ino
    view.setUint32(bufPtr + 8, st.mode, true);        // st_mode
    view.setUint32(bufPtr + 12, st.nlink || 1, true); // st_nlink
    view.setUint32(bufPtr + 16, st.rdev || 0, true);  // st_rdev
    view.setUint32(bufPtr + 20, 0, true);             // st_uid (single-user)
    view.setUint32(bufPtr + 24, 0, true);             // st_gid
    view.setInt32(bufPtr + 28, 4096, true);           // st_blksize
    view.setBigInt64(bufPtr + 32, BigInt(size), true);                  // st_size
    view.setBigInt64(bufPtr + 40, BigInt(Math.ceil(size / 512)), true); // st_blocks (512B)
    view.setBigInt64(bufPtr + 48, BigInt(st.atime), true);   // st_atime
    view.setBigInt64(bufPtr + 56, BigInt(st.mtime), true);   // st_mtime
    view.setBigInt64(bufPtr + 64, BigInt(st.ctime), true);   // st_ctime
    view.setBigInt64(bufPtr + 72, BigInt(st.atime), true); view.setInt32(bufPtr + 80, (st.atimeNsec || 0) | 0, true);   // st_atim
    view.setBigInt64(bufPtr + 88, BigInt(st.mtime), true); view.setInt32(bufPtr + 96, (st.mtimeNsec || 0) | 0, true);   // st_mtim
    view.setBigInt64(bufPtr + 104, BigInt(st.ctime), true); view.setInt32(bufPtr + 112, (st.ctimeNsec || 0) | 0, true); // st_ctim
  }

  // Adapt a BlockFS instance to the WASM `env` import object.
  // matches the interface expected by wasm-ld / compiler.js:
  //   __open_impl, close, read, write, lseek, mkdir, remove, rename,
  //   __opendir, __readdir, __closedir, stat, lstat, fstat,
  //   getcwd, chdir, access, rmdir, unlink, pipe, dup, dup2, isatty,
  //   __tcgetattr, __tcsetattr, usleep, __nanosleep, __select_impl,
  //   __ioctl_tiocgwinsz
  // Return diagnostic snapshot of the filesystem.  For tests / debugging.
  BlockFS.prototype.inspect = function () {
    var sb = this._readSuperblock();
    var alloc = this._alloc;
    var poolStart, poolEnd;
    try { poolEnd = alloc._readMeta32(META_POOL_END); } catch (e) { poolEnd = 0; }
    try { poolStart = alloc._readMeta32(META_POOL_START); } catch (e) { poolStart = TLSF_POOL_OFFSET; }

    // Count inodes
    var inodeCount = 0;
    var nextInodeId = this._s.getUint32(SB_NEXT_INODE_ID);
    for (var i = 1; i < nextInodeId; i++) {
      var ino = this._inodes.read(i);
      if (ino && ino.mode !== 0) inodeCount++;
    }

    // Walk all TLSF blocks and verify consistency
    var block = poolStart;
    var usedBlocks = 0, freeBlocks = 0, totalUsed = 0, totalFree = 0;
    var largestFree = 0;
    var integrityErrors = [];
    while (block < poolEnd) {
      var sz = alloc._blockSize(block);
      if (sz === 0 || block + sz > poolEnd) {
        integrityErrors.push('bad block size ' + sz + ' at offset ' + block);
        break;
      }
      if (alloc._blockIsFree(block)) {
        freeBlocks++;
        totalFree += sz - BLOCK_OVERHEAD;
        if (sz > largestFree) largestFree = sz;
      } else {
        usedBlocks++;
        totalUsed += sz - BLOCK_OVERHEAD;
      }
      block += sz;
    }

    // Verify free list integrity
    var flMap = alloc._readMeta32(META_FL_BITMAP);
    var freeListCount = 0;
    for (var fl = 0; fl < FL_COUNT; fl++) {
      if (!(flMap & (1 << fl))) continue;
      var slMap = alloc._readMeta32(META_SL_BITMAP + fl * 4);
      for (var sl = 0; sl < SL_COUNT; sl++) {
        if (!(slMap & (1 << sl))) continue;
        var head = alloc._readMeta32(META_FREE_HEADS + (fl * SL_COUNT + sl) * 4);
        var cur = head;
        var visited = {};
        while (cur) {
          if (visited[cur]) {
            integrityErrors.push('free list cycle at ' + cur);
            break;
          }
          visited[cur] = true;
          if (!alloc._blockIsFree(cur)) {
            integrityErrors.push('non-free block ' + cur + ' in free list');
          }
          freeListCount++;
          cur = alloc._blockGetNextFree(cur);
        }
      }
    }
    if (freeListCount !== freeBlocks) {
      integrityErrors.push('free list count ' + freeListCount +
        ' != free blocks ' + freeBlocks);
    }

    return {
      superblock: sb,
      poolStart: poolStart,
      poolEnd: poolEnd,
      poolSize: poolEnd - poolStart,
      storeSize: this._s.size(),
      inodeTableCapacity: this._inodes.capacity(),
      nextInode: this._s.getUint32(SB_NEXT_INODE_ID),
      inodeCount: inodeCount,
      fdTableSize: this._fdTable.length,
      cwd: this._cwd,
      blocks: { used: usedBlocks, free: freeBlocks },
      bytes: { used: totalUsed, free: totalFree, largestFree: largestFree },
      integrityErrors: integrityErrors,
      alloc: {
        totalFreeBytes: alloc.totalFreeBytes(),
        freeBlockCount: alloc.freeBlockCount(),
      },
    };
  };

  // setStdin(data) — feed stdin bytes for the WASM program to consume
  // from fd 0.  data is a Uint8Array/Buffer (or an array of byte values,
  // the legacy shape).  Call before runModule; may be called repeatedly
  // to append chunks.
  BlockFS.prototype.setStdin = function (data) {
    this._stdinBuffer.push(data);
    this._stdinEOF = true;
  };

  // -----------------------------------------------------------------------
  // Live interactive stdin (no-JSPI path) — SharedArrayBuffer ring.
  //
  // The INPUT mirror of the console OUTPUT sab (createSharedConsoleBuffer):
  // the page (main thread) is the producer, this worker is the consumer.
  // read(0)/select() park on the SEQ futex via Atomics.wait until the page
  // pushes keystrokes (or signals EOF), then drain bytes synchronously — no
  // JSPI, so it works on Safari/iOS. Without a sab wired (Node CLI, headless
  // runs) stdin keeps its old pre-buffered/EOF behaviour.
  //
  // Layout: SharedArrayBuffer(32 + ringSize)
  //   control = Int32Array(sab, 0, 8):
  //     [0] SEQ      producer bumps on EVERY push or EOF — the wait cell
  //     [1] AVAIL    bytes available to read
  //     [2] WRITEPOS producer ring cursor (mod ringSize)
  //     [3] READPOS  consumer ring cursor (mod ringSize)
  //     [4] EOF      1 once the producer closes input (Ctrl-D / program end)
  //     [5] COLS     terminal columns (producer-set; default 80)
  //     [6] ROWS     terminal rows    (producer-set; default 24)
  //     [7] TERMIOS  consumer-set bitfield: bit0=icanon bit1=echo bit2=opost
  //   ring = Uint8Array(sab, 32, ringSize)
  //
  // The consumer snapshots SEQ before checking AVAIL/EOF and waits on SEQ —
  // because EOF doesn't change AVAIL, a plain wait on AVAIL would miss an
  // EOF-only wakeup (lost-wakeup). Any producer change bumps SEQ, so a wait
  // that races the change returns 'not-equal' at once.
  var SI_SEQ = 0, SI_AVAIL = 1, SI_WRITEPOS = 2, SI_READPOS = 3,
      SI_EOF = 4, SI_COLS = 5, SI_ROWS = 6, SI_TERMIOS = 7;
  var SI_HDR_BYTES = 32; // 8 * Int32

  // Wire (or clear, with null) the live-stdin sab. Called from toWasmEnv via
  // ctx.stdinSab; also a direct test seam.
  BlockFS.prototype.setStdinSab = function (sab) {
    if (!sab) { this._stdinSab = null; this._stdinCtrl = null; this._stdinRing = null; return; }
    this._stdinSab = sab;
    this._stdinCtrl = new Int32Array(sab, 0, 8);
    this._stdinRing = new Uint8Array(sab, SI_HDR_BYTES, sab.byteLength - SI_HDR_BYTES);
  };

  // True when the live-stdin sab has bytes ready or has hit EOF (EOF makes a
  // read return 0, which POSIX select reports as readable). Used by select().
  BlockFS.prototype._stdinSabReady = function () {
    var ctrl = this._stdinCtrl;
    return Atomics.load(ctrl, SI_AVAIL) > 0 || Atomics.load(ctrl, SI_EOF) !== 0;
  };

  // Blocking stdin read from the sab ring. Returns bytes read (>0, possibly a
  // partial read like a TTY) or 0 at EOF. Parks the worker on the SEQ futex
  // until the producer pushes input. Never busy-spins: if off-main-thread
  // blocking is unavailable it degrades to a non-blocking drain (then EOF).
  BlockFS.prototype._readStdinSab = function (buf, count) {
    var ctrl = this._stdinCtrl, ring = this._stdinRing, size = ring.length;
    for (;;) {
      var seq = Atomics.load(ctrl, SI_SEQ);
      var avail = Atomics.load(ctrl, SI_AVAIL);
      if (avail > 0) {
        var n = Math.min(count, avail);
        var rp = Atomics.load(ctrl, SI_READPOS);
        for (var i = 0; i < n; i++) buf[i] = ring[(rp + i) % size];
        Atomics.store(ctrl, SI_READPOS, (rp + n) % size);
        Atomics.sub(ctrl, SI_AVAIL, n);
        return n;
      }
      if (Atomics.load(ctrl, SI_EOF)) return 0; // EOF
      if (!_canBlock) return 0; // can't park → behave as EOF, never spin
      Atomics.wait(ctrl, SI_SEQ, seq); // wake on next producer push/EOF/signal
      // The kernel also rings SI_SEQ when it posts a signal to this process:
      // deliver here and surface EINTR (unless every action allows restart).
      if (this._sigcheck && this._sigcheck() === false) return this._setErr('EINTR');
    }
  };

  // -----------------------------------------------------------------------
  // Synchronous sleep primitive for the no-JSPI block-FS path.
  //
  // Atomics.wait() parks the calling agent on a SharedArrayBuffer cell until
  // it is notified or a timeout elapses. We point it at a cell that is always
  // 0 and is never notified, so it can ONLY wake by timing out — a precise,
  // blocking, JSPI-free sleep. This is what lets usleep/nanosleep and
  // select-with-timeout actually suspend on Safari/iOS, where
  // WebAssembly.Suspending (JSPI) is absent.
  //
  // Constraints: Atomics.wait needs a SharedArrayBuffer (→ cross-origin
  // isolation in the browser) and may only block off a Window's main thread
  // (it throws there). Block-FS always runs in a worker, so this holds in
  // practice; Node permits it on the main thread too. When the primitive is
  // unavailable we fall back to ENOSYS — never a busy-wait.
  var _sleepCell = null;
  var _canBlock = (function () {
    if (typeof SharedArrayBuffer === 'undefined' ||
        typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') {
      return false;
    }
    try {
      _sleepCell = new Int32Array(new SharedArrayBuffer(4));
      // Probe: expected (1) !== actual (0) ⇒ returns 'not-equal' immediately
      // without blocking; on a thread that cannot block this throws instead.
      Atomics.wait(_sleepCell, 0, 1, 0);
      return true;
    } catch (e) {
      _sleepCell = null;
      return false;
    }
  })();

  // Block the calling thread for `ms` milliseconds. `ms` may be fractional but
  // is honoured at millisecond granularity (matching the JSPI setTimeout path).
  // No-op when blocking is unavailable or the duration is non-positive.
  function blockingSleepMs(ms) {
    if (!_canBlock || !(ms > 0)) return;
    Atomics.wait(_sleepCell, 0, 0, ms); // cell stays 0 → can only time out
  }

  BlockFS.prototype.toWasmEnv = function (ctx) {
    var readString = ctx.readString;
    var setErrnoName = ctx.setErrnoName;
    var getMemory = ctx.getMemory;
    var writeOut = ctx.writeOut;
    var writeErr = ctx.writeErr;
    var self = this;

    // Wire the optional live-stdin sab (interactive page). Absent → stdin
    // stays pre-buffered/EOF and select reports it always-ready (old path).
    if (ctx.stdinSab) self.setStdinSab(ctx.stdinSab);

    // Signal safe-point probe for blocking stdin/select waits: with a kernel
    // attached (ctx.deliverSignals, bound late by runModule), a wake on the
    // SI_SEQ futex may mean "signal pending", not "bytes arrived" — the
    // check turns a parked read into EINTR (or transparently restarts under
    // SA_RESTART semantics: true = restart, false = EINTR, null = nothing).
    self._sigcheck = function () {
      return ctx.deliverSignals ? ctx.deliverSignals() : null;
    };

    // Wire the optional owner-brokered pipe transport (the embedder's runtime).
    // Absent → in-memory pipes (single instance). With it, pipe ends can cross
    // instances (the spawn-pipeline case).
    if (ctx.pipeBroker) self._pipeBroker = ctx.pipeBroker;

    function wrap(fn) {
      return function () {
        var result = fn.apply(self, arguments);
        if (result === null || result < 0) {
          setErrnoName(self._lastError || 'EIO');
          return -1;
        }
        return result;
      };
    }

    return {
      __open_impl: wrap(function (path_ptr, flags, mode) {
        var path = readString(path_ptr);
        return this.open(path, flags, mode);
      }),
      close: wrap(function (fd) { return this.close(fd); }),
      read: wrap(function (fd, buf_ptr, count) {
        var memory = getMemory();
        var buf = new Uint8Array(memory.buffer, buf_ptr, count);
        return this.read(fd, buf, count);
      }),
      write: wrap(function (fd, buf_ptr, count) {
        var memory = getMemory();
        var buf = new Uint8Array(memory.buffer, buf_ptr, count);
        if (fd === 1 || fd === 2) {
          // Default (non-redirected) stdout/stderr go to the console — gated
          // on the POSITIVE `console` capability that only BlockFS's default
          // 0/1/2 entries carry (CD27). Everything else — a dup2'd
          // pipe/file/dev entry, a foreign backend's entry (RemoteFS needs
          // no decoy), even a missing one — falls through to this.write so
          // the real routing (redirection, the FS_WRITE RPC) takes effect.
          var e = self._fdTable[fd];
          if (e && e.console === true) {
            if (fd === 1) writeOut(buf);
            else writeErr(buf);
            return count;
          }
        }
        return this.write(fd, buf, count);
      }),
      // 64-bit lseek: offset arrives as BigInt, result returns as BigInt. The
      // prototype returns null on error, so map that to -1n + errno (the generic
      // wrap()'s number -1 would throw at the i64 boundary).
      lseek: function (fd, offset, whence) {
        var r = self.lseek(fd, Number(offset), whence);
        if (r === null) { setErrnoName(self._lastError || 'EIO'); return -1n; }
        return BigInt(r);
      },
      mkdir: wrap(function (path_ptr, mode) {
        return this.mkdir(readString(path_ptr), mode);
      }),
      remove: wrap(function (path_ptr) {
        return this.unlink(readString(path_ptr));
      }),
      rename: wrap(function (old_ptr, new_ptr) {
        return this.rename(readString(old_ptr), readString(new_ptr));
      }),
      __opendir: wrap(function (path_ptr) {
        return this.opendir(readString(path_ptr));
      }),
      __readdir: wrap(function (handle, dirent_ptr) {
        var ent = this.readdir(handle);
        if (ent === null || ent < 0) {
          if (ent === null) return -1; // EOF, not an error
          return -1;
        }
        var memory = getMemory();
        var view = new DataView(memory.buffer);
        var bytes = new Uint8Array(memory.buffer);
        view.setInt32(dirent_ptr + 0, ent.ino, true);
        view.setInt32(dirent_ptr + 4, ent.type, true);
        var nameBytes = encodeStr(ent.name);
        var nameLen = Math.min(nameBytes.length, 255);
        for (var bi = 0; bi < nameLen; bi++)
          bytes[dirent_ptr + 8 + bi] = nameBytes[bi];
        bytes[dirent_ptr + 8 + nameLen] = 0;
        return 0;
      }),
      __closedir: wrap(function (handle) {
        return this.closedir(handle);
      }),
      stat: wrap(function (path_ptr, buf_ptr) {
        var st = this.stat(readString(path_ptr));
        if (st === null) return -1;
        writeStatBuf(getMemory(), buf_ptr, st);
        return 0;
      }),
      lstat: wrap(function (path_ptr, buf_ptr) {
        var st = this.lstat(readString(path_ptr));
        if (st === null) return -1;
        writeStatBuf(getMemory(), buf_ptr, st);
        return 0;
      }),
      fstat: wrap(function (fd, buf_ptr) {
        var st = this.fstat(fd);
        if (st === null) return -1;
        writeStatBuf(getMemory(), buf_ptr, st);
        return 0;
      }),
      getcwd: wrap(function (buf_ptr, size) {
        var cwd = this.getcwd();
        var encoded = encodeStr(cwd);
        if (encoded.length + 1 > size) { setErrnoName('ERANGE'); return 0; }
        var memory = getMemory();
        var bytes = new Uint8Array(memory.buffer);
        for (var ci = 0; ci < encoded.length; ci++)
          bytes[buf_ptr + ci] = encoded[ci];
        bytes[buf_ptr + encoded.length] = 0;
        return buf_ptr;
      }),
      chdir: wrap(function (path_ptr) {
        return this.chdir(readString(path_ptr));
      }),
      access: wrap(function (path_ptr, mode) {
        return this.access(readString(path_ptr), mode);
      }),
      rmdir: wrap(function (path_ptr) {
        return this.rmdir(readString(path_ptr));
      }),
      unlink: wrap(function (path_ptr) {
        return this.unlink(readString(path_ptr));
      }),
      pipe: wrap(function (pipefd_ptr) {
        var fds = this.pipe();
        if (fds === null) return -1;
        var view = new DataView(getMemory().buffer);
        view.setInt32(pipefd_ptr, fds[0], true);
        view.setInt32(pipefd_ptr + 4, fds[1], true);
        return 0;
      }),
      // AF_UNIX sockets (todos/0008): thin marshalling over the sock*
      // methods — real on RemoteFS (kernel RPCs), ENOSYS on plain BlockFS.
      __sock_socket: wrap(function (domain, type, protocol) {
        return this.sockSocket(domain, type, protocol);
      }),
      __sock_bind: wrap(function (fd, path_ptr) {
        return this.sockBind(fd, readString(path_ptr));
      }),
      __sock_listen: wrap(function (fd, backlog) {
        return this.sockListen(fd, backlog);
      }),
      __sock_accept: wrap(function (fd) {
        return this.sockAccept(fd);
      }),
      __sock_connect: wrap(function (fd, path_ptr) {
        return this.sockConnect(fd, readString(path_ptr));
      }),
      __sock_pair: wrap(function (sv_ptr) {
        var sfds = this.sockPair();
        if (sfds === null) return -1;
        var sview = new DataView(getMemory().buffer);
        sview.setInt32(sv_ptr, sfds[0], true);
        sview.setInt32(sv_ptr + 4, sfds[1], true);
        return 0;
      }),
      __sock_shutdown: wrap(function (fd, how) {
        return this.sockShutdown(fd, how);
      }),
      // FS_WATCH (ticket #75): the C-visible primitive under os/fswatch.h
      // — real over RemoteFS (kernel FS_WATCH_OPEN), ENOSYS in-process.
      __fs_watch: wrap(function (path_ptr, mask, flags) {
        return this.fsWatch(readString(path_ptr), mask >>> 0, flags >>> 0);
      }),
      dup: wrap(function (oldfd) {
        var nfd = this.dup(oldfd);
        if (nfd === null) return -1;
        return nfd;
      }),
      dup2: wrap(function (oldfd, newfd) {
        var nfd = this.dup2(oldfd, newfd);
        if (nfd === null) return -1;
        return nfd;
      }),
      isatty: function (fd) {
        // A live tty ring attached means stdio IS a terminal (kernel path),
        // regardless of what the worker's process.stdin says.
        if (fd >= 0 && fd <= 2 && self._stdinSab) return 1;
        // When running in Node, report the real TTY status for fd 0
        // so programs (Lua, etc.) can detect batch vs interactive mode.
        if (fd === 0 && typeof process !== 'undefined' && process.stdin) {
          return process.stdin.isTTY ? 1 : 0;
        }
        return self.isatty(fd);
      },
      __tcgetattr: function (fd, iflag_ptr, oflag_ptr, cflag_ptr, lflag_ptr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        var mem = new DataView(getMemory().buffer);
        mem.setInt32(iflag_ptr, 0x100, true);
        mem.setInt32(oflag_ptr, 0x1, true);
        mem.setInt32(cflag_ptr, 0xB00, true);
        mem.setInt32(lflag_ptr, 0x188, true);
        return 0;
      },
      __tcsetattr: function (fd, actions, iflag, oflag, cflag, lflag) {
        // Terminal is handled by the page. With a live-stdin sab wired, publish
        // the raw/echo/opost mode to its TERMIOS control word so the page can
        // switch line-discipline (e.g. stop local echo in raw mode) without a
        // postMessage relay.
        if (self._stdinSab) {
          var mode = ((lflag & 0x100) ? 1 : 0)   // icanon → bit0
                   | ((lflag & 0x8) ? 2 : 0)      // echo   → bit1
                   | ((oflag & 0x1) ? 4 : 0);     // opost  → bit2
          Atomics.store(self._stdinCtrl, SI_TERMIOS, mode);
        }
        return 0;
      },
      // ---- full-struct termios defaults (new binaries; no kernel) ----
      // With kernel.js attached, createSpawn's RPC-backed versions override
      // these (merge order). Here: canned values matching the legacy
      // __tcgetattr, plus standard control chars; setattr publishes the same
      // 3-bit mode word for the page line discipline. pgrp ops are ENOTTY —
      // no process groups without a kernel. Layout: 4×u32 flags, cc[20]@16.
      __tty_getattr: function (fd, tPtr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        var dv = new DataView(getMemory().buffer);
        dv.setUint32(tPtr, 0x100, true);        // ICRNL
        dv.setUint32(tPtr + 4, 0x1, true);      // OPOST
        dv.setUint32(tPtr + 8, 0xB00, true);    // CS8|CREAD
        dv.setUint32(tPtr + 12, 0x188, true);   // ISIG|ICANON|ECHO
        var m = new Uint8Array(getMemory().buffer);
        var cc = [4, 0, 0, 127, 0, 21, 0, 0, 3, 28, 26, 0, 17, 19, 0, 0, 1, 0, 0, 0];
        for (var ci = 0; ci < 20; ci++) m[tPtr + 16 + ci] = cc[ci];
        dv.setUint32(tPtr + 36, 0, true);
        dv.setUint32(tPtr + 40, 0, true);
        return 0;
      },
      __tty_setattr: function (fd, actions, tPtr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        if (self._stdinSab) {
          var dv2 = new DataView(getMemory().buffer);
          var oflag2 = dv2.getUint32(tPtr + 4, true);
          var lflag2 = dv2.getUint32(tPtr + 12, true);
          var mode2 = ((lflag2 & 0x100) ? 1 : 0) | ((lflag2 & 0x8) ? 2 : 0)
                    | ((oflag2 & 0x1) ? 4 : 0);
          Atomics.store(self._stdinCtrl, SI_TERMIOS, mode2);
        }
        return 0;
      },
      __tty_getpgrp: function (fd) { void fd; setErrnoName('ENOTTY'); return -1; },
      __tty_setpgrp: function (fd, pgid) { void fd; void pgid; setErrnoName('ENOTTY'); return -1; },
      sleep: function (seconds) {
        // Returns seconds left unslept (0 here — never interrupted). When
        // blocking is unavailable nothing is slept, so report the full amount.
        if (!_canBlock) return seconds;
        blockingSleepMs(seconds * 1000);
        return 0;
      },
      usleep: function (usec) {
        if (!_canBlock) { setErrnoName('ENOSYS'); return -1; }
        blockingSleepMs(usec / 1000);
        return 0;
      },
      __nanosleep: function (sec, nsec) {
        if (!_canBlock) { setErrnoName('ENOSYS'); return -1; }
        blockingSleepMs(sec * 1000 + nsec / 1e6);
        return 0;
      },
      // select(): synchronous readiness scan + Atomics-backed wait. Block-FS is
      // synchronous, so regular files and pipes can only change state from
      // within this program — the one asynchronous input is the live-stdin sab,
      // written by the page from another thread. Stdin readiness comes from the
      // sab (bytes or EOF); when stdin is requested but not ready we park on its
      // SEQ futex (honouring the timeout) and re-scan on wake. With no sab,
      // stdin is always-ready and the only thing to wait on is the timeout —
      // identical to before.
      __select_impl: function (nfds, readfds_ptr, writefds_ptr,
                                exceptfds_ptr, timeout_sec, timeout_usec,
                                has_timeout) {
        var mem = new DataView(getMemory().buffer);
        var FDS_WORDS = 2; // up to 64 fds, matching the other select backends
        function readBits(ptr) {
          if (!ptr) return null;
          var bits = [];
          for (var i = 0; i < FDS_WORDS; i++) bits.push(mem.getInt32(ptr + i * 4, true));
          return bits;
        }
        function writeBits(ptr, bits) {
          if (!ptr || !bits) return;
          for (var i = 0; i < FDS_WORDS; i++) mem.setInt32(ptr + i * 4, bits[i], true);
        }
        function isBitSet(bits, fd) { return bits && (bits[fd >> 5] & (1 << (fd & 31))) !== 0; }
        var hasSab = !!self._stdinSab;
        function scan() {
          var rIn = readBits(readfds_ptr), wIn = readBits(writefds_ptr), eIn = readBits(exceptfds_ptr);
          var rOut = rIn ? [0, 0] : null, wOut = wIn ? [0, 0] : null, eOut = eIn ? [0, 0] : null;
          var count = 0, stdinPending = false;
          var tbl = self._fdTable;
          for (var fd = 0; fd < nfds && fd < 64; fd++) {
            var entry = (fd >= 0 && fd < tbl.length) ? tbl[fd] : null;
            if (!entry) continue;
            if (rIn && isBitSet(rIn, fd)) {
              var rready;
              if (entry.type === 'pipe') {
                rready = entry.pipe.buffer.length > 0 || entry.pipe.closed.write;
              } else if (entry.console === true) {
                // stdin: with a live sab, ready only when it has bytes or EOF;
                // without one, always ready (pre-buffer/EOF, old behaviour).
                rready = hasSab ? self._stdinSabReady() : true;
                if (!rready) stdinPending = true;
              } else {
                rready = true; // regular files never block
              }
              if (rready) { rOut[fd >> 5] |= (1 << (fd & 31)); count++; }
            }
            if (wIn && isBitSet(wIn, fd)) {
              var wready = (entry.type === 'pipe') ? !entry.pipe.closed.read : true;
              if (wready) { wOut[fd >> 5] |= (1 << (fd & 31)); count++; }
            }
            // exceptfds: block-FS surfaces no exceptional conditions → never set.
          }
          return { count: count, rOut: rOut, wOut: wOut, eOut: eOut, stdinPending: stdinPending };
        }
        function commit(r) {
          writeBits(readfds_ptr, r.rOut);
          writeBits(writefds_ptr, r.wOut);
          writeBits(exceptfds_ptr, r.eOut);
          return r.count;
        }
        var r = scan();
        if (r.count > 0) return commit(r);
        // A live stdin sab is the only thing that can become ready from another
        // thread. If a stdin fd was requested but isn't ready, park on its SEQ
        // futex; any producer push/EOF bumps SEQ (so no lost-wakeup) and we
        // re-scan on wake.
        if (r.stdinPending && _canBlock) {
          var ctrl = self._stdinCtrl;
          if (has_timeout) {
            var ms = timeout_sec * 1000 + timeout_usec / 1000;
            if (ms > 0) {
              var seq = Atomics.load(ctrl, SI_SEQ);
              if (!self._stdinSabReady()) Atomics.wait(ctrl, SI_SEQ, seq, ms);
              // Signal wake (kernel rings SI_SEQ on posts): POSIX select
              // reports EINTR rather than restarting the timeout.
              if (self._sigcheck && self._sigcheck() === false) {
                setErrnoName('EINTR'); return -1;
              }
            }
            return commit(scan());
          }
          for (;;) {
            var seq2 = Atomics.load(ctrl, SI_SEQ);
            if (self._stdinSabReady()) break;
            Atomics.wait(ctrl, SI_SEQ, seq2);
            if (self._sigcheck && self._sigcheck() === false) {
              setErrnoName('EINTR'); return -1;
            }
          }
          return commit(scan());
        }
        if (has_timeout) {
          // Nothing async to wait on; sleep out the timeout, then re-scan.
          blockingSleepMs(timeout_sec * 1000 + timeout_usec / 1000);
          return commit(scan());
        }
        // No fds ready and no timeout: POSIX says block until one is. With no
        // stdin sab nothing can change state, so this is an unsatisfiable wait —
        // park indefinitely to honour the contract, or fail if we can't block
        // (never busy-spin).
        if (_canBlock) { for (;;) Atomics.wait(_sleepCell, 0, 0); }
        setErrnoName('ENOSYS'); return -1;
      },
      __ioctl_tiocgwinsz: function (fd, rows_ptr, cols_ptr) {
        // Read the real terminal size from the tty SAB header when wired (the
        // bridge keeps COLS/ROWS current); otherwise fall back to 80x24.
        // Guard on _stdinCtrl, NOT _stdinSab: brokered-mode RemoteFS wires
        // ONLY the winsize words (stdin flows via FS_READ RPCs, no ring), so
        // a _stdinSab guard left every brokered process at 80x24 (todos/0011).
        var rows = 24, cols = 80;
        if (self._stdinCtrl) {
          var c = Atomics.load(self._stdinCtrl, SI_COLS);
          var r = Atomics.load(self._stdinCtrl, SI_ROWS);
          if (c > 0) cols = c;
          if (r > 0) rows = r;
        }
        var mem = new DataView(getMemory().buffer);
        mem.setInt32(rows_ptr, rows, true);
        mem.setInt32(cols_ptr, cols, true);
        return 0;
      },
      // Pty control plane (todos/0020) — real only over a kernel (RemoteFS
      // implements openpty/setWinsize as RPCs); in-process BlockFS has no
      // second terminal to speak of, so these answer ENOSYS/ENOTTY.
      __openpty: function (m_ptr, s_ptr) {
        if (typeof self.openpty !== 'function') { setErrnoName('ENOSYS'); return -1; }
        var pr = self.openpty();
        if (pr === null) { setErrnoName(self._lastError || 'EIO'); return -1; }
        var pm = new DataView(getMemory().buffer);
        pm.setInt32(m_ptr, pr[0], true);
        pm.setInt32(s_ptr, pr[1], true);
        return 0;
      },
      __ioctl_tiocswinsz: function (fd, rows, cols) {
        if (typeof self.setWinsize !== 'function') { setErrnoName('ENOTTY'); return -1; }
        if (self.setWinsize(fd, rows | 0, cols | 0) === null) {
          setErrnoName(self._lastError || 'ENOTTY'); return -1;
        }
        return 0;
      },

      // ---- additional POSIX ops ----
      // realpath(3): PHYSICAL resolution — symlinks followed (todos/0263). For
      // in-process BlockFS this.realpathPhysical walks locally; for brokered
      // RemoteFS it is ONE FS_REALPATH RPC resolved kernel-side. On failure we
      // return NULL(0) + errno, matching glibc realpath and the standalone-Node
      // flavor (both require every component to exist). NB not wrap()ped: a
      // realpath error is a NULL return, not a -1.
      realpath: function (path_ptr, resolved_ptr) {
        var path = readString(path_ptr);
        var resolved = self.realpathPhysical(path);
        if (resolved === null) { setErrnoName(self._lastError || 'ENOENT'); return 0; }
        if (resolved_ptr === 0) { setErrnoName('EINVAL'); return 0; } // NULL buf unsupported (standalone parity)
        var encoded = encodeStr(resolved);
        var memory = getMemory();
        var bytes = new Uint8Array(memory.buffer);
        for (var ri = 0; ri < encoded.length; ri++)
          bytes[resolved_ptr + ri] = encoded[ri];
        bytes[resolved_ptr + encoded.length] = 0;
        return resolved_ptr;
      },
      ftruncate: wrap(function (fd, size) { return this.ftruncate(fd, Number(size)); }),
      chmod: wrap(function (path_ptr, mode) {
        return this.chmod(readString(path_ptr), mode);
      }),
      fchmod: wrap(function (fd, mode) { return this.fchmod(fd, mode); }),
      // atime/mtime arrive as i64 BigInts (time_t); Number() them before the
      // FS scales by timeScale (BigInt * Number would throw).
      __utime: wrap(function (path_ptr, atime, mtime) {
        return this.utime(readString(path_ptr), Number(atime), Number(mtime));
      }),
      __futime: wrap(function (fd, atime, mtime) {
        return this.futime(fd, Number(atime), Number(mtime));
      }),
      link: wrap(function (old_ptr, new_ptr) {
        return this.link(readString(old_ptr), readString(new_ptr));
      }),
      symlink: wrap(function (target_ptr, link_ptr) {
        return this.symlink(readString(target_ptr), readString(link_ptr));
      }),
      readlink: wrap(function (path_ptr, buf_ptr, bufsize) {
        var memory = getMemory();
        var buf = new Uint8Array(memory.buffer, buf_ptr, bufsize);
        return this.readlink(readString(path_ptr), buf, bufsize);
      }),
      // libc fcntl reaches us as __fcntl3(fd, cmd, arg) — the C inline
      // unpacks its variadic int (todos/0005: the shell's fd-save dance
      // needs a REAL F_DUPFD; before that the C fcntl was a no-op).
      __fcntl3: wrap(function (fd, cmd, arg) {
        // F_DUPFD (0) / F_DUPFD_CLOEXEC (1030; CLOEXEC untracked in v1)
        if (cmd === 0 || cmd === 1030) {
          return this.fcntl_dupfd(fd, arg | 0);
        }
        // F_GETFL (cmd == 3) — return file access mode
        if (cmd === 3) {
          // Return O_RDWR if the fd has an inode, O_RDONLY for stdin
          if (fd <= 2) return 0; // O_RDONLY
          var entry = self._fdTable[fd];
          if (entry && entry.inoId !== undefined) return 2; // O_RDWR
          return 0;
        }
        // For all other fcntl commands (file locking, etc.), return
        // success rather than ENOSYS.  SQLite treats ENOSYS as a disk
        // I/O error.
        return 0;
      }),
      // fsync/fdatasync: a program explicitly asking for durability. Dispatch
      // via `this.` like every other fd op so RemoteFS (kernel.js) can serve
      // it as an RPC — the old inline `this._s.flush()` reached for the
      // BlockFS-private store handle and crashed brokered processes (sqlite's
      // journal fsync was the first caller to notice).
      fsync: wrap(function (fd) { return this.fsync(fd); }),
      fdatasync: wrap(function (fd) { return this.fsync(fd); }),
    };
  };

  // =================================================================
  // Factory functions
  // =================================================================

  // Production init: async, backed by OPFS.
  // After this returns, the returned BlockFS is fully synchronous.
  BlockFS.init = async function (opfsName) {
    opfsName = opfsName || '__blockfs';
    var root = await navigator.storage.getDirectory();
    var fileHandle;
    try {
      fileHandle = await root.getFileHandle(opfsName, { create: false });
    } catch (e) {
      fileHandle = await root.getFileHandle(opfsName, { create: true });
    }
    var syncHandle = await fileHandle.createSyncAccessHandle();
    var store = new SyncAccessHandleStore(syncHandle);
    return BlockFS.create(store);
  };

  // Production v4 workspace mount + migration lifecycle, OPFS-backed. Returns
  // { fs, mode, handles }. Modes: 'v4' (mounted an existing complete v4 image),
  // 'migrated' (migrated the legacy v3 image forward — v3 file kept as rollback),
  // 'fresh' (no prior data), 'legacy-readonly' (the toggle: the old v3 image,
  // strictly read-only), 'no-legacy' (toggle requested but no v3 image exists).
  // The v3 image is NEVER written. Caller keeps `handles` open for the session.
  BlockFS.openWorkspace = async function (opts) {
    opts = opts || {};
    var v4name = opts.v4Name || 'workspace.v4.img';
    var v3name = opts.v3Name || 'workspace.img';
    var root = await navigator.storage.getDirectory();
    async function open(name, create) {
      var fh;
      try { fh = await root.getFileHandle(name, { create: false }); }
      catch (e) { if (!create) return null; fh = await root.getFileHandle(name, { create: true }); }
      var h = await fh.createSyncAccessHandle();
      return { handle: h, store: new SyncAccessHandleStore(h) };
    }
    function isV3(store) {
      return store.size() >= SUPERBLOCK_SIZE &&
        store.getUint32(SB_MAGIC) === MAGIC && store.getUint32(SB_VERSION) === 3;
    }

    // Toggle: mount the legacy v3 image strictly read-only (no migration, no write).
    if (opts.viewLegacy) {
      var leg = await open(v3name, false);
      if (!leg || !isV3(leg.store)) { if (leg) leg.handle.close(); return { fs: null, mode: 'no-legacy', handles: [] }; }
      var rfs = BlockFS.create(new ReadOnlyStore(leg.store));
      rfs._readonly = true;
      return { fs: rfs, mode: 'legacy-readonly', handles: [leg.handle] };
    }

    // Pass-through for MountFS user volumes (todos/0026): skip the /dev
    // self-heal on volumes mounted at a non-root prefix.
    var v4opts = opts.noDevNodes ? { noDevNodes: true } : undefined;
    var v4 = await open(v4name, true);
    if (BlockFS.isMigrationComplete(v4.store)) {
      return { fs: BlockFS.createV4(v4.store, v4opts), mode: 'v4', handles: [v4.handle] };
    }
    // v4 absent/incomplete: migrate forward from a legacy v3 image if present.
    var legacy = await open(v3name, false);
    if (legacy && isV3(legacy.store)) {
      v4.handle.truncate(0);                       // discard any partial v4, clean retry
      BlockFS.migrateV3toV4(legacy.store, v4.store); // legacy is read-only inside migrate
      legacy.handle.close();                       // release v3 handle; file kept as rollback
      return { fs: BlockFS.createV4(v4.store, v4opts), mode: 'migrated', handles: [v4.handle] };
    }
    if (legacy) legacy.handle.close();
    var freshFs = BlockFS.createV4(v4.store, v4opts);
    // A natively-fresh v4 has no migration pending: mark it complete NOW, at
    // the one site where "no legacy exists" was just verified. Without this,
    // every future mount re-enters the migrate-check path — and a legacy
    // workspace.img appearing later (same-origin app, restored backup) would
    // truncate(0) this image and "migrate" over it. Deliberately NOT set in
    // createV4 itself: migrateV3toV4 formats its destination through
    // createV4, and only its final copy step may set the bit (a crash
    // mid-migration must stay visibly incomplete).
    v4.store.setUint32(SB_FLAGS, v4.store.getUint32(SB_FLAGS) | SB_MIGRATED_BIT);
    return { fs: freshFs, mode: 'fresh', handles: [v4.handle] };
  };

  // Test init: sync, backed by any ByteStore.
  BlockFS.create = function (store) {
    var storeSize = store.size();
    var formatted = false;

    // Check if store needs formatting
    if (storeSize < SUPERBLOCK_SIZE) {
      store.resize(TLSF_POOL_OFFSET + 65536);
      storeSize = store.size();
      formatted = true;
    } else {
      var magic = store.getUint32(SB_MAGIC);
      if (magic !== MAGIC) formatted = true;
    }

    if (formatted) {
      // Ensure minimum size
      if (storeSize < TLSF_POOL_OFFSET + 65536) {
        store.resize(TLSF_POOL_OFFSET + 65536);
        storeSize = store.size();
      }
      // Zero the superblock area
      var zero256 = new Uint8Array(SUPERBLOCK_SIZE);
      store.setBytes(0, zero256);
    }

    var alloc;
    var inodeTable;

    if (formatted) {
      // Init fresh TLSF allocator (zeroes metadata, creates initial free block)
      alloc = new TLSFAllocator(store, SUPERBLOCK_SIZE,
        storeSize - TLSF_POOL_OFFSET);
      inodeTable = new InodeTable(alloc);
      // Create inode table
      inodeTable.init(INITIAL_INODE_CAPACITY);
      // Create BlockFS (handles root dir creation)
      var fs = new BlockFS(store, alloc, inodeTable, 1, true);
      fs._writeSuperblock();
      return fs;
    } else {
      // Load existing filesystem — must NOT re-init TLSF (would destroy
      // the allocator state stored in the TLSF metadata region).
      alloc = new TLSFAllocator(store, SUPERBLOCK_SIZE, 0);
      // Override the zeroed metadata with what's already in the store.
      // _init() zeroed the metadata region; we re-read the pool_end and
      // last_block from the store.  Actually, _init() destroyed the free
      // list — we need to rebuild it by walking all blocks.
      //
      // _init(poolSize=0) returned early; TLSF metadata is intact.
      inodeTable = new InodeTable(alloc);
      var sb = {
        tlsfPoolOffset: store.getUint32(SB_TLSF_POOL_OFFSET),
        tlsfPoolSize: store.getUint32(SB_TLSF_POOL_SIZE),
        inodeTblExtent: store.getUint32(SB_INODE_TBL_EXTENT),
        inodeTblCap: store.getUint32(SB_INODE_TBL_CAP),
        nextInodeId: store.getUint32(SB_NEXT_INODE_ID),
        rootInode: store.getUint32(SB_ROOT_INODE)
      };
      inodeTable.load(sb.inodeTblExtent, sb.inodeTblCap);
      var fs = new BlockFS(store, alloc, inodeTable, sb.rootInode, false);
      // _nextInode is read THROUGH the superblock (SB_NEXT_INODE_ID); nothing to cache.
      return fs;
    }
  };

  // Mount/format a v4 image (128-byte inodes, TLSF64, ms timestamps). Parallel to
  // create(); v3 stays the default. Formats a fresh store, or loads an existing
  // v4 one (magic + version 4). Used by the migration and the v4 worker path.
  // opts.noDevNodes skips the /dev self-heal — for volumes mounted at a
  // non-root prefix under MountFS (todos/0026), where /dev is served by the
  // root volume and a /root/dev would just be clutter in $HOME.
  // opts.readonly (todos/0040) mounts an EXISTING v4 image read-only: every
  // mutating op returns EROFS, the store is wrapped in ReadOnlyStore as a
  // backstop, and an unformatted/non-v4 store throws (a readonly mount must
  // never format). This is how the baked system blob is mounted at /usr.
  BlockFS.createV4 = function (store, opts) {
    if (opts && opts.readonly) {
      if (store.size() < SUPERBLOCK_SIZE ||
          store.getUint32(SB_MAGIC) !== MAGIC || store.getUint32(SB_VERSION) !== 4) {
        throw new Error('createV4: readonly mount of an unformatted or non-v4 store');
      }
      var roStore = new ReadOnlyStore(store);
      var roAlloc = new TLSF64Allocator(roStore, SUPERBLOCK_SIZE, 0); // load, no init
      var roFs = new BlockFS(roStore, roAlloc, new InodeTable128(roAlloc),
        roStore.getUint32(SB_ROOT_INODE), false, FMT_V4);
      roFs._readonly = true;
      return roFs;
    }
    var storeSize = store.size();
    var formatted = false;
    if (storeSize < SUPERBLOCK_SIZE) {
      store.resize(TLSF_POOL_OFFSET64 + 65536); storeSize = store.size(); formatted = true;
    } else if (store.getUint32(SB_MAGIC) !== MAGIC || store.getUint32(SB_VERSION) !== 4) {
      formatted = true;
    }
    if (formatted) {
      if (storeSize < TLSF_POOL_OFFSET64 + 65536) { store.resize(TLSF_POOL_OFFSET64 + 65536); storeSize = store.size(); }
      store.setBytes(0, new Uint8Array(SUPERBLOCK_SIZE));
    }
    var alloc, inodeTable, fs;
    if (formatted) {
      alloc = new TLSF64Allocator(store, SUPERBLOCK_SIZE, storeSize - TLSF_POOL_OFFSET64);
      inodeTable = new InodeTable128(alloc);
      inodeTable.init(INITIAL_INODE_CAPACITY);
      fs = new BlockFS(store, alloc, inodeTable, 1, true, FMT_V4);
      fs._writeSuperblock();
      if (!(opts && opts.noDevNodes)) fs.ensureDevNodes();
      return fs;
    }
    alloc = new TLSF64Allocator(store, SUPERBLOCK_SIZE, 0); // load existing metadata
    inodeTable = new InodeTable128(alloc);
    fs = new BlockFS(store, alloc, inodeTable, store.getUint32(SB_ROOT_INODE), false, FMT_V4);
    if (!(opts && opts.noDevNodes)) fs.ensureDevNodes(); // self-heal /dev on every v4 mount (idempotent)
    return fs;
  };

  // Migration is "complete" iff bit 0 of the v4 superblock flags is set. A
  // half-written v4 image (crash mid-copy) won't have it, so a caller knows to
  // discard + retry rather than mount a partial filesystem.
  var SB_MIGRATED_BIT = 1;
  BlockFS.isMigrationComplete = function (store) {
    if (store.size() < SUPERBLOCK_SIZE) return false;
    if (store.getUint32(SB_MAGIC) !== MAGIC || store.getUint32(SB_VERSION) !== 4) return false;
    return (store.getUint32(SB_FLAGS) & SB_MIGRATED_BIT) !== 0;
  };

  // ---- sealed volumes (todos/0040) ----
  // A baked read-only blob is SEALED: superblock flags bit 1 + a SHA-256 of
  // every byte after the superblock at SB_SEAL_HASH. mkimage seals at bake
  // time; fsck_v4 recomputes and flags any post-bake mutation. Runtime mounts
  // don't verify (the ReadOnlyStore wrap prevents mutation in the first
  // place) — the seal is the OFFLINE tamper check. Superblock bytes 36..67
  // were reserved/zero before this, so old images read as unsealed.
  var SB_SEALED_BIT = 2;
  var SB_SEAL_HASH = 36;   // 32 bytes
  function sha256(bytes) {
    // WebCrypto is everywhere we run (browsers, workers, Node >= 19) — async.
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      return Promise.reject(new Error('sealVolume: WebCrypto unavailable'));
    }
    return crypto.subtle.digest('SHA-256', bytes).then(function (h) { return new Uint8Array(h); });
  }
  BlockFS.sealVolume = function (store) {
    return sha256(store.getBytes(SUPERBLOCK_SIZE, store.size() - SUPERBLOCK_SIZE))
      .then(function (hash) {
        store.setUint32(SB_FLAGS, store.getUint32(SB_FLAGS) | SB_SEALED_BIT);
        store.setBytes(SB_SEAL_HASH, hash);
        store.flush();
      });
  };
  // -> Promise<true|false|null>: intact / mutated / not sealed.
  BlockFS.verifySeal = function (store) {
    if (store.size() < SUPERBLOCK_SIZE ||
        (store.getUint32(SB_FLAGS) & SB_SEALED_BIT) === 0) return Promise.resolve(null);
    var want = store.getBytes(SB_SEAL_HASH, 32);
    return sha256(store.getBytes(SUPERBLOCK_SIZE, store.size() - SUPERBLOCK_SIZE))
      .then(function (got) {
        for (var i = 0; i < 32; i++) if (got[i] !== want[i]) return false;
        return true;
      });
  };

  // Non-destructive migrate-forward: read the v3 image, write a fresh v4 image.
  // v3store is only ever READ (never mutated) — it's the rollback. The whole tree
  // is copied via the high-level API (mkdir/write/symlink/link), preserving mode,
  // mtime/atime, and hardlinks (same src inode -> link to the first copy). On
  // success the v4 superblock's completion bit is set. Returns the mounted v4 fs.
  BlockFS.migrateV3toV4 = function (v3store, v4store) {
    var src = BlockFS.create(v3store);    // v3, read-source only
    src._readonly = true;                 // never write the source (atime etc.)
    var dst = BlockFS.createV4(v4store);  // fresh v4
    var inoMap = {};                      // src inodeId -> first dst path (hardlinks)

    function walk(srcDir, dstDir) {
      var h = src.opendir(srcDir);
      if (h === null) throw new Error('migrate: opendir ' + srcDir);
      var ent;
      while ((ent = src.readdir(h)) !== null) {
        if (ent.name === '.' || ent.name === '..') continue;
        var sp = srcDir === '/' ? '/' + ent.name : srcDir + '/' + ent.name;
        var dp = dstDir === '/' ? '/' + ent.name : dstDir + '/' + ent.name;
        var st = src.lstat(sp);               // the entry itself (don't follow links)
        var type = st.mode & S_IFMT, perm = st.mode & 0o7777;
        if (type !== S_IFDIR && inoMap[st.ino] !== undefined) {
          dst.link(inoMap[st.ino], dp); // hardlink: same inode already copied
          continue;
        }
        if (type === S_IFDIR) {
          dst.mkdir(dp, perm);
          walk(sp, dp);
          dst.chmod(dp, perm);
          dst.utime(dp, st.atime, st.mtime); // restore dir times after populating
        } else if (type === S_IFLNK) {
          // Symlink: copy the target text, recreate as a real link (not a byte copy
          // of a regular file — symlinks are a distinct inode type now).
          var lbuf = new Uint8Array(st.size > 0 ? st.size : 1);
          var ln = src.readlink(sp, lbuf, lbuf.length);
          var tgt = ln > 0 ? decodeStr(lbuf.subarray(0, ln)) : '';
          dst.symlink(tgt, dp);
          inoMap[st.ino] = dp;
        } else {
          // Regular file.
          var data = new Uint8Array(st.size);
          if (st.size > 0) { var fr = src.open(sp, 0, 0); src.read(fr, data, st.size); src.close(fr); }
          var fw = dst.open(dp, 0x40 | 0x200 | 1, perm); // O_CREAT|O_TRUNC|O_WRONLY
          if (st.size > 0) dst.write(fw, data, st.size);
          dst.close(fw);
          dst.chmod(dp, perm);
          dst.utime(dp, st.atime, st.mtime);
          inoMap[st.ino] = dp;
        }
      }
      src.closedir(h);
    }

    walk('/', '/');
    v4store.setUint32(SB_FLAGS, v4store.getUint32(SB_FLAGS) | SB_MIGRATED_BIT);
    return dst;
  };

  // =================================================================
  // MountFS (todos/0026) — mount table over N BlockFS volumes
  // =================================================================
  //
  // Delegates every path operation to the volume owning the longest matching
  // mount prefix ('/' system, '/root' user in the reference OS), prefix
  // stripped. Own fd/dir-handle namespaces map handle -> {volume, volume
  // handle} — the kernel's 'file' OFDs treat the fd as opaque, so
  // Kernel({fs: mountfs}) just works. POSIX edges: cross-volume rename/link
  // -> EXDEV (busybox mv falls back to copy+unlink); unlink/rmdir/rename
  // targeting a mount point -> EBUSY.
  //
  // Symlinks resolve in the FULL namespace: each volume gets
  // _mountPrefix/_mountOwns hooks; _walkHops resolves targets through them
  // (in-volume targets strip back to volume-relative — the fast path — and
  // foreign ones throw __mountEscape with the full-namespace continuation).
  // The _dispatch loop here catches the escape, rewrites the path argument
  // whose walk escaped (__mountFrom tells it which, including parent-dir
  // walks, which are always a prefix of their argument), and retries on the
  // owning volume — bounded by SYMLOOP_MAX like the in-volume walk. Each
  // volume stays a complete, independently fsck-able BlockFS image.
  //
  // MountFS is kernel-embedder-side only: process-side RemoteFS and the
  // standalone single-volume paths are untouched. Console stdio (fd 0-2)
  // never routes here, so read/write on 0-2 are EBADF by design.

  function MountFS(mounts) {
    // mounts: { '/': fs, '/root': fs } or [{ prefix, fs }]; '/' is required.
    var list = Array.isArray(mounts)
      ? mounts.map(function (m) { return { prefix: m.prefix, fs: m.fs }; })
      : Object.keys(mounts).map(function (p) { return { prefix: p, fs: mounts[p] }; });
    list.forEach(function (m) {
      if (m.prefix !== '/' && m.prefix.slice(-1) === '/') m.prefix = m.prefix.slice(0, -1);
      if (m.prefix.charAt(0) !== '/') throw new Error('MountFS: prefix must be absolute: ' + m.prefix);
    });
    list.sort(function (a, b) { return b.prefix.length - a.prefix.length; }); // longest first, '/' last
    if (!list.length || list[list.length - 1].prefix !== '/') {
      throw new Error('MountFS: a "/" mount is required');
    }
    this._mounts = list;
    this._cwd = '/';
    this._lastError = '';
    this._fdTable = [null, null, null];   // 0-2 reserved (stdio convention)
    this._dirTable = [];

    var self = this;
    list.forEach(function (m) {
      m.fs._mountPrefix = m.prefix;
      m.fs._mountOwns = function (full) {
        var r = self._route(full);
        return r.mount === m ? r.rel : null;
      };
    });
    // The mount-point directory must exist in the volume UNDERNEATH it so a
    // readdir of the parent lists it (no synthesis). mkdir -p, idempotent.
    list.forEach(function (m) {
      if (m.prefix === '/') return;
      var parts = m.prefix.split('/').filter(function (p) { return p; });
      var acc = '';
      for (var i = 0; i < parts.length; i++) {
        acc += '/' + parts[i];
        var under = self._routeUnder(acc);
        if (under && under.fs.lstat(under.rel) === null) under.fs.mkdir(under.rel, 0o755);
      }
    });
  }

  MountFS.prototype._setErr = function (name) {
    this._lastError = name;
    return null;
  };

  // Lexical resolve against MountFS's cwd — same logic as BlockFS._resolvePath.
  MountFS.prototype._resolvePath = function (path) {
    if (path.length > 0 && path[0] !== '/') {
      path = this._cwd + (this._cwd.endsWith('/') ? '' : '/') + path;
    }
    var parts = path.split('/');
    var resolved = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') continue;
      if (parts[i] === '..') { resolved.pop(); continue; }
      resolved.push(parts[i]);
    }
    return '/' + resolved.join('/');
  };

  // Longest-prefix route of a NORMALIZED absolute path -> { mount, fs, rel }.
  MountFS.prototype._route = function (path) {
    for (var i = 0; i < this._mounts.length; i++) {
      var m = this._mounts[i], p = m.prefix;
      if (p === '/' || path === p || path.lastIndexOf(p + '/', 0) === 0) {
        return { mount: m, fs: m.fs, rel: p === '/' ? path : (path.slice(p.length) || '/') };
      }
    }
  };

  // Route ignoring an exact-prefix match — the volume UNDERNEATH a mount
  // point (used to materialize mount-point directories in the outer volume).
  MountFS.prototype._routeUnder = function (path) {
    for (var i = 0; i < this._mounts.length; i++) {
      var m = this._mounts[i], p = m.prefix;
      if (p === path) continue;
      if (p === '/' || path === p || path.lastIndexOf(p + '/', 0) === 0) {
        return { mount: m, fs: m.fs, rel: p === '/' ? path : (path.slice(p.length) || '/') };
      }
    }
    return null;
  };

  MountFS.prototype._isMountPoint = function (path) {
    for (var i = 0; i < this._mounts.length; i++) {
      if (this._mounts[i].prefix !== '/' && this._mounts[i].prefix === path) return true;
    }
    return false;
  };

  // Run `fn(vol, rel...)` with every path routed to ONE volume, retrying on
  // cross-volume symlink escapes. opts.busyOnMount: refuse mount-point
  // arguments with EBUSY (unlink/rmdir/rename). Two-path calls that route to
  // different volumes fail EXDEV (rename/link are the only two-path ops).
  MountFS.prototype._dispatch = function (paths, opts, fn) {
    var self = this;
    for (var n = 0; n < paths.length; n++) paths[n] = this._resolvePath(String(paths[n]));
    for (var hop = 0; hop <= SYMLOOP_MAX; hop++) {
      if (opts.busyOnMount) {
        for (var b = 0; b < paths.length; b++) {
          if (this._isMountPoint(paths[b])) return this._setErr('EBUSY');
        }
      }
      var routes = paths.map(function (p) { return self._route(p); });
      if (routes.length === 2 && routes[0].mount !== routes[1].mount) {
        return this._setErr('EXDEV');
      }
      var vol = routes[0].fs;
      try {
        var r = fn.apply(null, [vol].concat(routes.map(function (m) { return m.rel; })));
        this._lastError = vol._lastError;
        return r;
      } catch (e) {
        if (!e || !e.__mountEscape) throw e;
        // Rewrite every argument whose walk (or parent-dir walk — always a
        // path prefix of the argument) escaped, then retry. Escape splicing
        // is prefix-stable: replacing the escaped prefix is exactly what the
        // walk itself would have produced for the longer path.
        var from = e.__mountFrom, to = e.__mountEscape, hit = false;
        for (var j = 0; j < paths.length; j++) {
          var rel = routes[j].rel;
          var match = rel === from ||
            (from === '/' ? true : rel.lastIndexOf(from + '/', 0) === 0);
          if (match) {
            paths[j] = this._resolvePath(from === '/' ? to + rel : to + rel.slice(from.length));
            hit = true;
          }
        }
        if (!hit) throw e; // escape from a path we never passed — a bug; surface it
      }
    }
    return this._setErr('ELOOP');
  };

  // ---- handle tables ----
  MountFS.prototype._allocFd = function (entry) {
    for (var i = 3; i < this._fdTable.length; i++) {
      if (this._fdTable[i] === null) { this._fdTable[i] = entry; return i; }
    }
    this._fdTable.push(entry);
    return this._fdTable.length - 1;
  };
  MountFS.prototype._fdEntry = function (fd) {
    if (fd < 3 || fd >= this._fdTable.length) return null;
    return this._fdTable[fd];
  };

  // ---- path operations ----
  MountFS.prototype.open = function (path, flags, mode) {
    var owner = null;
    var volFd = this._dispatch([path], {}, function (vol, rel) {
      owner = vol;
      return vol.open(rel, flags, mode);
    });
    if (volFd === null || typeof volFd !== 'number' || volFd < 0) return null;
    return this._allocFd({ vol: owner, fd: volFd });
  };

  MountFS.prototype.stat = function (path) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.stat(rel); });
  };

  // immutableKey (todos/0037): the full-namespace twin of BlockFS's — the
  // walk (with symlink escapes, so /bin/ls resolves through the /bin ->
  // /usr/bin link) decides the OWNING volume, and the key is non-null only
  // when that volume is read-only. Prefix + inode id is unique across the
  // mount table and stable for the mount's lifetime.
  MountFS.prototype.immutableKey = function (path) {
    var owner = null;
    var st = this._dispatch([path], {}, function (vol, rel) {
      owner = vol;
      return vol.stat(rel);
    });
    if (!st || !owner || !owner._readonly) return null;
    if ((st.mode & S_IFMT) !== S_IFREG) return null;
    return owner._mountPrefix + ':' + st.ino;
  };

  MountFS.prototype.lstat = function (path) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.lstat(rel); });
  };
  MountFS.prototype.access = function (path, mode) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.access(rel, mode); });
  };
  MountFS.prototype.chmod = function (path, mode) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.chmod(rel, mode); });
  };
  MountFS.prototype.utime = function (path, atime, mtime) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.utime(rel, atime, mtime); });
  };
  MountFS.prototype.readlink = function (path, buf, bufsize) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.readlink(rel, buf, bufsize); });
  };
  MountFS.prototype.mkdir = function (path, mode) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.mkdir(rel, mode); });
  };
  MountFS.prototype.mknod = function (path, mode, dev) {
    return this._dispatch([path], {}, function (vol, rel) { return vol.mknod(rel, mode, dev); });
  };
  MountFS.prototype.unlink = function (path) {
    return this._dispatch([path], { busyOnMount: true }, function (vol, rel) { return vol.unlink(rel); });
  };
  MountFS.prototype.remove = MountFS.prototype.unlink; // alias, like BlockFS
  MountFS.prototype.rmdir = function (path) {
    return this._dispatch([path], { busyOnMount: true }, function (vol, rel) { return vol.rmdir(rel); });
  };
  MountFS.prototype.rename = function (oldPath, newPath) {
    return this._dispatch([oldPath, newPath], { busyOnMount: true },
      function (vol, relOld, relNew) { return vol.rename(relOld, relNew); });
  };
  MountFS.prototype.link = function (oldPath, newPath) {
    return this._dispatch([oldPath, newPath], {},
      function (vol, relOld, relNew) { return vol.link(relOld, relNew); });
  };
  MountFS.prototype.symlink = function (target, linkPath) {
    // Only linkPath routes; the target is opaque text stored verbatim
    // (full-namespace by convention — that's the point of the escape walk).
    return this._dispatch([linkPath], {}, function (vol, rel) { return vol.symlink(target, rel); });
  };

  MountFS.prototype.opendir = function (path) {
    var owner = null;
    var volH = this._dispatch([path], {}, function (vol, rel) {
      owner = vol;
      return vol.opendir(rel);
    });
    if (volH === null || typeof volH !== 'number' || volH < 0) return null;
    for (var i = 0; i < this._dirTable.length; i++) {
      if (this._dirTable[i] === null) { this._dirTable[i] = { vol: owner, h: volH }; return i; }
    }
    this._dirTable.push({ vol: owner, h: volH });
    return this._dirTable.length - 1;
  };
  MountFS.prototype.readdir = function (handle) {
    var d = (handle >= 0 && handle < this._dirTable.length) ? this._dirTable[handle] : null;
    if (!d) return this._setErr('EBADF');
    var r = d.vol.readdir(d.h);
    this._lastError = d.vol._lastError;
    return r;
  };
  MountFS.prototype.closedir = function (handle) {
    var d = (handle >= 0 && handle < this._dirTable.length) ? this._dirTable[handle] : null;
    if (!d) return this._setErr('EBADF');
    var r = d.vol.closedir(d.h);
    this._lastError = d.vol._lastError;
    this._dirTable[handle] = null;
    return r;
  };

  MountFS.prototype.getcwd = function () { return this._cwd; };
  // Physical realpath over the full mount namespace — each lstat/readlink hop
  // routes by longest prefix, so a symlink crossing a mount (/bin -> /usr/bin,
  // /usr/local -> /var/local) resolves correctly. See physicalRealpath. (0263)
  MountFS.prototype.realpathPhysical = function (path) { return physicalRealpath(this, path); };
  MountFS.prototype.chdir = function (path) {
    var resolved = this._resolvePath(String(path));
    var st = this.stat(resolved);
    if (st === null) return null; // _lastError set by stat
    if ((st.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');
    this._cwd = resolved;
    return 0;
  };

  // ---- fd operations (delegate through the fd map) ----
  MountFS.prototype._fdOp = function (fd, fn) {
    var e = this._fdEntry(fd);
    if (!e) return this._setErr('EBADF');
    var r = fn(e.vol, e.fd);
    this._lastError = e.vol._lastError;
    return r;
  };
  MountFS.prototype.read = function (fd, buf, count) {
    return this._fdOp(fd, function (vol, vfd) { return vol.read(vfd, buf, count); });
  };
  MountFS.prototype.write = function (fd, buf, count) {
    return this._fdOp(fd, function (vol, vfd) { return vol.write(vfd, buf, count); });
  };
  MountFS.prototype.lseek = function (fd, offset, whence) {
    return this._fdOp(fd, function (vol, vfd) { return vol.lseek(vfd, offset, whence); });
  };
  MountFS.prototype.fstat = function (fd) {
    return this._fdOp(fd, function (vol, vfd) { return vol.fstat(vfd); });
  };
  MountFS.prototype.ftruncate = function (fd, size) {
    return this._fdOp(fd, function (vol, vfd) { return vol.ftruncate(vfd, size); });
  };
  MountFS.prototype.fchmod = function (fd, mode) {
    return this._fdOp(fd, function (vol, vfd) { return vol.fchmod(vfd, mode); });
  };
  MountFS.prototype.futime = function (fd, atime, mtime) {
    return this._fdOp(fd, function (vol, vfd) { return vol.futime(vfd, atime, mtime); });
  };
  MountFS.prototype.fsync = function (fd) {
    return this._fdOp(fd, function (vol, vfd) { return vol.fsync(vfd); });
  };
  MountFS.prototype.close = function (fd) {
    var e = this._fdEntry(fd);
    if (!e) return this._setErr('EBADF');
    var r = e.vol.close(e.fd);
    this._lastError = e.vol._lastError;
    this._fdTable[fd] = null;
    return r;
  };
  MountFS.prototype.dup = function (fd) {
    var e = this._fdEntry(fd);
    if (!e) return this._setErr('EBADF');
    var nf = e.vol.dup(e.fd);
    this._lastError = e.vol._lastError;
    if (nf === null || typeof nf !== 'number' || nf < 0) return null;
    return this._allocFd({ vol: e.vol, fd: nf });
  };
  MountFS.prototype.fcntl_dupfd = function (fd, minfd) {
    var e = this._fdEntry(fd);
    if (!e) return this._setErr('EBADF');
    var nf = e.vol.dup(e.fd);
    this._lastError = e.vol._lastError;
    if (nf === null || typeof nf !== 'number' || nf < 0) return null;
    if (minfd < 3) minfd = 3; // 0-2 reserved in the mount namespace
    while (this._fdTable.length < minfd) this._fdTable.push(null);
    for (var i = minfd; i < this._fdTable.length; i++) {
      if (this._fdTable[i] === null) { this._fdTable[i] = { vol: e.vol, fd: nf }; return i; }
    }
    this._fdTable.push({ vol: e.vol, fd: nf });
    return this._fdTable.length - 1;
  };
  MountFS.prototype.isatty = function (fd) {
    return fd >= 0 && fd <= 2 ? 1 : 0; // stdio convention, like BlockFS
  };

  // =================================================================
  // Module exports
  // =================================================================

  return {
    init: BlockFS.init,
    openWorkspace: BlockFS.openWorkspace,
    create: BlockFS.create,
    createV4: BlockFS.createV4,
    migrateV3toV4: BlockFS.migrateV3toV4,
    isMigrationComplete: BlockFS.isMigrationComplete,
    sealVolume: BlockFS.sealVolume,
    verifySeal: BlockFS.verifySeal,
    // The class itself: kernel.js's RemoteFS reuses BlockFS.prototype
    // .toWasmEnv over its RPC-backed method surface (todos/0009).
    BlockFS: BlockFS,
    MountFS: MountFS,
    MemoryByteStore: MemoryByteStore,
    ReadOnlyStore: ReadOnlyStore,
    SabByteStore: SabByteStore,
    storeToSab: storeToSab,
    SyncAccessHandleStore: SyncAccessHandleStore,
    TLSFAllocator: TLSFAllocator,
    TLSF64Allocator: TLSF64Allocator,
    // The synchronous sleep primitive (Atomics.wait on a never-notified
    // cell) + its availability probe. The SDL flavors reuse it for
    // SDL_Delay wherever blocking is legal (workers, Node) — see
    // createNullSDL / createSurfaceSDL — so there is ONE blocking-sleep
    // implementation, shared with usleep/nanosleep above.
    blockingSleepMs: blockingSleepMs,
    canBlockSync: function () { return _canBlock; },
  };
})();

/**
 * Create POSIX WASM imports backed by Node.js APIs.
 * Environment variables are NOT handled here — `environ` lives in wasm memory
 * (the libc owns it), seeded by the host via instance.exports.__set_environ
 * after instantiation. This provides only getpid.
 * @param {object} options
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createPosix({ ctx }) {
  const pid = (ctx && ctx.pid != null) ? ctx.pid : process.pid;
  const ppid = (ctx && ctx.ppid != null) ? ctx.ppid
    : (typeof process.ppid === 'number' ? process.ppid : 0);
  const livePpid = ctx && ctx.getppid;   // vDSO read (todos/0179): reparent-aware
  return {
    [ENV_KEY]: {
      getpid: function () { return pid; },
      getppid: function () {
        if (livePpid) { const v = livePpid(); if (v != null) return v; }
        return ppid;
      },
    },
  };
}

/**
 * Create POSIX WASM imports for the browser environment.
 * Environment variables are NOT handled here (see createPosix) — they live in
 * wasm memory and are seeded via __set_environ. This provides only getpid.
 * @param {object} options
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createBrowserPosix({ ctx }) {
  // The runtime-minted pid for THIS process (the owner kernel passes it per run);
  // ppid is its spawner (0 for a top-level run). Fallback 1/0 keeps single-run
  // callers that don't thread ids working.
  const pid = (ctx && ctx.pid != null) ? ctx.pid : 1;
  const ppid = (ctx && ctx.ppid != null) ? ctx.ppid : 0;
  const livePpid = ctx && ctx.getppid;   // vDSO read (todos/0179): reparent-aware
  return {
    [ENV_KEY]: {
      getpid: function () { return pid; },
      getppid: function () {
        if (livePpid) { const v = livePpid(); if (v != null) return v; }
        return ppid;
      },
    },
  };
}


/**
 * Create no-op SDL imports so a wasm module that imports __sdl_* can
 * instantiate in environments that have no display (Node, headless
 * runners). Every function returns a safe sentinel: 0 (failure-like),
 * an unused handle, or void. SDL_Init returns 0 (success) so programs
 * that bail out on init failure still run; everything else is inert.
 * Used by run-unit.js and the Node CLI entry point.
 * @returns {{[k:string]: object}}
 */
// ---- Process model: posix_spawn host imports (mirrors the SDL seam) ----
//
// Three imports back the C posix_spawn/system/popen/waitpid/kill family. The
// runtime that can actually create processes (the c/ app's owner worker) passes
// `spawnHooks` into runModule; without it, createNullSpawn makes the imports
// resolve to ENOSYS so any module that links __spawn still instantiates (the
// createNullSDL discipline).
//
// Field offsets (wasm32, all i32): __fd_action {op@0,fd@4,arg@8,path@12,mode@16}
// = 20 bytes; __spawn_spec {path@0,argv@4,envp@8,cwd@12,actions@16,n_actions@20,
// flags@24,pgid@28,trace@32} = 36 bytes. `trace` (todos/0046) is read ONLY
// under flags bit1 (__SPAWN_TRACE) — binaries built against the 32-byte spec
// never set that bit, so the extra read can't pick up their stack garbage.
function readSpawnSpec(ctx, p) {
  // Read the whole struct in one synchronous burst — never hold a DataView
  // across anything that could grow/detach memory.
  const dv = new DataView(ctx.getMemory().buffer);
  const i32 = (off) => dv.getInt32(p + off, true);
  const u32 = (off) => dv.getUint32(p + off, true);
  const readStr = (ptr) => (ptr ? ctx.readString(ptr) : null);

  const path = readStr(u32(0));
  if (path === null) throw new Error('spawn: null path');

  // argv / envp: NULL-terminated i32 arrays of char* (null envp => inherit).
  function readStrVec(ptr) {
    if (!ptr) return null;
    const out = [];
    const mem = new DataView(ctx.getMemory().buffer);
    for (let i = 0; ; i++) {
      const s = mem.getUint32(ptr + i * 4, true);
      if (s === 0) break;
      out.push(ctx.readString(s));
    }
    return out;
  }
  const argv = readStrVec(u32(4)) || [];
  const envp = readStrVec(u32(8)); // null => inherit (resolved by the hook)
  const cwd = readStr(u32(12));

  // file_actions: n × 20 bytes.
  const actionsPtr = u32(16);
  const nActions = i32(20);
  const actions = [];
  for (let k = 0; k < nActions; k++) {
    const base = actionsPtr + k * 20;
    actions.push({
      op: dv.getInt32(base + 0, true),
      fd: dv.getInt32(base + 4, true),
      arg: dv.getInt32(base + 8, true),
      path: readStr(dv.getUint32(base + 12, true)),
      mode: dv.getInt32(base + 16, true),
    });
  }
  const flags = u32(24);
  return { path, argv, envp, cwd, actions, flags, pgid: i32(28),
           trace: (flags & 2) ? i32(32) : -1 };
}

// hooks: { spawn(spec)->{pid}|{errno}, wait(pid,options)->{pid,status}|{errno},
//          kill(pid,sig)->{}|{errno} }. spawn/wait block the worker thread
// (return synchronously to C) — in the run worker that's a park on Atomics.wait
// over the block-RPC SAB, so posix_spawn's synchronous contract is JSPI-free.
function createSpawn(ctx, hooks) {
  const env = {
      __spawn: function (p) {
        let spec;
        try { spec = readSpawnSpec(ctx, p); }
        catch (e) { ctx.setErrnoName('EFAULT'); return -1; }
        const r = hooks.spawn(spec);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        return r.pid;
      },
      __spawn_wait: function (pid, statusPtr, options) {
        for (;;) {
          const r = hooks.wait(pid, options);
          if (r && r.errno) {
            // EINTR: run the interrupting handlers NOW (this is the safe
            // point); transparently restart the wait when every delivered
            // action carried SA_RESTART. deliverSignals: null = nothing ran
            // (don't spin), true = all restartable, false = EINTR surfaces.
            if (r.errno === 'EINTR' && ctx.deliverSignals) {
              if (ctx.deliverSignals() === true) continue;
            }
            ctx.setErrnoName(r.errno); return -1;
          }
          if (statusPtr) {
            new DataView(ctx.getMemory().buffer).setInt32(statusPtr, r.status | 0, true);
          }
          return r.pid;
        }
      },
      __spawn_kill: function (pid, sig) {
        const r = hooks.kill(pid, sig);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        return 0;
      },
      // Process groups (libc setpgid/getpgid/getpgrp — landed with the
      // shell port, todos/0005; the kernel RPCs existed since Phase 1).
      __spawn_setpgid: function (pid, pgid) {
        if (!hooks.setpgid) { ctx.setErrnoName('ENOSYS'); return -1; }
        const r = hooks.setpgid(pid, pgid);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        return 0;
      },
      __spawn_getpgid: function (pid) {
        if (!hooks.getpgid) { ctx.setErrnoName('ENOSYS'); return -1; }
        const r = hooks.getpgid(pid);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        return r.pgid | 0;
      },
      // libc setsid() (todos/0179 — the SETSID RPC existed since Phase 1;
      // the C surface landed with the vDSO page's mutation-visibility test).
      __spawn_setsid: function () {
        if (!hooks.setsid) { ctx.setErrnoName('ENOSYS'); return -1; }
        const r = hooks.setsid();
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        return r.sid | 0;
      },
      // libc getsid() (todos/0043 — pgrep -s 0 resolves its own session).
      __spawn_getsid: function (pid) {
        if (!hooks.getsid) { ctx.setErrnoName('ENOSYS'); return -1; }
        const r = hooks.getsid(pid);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        return r.sid | 0;
      },
      // Interval timers (todos/0044): the kernel owns ONE ITIMER_REAL per
      // process; ms over the wire (the libc converts timeval <-> ms). The
      // old/current value comes back through out[2] = {value_ms, interval_ms}.
      __setitimer: function (which, valueMs, intervalMs, outPtr) {
        if (!hooks.setitimer) { ctx.setErrnoName('ENOSYS'); return -1; }
        const r = hooks.setitimer(which | 0, valueMs | 0, intervalMs | 0);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        if (outPtr) {
          const dv = new DataView(ctx.getMemory().buffer);
          dv.setUint32(outPtr, r.valueMs >>> 0, true);
          dv.setUint32(outPtr + 4, r.intervalMs >>> 0, true);
        }
        return 0;
      },
      __getitimer: function (which, outPtr) {
        if (!hooks.getitimer) { ctx.setErrnoName('ENOSYS'); return -1; }
        const r = hooks.getitimer(which | 0);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        if (outPtr) {
          const dv = new DataView(ctx.getMemory().buffer);
          dv.setUint32(outPtr, r.valueMs >>> 0, true);
          dv.setUint32(outPtr + 4, r.intervalMs >>> 0, true);
        }
        return 0;
      },
      // Mirror a signal-disposition change to the kernel so kill() applies the
      // right action (terminate only when the target left the signal at DFL).
      __on_sigdisp: function (sig, kind) { if (hooks.sigdisp) hooks.sigdisp(sig, kind); },
      // Run the host's in-browser compiler (no wasm image to exec). Reads cwd +
      // NULL-terminated argv from memory, calls the kernel's compile hook
      // (synchronous from C — the worker parks on the SAB), and packs the result
      // into the caller's buffer: i32 exitCode, i32 outLen, i32 errLen, then the
      // stdout and stderr bytes. The program (/bin/cc) writes those to its own
      // fd1/fd2, so the output flows through normal fd inheritance.
      __compile: function (cwdPtr, argvPtr, bufPtr, cap) {
        if (!hooks.compile) { ctx.setErrnoName('ENOSYS'); return -1; }
        const cwd = cwdPtr ? ctx.readString(cwdPtr) : '/';
        const argv = [];
        {
          const mem = new DataView(ctx.getMemory().buffer);
          for (let i = 0; ; i++) {
            const s = mem.getUint32(argvPtr + i * 4, true);
            if (s === 0) break;
            argv.push(ctx.readString(s));
          }
        }
        const r = hooks.compile(argv, cwd);
        if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
        const enc = new TextEncoder();
        const out = enc.encode(r.stdout || '');
        const err = enc.encode(r.stderr || '');
        const total = 12 + out.length + err.length;
        if (total > cap) { ctx.setErrnoName('ENOMEM'); return -1; }
        const dv = new DataView(ctx.getMemory().buffer);
        dv.setInt32(bufPtr, r.exitCode | 0, true);
        dv.setInt32(bufPtr + 4, out.length, true);
        dv.setInt32(bufPtr + 8, err.length, true);
        const m = new Uint8Array(ctx.getMemory().buffer);
        m.set(out, bufPtr + 12);
        m.set(err, bufPtr + 12 + out.length);
        return total;
      },
      // Mirror the libc blocked mask onto the kernel page (kernel.js honors
      // it for default actions; sigpoll leaves blocked bits pending), then
      // deliver anything that just became claimable — this is the unblock
      // half of sigprocmask/sigsuspend.
      __on_sigmask: function (mask) {
        if (hooks.sigmask) hooks.sigmask(mask >>> 0);
        if (ctx.deliverSignals) ctx.deliverSignals();
      },
      // pause()/sigsuspend() backend: park on the kernel doorbell until a
      // signal is deliverable, run its handlers, and only then return (the
      // libc surfaces EINTR). Loops on spurious wakes where another safe
      // point raced the claim.
      __sig_pause: function () {
        if (!hooks.park) { ctx.setErrnoName('ENOSYS'); return -1; }
        for (;;) {
          hooks.park();
          if (!ctx.deliverSignals) return 0;
          if (ctx.deliverSignals() !== null) return 0;
        }
      },
  };
  // ---- Phase 3 tty control plane: termios/pgrp syscalls become kernel RPCs
  // (the line discipline lives in kernel.js's Tty). struct termios layout
  // (must match <termios.h>): iflag@0 oflag@4 cflag@8 lflag@12, cc[20]@16,
  // ispeed@36 ospeed@40. Without these hooks the BlockFS/node-fs defaults
  // (canned values) stay in effect — createSpawn merges later and wins.
  if (hooks.ttyGetattr) {
    // The fd passes through to the kernel since 0020 (ptys): it resolves
    // which tty the fd names (pty slave/master vs the system tty) through
    // the caller's fd table — shells hold the tty on high dup'd fds (hush
    // parks it at 255), so no fd gate here.
    env.__tty_getattr = function (fd, tPtr) {
      if (fd < 0) { ctx.setErrnoName('EBADF'); return -1; }
      const r = hooks.ttyGetattr(fd);
      if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
      const dv = new DataView(ctx.getMemory().buffer);
      dv.setUint32(tPtr, r.iflag >>> 0, true);
      dv.setUint32(tPtr + 4, r.oflag >>> 0, true);
      dv.setUint32(tPtr + 8, r.cflag >>> 0, true);
      dv.setUint32(tPtr + 12, r.lflag >>> 0, true);
      const m = new Uint8Array(ctx.getMemory().buffer);
      for (let i = 0; i < 20; i++) m[tPtr + 16 + i] = (r.cc && r.cc[i]) | 0;
      dv.setUint32(tPtr + 36, 0, true);
      dv.setUint32(tPtr + 40, 0, true);
      return 0;
    };
    env.__tty_setattr = function (fd, actions, tPtr) {
      if (fd < 0) { ctx.setErrnoName('EBADF'); return -1; }
      const dv = new DataView(ctx.getMemory().buffer);
      const m = new Uint8Array(ctx.getMemory().buffer);
      const r = hooks.ttySetattr(fd, actions, {
        iflag: dv.getUint32(tPtr, true),
        oflag: dv.getUint32(tPtr + 4, true),
        cflag: dv.getUint32(tPtr + 8, true),
        lflag: dv.getUint32(tPtr + 12, true),
        cc: Array.from(m.subarray(tPtr + 16, tPtr + 36)),
      });
      if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
      return 0;
    };
    // The kernel resolves the fd through the caller's fd table (0020);
    // fds it can't resolve fall back to the process's attached tty, which
    // keeps hush's high dup'd tty fd (255) working (todos/0005).
    env.__tty_getpgrp = function (fd) {
      if (fd < 0) { ctx.setErrnoName('EBADF'); return -1; }
      const r = hooks.ttyGetpgrp(fd);
      if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
      return r.pgid;
    };
    env.__tty_setpgrp = function (fd, pgid) {
      if (fd < 0) { ctx.setErrnoName('EBADF'); return -1; }
      const r = hooks.ttySetpgrp(fd, pgid);
      if (r && r.errno) { ctx.setErrnoName(r.errno); return -1; }
      return 0;
    };
  }
  // With a kernel doorbell available, sleeps become interruptible: park on
  // the doorbell (any posted signal rings it), deliver, and report the
  // interruption the way each API wants it. These override the BlockFS env
  // versions (createSpawn merges later in runModule).
  if (hooks.park) {
    env.sleep = function (seconds) {
      const ms = seconds * 1000;
      const start = Date.now();
      if (hooks.park(ms) === 'signal') {
        if (ctx.deliverSignals) ctx.deliverSignals();
        const left = Math.ceil((ms - (Date.now() - start)) / 1000);
        return left > 0 ? left : 0;   // sleep(): seconds left unslept
      }
      return 0;
    };
    env.usleep = function (usec) {
      if (hooks.park(usec / 1000) === 'signal') {
        if (ctx.deliverSignals) ctx.deliverSignals();
        ctx.setErrnoName('EINTR');
        return -1;
      }
      return 0;
    };
    env.__nanosleep = function (sec, nsec) {
      if (hooks.park(sec * 1000 + nsec / 1e6) === 'signal') {
        if (ctx.deliverSignals) ctx.deliverSignals();
        ctx.setErrnoName('EINTR');   // rem not reported (documented in KERNEL.md)
        return -1;
      }
      return 0;
    };
  }
  return { [ENV_KEY]: env };
}

function createNullSpawn(ctx) {
  const enosys = function () { ctx.setErrnoName('ENOSYS'); return -1; };
  // __on_sigdisp/__on_sigmask are no-ops without a kernel — dispositions and
  // the mask are still recorded libc-side for raise()/abort(); there's just
  // no owner to mirror to. __sig_pause reports ENOSYS so pause() never hangs.
  return { [ENV_KEY]: {
    __spawn: enosys, __spawn_wait: enosys, __spawn_kill: enosys,
    __spawn_setpgid: enosys, __spawn_getpgid: enosys, __spawn_getsid: enosys,
    __spawn_setsid: enosys,
    __on_sigdisp: function () {}, __on_sigmask: function () {},
    __sig_pause: enosys, __compile: enosys,
    __setitimer: enosys, __getitimer: enosys,   // timers live in the kernel (0044)
  } };
}

/* Bulk chunk for the hook-framed RAW staging lanes (clipboard __clip_set,
   http request bodies). The kernel owns its page layout, so the value is
   derived THERE (kernel.js KP_HOOK_CHUNK, from KP_PAYLOAD_CAP) and rides the
   spawnHooks seam as hooks.payloadChunk — host.js deliberately does not
   restate the kernel-page layout (todos/0235). Only consulted when a kernel
   lane is actually live, and then the field is REQUIRED: kernel.js and
   host.js ship from one tree, so a missing field is version skew — fail
   loud rather than chunk on a stale guess. */
function hookPayloadChunk(hooks) {
  const n = hooks && hooks.payloadChunk;
  if (!(n > 0)) {
    throw new Error('spawnHooks.payloadChunk missing — kernel.js/host.js out of sync (todos/0235)');
  }
  return n | 0;
}

/* ---- System clipboard (todos/0090) ----
   __clip_set(fmt, ptr, len) / __clip_get(fmt, ptr, cap): the C-visible
   primitives under SDL_SetClipboardText/SDL_GetClipboardText (__SDL.c) and
   the win32 veneer's clipboard API. Kernel-backed when spawnHooks carry
   clipSet/clipGet — ONE system-wide slot, so copy/paste crosses processes
   and survives the writer exiting. Otherwise (standalone pages, embedder
   kernels predating the ops — detected by ENOSYS) a process-local slot with
   identical semantics, the two-transports-one-fs pattern. fmt 1 = UTF-8
   text; fmt 0 clears. __clip_get returns the TOTAL byte length (filling at
   most cap bytes) or -1 when empty / stored format differs — the C side
   sizes with cap 0, then reads, retrying if the slot grew in between. */
function createClipboard(ctx, hooks) {
  let kernelized = !!(hooks && typeof hooks.clipSet === 'function' &&
                      typeof hooks.clipGet === 'function');
  const CHUNK = kernelized ? hookPayloadChunk(hooks) : 0;   // unused local-slot side
  let local = null;                // {fmt, bytes} fallback slot
  return { [ENV_KEY]: {
    __clip_set: function (fmt, ptr, len) {
      fmt >>>= 0; len >>>= 0;
      const bytes = new Uint8Array(ctx.getMemory().buffer).slice(ptr, ptr + len);
      while (kernelized) {
        let off = 0;
        for (;;) {
          const n = Math.min(bytes.length - off, CHUNK);
          const last = off + n >= bytes.length ? 1 : 0;
          const payload = new Uint8Array(12 + n);
          const dv = new DataView(payload.buffer);
          dv.setUint32(0, fmt, true);
          dv.setUint32(4, last, true);
          dv.setUint32(8, off, true);
          payload.set(bytes.subarray(off, off + n), 12);
          const r = hooks.clipSet(payload);
          if (r && r.errno) {
            if (r.errno === 'ENOSYS') { kernelized = false; break; }
            ctx.setErrnoName(r.errno);
            return -1;
          }
          off += n;
          if (last) return 0;
        }
      }
      local = (fmt && bytes.length) ? { fmt: fmt, bytes: bytes } : null;
      return 0;
    },
    __clip_get: function (fmt, ptr, cap) {
      fmt >>>= 0; cap >>>= 0;
      while (kernelized) {
        let off = 0;
        for (;;) {
          const r = hooks.clipGet(fmt, off);
          if (r && r.errno === 'ENOSYS') { kernelized = false; break; }
          if (!r || r.errno || !r.raw || r.raw.length < 4) return -1;
          const dv = new DataView(r.raw.buffer, r.raw.byteOffset, r.raw.length);
          const total = dv.getInt32(0, true);
          if (total < 0) return -1;
          const chunk = r.raw.subarray(4);
          const want = Math.min(cap, total) - off;
          if (want <= 0 || chunk.length === 0) return total;
          const take = Math.min(want, chunk.length);
          new Uint8Array(ctx.getMemory().buffer).set(chunk.subarray(0, take), ptr + off);
          off += take;
          if (off >= Math.min(cap, total)) return total;
        }
      }
      if (!local || local.fmt !== fmt) return -1;
      const n = Math.min(cap, local.bytes.length);
      if (n > 0) new Uint8Array(ctx.getMemory().buffer).set(local.bytes.subarray(0, n), ptr);
      return local.bytes.length;
    },
  } };
}

/* ---- HTTP transport (todos/0172) ----
   The C-visible primitive under the libcurl veneer (0173) and /bin/code
   (0174). Kernel-backed via spawnHooks (fetch runs kernel-side; the process
   streams the body through the doorbell under backpressure). No kernel (a
   standalone page, or an embedder predating the 0x06xx ops — detected by
   ENOSYS) means no network: __http_open returns -1/ENOSYS, fail-loud, the
   two-transports-one-fs precedent. Blocking by construction — every call
   parks the worker on the doorbell like any other RPC.

   Surface (all pointers are into wasm memory; strings are NUL-terminated):
     __http_open(method, url, headers, body, blen) -> id>0 | -1
        headers: "Name: Value\n"-joined lines (or ""); body/blen optional.
     __http_status(id, status_out, hdr, hdr_cap) -> total header bytes | -1
        writes the numeric status to *status_out; copies min(total,hdr_cap).
     __http_read(id, buf, cap) -> n>0 | 0 (EOF) | -1 (error)
     __http_close(id) -> 0
   The veneer maps curl_easy_perform onto open -> status (feeds
   HEADERFUNCTION) -> read loop (feeds WRITEFUNCTION) -> close. */
function createHttp(ctx, hooks) {
  const have = !!(hooks && typeof hooks.httpOpen === 'function');
  const CHUNK = have ? hookPayloadChunk(hooks) : 0;   // unused on the ENOSYS side
  const enc = new TextEncoder();
  return { [ENV_KEY]: {
    __http_open: function (methodPtr, urlPtr, headersPtr, bodyPtr, blen) {
      if (!have) { ctx.setErrnoName('ENOSYS'); return -1; }
      const method = methodPtr ? ctx.readString(methodPtr) : 'GET';
      const url = urlPtr ? ctx.readString(urlPtr) : '';
      const hdrRaw = headersPtr ? ctx.readString(headersPtr) : '';
      const headers = hdrRaw.split('\n').map((s) => s.trim()).filter((s) => s.length);
      blen = blen >>> 0;
      // Stage the request body in page-sized chunks (contiguous, off 0 first).
      if (blen) {
        const body = new Uint8Array(ctx.getMemory().buffer).slice(bodyPtr, bodyPtr + blen);
        let off = 0;
        while (off < blen) {
          const n = Math.min(blen - off, CHUNK);
          const payload = new Uint8Array(4 + n);
          new DataView(payload.buffer).setUint32(0, off, true);
          payload.set(body.subarray(off, off + n), 4);
          const r = hooks.httpBody(payload);
          if (r && r.errno) { ctx.setErrnoName(r.errno === 'ENOSYS' ? 'ENOSYS' : r.errno); return -1; }
          off += n;
        }
      }
      const r = hooks.httpOpen({ method, url, headers });
      if (r && r.errno) { ctx.setErrnoName(r.errno === 'ENOSYS' ? 'ENOSYS' : r.errno); return -1; }
      return r && r.id ? r.id : -1;
    },
    __http_status: function (id, statusOut, hdrPtr, hdrCap) {
      if (!have) { ctx.setErrnoName('ENOSYS'); return -1; }
      const r = hooks.httpStatus(id | 0);
      if (!r || r.errno) {
        // The C surface only sees errno; keep the transport's real error text
        // visible (a bare CURLE_COULDNT_CONNECT hid the ticket-#78 TypeError).
        if (r && r.error) console.error('__http_status: transfer failed:', r.error);
        ctx.setErrnoName((r && r.errno) || 'EIO'); return -1;
      }
      if (statusOut) new DataView(ctx.getMemory().buffer).setInt32(statusOut, r.status | 0, true);
      const hb = enc.encode(r.headers || '');
      const n = Math.min(hdrCap >>> 0, hb.length);
      if (n > 0 && hdrPtr) new Uint8Array(ctx.getMemory().buffer).set(hb.subarray(0, n), hdrPtr);
      return hb.length;
    },
    __http_read: function (id, buf, cap) {
      if (!have) { ctx.setErrnoName('ENOSYS'); return -1; }
      const r = hooks.httpRead(id | 0, cap >>> 0);
      if (r && r.errno) {
        if (r.errno === 'EINTR') { ctx.setErrnoName('EINTR'); return -1; }
        if (r.error) console.error('__http_read: transfer failed:', r.error);
        ctx.setErrnoName(r.errno); return -1;
      }
      const raw = r && r.raw ? r.raw : new Uint8Array(0);
      const n = Math.min(cap >>> 0, raw.length);
      if (n > 0 && buf) new Uint8Array(ctx.getMemory().buffer).set(raw.subarray(0, n), buf);
      return n;                        // 0 = clean EOF
    },
    __http_close: function (id) {
      if (have) hooks.httpClose(id | 0);
      return 0;
    },
  } };
}

// A blocking SDL loop (while(running){ poll; render; SDL_Delay; }) can't be
// honoured in the STANDALONE BROWSER runtime (createBrowserSDL): the app runs
// every program through the synchronous, no-JSPI block-FS model, the frame
// loop is rAF-driven (main() must return so the callback model can pace it),
// and input/presents ride the worker's message loop — a main() that never
// returns starves them no matter how SDL_Delay itself is implemented. So that
// flavor throws this rather than freezing silently, and the same throw backs
// any context where the thread genuinely cannot block (a browser main
// thread — Atomics.wait is illegal there).
//
// Everywhere blocking IS legal the classic loop is FIRST-CLASS (todos/0224):
// OS processes run in workers, where SDL_Delay is a cooperative pumpWait
// sleep — input keeps draining into the wasm event queue and the compositor
// may park while the app dawdles (createSurfaceSDL's sdlDelay); headless
// standalone runs block outright like usleep (createNullSDL). Only the
// standalone-browser callback model keeps the restructure requirement,
// because there the constraint is real.
function sdlDelayUnsupported() {
  throw new Error(
    'SDL_Delay() is not supported in this runtime (no JSPI, cannot block). A ' +
    'blocking SDL loop cannot yield to the browser here, so the window never ' +
    'updates and input never arrives. Restructure to the callback model: move ' +
    'your per-frame work into a function and register it with ' +
    'emscripten_set_main_loop(frame, 0, 1) (or __setAnimationFrameFunc(frame)), ' +
    'then return from main(). The host drives that via requestAnimationFrame — ' +
    'no JSPI, works on every engine including Safari/iOS. (Under the OS, ' +
    'SDL_Delay works: processes run in workers where blocking is legal.)'
  );
}

// SDL_AudioStream get-callback (pull) mode: passing a non-NULL callback to
// SDL_OpenAudioDeviceStream tells SDL to call it from its own audio thread to
// PULL samples. There is no audio thread here (Web Audio is driven from the main
// thread), so this can't be honoured — fail loud rather than silently behave as
// push mode and play silence. Mirrors sdlDelayUnsupported: explain why + the
// supported alternative.
function sdlAudioGetCallbackUnsupported() {
  throw new Error(
    'SDL_OpenAudioDeviceStream was given a non-NULL get-callback (pull mode), ' +
    'which is not supported in this runtime: there is no SDL audio thread to ' +
    'invoke it (audio is driven from the main thread via Web Audio). Pass a NULL ' +
    'callback and push samples yourself with SDL_PutAudioStreamData (push mode), ' +
    'which this runtime backs with a SharedArrayBuffer ring into Web Audio.'
  );
}

function createNullSDL() {
  let animationFrameFunc = null;
  let sdlTicksBase = null;   // ms baseline captured at SDL_Init (see __sdl_get_ticks)
  const nullTextures = [];   // 1-based; tracks per-texture state observable headless
                             // (scale mode), so the C↔host contract is testable
                             // without a GPU. Same fail-loud rules as createBrowserSDL.
  return {
    getAnimationFrameFunc: function () { return animationFrameFunc; },
    [ENV_KEY]: {
      __sdl_init: function () { sdlTicksBase = Date.now(); return 0; },
      __sdl_quit: function () { animationFrameFunc = null; },
      __sdl_create_window: function () { return 1; },
      __sdl_destroy_window: function () {},
      __sdl_set_window_title: function () {},
      __sdl_set_relative_mouse_mode: function () {},
      __sdl_set_cursor: function () {},                   // no display (todos/0105)
      __sdl_set_window_size: function () { return -1; },  // no window system to resize
      // Anchored popups + display bounds are OS-WM concepts (todos/0256):
      // no window system here -> clean failure, the C side sets SDL errors.
      __sdl_create_popup_window: function () { return 0; },
      __sdl_get_display_bounds: function () { return 0; },
      __sdl_update_window_surface: function () { return 0; },
      __sdl_create_renderer: function () { return 1; },
      __sdl_destroy_renderer: function () {},
      __sdl_create_texture: function () { nullTextures.push({ scaleMode: 1, blendMode: 0 }); return nullTextures.length; },  // SDL3 default LINEAR; blend set by C
      __sdl_destroy_texture: function (t) { if (t > 0 && nullTextures[t - 1]) nullTextures[t - 1] = null; },
      __sdl_update_texture: function () {},
      __sdl_set_texture_color_mod: function () {},
      __sdl_set_texture_alpha_mod: function () {},
      __sdl_set_texture_blend_mode: function (t, mode) {
        if (mode !== 0 && mode !== 1 && mode !== 2 && mode !== 4) throw new Error('SDL: unsupported blend mode ' + mode + ' (supported: NONE=0, BLEND=1, ADD=2, MOD=4)');
        const tx = nullTextures[t - 1]; if (tx) tx.blendMode = mode;
      },
      __sdl_get_texture_blend_mode: function (t) {
        const tx = nullTextures[t - 1]; return tx ? tx.blendMode : 0;
      },
      __sdl_set_texture_scale_mode: function (t, mode) {
        if (mode !== 0 && mode !== 1) throw new Error('SDL: unsupported scale mode ' + mode + ' (supported: NEAREST=0, LINEAR=1)');
        const tx = nullTextures[t - 1]; if (tx) tx.scaleMode = mode;
      },
      __sdl_get_texture_scale_mode: function (t) {
        const tx = nullTextures[t - 1]; return tx ? tx.scaleMode : 1;
      },
      __sdl_set_draw_color: function () {},
      __sdl_set_draw_blend_mode: function () {},
      __sdl_render_clear: function () {},
      __sdl_render_quad: function () {},
      __sdl_render_geometry: function () {},
      __sdl_render_present: function () {},
      __sdl_set_animation_frame_func: function (callbackPtr) { animationFrameFunc = callbackPtr; },
      __sdl_push_key_event: function () {},
      __sdl_push_mouse_button_event: function () {},
      __sdl_push_mouse_motion_event: function () {},
      __sdl_push_mouse_wheel_event: function () {},
      __sdl_push_quit_event: function () {},
      __sdl_open_audio_device: function () { return 1; },
      __sdl_queue_audio: function () { return 0; },
      __sdl_get_queued_audio_size: function () { return 0; },
      __sdl_clear_queued_audio: function () {},
      __sdl_pause_audio_device: function () {},
      __sdl_close_audio_device: function () {},
      __sdl_audio_callback_unsupported: function () { sdlAudioGetCallbackUnsupported(); },
      // SDL_GetTicks: ms since SDL_Init, full range (C casts to Uint64; no 32-bit
      // wrap). Lazily baseline if a program reads ticks before SDL_Init.
      __sdl_get_ticks: function () { if (sdlTicksBase === null) sdlTicksBase = Date.now(); return Date.now() - sdlTicksBase; },
      // SDL_Delay (todos/0224): headless contexts CAN block — the same
      // primitive as usleep/nanosleep (Atomics.wait on a never-notified
      // cell) — so the classic while(running){ poll; draw; SDL_Delay(16); }
      // loop runs unmodified under Node CLI / headless tests. No display and
      // no input ring in this flavor, so a plain blocking sleep is the whole
      // contract. Where the thread cannot block (a browser main thread) the
      // loud throw remains — see sdlDelayUnsupported().
      __sdl_delay: function (ms) {
        if (!BLOCK_FS.canBlockSync()) sdlDelayUnsupported();
        BLOCK_FS.blockingSleepMs(ms);
      },
      // No OS input ring in this flavor — SDL_WaitEvent* falls back to a
      // nanosleep pace on a 0 return (todos/0161); no kernel WAIT either —
      // __wait callers fall back to their chunked poll on -2 (todos/0178).
      __sdl_pump_wait: function () { return 0; },
      __wait: function () { return -2; },
    },
  };
}

/* ==========================================================================
 * Surface-backed SDL for OS processes (todos/WM.md; kernel side: kernel.js
 * "WM surfaces"). Selected by runModule when spawnHooks carry the surface
 * ops (i.e. the process runs under kernel.js) and no canvas was injected.
 *
 * The app-facing API is unchanged (WM.md invariant #1); what varies is the
 * present transport, picked per environment:
 *   - browser (OffscreenCanvas + navigator.gpu): the full WebGPU SDL backend
 *     renders onto a WORKER-LOCAL OffscreenCanvas; each present transfers an
 *     ImageBitmap to the kernel compositor ({type:'wm-frame'} — spike S1:
 *     GPU-backed end to end). One window per process in this flavor (one
 *     canvas), matching the standalone runtime.
 *   - headless (stock Node): SDL_UpdateWindowSurface writes REAL pixels into
 *     the surface's shm double buffer (mailbox: write back, flip, never
 *     block) — deterministic kernel screenshots with zero dependencies. The
 *     SDL_Renderer API keeps null-backend behavior (WM.md tier 0; Dawn or
 *     the browser provide GPU pixels).
 * Input arrives on the per-process ring (kernel = producer); the frame loop
 * drains it into the wasm event queue before every tick.
 *
 * Layout constants MUST MATCH kernel.js (SH_* / IR_* / WMEV / AU_* there) —
 * ENFORCED by assertWmSabLayout below (CD26): every field is cross-checked
 * against the kernel's published copy at surface-backend setup.
 * ========================================================================== */
/* Push bytes from wasm memory into an audio ring SAB (layout:
 * createSharedAudioBuffer — [writePos, queuedBytes, playing, reserved] +
 * PCM). Returns the byte count ACCEPTED (partial when the ring is nearly
 * full; the C SDL_AudioStream backlogs the rest — FIFO preserved, never
 * dropped). alignBytes > 1 rounds the accept DOWN to whole frames: the
 * kernel mixer (todos/0017) derives its read position from
 * writePos - queuedBytes and needs both to advance by whole frames.
 * writePos advances MASKED modulo capacity — an unbounded Atomics.add
 * wraps the Int32 negative after 2^31 cumulative bytes (~1.5-3h of
 * 44.1kHz stereo S16) and the negative ring offset kills the run with a
 * RangeError. Single producer, so load/modify/store is race-free. */
function audioRingPush(control, ringData, cap, memory, dataPtr, len, alignBytes) {
  const queuedBytes = Atomics.load(control, WMAU_QUEUED);
  const free = cap - Math.max(0, queuedBytes);
  if (free <= 0 || len <= 0) return 0;
  let accepted = Math.min(len, free, cap);
  if (alignBytes > 1) accepted -= accepted % alignBytes;
  if (accepted <= 0) return 0;
  // Defend against the wasm passing a bad (dataPtr, accepted) pair.
  if (dataPtr < 0 || (dataPtr >>> 0) + (accepted >>> 0) > memory.buffer.byteLength) {
    return 0;
  }
  const src = new Uint8Array(memory.buffer, dataPtr, accepted);
  const writePos = Atomics.load(control, WMAU_WPOS) % cap;
  const firstChunk = Math.min(accepted, cap - writePos);
  ringData.set(src.subarray(0, firstChunk), writePos);
  if (firstChunk < accepted) {
    ringData.set(src.subarray(firstChunk), 0);
  }
  Atomics.store(control, WMAU_WPOS, (writePos + accepted) % cap);
  Atomics.add(control, WMAU_QUEUED, accepted); /* increment queuedBytes */
  return accepted;
}

const WMSH_MAGIC = 0, WMSH_W = 1, WMSH_H = 2, WMSH_FORMAT = 3, WMSH_FLIP = 4,
      WMSH_SEQ = 5;
const WMSH_MAGIC_VALUE = 0x574d5346;
const WMSH_HDR_BYTES = 64;
const WMIR_WPOS = 0, WMIR_RPOS = 1, WMIR_CAP = 2, WMIR_DROPPED = 3;
const WMIR_HDR_BYTES = 32, WMIR_RECORD_WORDS = 8, WMIR_DEFAULT_CAP = 256;
const WMAU_WPOS = 0, WMAU_QUEUED = 1, WMAU_PLAYING = 2, WMAU_HDR_BYTES = 16;
const WMEV_QUIT = 0x100, WMEV_WINDOW_RESIZED = 0x206,
      WMEV_FOCUS_GAINED = 0x20E, WMEV_FOCUS_LOST = 0x20F,
      WMEV_KEYDOWN = 0x300, WMEV_KEYUP = 0x301,
      WMEV_MOUSEMOTION = 0x400, WMEV_MOUSEBUTTONDOWN = 0x401,
      WMEV_MOUSEBUTTONUP = 0x402, WMEV_MOUSEWHEEL = 0x403;

/* CD26 tripwire (mirrors todos/0235's payloadChunk rule): the constants
 * above re-declare kernel.js's SH_* / IR_* / WMEV / AU_* SAB layouts —
 * host.js is a standalone module and cannot import them — and drift between
 * the two copies corrupts presents/screenshots/input/audio SILENTLY. The
 * kernel publishes its declaration as spawnHooks.wmSabLayout (kernel.js
 * WM_SAB_LAYOUT); this cross-checks EVERY field — both key sets, exact
 * values — at surface-backend setup, which runs for every kernel-attached
 * process from pid 1 on, so a one-sided layout edit fails the boot loud
 * instead of shipping wrong pixels. The field is REQUIRED (the 0235 rule:
 * kernel.js and host.js ship from one tree, so a missing field is version
 * skew — fail loud rather than present on a stale guess). */
function assertWmSabLayout(hooks) {
  const mine = {
    shMagic: WMSH_MAGIC, shW: WMSH_W, shH: WMSH_H, shFormat: WMSH_FORMAT,
    shFlip: WMSH_FLIP, shSeq: WMSH_SEQ,
    shMagicValue: WMSH_MAGIC_VALUE, shHdrBytes: WMSH_HDR_BYTES,
    irWpos: WMIR_WPOS, irRpos: WMIR_RPOS, irCap: WMIR_CAP,
    irDropped: WMIR_DROPPED,
    irHdrBytes: WMIR_HDR_BYTES, irRecordWords: WMIR_RECORD_WORDS,
    auWpos: WMAU_WPOS, auQueued: WMAU_QUEUED, auPlaying: WMAU_PLAYING,
    auHdrBytes: WMAU_HDR_BYTES,
    ev: {
      QUIT: WMEV_QUIT, WINDOW_RESIZED: WMEV_WINDOW_RESIZED,
      FOCUS_GAINED: WMEV_FOCUS_GAINED, FOCUS_LOST: WMEV_FOCUS_LOST,
      KEYDOWN: WMEV_KEYDOWN, KEYUP: WMEV_KEYUP,
      MOUSEMOTION: WMEV_MOUSEMOTION, MOUSEBUTTONDOWN: WMEV_MOUSEBUTTONDOWN,
      MOUSEBUTTONUP: WMEV_MOUSEBUTTONUP, MOUSEWHEEL: WMEV_MOUSEWHEEL,
    },
  };
  const theirs = hooks && hooks.wmSabLayout;
  if (!theirs) {
    throw new Error('spawnHooks.wmSabLayout missing — kernel.js/host.js out of sync (CD26, the todos/0235 shape)');
  }
  const drift = [];
  (function cmp(a, b, prefix) {
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    keys.forEach(function (k) {
      const av = a[k], bv = b[k];
      if (av !== null && typeof av === 'object' &&
          bv !== null && typeof bv === 'object') {
        cmp(av, bv, prefix + k + '.');
      } else if (av !== bv) {
        drift.push(prefix + k + ' (host.js ' + av + ' vs kernel.js ' + bv + ')');
      }
    });
  })(mine, theirs, '');
  if (drift.length) {
    throw new Error('shared-SAB layout drift between host.js and kernel.js (CD26): ' +
                    drift.join(', ') + ' — the two declarations MUST move together');
  }
}
// Cursor shape (SDL_SystemCursor) -> CSS `cursor` name (todos/0105). Index is
// the wire shape; -1 (hidden) maps to 'none'. The kernel derives chrome
// resize cursors and overlays them over an app's per-surface cursor; the
// page/canvas just applies the name. os.html carries an identical map (it is
// a standalone HTML bridge, not a host.js importer) — keep the two in sync.
const CURSOR_CSS = [
  'default', 'text', 'wait', 'crosshair', 'progress',
  'nwse-resize', 'nesw-resize', 'ew-resize', 'ns-resize', 'move',
  'not-allowed', 'pointer', 'nw-resize', 'n-resize', 'ne-resize',
  'e-resize', 'se-resize', 's-resize', 'sw-resize', 'w-resize',
];
CURSOR_CSS[-1] = 'none';

/* Lazy, optional Dawn probe (todos/WM.md "Headless testing tiers", tier 1):
 * the `webgpu` package (dawn-gpu/node-webgpu) is a devDependency, NEVER a hard
 * import — stock Node resolves null and webgpu programs see a clean
 * adapter-unavailable (identical to the null backend). Probed only when a
 * program actually calls wgpuInstanceRequestAdapter, so non-GPU OS processes
 * never pay the native-addon load. One Dawn GPU per worker (spike S3 shape). */
let dawnGpu;   /* undefined = unprobed; null = unavailable; else the Dawn GPU */
function resolveDawnGpu() {
  if (dawnGpu === undefined) {
    dawnGpu = null;
    if (typeof process !== 'undefined' && typeof require === 'function') {
      try { dawnGpu = require('webgpu').create([]); } catch (e) { /* not installed */ }
    }
  }
  return Promise.resolve(dawnGpu);
}

// Per-device source ring for the kernel audio mixer (todos/0017). 256K is
// ~1.5s of 44.1kHz stereo S16 — apps self-pace against much smaller queue
// targets (doom keeps 200ms), and it is a multiple of every frame size
// (1..8 bytes), which the kernel requires (frames never straddle the wrap).
const WMAUDIO_RING_BYTES = 256 * 1024;

function createSurfaceSDL({ ctx, hooks }) {
  assertWmSabLayout(hooks);   // CD26: fail the process spawn loud on layout drift
  const { readString, getMemory, getExports } = ctx;
  const handleBySid = new Map();     // sid -> SDL window handle
  const kFlagsBySid = new Map();     // sid -> current kernel surface flags word
  let ring = null;                   // { sab, i32, f32, cap } — one per process
  let onConfigure = null;            // flavor hook: WINDOW_RESIZED ring record

  /* ---- audio: per-device source rings into the kernel mixer (todos/0017;
   * WM.md "Audio mixing"). Same SAB layout as the standalone ring
   * (createSharedAudioBuffer); the kernel is the consumer instead of the
   * page. `playing` is written HERE (SDL3 devices open paused; resume sets
   * it) — the mixer skips paused rings. Kernels without the mixer hooks
   * (older embedders) keep the historical null behavior. ---- */
  const audioDevices = [];           // handle-1 -> { aid, control, ring, cap, frameBytes } | null
  function buildAudioEnv() {
    if (typeof hooks.audioOpen !== 'function') {
      let nullGain = 100;                        // no mixer: remember-only
      return {
        __sdl_open_audio_device: function () { return 1; },
        __sdl_queue_audio: function () { return 0; },
        __sdl_get_queued_audio_size: function () { return 0; },
        __sdl_clear_queued_audio: function () {},
        __sdl_pause_audio_device: function () {},
        __sdl_close_audio_device: function () {},
        __sdl_audio_callback_unsupported: function () { sdlAudioGetCallbackUnsupported(); },
        __audio_gain: function (gain) {
          if (gain >= 0) nullGain = Math.min(200, gain | 0);
          return nullGain;
        },
      };
    }
    return {
      __sdl_open_audio_device: function (freq, format, channels) {
        const sab = new SharedArrayBuffer(WMAU_HDR_BYTES + WMAUDIO_RING_BYTES);
        const r = hooks.audioOpen(freq, format, channels, sab);
        if (!r || r.errno || !(r.aid > 0)) return 0;   // C shim sets the SDL error
        let bytesPerSample = 2;                        // S16 default
        if (format === 0x8120 || format === 0x8020) bytesPerSample = 4;
        else if (format === 0x8008 || format === 0x0008) bytesPerSample = 1;
        audioDevices.push({
          aid: r.aid,
          control: new Int32Array(sab, 0, WMAU_HDR_BYTES >> 2),
          ring: new Uint8Array(sab, WMAU_HDR_BYTES, WMAUDIO_RING_BYTES),
          cap: WMAUDIO_RING_BYTES,
          frameBytes: bytesPerSample * channels,
        });
        return audioDevices.length;
      },
      __sdl_queue_audio: function (dev, dataPtr, len) {
        const d = audioDevices[dev - 1];
        if (!d) return 0;
        // Frame-aligned pushes (the mixer's readPos derivation needs them);
        // the C SDL_AudioStream backlogs any rounded-off remainder.
        return audioRingPush(d.control, d.ring, d.cap, getMemory(), dataPtr, len, d.frameBytes);
      },
      __sdl_get_queued_audio_size: function (dev) {
        const d = audioDevices[dev - 1];
        return d ? Math.max(0, Atomics.load(d.control, WMAU_QUEUED)) : 0;
      },
      __sdl_clear_queued_audio: function (dev) {
        const d = audioDevices[dev - 1];
        if (d) Atomics.store(d.control, WMAU_QUEUED, 0);   // mixer self-heals a racy negative
      },
      __sdl_pause_audio_device: function (dev, pause_on) {
        const d = audioDevices[dev - 1];
        if (d) Atomics.store(d.control, WMAU_PLAYING, pause_on ? 0 : 1);
      },
      __sdl_close_audio_device: function (dev) {
        const d = audioDevices[dev - 1];
        if (d) { hooks.audioClose(d.aid); audioDevices[dev - 1] = null; }
      },
      __sdl_audio_callback_unsupported: function () { sdlAudioGetCallbackUnsupported(); },
      // Master mixer gain (todos/0048, kernel AUDIO_GAIN): percent 0..200,
      // negative queries. Older embedder kernels answer ENOSYS -> -1.
      __audio_gain: function (gain) {
        if (typeof hooks.audioGain !== 'function') return -1;
        const r = hooks.audioGain(gain | 0);
        return r && !r.errno && r.gain >= 0 ? r.gain : -1;
      },
    };
  }
  const audioEnv = buildAudioEnv();

  function allocFb(w, h) {
    const sab = new SharedArrayBuffer(WMSH_HDR_BYTES + 2 * w * h * 4);
    const i32 = new Int32Array(sab);
    i32[WMSH_MAGIC] = WMSH_MAGIC_VALUE;
    i32[WMSH_W] = w; i32[WMSH_H] = h;
    return { sab, i32, u8: new Uint8Array(sab), w, h };
  }
  function ensureRing() {
    if (ring) return ring;
    const sab = new SharedArrayBuffer(WMIR_HDR_BYTES + WMIR_DEFAULT_CAP * WMIR_RECORD_WORDS * 4);
    const i32 = new Int32Array(sab);
    i32[WMIR_CAP] = WMIR_DEFAULT_CAP;
    ring = { sab, i32, f32: new Float32Array(sab), cap: WMIR_DEFAULT_CAP };
    return ring;
  }
  function surfaceCreate(titlePtr, w, h, sdlFlags, popup) {
    const title = titlePtr ? readString(titlePtr) : '';
    const fb = allocFb(w, h);
    // SDL_WINDOW_BORDERLESS (0x10) -> kernel surface flags bit0 (no chrome);
    // SDL_WINDOW_RESIZABLE (0x20) -> bit2 (todos/0021: the kernel offers
    // resize — drag zones, wmResize — only to surfaces that carry it);
    // SDL_WINDOW_TRANSPARENT (0x40000000) -> bit3 (todos/0063: per-pixel
    // alpha, composited src-over in both composites).
    let kFlags = ((sdlFlags & 0x10) ? 1 : 0) | ((sdlFlags & 0x20) ? 4 : 0) |
                 ((sdlFlags & 0x40000000) ? 8 : 0);
    // SDL_CreatePopupWindow (todos/0256): an anchored child surface — kernel
    // flag bit6 + parentSid/dx/dy, implicitly borderless (bit0), and
    // SDL_WINDOW_POPUP_MENU (0x80000) carries the kernel GRAB (bit7, menu
    // arch A2: press-outside-dismisses); SDL_WINDOW_TOOLTIP (0x40000) does
    // not grab. Kernels predating 0256 ignore the extra fields and create a
    // plain borderless top-level.
    let parentSid = 0, dx = 0, dy = 0;
    if (popup) {
      kFlags |= 1 | 64 | ((sdlFlags & 0x80000) ? 128 : 0);
      parentSid = popup.parentSid | 0;
      dx = popup.dx | 0;
      dy = popup.dy | 0;
    }
    const r = hooks.surfaceCreate(w, h, title, fb.sab, ensureRing().sab, kFlags,
                                  parentSid, dx, dy);
    if (!r || r.errno || !(r.sid > 0)) return null;
    kFlagsBySid.set(r.sid, kFlags);
    return { sid: r.sid, fb };
  }
  /* SDL_GetDisplayBounds (todos/0256): the kernel screen dims off the vDSO
   * page (zero RPCs). Packed (w << 16) | h — dims are capped at 8192 kernel-
   * side, so the pack always fits a positive i32; 0 = no display authority
   * in this flavor (the C side surfaces a clean SDL error). */
  function displayBounds() {
    if (typeof hooks.screen !== 'function') return 0;
    const scr = hooks.screen();
    if (!scr || !(scr.w > 0) || !(scr.h > 0)) return 0;
    return (scr.w << 16) | scr.h;
  }
  /* SDL_SetWindowRelativeMouseMode -> SURFACE_SET_FLAGS bit1 (todos/0018).
   * The kernel round-trips the flag to the UI bridge (pointer lock) and
   * pushes rel-flagged motion records while the lock is held. Pre-0018
   * embedders lack the hook: the request is a clean no-op (the app keeps
   * absolute-derived xrel/yrel, exactly the pre-0018 behavior). */
  function setRelativeMouse(handle, enabled) {
    if (typeof hooks.surfaceSetFlags !== 'function') return;
    for (const [sid, h] of handleBySid) {
      if (h === handle) {
        const flags = ((kFlagsBySid.get(sid) | 0) & ~2) | (enabled ? 2 : 0);
        kFlagsBySid.set(sid, flags);
        hooks.surfaceSetFlags(sid, flags);
      }
    }
  }
  /* SDL_SetCursor -> SURFACE_SET_CURSOR (todos/0105). The kernel keeps the
   * per-surface cursor shape and OVERLAYS chrome cursors (resize edges) over
   * it, then round-trips the effective cursor to the UI bridge. Pre-0105
   * embedders lack the hook: a clean no-op (the native arrow stays). */
  function setCursor(handle, shape) {
    if (typeof hooks.surfaceSetCursor !== 'function') return;
    for (const [sid, h] of handleBySid) {
      if (h === handle) hooks.surfaceSetCursor(sid, shape | 0);
    }
  }
  /* Owner-initiated resize (todos/0068, SDL_SetWindowSize): ask the kernel
   * for a new buffer size. The kernel answers asynchronously with the same
   * WINDOW_RESIZED -> configure -> present-ack renegotiation as a WM/drag
   * resize (below), so the app-facing contract is one path: the new size
   * arrives as SDL_EVENT_WINDOW_RESIZED. Pre-0068 embedders lack the hook
   * -> loud failure (SDL_SetWindowSize returns false). */
  function requestResize(sid, w, h) {
    if (typeof hooks.surfaceResize !== 'function') return -1;
    const r = hooks.surfaceResize(sid, w | 0, h | 0);
    return (r && !r.errno) ? 0 : -1;
  }
  /* ---- buffer renegotiation (todos/0019) ----
   * A WINDOW_RESIZED ring record allocates the NEW fb here; the ack (a
   * SURFACE_CONFIGURE RPC, new SAB riding {type:'wm-sabs'} like at create)
   * is gated on the app's first present AT the new size — that frame lands
   * in the new SAB, so the kernel's swap is tear-free by construction.
   * Old-size in-flight frames keep landing in the OLD SAB (still the one
   * on screen), so the app stays live while it adopts the new size; a
   * binary that never handles the event just keeps its old geometry. */
  function beginConfigure(win, w, h) {
    if (typeof hooks.surfaceConfigure !== 'function') return;  // pre-0019 embedder
    win.pendingCfg = { w: w, h: h, fb: allocFb(w, h) };
  }
  function ackConfigure(win) {
    const cfg = win.pendingCfg;
    win.pendingCfg = null;
    const r = hooks.surfaceConfigure(win.sid, cfg.w, cfg.h, cfg.fb.sab);
    // EINVAL (surface gone / no configure pending kernel-side): keep the
    // old buffer; a fresh WINDOW_RESIZED event re-negotiates if wanted.
    if (r && !r.errno) { win.fb = cfg.fb; win.w = cfg.w; win.h = cfg.h; }
  }
  /* Doorbell-on-present (todos/0169): an shm present is SAB-only, so a
   * parked compositor cannot see it — after every WMSH_SEQ bump, re-read
   * the kernel-page parked flag and post want-frame if set. Cost while
   * armed: one atomic load per present; the message only when parked. Also
   * records that a present happened so pumpWait's next entry can tell the
   * kernel this app is back to waiting (frame-idle — clears the kernel-side
   * wantFrame pin without a per-park message from quiet pollers). */
  let presentedSinceIdle = false;
  function ringIfParked() {
    presentedSinceIdle = true;
    if (hooks.compParked && hooks.compParked()) hooks.wantFrame();
  }
  /* SDL_UpdateWindowSurface -> shm mailbox present (write the back buffer,
   * flip, never block). Used by BOTH flavors: CPU-present apps ride the shm
   * transport even in the browser (no GPU dependency; the compositor
   * putImageData's it) — only GPU-rendered frames ride bitmap handoff. */
  function shmPresent(win, pixelsPtr, w, h, pitch) {
    const cfg = win.pendingCfg;
    const fb = (cfg && w === cfg.w && h === cfg.h) ? cfg.fb : win.fb;
    const cw = Math.min(w, fb.w), ch = Math.min(h, fb.h);
    const mem = new Uint8Array(getMemory().buffer);
    const front = Atomics.load(fb.i32, WMSH_FLIP) & 1;
    const back = 1 - front;
    const base = WMSH_HDR_BYTES + back * fb.w * fb.h * 4;
    if (pitch === fb.w * 4 && cw === fb.w) {
      fb.u8.set(mem.subarray(pixelsPtr, pixelsPtr + cw * 4 * ch), base);
    } else {
      for (let row = 0; row < ch; row++) {
        fb.u8.set(mem.subarray(pixelsPtr + row * pitch, pixelsPtr + row * pitch + cw * 4),
          base + row * fb.w * 4);
      }
    }
    Atomics.store(fb.i32, WMSH_FLIP, back);
    Atomics.add(fb.i32, WMSH_SEQ, 1);
    ringIfParked();                         // doorbell-on-present (todos/0169)
    if (fb !== win.fb) ackConfigure(win);   // first new-size frame: ack + swap
    return 0;
  }
  /* Drain the input ring into the wasm event queue. Runs before every frame
   * tick (and is exposed for embedder pumps). Single consumer by design.
   * Returns the record count drained — pumpWait's no-park signal (0168). */
  function drainInput() {
    if (!ring) return 0;
    const ex = getExports();
    const cap2 = ring.cap * 2;
    let drained = 0;
    let rpos = Atomics.load(ring.i32, WMIR_RPOS);
    while (rpos !== Atomics.load(ring.i32, WMIR_WPOS)) {
      drained++;
      const base = (WMIR_HDR_BYTES >> 2) + (rpos % ring.cap) * WMIR_RECORD_WORDS;
      const type = ring.i32[base];
      const handle = handleBySid.get(ring.i32[base + 1]) || 1;
      switch (type) {
        case WMEV_KEYDOWN: case WMEV_KEYUP:
          if (ex.__sdl_push_key_event) {
            ex.__sdl_push_key_event(handle, type, ring.i32[base + 2], ring.i32[base + 3],
              ring.i32[base + 4], ring.i32[base + 5]);
          }
          break;
        case WMEV_MOUSEMOTION:
          if (ring.i32[base + 5]) {
            // Relative record (word[5]=1, todos/0018): [2]/[3] are f32 deltas,
            // not positions — pointer-lock motion or an injected rel event.
            if (ex.__sdl_push_mouse_motion_rel_event) {
              ex.__sdl_push_mouse_motion_rel_event(handle, ring.f32[base + 2], ring.f32[base + 3], ring.i32[base + 4]);
            }
          } else if (ex.__sdl_push_mouse_motion_event) {
            ex.__sdl_push_mouse_motion_event(handle, ring.f32[base + 2], ring.f32[base + 3], ring.i32[base + 4]);
          }
          break;
        case WMEV_MOUSEBUTTONDOWN: case WMEV_MOUSEBUTTONUP:
          if (ex.__sdl_push_mouse_button_event) {
            ex.__sdl_push_mouse_button_event(handle, type, ring.i32[base + 4],
              ring.f32[base + 2], ring.f32[base + 3]);
          }
          break;
        case WMEV_MOUSEWHEEL:
          if (ex.__sdl_push_mouse_wheel_event) {
            ex.__sdl_push_mouse_wheel_event(handle, ring.f32[base + 2], ring.f32[base + 3], ring.i32[base + 4]);
          }
          break;
        case WMEV_QUIT:
          // The record names the closed surface (kernel _wmEventTo stamps
          // the sid); the SDL side decides per-window vs process-wide.
          if (ex.__sdl_push_quit_event) ex.__sdl_push_quit_event(handle);
          break;
        case WMEV_WINDOW_RESIZED:
          // Renegotiate BEFORE the wasm sees the event: the app handles it
          // in this same frame tick, and its next present at the new size
          // must find the new SAB waiting (see beginConfigure above).
          if (onConfigure) onConfigure(ring.i32[base + 1], ring.i32[base + 2], ring.i32[base + 3]);
          if (ex.__sdl_push_window_event) {
            ex.__sdl_push_window_event(handle, type, ring.i32[base + 2], ring.i32[base + 3]);
          }
          break;
        case WMEV_FOCUS_GAINED: case WMEV_FOCUS_LOST:
          // The owner focus pair (todos/0256, menu arch A9): SDL3's stock
          // SDL_EVENT_WINDOW_FOCUS_GAINED/LOST, delivered per-window.
          if (ex.__sdl_push_window_event) {
            ex.__sdl_push_window_event(handle, type, 0, 0);
          }
          break;
      }
      rpos = (rpos + 1) % cap2;
      Atomics.store(ring.i32, WMIR_RPOS, rpos);
    }
    return drained;
  }
  /* Blocking message-loop park (todos/0058 — user32's GetMessage): drain,
   * and if the ring is dry park on IR_WPOS until the kernel's push
   * notifies (kernel.js _wmPushEvent) or timeoutMs elapses, then drain
   * again. Runs INSIDE a wasm import call, so the drained events are in
   * the wasm event queue when the import returns — the one way input
   * reaches a main() that never returns to the frame scheduler. Returns 1
   * if a ring exists (a window was created), 0 otherwise so the caller
   * can pace itself instead of spinning. Wakes can be spurious; the
   * caller re-checks its queues. Processes run in workers, where
   * Atomics.wait is allowed.
   * NO PARK WHEN THE ENTRY DRAIN PRODUCED EVENTS (todos/0168): events that
   * landed between the caller's last queue check and this call used to be
   * moved into the wasm queue and then slept past for the full timeout —
   * under a 25ms GetMessage chunk that was a bounded hiccup, under wm.c's
   * 1s event-loop park it lost a drag's tail events for a visible second
   * (the marquee regression that found this). Return instead; the caller's
   * contract is already re-poll-on-any-return. */
  function pumpWait(timeoutMs) {
    // WaitEvent/GetMessage entry = this app is back to waiting on events
    // (todos/0169): release the kernel-side wantFrame pin so the compositor
    // may park. Gated on a present since the last release — an idle 25ms
    // GetMessage chunker posts nothing, an app that just presented posts
    // exactly once.
    if (presentedSinceIdle) {
      presentedSinceIdle = false;
      if (hooks.frameIdle) hooks.frameIdle();
    }
    if (drainInput() > 0) return 1;
    if (!ring) return 0;
    if (timeoutMs > 0) {
      const wpos = Atomics.load(ring.i32, WMIR_WPOS);
      if (wpos === Atomics.load(ring.i32, WMIR_RPOS)) {
        Atomics.wait(ring.i32, WMIR_WPOS, wpos, timeoutMs);
        drainInput();
      }
    }
    return 1;
  }
  /* Unified multi-source wait (todos/0178) — the __wait import. One
   * kernel FS_WAIT RPC over {read fds} ⊕ the input ring ⊕ a timeout;
   * readiness-check and park are atomic KERNEL-side, which is the whole
   * point: this is the only sanctioned way to sleep on more than one
   * source (KERNEL.md's two-tier wait rule — single-source ring/vsync
   * parks stay raw futexes like pumpWait above). Returns why: 0 timeout,
   * 1 fd readable, 2 ring (records already drained into the wasm event
   * queue), -1 signal (EINTR; the handler ran at this import's return),
   * -2 no kernel WAIT in this flavor. Wakes may be spurious-shaped
   * (why=2 with the record already consumed by an entry drain) — the
   * caller's contract is re-poll-on-any-return, same as pumpWait.
   * Keeps pumpWait's two entry rules: frame-idle release (0169), and
   * NO PARK WHEN THE ENTRY DRAIN PRODUCED EVENTS (todos/0168, b136b72) —
   * events moved into the wasm queue before the kernel scan would
   * otherwise be slept past. */
  function waitMulti(rfdsPtr, nr, ringInterest, timeoutMs) {
    if (typeof hooks.waitMulti !== 'function') return -2;
    if (presentedSinceIdle) {
      presentedSinceIdle = false;
      if (hooks.frameIdle) hooks.frameIdle();
    }
    if (ringInterest && drainInput() > 0) return 2;
    const mem = new DataView(getMemory().buffer);
    const r = [];
    for (let i = 0; i < nr && i < 64; i++) r.push(mem.getInt32(rfdsPtr + i * 4, true));
    const resp = hooks.waitMulti({
      r,
      ring: ring && ringInterest ? 1 : 0,     // no ring yet: fds/timeout only
      timeoutMs: timeoutMs < 0 ? null : timeoutMs,
    });
    if (resp.errno === 'EINTR') return -1;
    if (resp.errno) return -2;                // ENOSYS: embedder kernel predates 0178
    if (ringInterest) drainInput();           // ring wake visible at import return
    return resp.why | 0;
  }
  /* SDL_Delay (todos/0224): OS processes run in workers, where blocking is
   * legal — the classic while(running){ poll; draw; SDL_Delay(16); } corpus
   * loop is FIRST-CLASS here, no restructure-to-callback tax (that tax is
   * real only in the standalone browser runtime; see sdlDelayUnsupported).
   * Sleep in pumpWait parks so the OS input ring keeps draining into the
   * wasm event queue while we sleep: an event arriving mid-delay is queued
   * for the app's next SDL_PollEvent but does NOT shorten the sleep (SDL
   * semantics — Delay sleeps its full duration; the deadline loop below
   * re-parks for the remainder after every early wake). pumpWait's entry
   * rules carry over: the 0169 frame-idle release lets the compositor park
   * while an app dawdles between presents (the next present's doorbell
   * re-wakes it — the IDLE-POWER discipline), and cooperative signals run
   * at this import's return, matching usleep/nanosleep. Pre-window there is
   * no ring yet (pumpWait returns 0 without sleeping) — fall back to the
   * raw blocking sleep, never a spin. */
  function sdlDelay(ms) {
    const end = Date.now() + (ms | 0);
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return;
      if (pumpWait(left) === 0) { BLOCK_FS.blockingSleepMs(left); return; }
    }
  }

  /* ---- browser flavor: the real WebGPU SDL backend on a worker-local
   * OffscreenCanvas, presents handed to the kernel as ImageBitmaps ---- */
  if (typeof OffscreenCanvas !== 'undefined' &&
      typeof navigator !== 'undefined' && navigator.gpu &&
      typeof hooks.surfaceFrame === 'function') {
    /* Per-window GPU present binding (menu build item 0, design amendment A4):
     * every GPU-presenting window owns its own OffscreenCanvas, keyed by sid —
     * symmetric with the shm path's fbByHandle/handleBySid. The binding is
     * established at SDL_GetWGPUSurface time (the window handle crosses on the
     * __wgpu_instance_create_surface_for_window import), NOT at window-create,
     * so creating a second window can never repoint an existing surface's
     * presents. */
    const canvasBySid = new Map();     // sid -> that window's OffscreenCanvas
    /* The shared inner canvas serves the SDL_Renderer flush (which passes its
     * window handle per-present) and pre-A4 binaries' webgpu surfaces (the
     * handle-less wgpuInstanceCreateSurface import), whose tail keeps the old
     * last-created-window semantics — old baked binaries behave exactly as
     * before. */
    const canvas = new OffscreenCanvas(1, 1);
    let legacySid = 0;                 // last-created window (legacy tail only)
    /* The gpu-transport present tail (raw webgpu.h wgpuSurfacePresent and the
     * SDL renderer's flush land here): snapshot the given canvas and hand the
     * frame to the kernel (todos/WM.md, spike S1). */
    const presentTo = function (sid, cnv) {
      if (!handleBySid.has(sid)) return;   // window already destroyed
      try {
        const bmp = cnv.transferToImageBitmap();
        // gpu-transport resize ack (todos/0019): the first bitmap at the
        // pending size acks FIRST, so the kernel geometry is already the
        // new size when this frame lands (no one-frame scaled draw).
        const win = fbByHandle.get(handleBySid.get(sid));
        if (win && win.pendingCfg &&
            bmp.width === win.pendingCfg.w && bmp.height === win.pendingCfg.h) {
          ackConfigure(win);
        }
        hooks.surfaceFrame(sid, bmp);
      } catch (e) { /* canvas may be zero-sized pre-configure */ }
    };
    // Shared-canvas tail: the SDL_Renderer flush passes its window handle; a
    // pre-A4 webgpu surface passes nothing and resolves to the legacy sid.
    const presentFrame = function (windowHandle) {
      const win = windowHandle ? fbByHandle.get(windowHandle) : null;
      const sid = win ? win.sid : legacySid;
      if (sid) presentTo(sid, canvas);
    };
    const inner = createBrowserSDL({ canvas, ctx, onPresent: presentFrame });
    // Audio goes to the kernel mixer, not the page: override the inner
    // backend's ring-less stubs (it was built without sharedAudioBuffer).
    const env = Object.assign({}, inner[ENV_KEY], audioEnv);
    const innerCreate = env.__sdl_create_window;
    const innerDestroy = env.__sdl_destroy_window;
    const innerSetTitle = env.__sdl_set_window_title;
    const fbByHandle = new Map();              // handle -> { sid, fb, w, h }
    env.__sdl_create_window = function (titlePtr, x, y, w, h, flags) {
      const s = surfaceCreate(titlePtr, w, h, flags);
      if (!s) return 0;
      const handle = innerCreate(titlePtr, x, y, w, h, flags);
      legacySid = s.sid;                       // legacy handle-less tail only
      handleBySid.set(s.sid, handle);
      fbByHandle.set(handle, { sid: s.sid, fb: s.fb, w: w, h: h });
      return handle;
    };
    // SDL_CreatePopupWindow (todos/0256): an anchored child of an existing
    // window — registered in the SAME per-handle tables, so presents,
    // events, destroy and owner-resize all ride the ordinary per-window
    // paths. Deliberately does NOT repoint legacySid (a popup is never the
    // GPU legacy present target).
    env.__sdl_create_popup_window = function (parentHandle, dx, dy, w, h, flags) {
      const pwin = fbByHandle.get(parentHandle);
      if (!pwin) return 0;
      const s = surfaceCreate(0, w, h, flags,
                              { parentSid: pwin.sid, dx: dx, dy: dy });
      if (!s) return 0;
      const handle = innerCreate(0, 0, 0, w, h, flags);
      handleBySid.set(s.sid, handle);
      fbByHandle.set(handle, { sid: s.sid, fb: s.fb, w: w, h: h });
      return handle;
    };
    env.__sdl_get_display_bounds = displayBounds;   // (todos/0256)
    // CPU software-present path: shm transport, no GPU dependency (see
    // shmPresent). The WebGPU renderer keeps the bitmap path via onPresent.
    env.__sdl_update_window_surface = function (handle, pixelsPtr, w, h, pitch) {
      const win = fbByHandle.get(handle);
      return win ? shmPresent(win, pixelsPtr, w, h, pitch) : -1;
    };
    env.__sdl_destroy_window = function (handle) {
      innerDestroy(handle);
      fbByHandle.delete(handle);
      for (const [sid, h] of handleBySid) {
        if (h === handle) {
          hooks.surfaceDestroy(sid); handleBySid.delete(sid); kFlagsBySid.delete(sid);
          canvasBySid.delete(sid);             // tear down only this sid's canvas
          if (legacySid === sid) legacySid = 0;
        }
      }
    };
    env.__sdl_set_window_title = function (handle, titlePtr) {
      innerSetTitle(handle, titlePtr);
      for (const [sid, h] of handleBySid) {
        if (h === handle) hooks.surfaceSetTitle(sid, titlePtr ? readString(titlePtr) : '');
      }
    };
    // OS flavor: pointer lock is the KERNEL's (via the surface flag), not the
    // worker-local OffscreenCanvas's — fully override the inner notify path.
    env.__sdl_set_relative_mouse_mode = function (handle, enabled) {
      setRelativeMouse(handle, enabled);
    };
    // OS flavor: the cursor is the KERNEL's (per-surface state + chrome
    // overlay), not the worker-local canvas's — override the inner path.
    env.__sdl_set_cursor = function (handle, shape) { setCursor(handle, shape); };
    env.__sdl_set_window_size = function (handle, w, h) {
      const win = fbByHandle.get(handle);
      return win ? requestResize(win.sid, w, h) : -1;
    };
    env.__sdl_pump_wait = pumpWait;   // user32 blocking GetMessage (0058)
    env.__wait = waitMulti;           // unified multi-source wait (0178)
    env.__sdl_delay = sdlDelay;       // cooperative worker sleep (0224) —
                                      // overrides inner's standalone-page throw
    // Resize request (todos/0019): allocate the new shm SAB and resize the
    // canvas that presents THIS sid (per-window binding, A4) — the SDL
    // renderer draws at canvas size, and a webgpu.h app's own
    // wgpuSurfaceConfigure re-sizes it again (idempotent). Unbound sids keep
    // resizing the shared inner canvas (renderer + legacy tails). The ack
    // rides the next matching-size present (shmPresent or presentTo above).
    onConfigure = function (sid, w, h) {
      const win = fbByHandle.get(handleBySid.get(sid));
      if (!win) return;
      beginConfigure(win, w, h);
      const c = canvasBySid.get(sid) || canvas;
      c.width = w;
      c.height = h;
    };
    const out = Object.assign({}, inner);
    out[ENV_KEY] = env;
    out.drainInput = drainInput;
    // Vsync broadcast (todos/0100, wired by todos/0167): when the kernel
    // advertises a real frame clock (compositor rAF → vsyncTick), pace the
    // frame loop by awaiting the kernel-page tick word — phase-aligned with
    // the composite that samples our presents, and parked for free while
    // the tab is hidden (no ticks = no frames, the honest pause). Without
    // the advertisement (standalone pages) keep inner's deadline pacer.
    if (typeof hooks.vsyncEnabled === 'function' &&
        typeof hooks.vsyncWait === 'function' && hooks.vsyncEnabled()) {
      out.requestAnimationFrame = function (cb) { hooks.vsyncWait().then(cb); };
    }
    // Raw webgpu.h apps (runModule builds the webgpu binding from this):
    // bindWindow hands out the PER-WINDOW canvas + present tail at
    // SDL_GetWGPUSurface time (A4); canvas/onPresent remain the legacy
    // shared-canvas tail for pre-A4 binaries' handle-less surfaces.
    out.webgpuConfig = {
      canvas: canvas,
      onPresent: presentFrame,
      bindWindow: function (handle) {
        const win = fbByHandle.get(handle);
        if (!win) return null;
        const sid = win.sid;
        let c = canvasBySid.get(sid);
        if (!c) { c = new OffscreenCanvas(1, 1); canvasBySid.set(sid, c); }
        return { canvas: c, present: function () { presentTo(sid, c); } };
      },
    };
    return out;
  }

  /* ---- headless/shm flavor: real UpdateWindowSurface pixels, null-backend
   * renderer (tier 0), real windows + events ---- */
  let animationFrameFunc = null;
  let sdlTicksBase = null;
  const windows = [];                // handle-1 -> { sid, w, h, fb, pendingCfg? } | null
  const nullTextures = [];
  onConfigure = function (sid, w, h) {
    const win = windows[(handleBySid.get(sid) || 0) - 1];
    if (win) beginConfigure(win, w, h);
  };
  return {
    getAnimationFrameFunc: function () { return animationFrameFunc; },
    // Vsync broadcast (todos/0100): when the kernel advertises a real frame
    // clock (browser compositor rAF → vsyncTick), pace the frame loop by
    // awaiting the kernel-page tick word — phase-aligned with the composite
    // that samples our presents, and parked for free while the tab is
    // hidden (no ticks = no frames, the honest pause). Headless kernels
    // never advertise, so Node keeps the deadline-setTimeout pacer.
    requestAnimationFrame:
      (typeof hooks.vsyncEnabled === 'function' &&
       typeof hooks.vsyncWait === 'function' && hooks.vsyncEnabled())
        ? function (cb) { hooks.vsyncWait().then(cb); }
        : null,             // frame loop falls back to the deadline pacer
    drainInput: drainInput,
    /* Raw webgpu.h apps: real WebGPU headless via the lazy Dawn probe (tier 1);
     * the binding's shm present tail lands frames in the SDL window's SAB —
     * kernel screenshots can't tell Dawn output from a CPU app. Without the
     * package the resolver yields null (clean adapter-unavailable, tier 0). */
    webgpuConfig: {
      resolveGpu: resolveDawnGpu,
      shmSurface: {
        /* Per-window binding (A4): a surface created through
         * SDL_GetWGPUSurface names its window — presents land on IT. */
        byHandle: function (handle) { return windows[handle - 1] || null; },
        /* Legacy tail for pre-A4 binaries (handle-less
         * wgpuInstanceCreateSurface): newest live window, the old behavior. */
        getTarget: function () {
          for (let i = windows.length - 1; i >= 0; i--) if (windows[i]) return windows[i];
          return null;
        },
        /* Tightly-packed RGBA rows (src may carry copyTextureToBuffer's 256B
         * row padding) -> back buffer -> mailbox flip, mirroring shmPresent —
         * including the renegotiation gate: a Dawn app that reconfigured its
         * surface to the pending size acks through here (todos/0019). */
        present: function (win, src, srcPitch, sw, sh) {
          const cfg = win.pendingCfg;
          const fb = (cfg && sw === cfg.w && sh === cfg.h) ? cfg.fb : win.fb;
          const cw = Math.min(sw, fb.w), ch = Math.min(sh, fb.h);
          const front = Atomics.load(fb.i32, WMSH_FLIP) & 1;
          const back = 1 - front;
          const base = WMSH_HDR_BYTES + back * fb.w * fb.h * 4;
          for (let row = 0; row < ch; row++) {
            fb.u8.set(src.subarray(row * srcPitch, row * srcPitch + cw * 4),
              base + row * fb.w * 4);
          }
          Atomics.store(fb.i32, WMSH_FLIP, back);
          Atomics.add(fb.i32, WMSH_SEQ, 1);
          ringIfParked();                   // doorbell-on-present (todos/0169)
          if (fb !== win.fb) ackConfigure(win);
        },
      },
    },
    [ENV_KEY]: Object.assign({
      __sdl_init: function () { sdlTicksBase = Date.now(); return 0; },
      __sdl_quit: function () { animationFrameFunc = null; },
      __sdl_create_window: function (titlePtr, x, y, w, h, flags) {
        const s = surfaceCreate(titlePtr, w, h, flags);
        if (!s) return 0;
        windows.push({ sid: s.sid, w: w, h: h, fb: s.fb });
        handleBySid.set(s.sid, windows.length);
        return windows.length;
      },
      // SDL_CreatePopupWindow (todos/0256): anchored child, same per-handle
      // tables — presents/events/destroy/owner-resize ride the ordinary
      // per-window paths (see the browser flavor's twin above).
      __sdl_create_popup_window: function (parentHandle, dx, dy, w, h, flags) {
        const pwin = windows[parentHandle - 1];
        if (!pwin) return 0;
        const s = surfaceCreate(0, w, h, flags,
                                { parentSid: pwin.sid, dx: dx, dy: dy });
        if (!s) return 0;
        windows.push({ sid: s.sid, w: w, h: h, fb: s.fb });
        handleBySid.set(s.sid, windows.length);
        return windows.length;
      },
      __sdl_get_display_bounds: displayBounds,   // (todos/0256)
      __sdl_destroy_window: function (handle) {
        const win = windows[handle - 1];
        if (!win) return;
        hooks.surfaceDestroy(win.sid);
        handleBySid.delete(win.sid);
        kFlagsBySid.delete(win.sid);
        windows[handle - 1] = null;
      },
      __sdl_set_window_title: function (handle, titlePtr) {
        const win = windows[handle - 1];
        if (win) hooks.surfaceSetTitle(win.sid, titlePtr ? readString(titlePtr) : '');
      },
      __sdl_set_relative_mouse_mode: setRelativeMouse,
      __sdl_set_cursor: setCursor,          // per-surface cursor (todos/0105)
      __sdl_set_window_size: function (handle, w, h) {
        const win = windows[handle - 1];
        return win ? requestResize(win.sid, w, h) : -1;
      },
      /* The real pixel path: CPU framebuffer -> shm back buffer -> flip
       * (mailbox present; never blocks, newest frame wins). */
      __sdl_update_window_surface: function (handle, pixelsPtr, w, h, pitch) {
        const win = windows[handle - 1];
        return win ? shmPresent(win, pixelsPtr, w, h, pitch) : -1;
      },
      /* Renderer API: null-backend contract (tier 0 — no GPU pixels headless;
       * Dawn or the browser flavor provide them). Validation mirrors
       * createNullSDL so the C<->host contract stays testable. */
      __sdl_create_renderer: function () { return 1; },
      __sdl_destroy_renderer: function () {},
      __sdl_create_texture: function () { nullTextures.push({ scaleMode: 1, blendMode: 0 }); return nullTextures.length; },
      __sdl_destroy_texture: function (t) { if (t > 0 && nullTextures[t - 1]) nullTextures[t - 1] = null; },
      __sdl_update_texture: function () {},
      __sdl_set_texture_color_mod: function () {},
      __sdl_set_texture_alpha_mod: function () {},
      __sdl_set_texture_blend_mode: function (t, mode) {
        if (mode !== 0 && mode !== 1 && mode !== 2 && mode !== 4) throw new Error('SDL: unsupported blend mode ' + mode + ' (supported: NONE=0, BLEND=1, ADD=2, MOD=4)');
        const tx = nullTextures[t - 1]; if (tx) tx.blendMode = mode;
      },
      __sdl_get_texture_blend_mode: function (t) {
        const tx = nullTextures[t - 1]; return tx ? tx.blendMode : 0;
      },
      __sdl_set_texture_scale_mode: function (t, mode) {
        if (mode !== 0 && mode !== 1) throw new Error('SDL: unsupported scale mode ' + mode + ' (supported: NEAREST=0, LINEAR=1)');
        const tx = nullTextures[t - 1]; if (tx) tx.scaleMode = mode;
      },
      __sdl_get_texture_scale_mode: function (t) {
        const tx = nullTextures[t - 1]; return tx ? tx.scaleMode : 1;
      },
      __sdl_set_draw_color: function () {},
      __sdl_set_draw_blend_mode: function () {},
      __sdl_render_clear: function () {},
      __sdl_render_quad: function () {},
      __sdl_render_geometry: function () {},
      __sdl_render_present: function () {},
      __sdl_set_animation_frame_func: function (callbackPtr) { animationFrameFunc = callbackPtr; },
      __sdl_push_key_event: function () {},
      __sdl_push_mouse_button_event: function () {},
      __sdl_push_mouse_motion_event: function () {},
      __sdl_push_mouse_wheel_event: function () {},
      __sdl_push_quit_event: function () {},
      __sdl_get_ticks: function () { if (sdlTicksBase === null) sdlTicksBase = Date.now(); return Date.now() - sdlTicksBase; },
      __sdl_delay: sdlDelay,       // cooperative worker sleep (0224)
      __sdl_pump_wait: pumpWait,   // user32 blocking GetMessage (0058)
      __wait: waitMulti,           // unified multi-source wait (0178)
      // Audio: real source rings into the kernel mixer in both flavors
      // (todos/0017) — see buildAudioEnv above.
    }, audioEnv),
  };
}

// Fullscreen-quad shader for the SDL software-surface blitter: a single
// covering triangle, sampling the uploaded CPU framebuffer texture. UV is
// derived from clip position with Y flipped (texture row 0 is the top).
const BLIT_WGSL = `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let xy = p[i];
  var o: VO;
  o.pos = vec4f(xy, 0.0, 1.0);
  o.uv = xy * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  return textureSample(tex, samp, v.uv);
}
`;

// SDL_Renderer shader: textured quads with per-vertex color (positions are
// already in NDC; color modulates the sampled texel — a 1×1 white texture turns
// it into a solid fill). Alpha-blended.
const RENDER_WGSL = `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) color: vec4f) -> VO {
  var o: VO;
  o.pos = vec4f(pos, 0.0, 1.0);
  o.uv = uv;
  o.color = color;
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(v: VO) -> @location(0) vec4f {
  return textureSample(tex, samp, v.uv) * v.color;
}
`;

// Shared lazy WebGPU context for a canvas: adapter/device acquisition, preferred
// format, and a single configure() (RENDER_ATTACHMENT|COPY_SRC so the canvas is
// snapshot-able). The SDL software blitter AND SDL_Renderer build on this; a
// program uses one or the other, and whichever runs first triggers acquisition.
// Acquisition is async (no JSPI) — callers register whenReady() work and
// drop/buffer frames until the device arrives.
function createCanvasGPU(canvas) {
  const gpu = (typeof navigator !== 'undefined' && navigator.gpu) ? navigator.gpu : null;
  const cg = { gpu: gpu, context: null, device: null, format: null, ready: false, started: false, waiters: [] };
  cg.ensure = function () {
    if (cg.started) return;
    cg.started = true;
    if (!gpu) { console.error('SDL/WebGPU: navigator.gpu missing'); return; }
    try { cg.context = canvas.getContext('webgpu'); }
    catch (e) { console.error('SDL/WebGPU: getContext(webgpu) failed', e); return; }
    if (!cg.context) { console.error('SDL/WebGPU: no webgpu canvas context'); return; }
    gpu.requestAdapter().then(function (ad) {
      if (!ad) throw new Error('no WebGPU adapter');
      return ad.requestDevice();
    }).then(function (dev) {
      cg.device = dev;
      try { dev.addEventListener('uncapturederror', function (ev) { console.error('SDL WebGPU error:', ev.error && ev.error.message); }); } catch (e) {}
      cg.format = gpu.getPreferredCanvasFormat();
      cg.context.configure({
        device: dev, format: cg.format, alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      cg.ready = true;
      const ws = cg.waiters; cg.waiters = [];
      for (const fn of ws) { try { fn(); } catch (e) { console.error(e); } }
    }).catch(function (e) { console.error('SDL/WebGPU: device init failed', e); });
  };
  cg.whenReady = function (cb) { if (cg.ready) cb(); else { cg.waiters.push(cb); cg.ensure(); } };
  return cg;
}

/**
 * Create SDL WASM imports backed by WebGPU (video) and the Web Audio API.
 * SDL_UpdateWindowSurface presents the CPU pixel buffer by uploading it to a
 * texture and drawing a fullscreen quad — so the canvas only ever uses the
 * 'webgpu' context (no Canvas2D), which keeps the SDL_GetWGPUSurface path open.
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas - The canvas element for rendering.
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createBrowserSDL({ canvas, ctx, sharedAudioBuffer, notifyAudio, notifyWindow, onPresent }) {
  const { readString, getMemory, getExports } = ctx;
  // onPresent (todos/WM.md gpu transport): called after every frame actually
  // reaches the canvas (software blit or renderer flush) — the OS surface
  // backend hooks transferToImageBitmap + kernel handoff here.

  const sdlWindows = [];
  const sdlAudioDevices = [];
  let animationFrameFunc = null;
  let sdlTicksBase = null;   // ms baseline captured at SDL_Init (see __sdl_get_ticks)

  // Shared canvas WebGPU context — both the software blitter and SDL_Renderer
  // build on it (a program uses one or the other; first use triggers the async
  // device acquisition).
  const cgpu = createCanvasGPU(canvas);

  // --- WebGPU software-surface blitter (SDL_UpdateWindowSurface) -------------
  // Uploads the CPU framebuffer to a texture and draws a fullscreen quad
  // (replacing Canvas2D putImageData). Lazy on first present; buffers the latest
  // frame until the shared device is ready, then presents synchronously.
  const blit = {
    pipeline: null, sampler: null, bindGroup: null, tex: null, texW: 0, texH: 0,
    ready: false, pending: null,
    // Last presented CPU framebuffer (RGBA), exposed via getLastFrame() for
    // deterministic surface readback (external surface probes + camera capture) —
    // reading the WebGPU canvas back is racy against the rAF present cycle.
    lastFrame: null,
  };
  function blitEnsure() {
    if (blit.pipeline) return;
    cgpu.whenReady(function () {
      if (blit.pipeline) return;
      const dev = cgpu.device;
      blit.sampler = dev.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
      const shader = dev.createShaderModule({ code: BLIT_WGSL });
      blit.pipeline = dev.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format: cgpu.format }] },
        primitive: { topology: 'triangle-list' },
      });
      blit.ready = true;
      if (blit.pending) { const p = blit.pending; blit.pending = null; blitPresent(p.win, p.ptr, p.w, p.h, p.pitch); }
    });
  }
  function blitPresent(win, ptr, w, h, pitch) {
    if (!blit.ready) { blit.pending = { win: win, ptr: ptr, w: w, h: h, pitch: pitch }; blitEnsure(); return; }
    const dev = cgpu.device;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (!blit.tex || blit.texW !== w || blit.texH !== h) {
      if (blit.tex) blit.tex.destroy();
      blit.tex = dev.createTexture({
        size: { width: w, height: h }, format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      blit.texW = w; blit.texH = h;
      blit.bindGroup = dev.createBindGroup({
        layout: blit.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: blit.sampler }, { binding: 1, resource: blit.tex.createView() }],
      });
    }
    // .slice() copies out of (possibly Shared)ArrayBuffer-backed wasm memory; no
    // 256-byte bytesPerRow constraint on queue.writeTexture, so pitch is fine.
    const frameBytes = new Uint8Array(getMemory().buffer, ptr, pitch * h).slice();
    blit.lastFrame = { width: w, height: h, pitch: pitch, pixels: frameBytes };
    dev.queue.writeTexture({ texture: blit.tex }, frameBytes, { offset: 0, bytesPerRow: pitch, rowsPerImage: h }, { width: w, height: h });
    const enc = dev.createCommandEncoder();
    const view = cgpu.context.getCurrentTexture().createView();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(blit.pipeline); pass.setBindGroup(0, blit.bindGroup); pass.draw(3, 1, 0, 0); pass.end();
    dev.queue.submit([enc.finish()]);
    if (onPresent) onPresent(win);   // per-window tail: name the presented window (A4)
  }

  // --- SDL_Renderer (batched 2D quads on WebGPU) ----------------------------
  // One render pass per SDL_RenderPresent: every quad drawn since RenderClear is
  // packed into one vertex buffer and drawn into the canvas. Solid fills use a
  // 1×1 white texture modulated by the per-vertex color. Pipeline is lazy on
  // first CreateRenderer; texture GPU resources materialize at present time
  // (device is ready then), so CreateTexture/UpdateTexture work before the async
  // device arrives. Early presents (pre-device) drop their frame (rAF re-draws).
  const sdlRenderers = [];   // 1-based handles
  const sdlTextures = [];     // 1-based handles (shared across renderers)
  // Textures destroyed mid-frame: SDL keeps a texture alive until the frame that
  // references it has presented, so we defer the GPU resource free to just after
  // the next present instead of destroying it out from under an in-flight draw.
  const pendingTexDestroy = [];
  // One pipeline per SDL blend mode (chosen per draw); a shared explicit bind
  // layout so a texture's bind group works with ANY of them.
  let rdrPipelines = null, rdrSamplerLinear = null, rdrSamplerNearest = null, rdrWhiteView = null, rdrWhiteBind = null, rdrBindLayout = null;
  // ONE persistent vertex buffer reused (and grown) across presents — never
  // created/destroyed per frame. Vertices for a frame accumulate in each
  // renderer's own growable CPU scratch (rd.verts) at draw time, are transformed
  // to NDC once at flush, and uploaded into this buffer. (Replaces the old path
  // that allocated a 48-float array per quad + created/destroyed a GPU buffer
  // every present — O(draws) garbage + a buffer churn per frame.)
  let rdrVbuf = null, rdrVbufSize = 0;
  let rdrCapturePending = false;   // set by getLastFrame(), cleared after readback
  // GPU-side BGRA→RGBA readback blit: fullscreen quad samples the bgra8unorm
  // canvas texture through a nearest sampler → rgba8unorm texture, so the
  // copyTextureToBuffer gives RGBA bytes (no swizzle needed in JS).
  let rdrReadbackPipeline = null, rdrReadbackBindLayout = null, rdrReadbackTex = null, rdrReadbackW = 0, rdrReadbackH = 0;

  // SDL_BLENDMODE → WebGPU blend descriptor (null = NONE, blending disabled).
  // These mirror SDL's documented blend equations:
  //   BLEND: dstRGB = srcRGB*srcA + dstRGB*(1-srcA);  dstA = srcA + dstA*(1-srcA)
  //   ADD:   dstRGB = srcRGB*srcA + dstRGB;           dstA = dstA
  //   MOD:   dstRGB = srcRGB*dstRGB;                  dstA = dstA
  const SDL_BLEND_DESC = {
    0: null,
    1: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } },
    2: { color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
    4: { color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
  };
  function sdlBlendValidate(mode) {
    if (!(mode in SDL_BLEND_DESC)) throw new Error('SDL: unsupported blend mode ' + mode + ' (supported: NONE=0, BLEND=1, ADD=2, MOD=4)');
    return mode;
  }

  function rdrEnsure() {
    if (rdrPipelines) return;
    cgpu.whenReady(function () {
      if (rdrPipelines) return;
      const dev = cgpu.device;
      rdrSamplerLinear = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      rdrSamplerNearest = dev.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
      rdrBindLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      });
      const pipelineLayout = dev.createPipelineLayout({ bindGroupLayouts: [rdrBindLayout] });
      const shader = dev.createShaderModule({ code: RENDER_WGSL });
      const mkPipeline = function (blend) {
        return dev.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module: shader, entryPoint: 'vs',
            buffers: [{
              arrayStride: 32,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x2' },
                { shaderLocation: 2, offset: 16, format: 'float32x4' },
              ],
            }],
          },
          fragment: {
            module: shader, entryPoint: 'fs',
            targets: [blend ? { format: cgpu.format, blend: blend } : { format: cgpu.format }],
          },
          primitive: { topology: 'triangle-list' },
        });
      };
      rdrPipelines = {};
      for (const mode of [0, 1, 2, 4]) rdrPipelines[mode] = mkPipeline(SDL_BLEND_DESC[mode]);
      const white = dev.createTexture({ size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
      dev.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 });
      rdrWhiteView = white.createView();
      rdrWhiteBind = dev.createBindGroup({ layout: rdrBindLayout, entries: [{ binding: 0, resource: rdrSamplerLinear }, { binding: 1, resource: rdrWhiteView }] });
      // Readback blit pipeline: fullscreen quad sampling the canvas texture
      // (bgra8unorm) through a nearest sampler → rgba8unorm output. Sampling
      // a bgra8unorm texture through a WGSL sampler normalises to RGBA in the
      // shader (the GPU does the swizzle), so copyTextureToBuffer from the
      // output gets RGBA bytes — no JS swizzle needed.
      rdrReadbackBindLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      });
      const readbackShader = dev.createShaderModule({ code: BLIT_WGSL });
      rdrReadbackPipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({ bindGroupLayouts: [rdrReadbackBindLayout] }),
        vertex: { module: readbackShader, entryPoint: 'vs' },
        fragment: { module: readbackShader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
    });
  }

  // Materialize + upload a texture's GPU resources (called at present time).
  function texBindGroup(t) {
    const dev = cgpu.device;
    if (!t.view) {
      t.gpuTex = dev.createTexture({ size: { width: t.w, height: t.h }, format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
      t.view = t.gpuTex.createView();
    }
    // Rebuild the bind group whenever it's been invalidated — first materialize,
    // or after SDL_SetTextureScaleMode nulled it to swap samplers. Gating this on
    // !t.view (as before) left a scale-mode change AFTER the texture's first
    // present returning a null bind group: view was already truthy so the block
    // never re-ran. SDL lets a program change scale mode at any time.
    if (!t.bindGroup) {
      const sampler = t.scaleMode === 0 ? rdrSamplerNearest : rdrSamplerLinear;
      t.bindGroup = dev.createBindGroup({ layout: rdrBindLayout, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: t.view }] });
    }
    if (t.dirty && t.cpuPixels) {
      // Upload only the dirty bounding box, sourced from the full cpuPixels buffer
      // (queue.writeTexture has no 256-byte bytesPerRow constraint, so the full
      // stride + a row offset addresses the sub-rect directly). A full-texture
      // update has dx/dy=0 and dw/dh=w/h, so this stays a single full upload.
      const fullPitch = t.w * 4;
      const dx = t.dx, dy = t.dy, dw = t.dx2 - t.dx, dh = t.dy2 - t.dy;
      dev.queue.writeTexture(
        { texture: t.gpuTex, origin: { x: dx, y: dy } },
        t.cpuPixels,
        { offset: dy * fullPitch + dx * 4, bytesPerRow: fullPitch, rowsPerImage: dh },
        { width: dw, height: dh });
      t.dirty = false;
    }
    return t.bindGroup;
  }

  // Each batch entry is a triangle list: { texH, verts:Float32Array, n } where
  // verts is n vertices of [x, y (pixel coords), u, v, r, g, b, a]. A quad is
  // 6 verts (2 triangles); SDL_RenderGeometry contributes its index-resolved
  // triangle soup. Flush packs them all into one vertex buffer (NDC-transforming
  // x,y) and draws one range per entry (so each entry keeps its own texture).
  // GPU→CPU readback for the SDL_Renderer path — ON DEMAND only (triggered by
  // getLastFrame()). The renderer draws straight to the canvas with NO CPU
  // framebuffer, so getLastFrame() (the surface probe + camera capture) would
  // be empty for renderer programs. On a capture frame: (1) a blit pass samples
  // the bgra8unorm canvas texture through a nearest sampler → rgba8unorm texture
  // (GPU does the BGRA→RGBA swizzle); (2) copyTextureToBuffer from the rgba8unorm
  // texture; (3) async map + row-wise unpad in JS (fast .set(), no per-pixel
  // branch). Non-capture frames pay zero GPU readback cost.
  const rb = { buf: null, bufSize: 0, busy: false, pending: null };
  function rdrReadbackEnsure(dev, W, H) {
    if (!rdrReadbackTex || rdrReadbackW !== W || rdrReadbackH !== H) {
      if (rdrReadbackTex) rdrReadbackTex.destroy();
      rdrReadbackTex = dev.createTexture({
        size: { width: W, height: H }, format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      rdrReadbackW = W; rdrReadbackH = H;
    }
  }
  function rdrEncodeReadback(enc, dev, canvasTex, W, H) {
    if (rb.busy) return false;
    rdrReadbackEnsure(dev, W, H);
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256;  // WebGPU 256B row alignment
    const size = bytesPerRow * H;
    if (!rb.buf || rb.bufSize !== size) {
      if (rb.buf) rb.buf.destroy();
      rb.buf = dev.createBuffer({ size: size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      rb.bufSize = size;
    }
    // Second render pass: blit canvas (bgra8unorm, sampled → RGBA in WGSL) →
    // readback texture (rgba8unorm). Nearest sampler for exact pixel values.
    const readbackBind = dev.createBindGroup({
      layout: rdrReadbackBindLayout,
      entries: [{ binding: 0, resource: rdrSamplerNearest }, { binding: 1, resource: canvasTex.createView() }],
    });
    const rpass = enc.beginRenderPass({
      colorAttachments: [{ view: rdrReadbackTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    rpass.setPipeline(rdrReadbackPipeline);
    rpass.setBindGroup(0, readbackBind);
    rpass.draw(3, 1, 0, 0);
    rpass.end();
    // Copy rgba8unorm readback texture → buffer (RGBA bytes, may have padded rows)
    enc.copyTextureToBuffer({ texture: rdrReadbackTex }, { buffer: rb.buf, bytesPerRow: bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    rb.pending = { W: W, H: H, bytesPerRow: bytesPerRow };
    return true;
  }
  function rdrStartReadbackMap() {
    if (!rb.pending || rb.busy) return;
    const p = rb.pending; rb.pending = null; rb.busy = true;
    rb.buf.mapAsync(GPUMapMode.READ).then(function () {
      const padded = new Uint8Array(rb.buf.getMappedRange());
      const W = p.W, H = p.H, bpr = p.bytesPerRow, pitch = W * 4;
      const out = new Uint8Array(pitch * H);
      // Row-wise unpad only — the blit pass already did BGRA→RGBA on the GPU,
      // so the bytes are already RGBA. Use .set() (memcpy speed) per row.
      if (bpr === pitch) {
        out.set(padded.subarray(0, pitch * H));
      } else {
        for (let y = 0; y < H; y++) out.set(padded.subarray(y * bpr, y * bpr + pitch), y * pitch);
      }
      blit.lastFrame = { width: W, height: H, pitch: pitch, pixels: out };
      rb.buf.unmap();
      rb.busy = false;
    }).catch(function (e) { console.error('SDL/WebGPU readback failed', e && e.message); rb.busy = false; });
  }

  // Ensure rd.verts can hold (rd.vertCount + addVerts) vertices (8 floats each),
  // growing by doubling and preserving the vertices already written this frame.
  function rdrReserve(rd, addVerts) {
    const need = (rd.vertCount + addVerts) * 8;
    if (rd.verts && rd.verts.length >= need) return;
    let cap = rd.verts ? rd.verts.length : 4096;   // 512 verts to start
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    if (rd.verts) next.set(rd.verts.subarray(0, rd.vertCount * 8));
    rd.verts = next;
  }
  function rdrResetBatch(rd) { rd.batch = []; rd.vertCount = 0; }

  function rdrFlush(rd) {
    const dev = cgpu.device;
    const W = canvas.width || 1, H = canvas.height || 1;
    const entries = rd.batch;
    const totalVerts = rd.vertCount;
    const verts = rd.verts;
    // Transform this frame's pixel-space vertices to NDC IN PLACE (no new array).
    // Only x,y change; uv/rgba are left as written.
    for (let i = 0; i < totalVerts; i++) {
      const s = i * 8;
      verts[s] = (verts[s] / W) * 2 - 1;
      verts[s + 1] = 1 - (verts[s + 1] / H) * 2;
    }
    // Reuse (and grow) the one persistent vertex buffer — never per-present churn.
    const byteLen = Math.max(32, totalVerts * 8 * 4);
    if (!rdrVbuf || rdrVbufSize < byteLen) {
      if (rdrVbuf) rdrVbuf.destroy();
      let cap = rdrVbufSize || (4096 * 4);
      while (cap < byteLen) cap *= 2;
      rdrVbuf = dev.createBuffer({ size: cap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      rdrVbufSize = cap;
    }
    if (totalVerts) dev.queue.writeBuffer(rdrVbuf, 0, verts, 0, totalVerts * 8);
    const enc = dev.createCommandEncoder();
    const curTex = cgpu.context.getCurrentTexture();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: curTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: rd.clear }] });
    pass.setVertexBuffer(0, rdrVbuf);
    for (const e of entries) {
      pass.setPipeline(rdrPipelines[e.blend]);   // e.blend ∈ {0,1,2,4}, validated when set
      // e.tex is the texture OBJECT captured at draw time (not a slot index), so a
      // texture destroyed mid-frame still renders this frame — its GPU free is
      // deferred until after this submit (pendingTexDestroy).
      pass.setBindGroup(0, e.tex ? texBindGroup(e.tex) : rdrWhiteBind);
      pass.draw(e.n, 1, e.first, 0);
    }
    pass.end();
    // On-demand GPU readback: only when getLastFrame() has been called since the
    // last present (surface probe or camera capture). Encoded in the same command
    // encoder so it's ordered after the draw calls. Non-capture frames skip this
    // entirely — zero GPU→CPU transfer cost.
    let didReadback = false;
    if (rdrCapturePending) {
      rdrCapturePending = false;
      didReadback = rdrEncodeReadback(enc, dev, curTex, W, H);
    }
    dev.queue.submit([enc.finish()]);
    if (didReadback) rdrStartReadbackMap();
    if (onPresent) onPresent(rd.window);   // per-window tail: the renderer's window (A4)
    rdrResetBatch(rd);
    // Now that this frame's draws are submitted, free any textures destroyed since
    // the last present (their GPU resources are no longer referenced by a batch).
    if (pendingTexDestroy.length) {
      for (const tx of pendingTexDestroy) { if (tx.gpuTex) { try { tx.gpuTex.destroy(); } catch (e) {} } }
      pendingTexDestroy.length = 0;
    }
  }

  return {
    [ENV_KEY]: {
      __sdl_init: function (flags) { sdlTicksBase = performance.now(); return 0; },
      __sdl_quit: function () { animationFrameFunc = null; },

      __sdl_create_window: function (title_ptr, x, y, w, h, flags) {
        // No context acquired here — a canvas yields only ONE context type for
        // its lifetime, so we defer to the first present (WebGPU blitter) or to
        // the program's own wgpu* calls (SDL_GetWGPUSurface).
        canvas.width = w;
        canvas.height = h;
        const title = title_ptr ? readString(title_ptr) : '';
        sdlWindows.push({ width: w, height: h, title: title });
        const handle = sdlWindows.length;
        // Carry the window title to the page so it can set document.title (SDL
        // sets the OS window title from the create-window title).
        if (notifyWindow) notifyWindow({ type: 'sdl-window', width: w, height: h, title: title });
        return handle;
      },
      __sdl_destroy_window: function (handle) {
        if (handle > 0 && sdlWindows[handle - 1]) {
          sdlWindows[handle - 1] = null;
        }
      },
      __sdl_set_window_title: function (handle, title_ptr) {
        const win = sdlWindows[handle - 1]; if (!win) return;
        const title = title_ptr ? readString(title_ptr) : '';
        win.title = title;
        if (notifyWindow) notifyWindow({ type: 'sdl-title', title: title });
      },
      // SDL_SetWindowRelativeMouseMode (todos/0018): the page owns the DOM, so
      // carry the request out — it arms click-to-pointer-lock on the canvas and
      // switches mousemove to movementX/Y descriptors while locked.
      __sdl_set_relative_mouse_mode: function (handle, enabled) {
        if (notifyWindow) notifyWindow({ type: 'sdl-relative-mouse', enabled: !!enabled });
      },
      // SDL_SetCursor (todos/0105): the standalone page owns its canvas, so
      // apply the CSS cursor directly (shape -1 = hide). The OS flavor
      // overrides this to route the shape through the kernel instead.
      __sdl_set_cursor: function (handle, shape) {
        if (canvas && canvas.style) canvas.style.cursor = CURSOR_CSS[shape] || 'default';
      },
      // SDL_SetWindowSize (todos/0068): only the kernel-surface flavor can
      // renegotiate a buffer; the standalone page's canvas is the page's.
      __sdl_set_window_size: function () { return -1; },
      // Anchored popups + display bounds are OS-WM concepts (todos/0256):
      // the standalone page has ONE canvas -> clean failure, C sets errors.
      __sdl_create_popup_window: function () { return 0; },
      __sdl_get_display_bounds: function () { return 0; },

      __sdl_update_window_surface: function (handle, pixelsPtr, w, h, pitch) {
        const winInfo = sdlWindows[handle - 1];
        if (!winInfo) return -1;
        blitPresent(handle, pixelsPtr, w, h, pitch);
        return 0;
      },

      /* ---- SDL_Renderer (2D accelerated, batched on WebGPU) ----
         Colors arrive as 0..1 floats (C does the /255). The single draw
         primitive __sdl_render_quad takes 4 dst corners (TL,TR,BR,BL in pixels)
         + a src rect (texture pixels); the C layer composes fill/copy/line/rect
         from it. texH 0 = the 1×1 white texture (solid fill). */
      __sdl_create_renderer: function (window) {
        rdrEnsure();
        // SDL renderers default to SDL_BLENDMODE_NONE for draw ops. verts is a
        // growable CPU scratch (pixel-space vertices for the current frame);
        // vertCount tracks how many are written; batch records draw ranges into it.
        sdlRenderers.push({ window: window, drawColor: [1, 1, 1, 1], drawBlendMode: 0, clear: { r: 0, g: 0, b: 0, a: 1 }, batch: [], verts: null, vertCount: 0 });
        return sdlRenderers.length;
      },
      __sdl_destroy_renderer: function (r) {
        if (r > 0 && sdlRenderers[r - 1]) sdlRenderers[r - 1] = null;
      },
      __sdl_create_texture: function (r, access, w, h) {
        sdlTextures.push({
          w: w, h: h, access: access, cpuPixels: null, pitch: w * 4,
          gpuTex: null, view: null, bindGroup: null, dirty: false,
          colorR: 1, colorG: 1, colorB: 1, alpha: 1,
          blendMode: 0,     // SDL_CreateTexture defaults to SDL_BLENDMODE_NONE
          scaleMode: 1,     // SDL_SCALEMODE_LINEAR (SDL3 default)
        });
        return sdlTextures.length;
      },
      __sdl_destroy_texture: function (t) {
        const tx = sdlTextures[t - 1];
        if (!tx) return;
        sdlTextures[t - 1] = null;
        // Defer the GPU free: the current frame's batch may still reference this
        // texture (it captures the object, not the slot). Freeing now would null a
        // bind group at present. Drained right after the next submit.
        pendingTexDestroy.push(tx);
      },
      __sdl_update_texture: function (t, pixelsPtr, pitch, x, y, w, h) {
        const tx = sdlTextures[t - 1];
        if (!tx) return;
        // Keep cpuPixels as the FULL texture (tightly packed, fullPitch stride) and
        // patch the (x,y,w,h) sub-region into it. A one-pixel update is then O(1),
        // and we only ever read the rect->h rows the caller actually provided
        // (the old code read pitch*texture->h → wrong data + OOB for sub-rects).
        const fullPitch = tx.w * 4;
        if (!tx.cpuPixels || tx.cpuPixels.length !== fullPitch * tx.h) {
          tx.cpuPixels = new Uint8Array(fullPitch * tx.h);
        }
        const mem = new Uint8Array(getMemory().buffer);
        const rowBytes = w * 4;
        for (let row = 0; row < h; row++) {
          const srcOff = pixelsPtr + row * pitch;
          tx.cpuPixels.set(mem.subarray(srcOff, srcOff + rowBytes), (y + row) * fullPitch + x * 4);
        }
        tx.pitch = fullPitch;
        // Union into the dirty bounding box (uploaded at present time).
        if (tx.dirty) {
          tx.dx = Math.min(tx.dx, x); tx.dy = Math.min(tx.dy, y);
          tx.dx2 = Math.max(tx.dx2, x + w); tx.dy2 = Math.max(tx.dy2, y + h);
        } else {
          tx.dx = x; tx.dy = y; tx.dx2 = x + w; tx.dy2 = y + h; tx.dirty = true;
        }
      },
      __sdl_set_texture_color_mod: function (t, rr, gg, bb) {
        const tx = sdlTextures[t - 1]; if (tx) { tx.colorR = rr; tx.colorG = gg; tx.colorB = bb; }
      },
      __sdl_set_texture_alpha_mod: function (t, a) {
        const tx = sdlTextures[t - 1]; if (tx) tx.alpha = a;
      },
      __sdl_set_texture_blend_mode: function (t, mode) {
        const tx = sdlTextures[t - 1]; if (tx) tx.blendMode = sdlBlendValidate(mode);
      },
      __sdl_get_texture_blend_mode: function (t) {
        const tx = sdlTextures[t - 1]; return tx ? tx.blendMode : 0;
      },
      __sdl_set_texture_scale_mode: function (t, mode) {
        const tx = sdlTextures[t - 1];
        if (!tx) return;
        if (mode !== 0 && mode !== 1) throw new Error('SDL: unsupported scale mode ' + mode + ' (supported: NEAREST=0, LINEAR=1)');
        if (tx.scaleMode !== mode) { tx.scaleMode = mode; tx.bindGroup = null; }   // recreate bind group with the right sampler
      },
      __sdl_get_texture_scale_mode: function (t) {
        const tx = sdlTextures[t - 1];
        return tx ? tx.scaleMode : 1;   // SDL3 default LINEAR for an unknown handle
      },
      __sdl_set_draw_color: function (r, rr, gg, bb, aa) {
        const rd = sdlRenderers[r - 1]; if (rd) rd.drawColor = [rr, gg, bb, aa];
      },
      __sdl_set_draw_blend_mode: function (r, mode) {
        const rd = sdlRenderers[r - 1]; if (rd) rd.drawBlendMode = sdlBlendValidate(mode);
      },
      __sdl_render_clear: function (r) {
        const rd = sdlRenderers[r - 1]; if (!rd) return;
        const c = rd.drawColor; rd.clear = { r: c[0], g: c[1], b: c[2], a: c[3] }; rdrResetBatch(rd);
      },
      __sdl_render_quad: function (r, texH, x0, y0, x1, y1, x2, y2, x3, y3, sx, sy, sw, sh) {
        const rd = sdlRenderers[r - 1]; if (!rd) return;
        let cr, cg, cb, ca, u0, u1, v0, v1;
        let tex = null;
        let blend = rd.drawBlendMode;   // textured draws use the texture's mode (below)
        if (texH) {
          const tx = sdlTextures[texH - 1];
          if (!tx) return;
          tex = tx;
          cr = tx.colorR; cg = tx.colorG; cb = tx.colorB; ca = tx.alpha;
          blend = tx.blendMode;
          const tw = tx.w || 1, th = tx.h || 1;
          u0 = sx / tw; u1 = (sx + sw) / tw; v0 = sy / th; v1 = (sy + sh) / th;
        } else {
          const c = rd.drawColor; cr = c[0]; cg = c[1]; cb = c[2]; ca = c[3];
          u0 = 0; u1 = 0; v0 = 0; v1 = 0;
        }
        // TL,TR,BR,BL → two triangles (TL,TR,BR) + (TL,BR,BL). Write the 6 verts
        // straight into the renderer's growable scratch — no per-quad allocation.
        rdrReserve(rd, 6);
        const a = rd.verts; let o = rd.vertCount * 8;
        a[o]=x0;a[o+1]=y0;a[o+2]=u0;a[o+3]=v0;a[o+4]=cr;a[o+5]=cg;a[o+6]=cb;a[o+7]=ca;o+=8;
        a[o]=x1;a[o+1]=y1;a[o+2]=u1;a[o+3]=v0;a[o+4]=cr;a[o+5]=cg;a[o+6]=cb;a[o+7]=ca;o+=8;
        a[o]=x2;a[o+1]=y2;a[o+2]=u1;a[o+3]=v1;a[o+4]=cr;a[o+5]=cg;a[o+6]=cb;a[o+7]=ca;o+=8;
        a[o]=x0;a[o+1]=y0;a[o+2]=u0;a[o+3]=v0;a[o+4]=cr;a[o+5]=cg;a[o+6]=cb;a[o+7]=ca;o+=8;
        a[o]=x2;a[o+1]=y2;a[o+2]=u1;a[o+3]=v1;a[o+4]=cr;a[o+5]=cg;a[o+6]=cb;a[o+7]=ca;o+=8;
        a[o]=x3;a[o+1]=y3;a[o+2]=u0;a[o+3]=v1;a[o+4]=cr;a[o+5]=cg;a[o+6]=cb;a[o+7]=ca;
        rd.batch.push({ tex: tex, n: 6, blend: blend, first: rd.vertCount });
        rd.vertCount += 6;
      },
      // SDL_RenderGeometry: C resolves indices into a flat triangle soup of
      // [x, y, u, v, r, g, b, a] per vertex (vertCount = a multiple of 3); copy it
      // straight into the renderer's scratch as one batch entry. texH 0 = solid.
      __sdl_render_geometry: function (r, texH, vertsPtr, vertCount) {
        const rd = sdlRenderers[r - 1]; if (!rd || vertCount <= 0) return;
        const src = new Float32Array(getMemory().buffer, vertsPtr, vertCount * 8);
        rdrReserve(rd, vertCount);
        rd.verts.set(src, rd.vertCount * 8);
        // Textured geometry uses the texture's blend mode; untextured uses the
        // renderer's draw blend mode.
        const tx = texH ? sdlTextures[texH - 1] : null;
        const blend = tx ? tx.blendMode : rd.drawBlendMode;
        rd.batch.push({ tex: tx, n: vertCount, blend: blend, first: rd.vertCount });
        rd.vertCount += vertCount;
      },
      __sdl_render_present: function (r) {
        const rd = sdlRenderers[r - 1]; if (!rd) return;
        if (!rdrPipelines) { rdrEnsure(); rdrResetBatch(rd); return; }   // drop pre-device frames
        rdrFlush(rd);
      },

      /* ---- Audio ---- */
      /* PCM is written into a SharedArrayBuffer ring buffer. The main thread
       * reads from the same buffer and handles AudioContext scheduling.
       *
       * SharedArrayBuffer layout (see createSharedAudioBuffer):
       *   Int32[0] = writePos (masked mod capacity), Int32[1] = queuedBytes,
       *   Int32[2] = playing
       *   Bytes 16+ = PCM ring buffer data
       */
      __sdl_open_audio_device: function (freq, format, channels) {
        sdlAudioDevices.push({ freq: freq, channels: channels });
        const id = sdlAudioDevices.length;
        if (notifyAudio) notifyAudio({ type: 'audio-open', id: id, freq: freq, format: format, channels: channels });
        return id;
      },
      // Returns the number of bytes ACCEPTED into the ring (may be a partial fill
      // when the ring is nearly full). The C SDL_AudioStream holds whatever isn't
      // accepted in its unbounded backlog and re-pumps it next Put — so audio is
      // never silently dropped (SDL_AudioStream is an unbounded queue).
      __sdl_queue_audio: function (dev, dataPtr, len) {
        if (!sharedAudioBuffer) return 0;   // no ring wired → C keeps it all in backlog
        const sab = sharedAudioBuffer.sharedBuffer;
        const cap = sharedAudioBuffer.bufferSize;
        const control = new Int32Array(sab, 0, WMAU_HDR_BYTES >> 2);
        const ringData = new Uint8Array(sab, WMAU_HDR_BYTES, cap);
        return audioRingPush(control, ringData, cap, getMemory(), dataPtr, len, 1);
      },
      __sdl_get_queued_audio_size: function (dev) {
        if (!sharedAudioBuffer) return 0;   // no ring → ring holds nothing (C adds backlog)
        const control = new Int32Array(sharedAudioBuffer.sharedBuffer, 0, WMAU_HDR_BYTES >> 2);
        return Atomics.load(control, WMAU_QUEUED);
      },
      __sdl_clear_queued_audio: function (dev) {
        if (!sharedAudioBuffer) return;
        const control = new Int32Array(sharedAudioBuffer.sharedBuffer, 0, WMAU_HDR_BYTES >> 2);
        Atomics.store(control, WMAU_QUEUED, 0);
        if (notifyAudio) notifyAudio({ type: 'audio-clear', id: dev });
      },
      __sdl_pause_audio_device: function (dev, pause_on) {
        if (notifyAudio) notifyAudio({ type: 'audio-pause', id: dev, pause: !!pause_on });
      },
      __sdl_close_audio_device: function (dev) {
        if (notifyAudio) notifyAudio({ type: 'audio-close', id: dev });
      },
      __sdl_audio_callback_unsupported: function () { sdlAudioGetCallbackUnsupported(); },

      // The ONE flavor where SDL_Delay genuinely can't be honoured
      // (todos/0224 scoped the old uniform throw down to here): the
      // standalone-browser callback model paces frames via rAF, main() must
      // return, and input/presents ride the message loop — blocking would
      // freeze the page even where Atomics.wait is technically legal. Fails
      // loud; the error surfaces in the graphical sheet's on-screen debug
      // overlay. OS worker processes (createSurfaceSDL) and headless runs
      // (createNullSDL) implement it as a real sleep instead.
      __sdl_delay: function () { sdlDelayUnsupported(); },
      // No OS input ring in this flavor (events are pushed by page listeners,
      // and the main thread must never block) — SDL_WaitEvent* falls back to
      // a nanosleep pace on a 0 return (todos/0161), which itself fails loud
      // on a main thread that cannot Atomics.wait. No kernel WAIT either —
      // __wait callers fall back to their chunked poll on -2 (todos/0178).
      __sdl_pump_wait: function () { return 0; },
      __wait: function () { return -2; },
      // SDL_GetTicks: ms since SDL_Init, full range (C casts to Uint64; no 32-bit
      // wrap). Lazily baseline if ticks are read before SDL_Init.
      __sdl_get_ticks: function () { if (sdlTicksBase === null) sdlTicksBase = performance.now(); return Math.floor(performance.now() - sdlTicksBase); },
      __sdl_set_animation_frame_func: function (callbackPtr) {
        animationFrameFunc = callbackPtr;
      },
    },
    getAnimationFrameFunc: function () { return animationFrameFunc; },
    // Last presented SDL framebuffer (RGBA) for deterministic readback, or null
    // if nothing has been blitted yet. { width, height, pitch, pixels }.
    // Each call arms a readback on the NEXT RenderPresent (on-demand — no GPU
    // readback cost on frames where nothing is capturing).
    getLastFrame: function () { rdrCapturePending = true; return blit.lastFrame; },
    // NESTED workers (OS process workers are workers-of-workers) expose
    // requestAnimationFrame as a global but THROW NotSupportedError on call
    // (Chromium). Latch to a setTimeout pacer on the first failure instead
    // of dying — frame pacing degrades gracefully, the app keeps running.
    // The fallback is deadline-based: a fixed setTimeout(16) after each
    // callback makes the tick period 16ms + callback time, which silently
    // halves the presented frame rate of any app whose frame work is
    // non-trivial (the sameboy-GBC every-other-frame symptom).
    requestAnimationFrame: typeof requestAnimationFrame === 'function'
      ? (function () {
          let rafWorks = true;
          const FRAME_MS = 1000 / 60;
          let nextDue = 0;
          return function (cb) {
            if (rafWorks) {
              try { requestAnimationFrame(cb); return; } catch (e) { rafWorks = false; }
            }
            const now = Date.now();
            if (nextDue <= now) {
              nextDue = now + FRAME_MS;
              setTimeout(cb, 0);
            } else {
              const delay = nextDue - now;
              nextDue += FRAME_MS;
              setTimeout(cb, delay);
            }
          };
        })()
      : null,
    /* Push a key event from external source (e.g. worker message). mod is an
     * SDL_Keymod bitmask, repeat the DOM auto-repeat flag. */
    pushKeyEvent: function (handle, eventType, scancode, sym, mod, repeat) {
      const fn = getExports().__sdl_push_key_event;
      if (fn) fn(handle, eventType, scancode, sym, mod | 0, repeat ? 1 : 0);
    },
    pushQuitEvent: function (handle) {
      const fn = getExports().__sdl_push_quit_event;
      if (fn) fn(handle);
    },
    pushMouseButtonEvent: function (handle, eventType, button, x, y) {
      const fn = getExports().__sdl_push_mouse_button_event;
      if (fn) fn(handle, eventType, button, x, y);   // x,y are float (SDL coords)
    },
    pushMouseMotionEvent: function (handle, x, y, state) {
      const fn = getExports().__sdl_push_mouse_motion_event;
      if (fn) fn(handle, x, y, state | 0);   // state = SDL button-mask
    },
    pushMouseMotionRelEvent: function (handle, dx, dy, state) {
      const fn = getExports().__sdl_push_mouse_motion_rel_event;
      if (fn) fn(handle, dx, dy, state | 0);   // pointer-lock deltas (todos/0018)
    },
    pushMouseWheelEvent: function (handle, x, y, direction) {
      const fn = getExports().__sdl_push_mouse_wheel_event;
      if (fn) fn(handle, x, y, direction | 0);
    },
  };

}

/* ==========================================================================
 * WebGPU — expose the browser's WebGPU JS API to compiled C (webgpu.h).
 *
 * Mirrors createBrowserSDL: returns ENV_KEY-keyed __wgpu_* imports. The host
 * keeps a handle table (int <-> live JS WebGPU object) and receives only
 * PRIMITIVES — __webgpu.c flattens descriptor structs C-side (the compiler's
 * layout is authoritative). Async (requestAdapter/requestDevice) is callback
 * based with NO JSPI: the JS Promise resolves, then we invoke the C trampoline
 * export (__wgpu_call_*_cb) which rebuilds the by-value WGPUStringView and calls
 * the user's callback through its table index. Frames run on the shared SDL rAF
 * loop (wgpuSetMainLoopCallback -> __sdl_set_animation_frame_func). The canvas
 * is the SAME OffscreenCanvas the SDL backend gets. See todos/WEBGPU.md.
 * ========================================================================== */

/* Enum int <-> WebGPU JS string maps. Values mirror webgpu.h exactly. */
/* Full WGPUTextureFormat -> WebGPU string map (mirrors the header exactly;
   single source of truth — WGPU_STR_TO_FORMAT is derived by inverting it).
   0 == Undefined -> undefined (caller substitutes the preferred canvas format).
   Compressed (100+) resolve to strings unconditionally; the browser validates
   the backing feature (texture-compression-bc/etc2/astc) at create time. */
const WGPU_FORMAT_TO_STR = {
  0: undefined,
  1: 'r8unorm', 2: 'r8snorm', 3: 'r8uint', 4: 'r8sint',
  5: 'r16uint', 6: 'r16sint', 7: 'r16float',
  8: 'rg8unorm', 9: 'rg8snorm', 10: 'rg8uint', 11: 'rg8sint',
  12: 'r32float', 13: 'r32uint', 14: 'r32sint',
  15: 'rg16uint', 16: 'rg16sint', 17: 'rg16float',
  18: 'rgba8unorm', 19: 'rgba8unorm-srgb', 20: 'rgba8snorm', 21: 'rgba8uint', 22: 'rgba8sint',
  23: 'bgra8unorm', 24: 'bgra8unorm-srgb',
  25: 'rgb10a2uint', 26: 'rgb10a2unorm', 27: 'rg11b10ufloat', 28: 'rgb9e5ufloat',
  29: 'rg32float', 30: 'rg32uint', 31: 'rg32sint',
  32: 'rgba16uint', 33: 'rgba16sint', 34: 'rgba16float',
  35: 'rgba32float', 36: 'rgba32uint', 37: 'rgba32sint',
  38: 'stencil8',
  40: 'depth16unorm', 41: 'depth24plus', 42: 'depth24plus-stencil8',
  43: 'depth32float', 44: 'depth32float-stencil8',
  /* compressed (feature-gated) */
  100: 'bc1-rgba-unorm', 101: 'bc1-rgba-unorm-srgb', 102: 'bc2-rgba-unorm', 103: 'bc2-rgba-unorm-srgb',
  104: 'bc3-rgba-unorm', 105: 'bc3-rgba-unorm-srgb', 106: 'bc4-r-unorm', 107: 'bc4-r-snorm',
  108: 'bc5-rg-unorm', 109: 'bc5-rg-snorm', 110: 'bc6h-rgb-ufloat', 111: 'bc6h-rgb-float',
  112: 'bc7-rgba-unorm', 113: 'bc7-rgba-unorm-srgb',
  114: 'etc2-rgb8unorm', 115: 'etc2-rgb8unorm-srgb', 116: 'etc2-rgb8a1unorm', 117: 'etc2-rgb8a1unorm-srgb',
  118: 'etc2-rgba8unorm', 119: 'etc2-rgba8unorm-srgb',
  120: 'eac-r11unorm', 121: 'eac-r11snorm', 122: 'eac-rg11unorm', 123: 'eac-rg11snorm',
  124: 'astc-4x4-unorm', 125: 'astc-4x4-unorm-srgb', 126: 'astc-5x4-unorm', 127: 'astc-5x4-unorm-srgb',
  128: 'astc-5x5-unorm', 129: 'astc-5x5-unorm-srgb', 130: 'astc-6x5-unorm', 131: 'astc-6x5-unorm-srgb',
  132: 'astc-6x6-unorm', 133: 'astc-6x6-unorm-srgb', 134: 'astc-8x5-unorm', 135: 'astc-8x5-unorm-srgb',
  136: 'astc-8x6-unorm', 137: 'astc-8x6-unorm-srgb', 138: 'astc-8x8-unorm', 139: 'astc-8x8-unorm-srgb',
  140: 'astc-10x5-unorm', 141: 'astc-10x5-unorm-srgb', 142: 'astc-10x6-unorm', 143: 'astc-10x6-unorm-srgb',
  144: 'astc-10x8-unorm', 145: 'astc-10x8-unorm-srgb', 146: 'astc-10x10-unorm', 147: 'astc-10x10-unorm-srgb',
  148: 'astc-12x10-unorm', 149: 'astc-12x10-unorm-srgb', 150: 'astc-12x12-unorm', 151: 'astc-12x12-unorm-srgb',
};
const WGPU_COMPARE = {
  1: 'never', 2: 'less', 3: 'equal', 4: 'less-equal',
  5: 'greater', 6: 'not-equal', 7: 'greater-equal', 8: 'always',
};
const WGPU_STENCIL_OP = {
  1: 'keep', 2: 'zero', 3: 'replace', 4: 'invert',
  5: 'increment-clamp', 6: 'decrement-clamp', 7: 'increment-wrap', 8: 'decrement-wrap',
};
const WGPU_ERROR_FILTER = { 1: 'validation', 2: 'out-of-memory', 3: 'internal' };
/* Inverse of WGPU_FORMAT_TO_STR (string -> int), derived so the two never drift. */
const WGPU_STR_TO_FORMAT = Object.fromEntries(
  Object.entries(WGPU_FORMAT_TO_STR).filter(([, v]) => v).map(([k, v]) => [v, +k])
);
const WGPU_LOADOP = { 1: 'clear', 2: 'load' };
const WGPU_STOREOP = { 1: 'store', 2: 'discard' };
const WGPU_TOPO = { 0: 'point-list', 1: 'line-list', 2: 'line-strip', 3: 'triangle-list', 4: 'triangle-strip' };
const WGPU_FRONT = { 0: 'ccw', 1: 'cw' };
const WGPU_CULL = { 0: 'none', 1: 'front', 2: 'back' };
const WGPU_ALPHA = { 0: 'opaque', 1: 'opaque', 2: 'premultiplied' };
/* Vertex attribute formats — int (webgpu.h WGPUVertexFormat) -> WebGPU string.
   Full set; values 1-9 historical, 10+ appended (mirror the header exactly). */
const WGPU_VERTEX_FORMAT = {
  1: 'float32', 2: 'float32x2', 3: 'float32x3', 4: 'float32x4',
  5: 'uint32', 6: 'uint32x2', 7: 'uint32x3', 8: 'uint32x4', 9: 'unorm8x4',
  10: 'uint8', 11: 'uint8x2', 12: 'uint8x4',
  13: 'sint8', 14: 'sint8x2', 15: 'sint8x4',
  16: 'unorm8', 17: 'unorm8x2', 18: 'snorm8', 19: 'snorm8x2', 20: 'snorm8x4',
  21: 'uint16', 22: 'uint16x2', 23: 'uint16x4',
  24: 'sint16', 25: 'sint16x2', 26: 'sint16x4',
  27: 'unorm16', 28: 'unorm16x2', 29: 'unorm16x4',
  30: 'snorm16', 31: 'snorm16x2', 32: 'snorm16x4',
  33: 'float16', 34: 'float16x2', 35: 'float16x4',
  36: 'sint32', 37: 'sint32x2', 38: 'sint32x3', 39: 'sint32x4',
  40: 'unorm10-10-10-2', 41: 'unorm8x4-bgra',
};
const WGPU_STEP_MODE = { 0: 'vertex', 1: 'instance' };
/* Buffer binding type — int (WGPUBufferBindingType) -> WGSL/JS string. */
const WGPU_BUFFER_BINDING_TYPE = { 1: 'uniform', 2: 'storage', 3: 'read-only-storage' };
/* Texture/sampler enums — int -> WebGPU JS string. */
const WGPU_ADDRESS_MODE = { 0: 'clamp-to-edge', 1: 'clamp-to-edge', 2: 'repeat', 3: 'mirror-repeat' };
const WGPU_FILTER_MODE = { 0: 'nearest', 1: 'nearest', 2: 'linear' };
const WGPU_TEXTURE_DIMENSION = { 1: '1d', 2: '2d', 3: '3d' };
const WGPU_VIEW_DIMENSION = { 1: '1d', 2: '2d', 3: '2d-array', 4: 'cube', 5: 'cube-array', 6: '3d' };
const WGPU_TEXTURE_ASPECT = { 1: 'all', 2: 'stencil-only', 3: 'depth-only' };
const WGPU_STORAGE_ACCESS = { 1: 'write-only', 2: 'read-only', 3: 'read-write' };
const WGPU_SAMPLER_BINDING_TYPE = { 1: 'filtering', 2: 'non-filtering', 3: 'comparison' };
const WGPU_TEXTURE_SAMPLE_TYPE = { 1: 'float', 2: 'unfilterable-float', 3: 'depth', 4: 'sint', 5: 'uint' };
const WGPU_INDEX_FORMAT = { 1: 'uint16', 2: 'uint32' };
const WGPU_BLEND_OP = { 1: 'add', 2: 'subtract', 3: 'reverse-subtract', 4: 'min', 5: 'max' };
const WGPU_BLEND_FACTOR = {
  0: 'zero', 1: 'one', 2: 'src', 3: 'one-minus-src', 4: 'src-alpha', 5: 'one-minus-src-alpha',
  6: 'dst', 7: 'one-minus-dst', 8: 'dst-alpha', 9: 'one-minus-dst-alpha',
};

/* Strict enum resolvers — fail loud on an unrecognized value instead of
   silently substituting a default (the repo's "surface errors loudly" rule).
   wgpuEnumReq: every value (including 0) must be a real enumerant.
   wgpuEnumOpt: 0 == WGPU*_Undefined -> the spec default; anything else strict. */
function wgpuEnumReq(map, v, name) {
  const s = map[v >>> 0];
  if (s === undefined) throw new Error(name + ': unsupported enum value ' + v);
  return s;
}
function wgpuEnumOpt(map, v, name, dflt) {
  v = v >>> 0;
  if (v === 0) return dflt;
  const s = map[v];
  if (s === undefined) throw new Error(name + ': unsupported enum value ' + v);
  return s;
}
/* Texture format: 0 (Undefined) -> undefined (caller substitutes a default);
   any other value must be a known WGPUTextureFormat or we fail loud. */
function wgpuFormat(v, name) {
  v = v >>> 0;
  if (v === 0) return undefined;
  if (!(v in WGPU_FORMAT_TO_STR)) throw new Error(name + ': unsupported WGPUTextureFormat ' + v);
  return WGPU_FORMAT_TO_STR[v];
}

/* Status codes (must match webgpu.h). */
const WGPU_REQ_SUCCESS = 1, WGPU_REQ_UNAVAILABLE = 2, WGPU_REQ_ERROR = 3;
const WGPU_MAP_SUCCESS = 1, WGPU_MAP_ERROR = 3;

function createBrowserWebGPU({ canvas, ctx, notifyWindow, resolveGpu, shmSurface, onPresent, bindWindow }) {
  const { readString, getMemory, getExports } = ctx;
  /* GPU acquisition: navigator.gpu synchronously when present (browser);
   * otherwise an injected async resolver — the OS headless flavor's lazy Dawn
   * probe (todos/WM.md tier 1). gpuNow latches once the resolver settles so the
   * sync paths keep working. */
  let gpuNow = (typeof navigator !== 'undefined' && navigator.gpu) ? navigator.gpu : null;
  function gpuPromise() {
    if (gpuNow) return Promise.resolve(gpuNow);
    if (resolveGpu) return resolveGpu().then(function (g) { if (g) gpuNow = g; return g; });
    return Promise.resolve(null);
  }
  /* Dawn (resolveGpu) mode: every backend promise is tracked so the exit path
   * can drain before the kernel terminates the worker — worker.terminate()
   * with pending Dawn async events aborts the whole Node process (WM.md spike
   * S3 caveat). ctx.gpuDrain is awaited by runModule's deferred exit path;
   * SIGKILL mid-frame remains the accepted crash risk of the optional tier. */
  const inflight = new Set();
  const dawnDevices = [];
  function track(p) {
    if (!resolveGpu) return p;               /* browser: no drain needed */
    inflight.add(p);
    const drop = function () { inflight.delete(p); };
    p.then(drop, drop);
    return p;
  }
  if (resolveGpu) {
    ctx.gpuDrain = function () {
      return Promise.allSettled(Array.from(inflight)).then(function () {
        for (const d of dawnDevices) { try { d.destroy(); } catch (e) {} }
        /* let destroy's own events settle before the EXIT handshake */
        return new Promise(function (res) { setTimeout(res, 25); });
      });
    };
  }
  const utf8 = new TextDecoder();

  /* Handle table: index 0 == null. Freelist reuses slots so a per-frame churn
   * of textures/views/encoders does not grow the array without bound. */
  const handles = [null];
  const freeList = [];
  /* Active mapped ranges per buffer handle: { range (JS ArrayBuffer), dstPtr,
     size }. getMappedRange records them; unmap flushes wasm staging -> GPU. */
  const mappedRanges = new Map();
  function alloc(obj) {
    if (freeList.length) { const i = freeList.pop(); handles[i] = obj; return i; }
    handles.push(obj); return handles.length - 1;
  }
  function get(h) { return h ? handles[h] : null; }
  function release(h) {
    if (h > 0 && h < handles.length) { handles[h] = null; freeList.push(h); }
  }

  function readStr(ptr, len) {
    if (!ptr) return '';
    if (len < 0) return readString(ptr);  /* WGPU_STRLEN -> null-terminated */
    return utf8.decode(new Uint8Array(getMemory().buffer, ptr, len));
  }
  function entryName(ptr, len) {
    if (!ptr || len === 0) return undefined;  /* let WebGPU pick the sole entry */
    return readStr(ptr, len);
  }
  function preferredFormat() {
    if (shmSurface) return 'rgba8unorm';   /* the shm SAB framebuffer is RGBA8 */
    try { if (gpuNow && gpuNow.getPreferredCanvasFormat) return gpuNow.getPreferredCanvasFormat(); }
    catch (e) {}
    return 'bgra8unorm';
  }
  /* ---- shm present tail (Dawn / headless OS): the "swapchain" is a plain
   * GPUTexture; present = copyTextureToBuffer readback -> the SDL window's shm
   * SAB, flipped mailbox-style — the kernel compositor cannot tell Dawn output
   * from a CPU app (todos/WM.md "The two axes"). Usage/mode literals are the
   * WebGPU spec constants (Dawn's globals are not installed). */
  function shmPresentTail(s) {
    if (!s.tex || !s.device || s.pending) return;  /* mailbox: drop while a readback is in flight */
    /* Per-window binding (A4): a window-bound surface presents into ITS
     * window; only legacy handle-less surfaces fall back to newest-wins. */
    const target = s.winHandle ? shmSurface.byHandle(s.winHandle)
                               : shmSurface.getTarget();
    if (!target) return;                           /* no SDL window to present into */
    const enc = s.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: s.tex },
      { buffer: s.readBuf, bytesPerRow: s.bytesPerRow },
      { width: s.w, height: s.h }
    );
    s.device.queue.submit([enc.finish()]);
    s.pending = true;
    track(s.readBuf.mapAsync(1 /* GPUMapMode.READ */).then(function () {
      let px = new Uint8Array(s.readBuf.getMappedRange());
      if (s.format === 'bgra8unorm') {
        if (!s.scratch || s.scratch.length !== px.length) s.scratch = new Uint8Array(px.length);
        const sc = s.scratch;
        for (let i = 0; i < px.length; i += 4) {
          sc[i] = px[i + 2]; sc[i + 1] = px[i + 1]; sc[i + 2] = px[i]; sc[i + 3] = px[i + 3];
        }
        px = sc;
      }
      shmSurface.present(target, px, s.bytesPerRow, s.w, s.h);
      s.readBuf.unmap();
      s.pending = false;
    }).catch(function (e) { s.pending = false; console.error('wgpu shm present readback failed', e); }));
  }
  /* Unpack packed pipeline-overridable constants into a {name: value} record.
     Ints: [ count, per entry: keyPtr, keyLen ]; values ride a parallel Float64
     array (count doubles). Returns null when there are no constants. */
  function unpackConstants(intsPtr, intsLen, valsPtr) {
    if (!intsPtr || intsLen <= 0) return null;
    const a = new Int32Array(getMemory().buffer, intsPtr, intsLen);
    const count = a[0];
    if (!count) return null;
    const dv = new Float64Array(getMemory().buffer, valsPtr >>> 0, count);
    const out = {};
    let i = 1;
    for (let k = 0; k < count; k++) {
      const keyPtr = a[i++], keyLen = a[i++];
      out[readStr(keyPtr, keyLen)] = dv[k];
    }
    return out;
  }

  function callAdapterCb(cb, status, adapterHandle, ud1, ud2) {
    const fn = getExports().__wgpu_call_adapter_cb;
    if (fn) fn(cb, status, adapterHandle, 0, 0, ud1, ud2);
  }
  function callDeviceCb(cb, status, deviceHandle, ud1, ud2) {
    const fn = getExports().__wgpu_call_device_cb;
    if (fn) fn(cb, status, deviceHandle, 0, 0, ud1, ud2);
  }

  return {
    [ENV_KEY]: {
      __wgpu_create_instance: function () { return alloc({ kind: 'instance' }); },

      /* Handle-less surface (wgpuInstanceCreateSurface — pre-A4 binaries and
       * direct webgpu.h callers): the LEGACY tail. Headless presents into the
       * newest window (getTarget); browser draws on the shared canvas whose
       * present resolves to the last-created window. */
      __wgpu_instance_create_surface: function (instance) {
        if (shmSurface) {
          /* Canvas-less surface (Dawn/headless): the swapchain texture is
           * created at configure time; present is the readback tail. */
          return alloc({ kind: 'surface', shm: true, winHandle: 0, tex: null,
                         w: 0, h: 0,
                         format: null, device: null, readBuf: null, bytesPerRow: 0,
                         pending: false, scratch: null });
        }
        if (!canvas) return 0;
        let gpuCtx = null;
        try { gpuCtx = canvas.getContext('webgpu'); }
        catch (e) { console.error('wgpuInstanceCreateSurface: getContext(webgpu) failed', e); }
        if (!gpuCtx) { console.error('wgpuInstanceCreateSurface: no webgpu canvas context'); return 0; }
        return alloc({ kind: 'surface', gpuCtx: gpuCtx, format: null });
      },

      /* Window-bound surface (SDL_GetWGPUSurface — menu build item 0 / A4):
       * the SDL window handle crosses the import so THIS surface's presents
       * land on THAT window, per-window like the shm path. Headless stores
       * the handle for the readback tail; the browser flavor gets the
       * window's own OffscreenCanvas + present closure from bindWindow.
       * Standalone pages (one real canvas, no bindWindow) use the shared
       * canvas exactly like the handle-less import. */
      __wgpu_instance_create_surface_for_window: function (instance, window) {
        if (shmSurface) {
          if (!shmSurface.byHandle(window)) {
            console.error('SDL_GetWGPUSurface: no such window ' + window);
            return 0;
          }
          return alloc({ kind: 'surface', shm: true, winHandle: window | 0,
                         tex: null, w: 0, h: 0,
                         format: null, device: null, readBuf: null, bytesPerRow: 0,
                         pending: false, scratch: null });
        }
        const b = bindWindow ? bindWindow(window) : null;
        const cnv = b ? b.canvas : canvas;
        if (!cnv) {
          if (bindWindow) console.error('SDL_GetWGPUSurface: no such window ' + window);
          return 0;
        }
        let gpuCtx = null;
        try { gpuCtx = cnv.getContext('webgpu'); }
        catch (e) { console.error('SDL_GetWGPUSurface: getContext(webgpu) failed', e); }
        if (!gpuCtx) { console.error('SDL_GetWGPUSurface: no webgpu canvas context'); return 0; }
        return alloc({ kind: 'surface', gpuCtx: gpuCtx, format: null,
                       canvas: b ? b.canvas : null,
                       present: b ? b.present : null });
      },

      __wgpu_instance_request_adapter: function (instance, cb, ud1, ud2) {
        track(gpuPromise().then(function (g) {
          if (!g) {
            console.error('WebGPU unavailable (no navigator.gpu / headless GPU backend)');
            callAdapterCb(cb, WGPU_REQ_UNAVAILABLE, 0, ud1, ud2);
            return;
          }
          return g.requestAdapter().then(function (ad) {
            if (!ad) { callAdapterCb(cb, WGPU_REQ_UNAVAILABLE, 0, ud1, ud2); return; }
            callAdapterCb(cb, WGPU_REQ_SUCCESS, alloc(ad), ud1, ud2);
          });
        }).catch(function (e) {
          console.error('requestAdapter failed', e);
          callAdapterCb(cb, WGPU_REQ_ERROR, 0, ud1, ud2);
        }));
      },

      __wgpu_adapter_request_device: function (adapter, cb, ud1, ud2) {
        const ad = get(adapter);
        if (!ad) { Promise.resolve().then(function () { callDeviceCb(cb, WGPU_REQ_ERROR, 0, ud1, ud2); }); return; }
        track(ad.requestDevice().then(function (dev) {
          if (!dev) { callDeviceCb(cb, WGPU_REQ_ERROR, 0, ud1, ud2); return; }
          try {
            dev.addEventListener('uncapturederror', function (ev) {
              console.error('WebGPU uncaptured error:', ev.error && ev.error.message);
            });
          } catch (e) {}
          if (resolveGpu) dawnDevices.push(dev);
          callDeviceCb(cb, WGPU_REQ_SUCCESS, alloc(dev), ud1, ud2);
        }).catch(function (e) {
          console.error('requestDevice failed', e);
          callDeviceCb(cb, WGPU_REQ_ERROR, 0, ud1, ud2);
        }));
      },

      __wgpu_device_get_queue: function (device) { const d = get(device); return d ? alloc(d.queue) : 0; },

      __wgpu_surface_get_preferred_format: function (surface) {
        return WGPU_STR_TO_FORMAT[preferredFormat()] || 23;
      },

      __wgpu_surface_configure: function (surface, device, format, usage, width, height, alphaMode, presentMode, viewFormatsPacked, viewFormatsLen) {
        const s = get(surface), d = get(device);
        if (s && s.shm) {
          if (!d) throw new Error('wgpuSurfaceConfigure: invalid device handle');
          const sfmt = wgpuFormat(format, 'surfaceConfigure.format') || preferredFormat();
          if (sfmt !== 'rgba8unorm' && sfmt !== 'bgra8unorm') {
            throw new Error('wgpuSurfaceConfigure: format ' + sfmt + ' unsupported on the shm present tail (rgba8unorm/bgra8unorm only)');
          }
          s.format = sfmt; s.device = d;
          s.w = width >>> 0; s.h = height >>> 0;
          /* OR in texture-usage RENDER_ATTACHMENT(0x10) + COPY_SRC(0x01): the
           * app renders into it and present reads it back. */
          s.tex = d.createTexture({
            size: { width: s.w, height: s.h }, format: sfmt,
            usage: (usage >>> 0) | 0x10 | 0x01,
          });
          s.bytesPerRow = Math.ceil((s.w * 4) / 256) * 256;   /* copyTextureToBuffer alignment */
          s.readBuf = d.createBuffer({ size: s.bytesPerRow * s.h, usage: 0x08 /* COPY_DST */ | 0x01 /* MAP_READ */ });
          s.pending = false;
          return;
        }
        if (!s || !s.gpuCtx || !d) throw new Error('wgpuSurfaceConfigure: invalid surface/device handle');
        const fmt = wgpuFormat(format, 'surfaceConfigure.format') || preferredFormat();
        s.format = fmt;
        /* WebGPU's configure() takes no size — the canvas drawing buffer size IS
         * the surface size. Honor the requested width/height by sizing the
         * surface's OWN canvas (window-bound, A4) or the shared one (legacy),
         * mirroring __sdl_create_window. */
        const cfgCanvas = s.canvas || canvas;
        if (cfgCanvas && width > 0 && height > 0) { cfgCanvas.width = width; cfgCanvas.height = height; }
        // OR in COPY_SRC so the canvas is always read-back-able (snapshots,
        // external surface probes + camera capture); harmless if unused.
        const cfg = { device: d, format: fmt, usage: (usage >>> 0) | GPUTextureUsage.COPY_SRC, alphaMode: wgpuEnumReq(WGPU_ALPHA, alphaMode, 'alphaMode') };
        /* presentMode: a web canvas always presents vsync'd (Fifo). Accept
           Undefined(0)/Fifo(1); anything else is genuinely unsupported here. */
        presentMode = presentMode >>> 0;
        if (presentMode > 1) throw new Error('wgpuSurfaceConfigure: presentMode ' + presentMode + ' unsupported on a web canvas (only Fifo)');
        /* viewFormats packed: [ count, fmt0, ... ] -> additional formats the
           surface texture's views may use (e.g. an -srgb variant). */
        if (viewFormatsPacked && viewFormatsLen > 0) {
          const a = new Int32Array(getMemory().buffer, viewFormatsPacked, viewFormatsLen);
          const count = a[0];
          if (count) {
            const vfs = [];
            for (let i = 0; i < count; i++) vfs.push(wgpuFormat(a[1 + i], 'surfaceConfigure.viewFormats'));
            cfg.viewFormats = vfs;
          }
        }
        s.gpuCtx.configure(cfg);
        /* Reveal the canvas in the emitted page (reuses the SDL window path). */
        if (notifyWindow) notifyWindow({ type: 'sdl-window', width: width, height: height });
      },

      __wgpu_surface_get_current_texture: function (surface) {
        const s = get(surface);
        if (s && s.shm) return s.tex ? alloc(s.tex) : 0;
        if (!s || !s.gpuCtx) return 0;
        try { return alloc(s.gpuCtx.getCurrentTexture()); }
        catch (e) { console.error('getCurrentTexture failed', e); return 0; }
      },

      __wgpu_surface_present: function (surface) {
        const s = get(surface);
        if (s && s.shm) { shmPresentTail(s); return; }
        /* Canvas: presentation is implicit (the browser presents the configured
         * context after the frame). Under the OS the gpu transport hands the
         * finished frame to the kernel here (ImageBitmap handoff) — a
         * window-bound surface (A4) through its own per-window tail, a legacy
         * surface through the shared last-window tail. */
        if (s && s.present) {
          try { s.present(); } catch (e) { console.error('wgpu present handoff failed', e); }
          return;
        }
        if (onPresent) {
          try { onPresent(); } catch (e) { console.error('wgpu present handoff failed', e); }
        }
      },

      __wgpu_texture_create_view: function (texture, format, dimension, baseMip, mipCount, baseLayer, layerCount, aspect) {
        const t = get(texture); if (!t) return 0;
        const desc = {};
        const fmt = wgpuFormat(format, 'textureView.format'); if (fmt) desc.format = fmt;
        if (dimension) desc.dimension = wgpuEnumReq(WGPU_VIEW_DIMENSION, dimension, 'textureView.dimension');
        if (aspect) desc.aspect = wgpuEnumReq(WGPU_TEXTURE_ASPECT, aspect, 'textureView.aspect');
        if (baseMip) desc.baseMipLevel = baseMip >>> 0;
        if (mipCount) desc.mipLevelCount = mipCount >>> 0;
        if (baseLayer) desc.baseArrayLayer = baseLayer >>> 0;
        if (layerCount) desc.arrayLayerCount = layerCount >>> 0;
        return alloc(Object.keys(desc).length ? t.createView(desc) : t.createView());
      },

      __wgpu_device_create_shader_module_wgsl: function (device, codePtr, codeLen) {
        const d = get(device); if (!d) return 0;
        return alloc(d.createShaderModule({ code: readStr(codePtr, codeLen) }));
      },

      __wgpu_device_create_render_pipeline: function (device, vsModule, vsEntry, vsEntryLen, fsModule, fsEntry, fsEntryLen, targetsPacked, targetsLen, topology, stripIndexFormat, cullMode, frontFace, vbLayout, vbLayoutLen, layout, depthEnabled, depthFormat, depthWriteEnabled, depthCompare, depthBias, depthBiasSlopeScale, depthBiasClamp, stencilPacked, sampleCount, sampleMask, alphaToCoverage, vsConstInts, vsConstIntsLen, vsConstVals, fsConstInts, fsConstIntsLen, fsConstVals) {
        const d = get(device); if (!d) return 0;
        const vsConstants = unpackConstants(vsConstInts, vsConstIntsLen, vsConstVals);
        const primitive = {
          topology: wgpuEnumReq(WGPU_TOPO, topology, 'primitive.topology'),
          frontFace: wgpuEnumReq(WGPU_FRONT, frontFace, 'primitive.frontFace'),
          cullMode: wgpuEnumReq(WGPU_CULL, cullMode, 'primitive.cullMode'),
        };
        /* stripIndexFormat: required for indexed strip draws, must be undefined
           for list topologies -> 0 (Undefined) means omit. */
        if (stripIndexFormat) {
          const f = WGPU_INDEX_FORMAT[stripIndexFormat >>> 0];
          if (!f) throw new Error('primitive.stripIndexFormat: unsupported index format ' + stripIndexFormat);
          primitive.stripIndexFormat = f;
        }
        const desc = {
          layout: layout ? get(layout) : 'auto',
          vertex: { module: get(vsModule), entryPoint: entryName(vsEntry, vsEntryLen) },
          primitive: primitive,
        };
        /* Unpack the C-side packed vertex layout (struct-ignorant: a flat int
         * array). Layout: [ bufferCount, per buffer: arrayStride, stepMode,
         * attrCount, per attr: format, byteOffset, shaderLocation ]. */
        if (vbLayout && vbLayoutLen > 0) {
          const a = new Int32Array(getMemory().buffer, vbLayout, vbLayoutLen);
          let i = 0;
          const bufferCount = a[i++];
          const buffers = [];
          for (let b = 0; b < bufferCount; b++) {
            const arrayStride = a[i++] >>> 0;
            const stepMode = a[i++];
            const attrCount = a[i++];
            const attributes = [];
            for (let k = 0; k < attrCount; k++) {
              const fmt = a[i++], off = a[i++] >>> 0, loc = a[i++] >>> 0;
              const fmtStr = WGPU_VERTEX_FORMAT[fmt];
              if (!fmtStr) throw new Error('wgpuDeviceCreateRenderPipeline: unsupported WGPUVertexFormat ' + fmt);
              attributes.push({ format: fmtStr, offset: off, shaderLocation: loc });
            }
            buffers.push({ arrayStride: arrayStride, stepMode: wgpuEnumReq(WGPU_STEP_MODE, stepMode, 'vertex.stepMode'), attributes: attributes });
          }
          desc.vertex.buffers = buffers;
        }
        if (vsConstants) desc.vertex.constants = vsConstants;
        if (fsModule) {
          /* Unpack the C-side packed color targets (MRT). Layout:
             [ targetCount, per target: format, writeMask, blendEnabled,
               colorOp, colorSrc, colorDst, alphaOp, alphaSrc, alphaDst ].
             writeMask is honored as-is (0 == None); the C API requires the
             caller to set it (samples use WGPUColorWriteMask_All). */
          const targets = [];
          if (targetsPacked && targetsLen > 0) {
            const a = new Int32Array(getMemory().buffer, targetsPacked, targetsLen);
            let i = 0;
            const tc = a[i++];
            for (let t = 0; t < tc; t++) {
              const fmt = a[i++], writeMask = a[i++] >>> 0, blendEnabled = a[i++];
              const colorOp = a[i++], colorSrc = a[i++], colorDst = a[i++];
              const alphaOp = a[i++], alphaSrc = a[i++], alphaDst = a[i++];
              const target = {
                format: wgpuFormat(fmt, 'colorTarget.format') || preferredFormat(),
                writeMask: writeMask,
              };
              if (blendEnabled) {
                target.blend = {
                  color: {
                    operation: wgpuEnumOpt(WGPU_BLEND_OP, colorOp, 'blend.color.operation', 'add'),
                    srcFactor: wgpuEnumReq(WGPU_BLEND_FACTOR, colorSrc, 'blend.color.srcFactor'),
                    dstFactor: wgpuEnumReq(WGPU_BLEND_FACTOR, colorDst, 'blend.color.dstFactor'),
                  },
                  alpha: {
                    operation: wgpuEnumOpt(WGPU_BLEND_OP, alphaOp, 'blend.alpha.operation', 'add'),
                    srcFactor: wgpuEnumReq(WGPU_BLEND_FACTOR, alphaSrc, 'blend.alpha.srcFactor'),
                    dstFactor: wgpuEnumReq(WGPU_BLEND_FACTOR, alphaDst, 'blend.alpha.dstFactor'),
                  },
                };
              }
              targets.push(target);
            }
          }
          desc.fragment = {
            module: get(fsModule),
            entryPoint: entryName(fsEntry, fsEntryLen),
            targets: targets,
          };
          const fsConstants = unpackConstants(fsConstInts, fsConstIntsLen, fsConstVals);
          if (fsConstants) desc.fragment.constants = fsConstants;
        }
        if (depthEnabled) {
          const dfmt = WGPU_FORMAT_TO_STR[depthFormat];
          if (!dfmt) throw new Error('createRenderPipeline: unsupported depthStencil format ' + depthFormat);
          const dss = {
            format: dfmt,
            depthWriteEnabled: !!depthWriteEnabled,
            depthCompare: wgpuEnumOpt(WGPU_COMPARE, depthCompare, 'depthStencil.depthCompare', 'always'),
            depthBias: depthBias | 0,
            depthBiasSlopeScale: depthBiasSlopeScale,
            depthBiasClamp: depthBiasClamp,
          };
          /* Packed stencil: [frontCompare, frontFail, frontDepthFail, frontPass,
             backCompare, backFail, backDepthFail, backPass, readMask, writeMask]. */
          if (stencilPacked) {
            const a = new Int32Array(getMemory().buffer, stencilPacked, 10);
            const face = (o) => ({
              compare: wgpuEnumOpt(WGPU_COMPARE, a[o], 'stencil.compare', 'always'),
              failOp: wgpuEnumOpt(WGPU_STENCIL_OP, a[o + 1], 'stencil.failOp', 'keep'),
              depthFailOp: wgpuEnumOpt(WGPU_STENCIL_OP, a[o + 2], 'stencil.depthFailOp', 'keep'),
              passOp: wgpuEnumOpt(WGPU_STENCIL_OP, a[o + 3], 'stencil.passOp', 'keep'),
            });
            dss.stencilFront = face(0);
            dss.stencilBack = face(4);
            dss.stencilReadMask = a[8] >>> 0;
            dss.stencilWriteMask = a[9] >>> 0;
          }
          desc.depthStencil = dss;
        }
        /* Multisample state (MSAA). count defaults to 1; a 0 mask means the
           caller left it unset -> all-ones default. */
        desc.multisample = {
          count: (sampleCount >>> 0) || 1,
          mask: (sampleMask >>> 0) || 0xFFFFFFFF,
          alphaToCoverageEnabled: !!alphaToCoverage,
        };
        return alloc(d.createRenderPipeline(desc));
      },

      __wgpu_device_create_buffer: function (device, size, usage, mappedAtCreation) {
        const d = get(device); if (!d) return 0;
        return alloc(d.createBuffer({ size: size >>> 0, usage: usage >>> 0, mappedAtCreation: !!mappedAtCreation }));
      },

      __wgpu_queue_write_buffer: function (queue, buffer, bufferOffset, dataPtr, size) {
        const q = get(queue), buf = get(buffer);
        if (!q || !buf) throw new Error('wgpuQueueWriteBuffer: invalid queue/buffer handle');
        /* writeBuffer copies synchronously, so a view straight into wasm memory
         * is safe (no retained reference). */
        const src = new Uint8Array(getMemory().buffer, dataPtr, size >>> 0);
        q.writeBuffer(buf, bufferOffset >>> 0, src, 0, size >>> 0);
      },

      __wgpu_render_pass_set_vertex_buffer: function (pass, slot, buffer, offset, size) {
        const p = get(pass); if (!p) return;
        /* size < 0 (i.e. WGPU_WHOLE_SIZE truncated to -1) => rest of buffer. */
        if (size < 0) p.setVertexBuffer(slot >>> 0, get(buffer), offset >>> 0);
        else p.setVertexBuffer(slot >>> 0, get(buffer), offset >>> 0, size >>> 0);
      },

      __wgpu_render_pass_set_index_buffer: function (pass, buffer, format, offset, size) {
        const p = get(pass); if (!p) return;
        const fmt = WGPU_INDEX_FORMAT[format];
        if (!fmt) throw new Error('wgpuRenderPassEncoderSetIndexBuffer: unsupported index format ' + format);
        if (size < 0) p.setIndexBuffer(get(buffer), fmt, offset >>> 0);
        else p.setIndexBuffer(get(buffer), fmt, offset >>> 0, size >>> 0);
      },

      __wgpu_render_pass_draw_indexed: function (pass, indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
        const p = get(pass); if (p) p.drawIndexed(indexCount >>> 0, instanceCount >>> 0, firstIndex >>> 0, baseVertex | 0, firstInstance >>> 0);
      },

      __wgpu_render_pass_set_stencil_reference: function (pass, reference) {
        const p = get(pass); if (p) p.setStencilReference(reference >>> 0);
      },

      __wgpu_device_create_bind_group_layout: function (device, packedPtr, packedLen) {
        const d = get(device); if (!d) return 0;
        /* Packed: [ entryCount, per entry: binding, visibility, kind, detail ]. */
        const a = new Int32Array(getMemory().buffer, packedPtr, packedLen);
        let i = 0;
        const count = a[i++];
        const entries = [];
        for (let e = 0; e < count; e++) {
          const binding = a[i++] >>> 0, visibility = a[i++] >>> 0, kind = a[i++], detail = a[i++];
          const e0 = a[i++], e1 = a[i++], e2 = a[i++]; void e2;   /* e2 reserved */
          const entry = { binding: binding, visibility: visibility };
          if (kind === 0) {
            const t = WGPU_BUFFER_BINDING_TYPE[detail];
            if (!t) throw new Error('createBindGroupLayout: unsupported buffer binding type ' + detail);
            entry.buffer = { type: t, hasDynamicOffset: !!e0 };
          } else if (kind === 1) {
            entry.sampler = { type: wgpuEnumReq(WGPU_SAMPLER_BINDING_TYPE, detail, 'sampler.bindingType') };
          } else if (kind === 2) {
            const tex = { sampleType: wgpuEnumReq(WGPU_TEXTURE_SAMPLE_TYPE, detail, 'texture.sampleType') };
            tex.viewDimension = e0 ? wgpuEnumReq(WGPU_VIEW_DIMENSION, e0, 'texture.viewDimension') : '2d';
            if (e1) tex.multisampled = true;
            entry.texture = tex;
          } else if (kind === 3) {
            const fmt = wgpuFormat(e0, 'storageTexture.format');
            if (!fmt) throw new Error('createBindGroupLayout: storageTexture.format required');
            entry.storageTexture = {
              access: wgpuEnumReq(WGPU_STORAGE_ACCESS, detail, 'storageTexture.access'),
              format: fmt,
              viewDimension: e1 ? wgpuEnumReq(WGPU_VIEW_DIMENSION, e1, 'storageTexture.viewDimension') : '2d',
            };
          } else {
            throw new Error('createBindGroupLayout: unknown entry kind ' + kind);
          }
          entries.push(entry);
        }
        return alloc(d.createBindGroupLayout({ entries: entries }));
      },

      __wgpu_device_create_pipeline_layout: function (device, bglsPtr, count) {
        const d = get(device); if (!d) return 0;
        const a = new Int32Array(getMemory().buffer, bglsPtr, count);
        const bindGroupLayouts = [];
        for (let i = 0; i < count; i++) bindGroupLayouts.push(get(a[i]));
        return alloc(d.createPipelineLayout({ bindGroupLayouts: bindGroupLayouts }));
      },

      __wgpu_device_create_bind_group: function (device, layout, packedPtr, packedLen) {
        const d = get(device); if (!d) return 0;
        /* Packed: [ entryCount, per entry: binding, kind, handle, offset, size ]. */
        const a = new Int32Array(getMemory().buffer, packedPtr, packedLen);
        let i = 0;
        const count = a[i++];
        const entries = [];
        for (let e = 0; e < count; e++) {
          const binding = a[i++] >>> 0, kind = a[i++], handle = a[i++], offset = a[i++] >>> 0, size = a[i++];
          if (kind === 0) {
            const res = { buffer: get(handle), offset: offset };
            if (size > 0) res.size = size >>> 0;
            entries.push({ binding: binding, resource: res });
          } else if (kind === 1) {
            entries.push({ binding: binding, resource: get(handle) });           /* GPUSampler */
          } else if (kind === 2) {
            entries.push({ binding: binding, resource: get(handle) });           /* GPUTextureView */
          } else {
            throw new Error('createBindGroup: unknown entry kind ' + kind);
          }
        }
        return alloc(d.createBindGroup({ layout: get(layout), entries: entries }));
      },

      __wgpu_render_pass_set_bind_group: function (pass, index, group, offsetsPtr, offsetCount) {
        const p = get(pass); if (!p) return;
        offsetCount = offsetCount >>> 0;
        if (offsetCount > 0) {
          const offs = Array.from(new Uint32Array(getMemory().buffer, offsetsPtr >>> 0, offsetCount));
          p.setBindGroup(index >>> 0, get(group), offs);
        } else {
          p.setBindGroup(index >>> 0, get(group));
        }
      },

      __wgpu_device_create_texture: function (device, width, height, depth, format, usage, dimension, mipLevelCount, sampleCount) {
        const d = get(device); if (!d) return 0;
        const fmt = WGPU_FORMAT_TO_STR[format];
        if (!fmt) throw new Error('wgpuDeviceCreateTexture: unsupported format ' + format);
        return alloc(d.createTexture({
          size: { width: width >>> 0, height: height >>> 0, depthOrArrayLayers: (depth >>> 0) || 1 },
          format: fmt,
          usage: usage >>> 0,
          dimension: wgpuEnumOpt(WGPU_TEXTURE_DIMENSION, dimension, 'texture.dimension', '2d'),
          mipLevelCount: (mipLevelCount >>> 0) || 1,
          sampleCount: (sampleCount >>> 0) || 1,
        }));
      },

      __wgpu_device_create_sampler: function (device, addrU, addrV, addrW, magFilter, minFilter, mipmapFilter, lodMinClamp, lodMaxClamp, maxAnisotropy, compare) {
        const d = get(device); if (!d) return 0;
        const sd = {
          addressModeU: wgpuEnumOpt(WGPU_ADDRESS_MODE, addrU, 'sampler.addressModeU', 'clamp-to-edge'),
          addressModeV: wgpuEnumOpt(WGPU_ADDRESS_MODE, addrV, 'sampler.addressModeV', 'clamp-to-edge'),
          addressModeW: wgpuEnumOpt(WGPU_ADDRESS_MODE, addrW, 'sampler.addressModeW', 'clamp-to-edge'),
          magFilter: wgpuEnumOpt(WGPU_FILTER_MODE, magFilter, 'sampler.magFilter', 'nearest'),
          minFilter: wgpuEnumOpt(WGPU_FILTER_MODE, minFilter, 'sampler.minFilter', 'nearest'),
          mipmapFilter: wgpuEnumOpt(WGPU_FILTER_MODE, mipmapFilter, 'sampler.mipmapFilter', 'nearest'),
          lodMinClamp: lodMinClamp,
          lodMaxClamp: lodMaxClamp,
        };
        /* maxAnisotropy 0 is invalid in WebGPU (min 1) -> treat as unset and let
           the spec default (1) apply. compare 0 == Undefined -> a normal
           (non-comparison) sampler; any other value makes it a comparison sampler. */
        maxAnisotropy = maxAnisotropy >>> 0;
        if (maxAnisotropy > 0) sd.maxAnisotropy = maxAnisotropy;
        if (compare) sd.compare = wgpuEnumReq(WGPU_COMPARE, compare, 'sampler.compare');
        return alloc(d.createSampler(sd));
      },

      __wgpu_queue_write_texture: function (queue, texture, mipLevel, ox, oy, oz, aspect, dataPtr, dataSize, offset, bytesPerRow, rowsPerImage, width, height, depth) {
        const q = get(queue), t = get(texture);
        if (!q || !t) throw new Error('wgpuQueueWriteTexture: invalid queue/texture handle');
        /* writeTexture copies synchronously; a view into (non-shared) wasm memory is safe. */
        const src = new Uint8Array(getMemory().buffer, dataPtr, dataSize >>> 0);
        const layout = { offset: offset >>> 0, bytesPerRow: bytesPerRow >>> 0 };
        if (rowsPerImage > 0) layout.rowsPerImage = rowsPerImage >>> 0;
        q.writeTexture(
          { texture: t, mipLevel: mipLevel >>> 0, origin: { x: ox >>> 0, y: oy >>> 0, z: oz >>> 0 } },
          src, layout,
          { width: width >>> 0, height: height >>> 0, depthOrArrayLayers: (depth >>> 0) || 1 }
        );
      },

      __wgpu_cmd_copy_texture_to_buffer: function (encoder, srcTexture, mipLevel, ox, oy, oz, dstBuffer, offset, bytesPerRow, rowsPerImage, width, height, depth) {
        const enc = get(encoder), tex = get(srcTexture), buf = get(dstBuffer);
        if (!enc || !tex || !buf) throw new Error('wgpuCommandEncoderCopyTextureToBuffer: invalid handle');
        const dst = { buffer: buf, offset: offset >>> 0, bytesPerRow: bytesPerRow >>> 0 };
        if (rowsPerImage > 0) dst.rowsPerImage = rowsPerImage >>> 0;
        enc.copyTextureToBuffer(
          { texture: tex, mipLevel: mipLevel >>> 0, origin: { x: ox >>> 0, y: oy >>> 0, z: oz >>> 0 } },
          dst,
          { width: width >>> 0, height: height >>> 0, depthOrArrayLayers: (depth >>> 0) || 1 }
        );
      },

      __wgpu_buffer_map_async: function (buffer, mode, offset, size, cb, ud1, ud2) {
        const buf = get(buffer);
        const callCb = function (status) { const fn = getExports().__wgpu_call_buffer_map_cb; if (fn) fn(cb, status, ud1, ud2); };
        if (!buf) { Promise.resolve().then(function () { callCb(WGPU_MAP_ERROR); }); return; }
        /* size < 0 (i.e. WGPU_WHOLE_SIZE truncated to -1) => rest of buffer. */
        (size < 0 ? buf.mapAsync(mode >>> 0, offset >>> 0) : buf.mapAsync(mode >>> 0, offset >>> 0, size >>> 0))
          .then(function () { callCb(WGPU_MAP_SUCCESS); })
          .catch(function (e) { console.error('wgpuBufferMapAsync failed', e); callCb(WGPU_MAP_ERROR); });
      },

      __wgpu_buffer_get_size: function (buffer) {
        /* Lets the C wrapper resolve WGPU_WHOLE_SIZE/WGPU_WHOLE_MAP_SIZE to
           "rest of buffer" before it allocates the wasm-side staging copy. */
        const buf = get(buffer); return buf ? buf.size : 0;
      },

      __wgpu_buffer_get_mapped_range: function (buffer, offset, size, dstPtr) {
        const buf = get(buffer); if (!buf) throw new Error('wgpuBufferGetMappedRange: invalid buffer handle');
        size = size >>> 0; dstPtr = dstPtr >>> 0;
        const range = buf.getMappedRange(offset >>> 0, size);
        /* read path: seed the wasm staging copy with the current GPU bytes. */
        new Uint8Array(getMemory().buffer, dstPtr, size).set(new Uint8Array(range));
        /* remember for write-back on unmap (mappedAtCreation / MAP_WRITE). */
        let list = mappedRanges.get(buffer);
        if (!list) { list = []; mappedRanges.set(buffer, list); }
        list.push({ range: range, dstPtr: dstPtr, size: size });
      },

      __wgpu_buffer_unmap: function (buffer) {
        const b = get(buffer); if (!b) return;
        const list = mappedRanges.get(buffer);
        if (list) {
          /* flush staging -> GPU mapped range before unmap (write path /
             mappedAtCreation). Harmless for MAP_READ — unmap discards it. */
          for (const m of list) new Uint8Array(m.range).set(new Uint8Array(getMemory().buffer, m.dstPtr, m.size));
          mappedRanges.delete(buffer);
        }
        b.unmap();
      },

      __wgpu_cmd_copy_buffer_to_buffer: function (encoder, src, srcOffset, dst, dstOffset, size) {
        const enc = get(encoder), s = get(src), d = get(dst);
        if (!enc || !s || !d) throw new Error('wgpuCommandEncoderCopyBufferToBuffer: invalid handle');
        enc.copyBufferToBuffer(s, srcOffset >>> 0, d, dstOffset >>> 0, size >>> 0);
      },

      __wgpu_device_create_compute_pipeline: function (device, module, entry, entryLen, layout, constInts, constIntsLen, constVals) {
        const d = get(device); if (!d) return 0;
        const compute = { module: get(module), entryPoint: entryName(entry, entryLen) };
        const constants = unpackConstants(constInts, constIntsLen, constVals);
        if (constants) compute.constants = constants;
        return alloc(d.createComputePipeline({
          layout: layout ? get(layout) : 'auto',
          compute: compute,
        }));
      },

      __wgpu_command_encoder_begin_compute_pass: function (encoder) {
        const enc = get(encoder); return enc ? alloc(enc.beginComputePass()) : 0;
      },

      __wgpu_compute_pass_set_pipeline: function (pass, pipeline) { const p = get(pass); if (p) p.setPipeline(get(pipeline)); },
      __wgpu_compute_pass_set_bind_group: function (pass, index, group, offsetsPtr, offsetCount) {
        const p = get(pass); if (!p) return;
        offsetCount = offsetCount >>> 0;
        if (offsetCount > 0) {
          const offs = Array.from(new Uint32Array(getMemory().buffer, offsetsPtr >>> 0, offsetCount));
          p.setBindGroup(index >>> 0, get(group), offs);
        } else {
          p.setBindGroup(index >>> 0, get(group));
        }
      },
      __wgpu_compute_pass_dispatch: function (pass, x, y, z) { const p = get(pass); if (p) p.dispatchWorkgroups(x >>> 0, y >>> 0, z >>> 0); },
      __wgpu_compute_pass_end: function (pass) { const p = get(pass); if (p) p.end(); },

      __wgpu_device_push_error_scope: function (device, filter) {
        const d = get(device); if (d) d.pushErrorScope(wgpuEnumReq(WGPU_ERROR_FILTER, filter, 'errorScope.filter'));
      },

      __wgpu_device_pop_error_scope: function (device, cb, ud1, ud2) {
        const d = get(device);
        const fire = function (status, type) { const fn = getExports().__wgpu_call_pop_error_cb; if (fn) fn(cb, status, type, ud1, ud2); };
        if (!d) { Promise.resolve().then(function () { fire(3, 5); }); return; }
        d.popErrorScope().then(function (err) {
          if (!err) { fire(1, 1); return; }   /* success status, NoError */
          let type = 4;                        /* internal */
          if (typeof GPUValidationError !== 'undefined' && err instanceof GPUValidationError) type = 2;
          else if (typeof GPUOutOfMemoryError !== 'undefined' && err instanceof GPUOutOfMemoryError) type = 3;
          console.error('WebGPU error scope captured:', err.message);
          fire(1, type);                       /* success status, captured error type */
        }).catch(function (e) { console.error('popErrorScope failed', e); fire(3, 5); });
      },

      __wgpu_device_create_command_encoder: function (device) { const d = get(device); return d ? alloc(d.createCommandEncoder()) : 0; },

      __wgpu_command_encoder_begin_render_pass: function (encoder, colorPacked, colorLen, clearPacked, depthView, depthLoadOp, depthStoreOp, depthClearValue, depthReadOnly, stencilLoadOp, stencilStoreOp, stencilClearValue, stencilReadOnly) {
        const enc = get(encoder);
        if (!enc) return 0;
        /* Unpack the packed color attachments. Ints: [ count, per attachment:
           view, resolveTarget, loadOp, storeOp, depthSlice ]; clearValue rides a
           parallel Float64 array (4 doubles/attachment, in order). */
        const colorAttachments = [];
        if (colorPacked && colorLen > 0) {
          const a = new Int32Array(getMemory().buffer, colorPacked, colorLen);
          const count = a[0];
          const cv = new Float64Array(getMemory().buffer, clearPacked >>> 0, count * 4);
          let i = 1, c = 0;
          for (let k = 0; k < count; k++) {
            const view = a[i++], resolveTarget = a[i++], loadOp = a[i++], storeOp = a[i++], depthSlice = a[i++] >>> 0;
            const colorAtt = {
              view: get(view),
              loadOp: wgpuEnumOpt(WGPU_LOADOP, loadOp, 'colorAttachment.loadOp', 'clear'),
              storeOp: wgpuEnumOpt(WGPU_STOREOP, storeOp, 'colorAttachment.storeOp', 'store'),
              clearValue: { r: cv[c], g: cv[c + 1], b: cv[c + 2], a: cv[c + 3] },
            };
            c += 4;
            if (resolveTarget) colorAtt.resolveTarget = get(resolveTarget);   /* MSAA resolve */
            /* depthSlice is only valid for 3D color attachments; 0xFFFFFFFF
               (WGPU_DEPTH_SLICE_UNDEFINED) means unset -> omit. */
            if (depthSlice !== 0xFFFFFFFF) colorAtt.depthSlice = depthSlice;
            colorAttachments.push(colorAtt);
          }
        }
        const rp = { colorAttachments: colorAttachments };
        if (depthView) {
          const dsa = { view: get(depthView) };
          /* Read-only depth: the aspect is read (for testing) but never written,
             so it must NOT carry load/store ops. Otherwise set the ops + clear. */
          if (depthReadOnly) {
            dsa.depthReadOnly = true;
          } else {
            dsa.depthClearValue = depthClearValue;
            dsa.depthLoadOp = wgpuEnumOpt(WGPU_LOADOP, depthLoadOp, 'depthAttachment.depthLoadOp', 'clear');
            dsa.depthStoreOp = wgpuEnumOpt(WGPU_STOREOP, depthStoreOp, 'depthAttachment.depthStoreOp', 'store');
          }
          /* A stencil aspect (combined depth-stencil format) is read-only or needs
             its own ops. */
          if (stencilReadOnly) {
            dsa.stencilReadOnly = true;
          } else if (stencilLoadOp) {
            dsa.stencilLoadOp = wgpuEnumOpt(WGPU_LOADOP, stencilLoadOp, 'depthAttachment.stencilLoadOp', 'clear');
            dsa.stencilStoreOp = wgpuEnumOpt(WGPU_STOREOP, stencilStoreOp, 'depthAttachment.stencilStoreOp', 'store');
            dsa.stencilClearValue = stencilClearValue >>> 0;
          }
          rp.depthStencilAttachment = dsa;
        }
        return alloc(enc.beginRenderPass(rp));
      },

      __wgpu_render_pass_set_pipeline: function (pass, pipeline) { const p = get(pass); if (p) p.setPipeline(get(pipeline)); },
      __wgpu_render_pass_draw: function (pass, vc, ic, fv, fi) { const p = get(pass); if (p) p.draw(vc >>> 0, ic >>> 0, fv >>> 0, fi >>> 0); },
      __wgpu_render_pass_end: function (pass) { const p = get(pass); if (p) p.end(); },
      __wgpu_command_encoder_finish: function (encoder) { const e = get(encoder); return e ? alloc(e.finish()) : 0; },
      __wgpu_queue_submit_one: function (queue, cmd) { const q = get(queue), c = get(cmd); if (q && c) q.submit([c]); },
      __wgpu_release: function (handle) { release(handle); },
    },
  };
}

/* Null WebGPU backend: resolves the imports in headless/Node so modules always
 * instantiate. Async requests report failure (the program sees a clean error
 * rather than hanging on a never-fired callback). */
function createNullWebGPU(ctx) {
  function failAdapter(cb, ud1, ud2) {
    const fn = ctx && ctx.getExports() && ctx.getExports().__wgpu_call_adapter_cb;
    if (fn) fn(cb, WGPU_REQ_UNAVAILABLE, 0, 0, 0, ud1, ud2);
  }
  function failDevice(cb, ud1, ud2) {
    const fn = ctx && ctx.getExports() && ctx.getExports().__wgpu_call_device_cb;
    if (fn) fn(cb, WGPU_REQ_ERROR, 0, 0, 0, ud1, ud2);
  }
  return {
    [ENV_KEY]: {
      __wgpu_create_instance: function () { return 0; },
      __wgpu_instance_create_surface: function () { return 0; },
      __wgpu_instance_create_surface_for_window: function () { return 0; },
      __wgpu_instance_request_adapter: function (instance, cb, ud1, ud2) {
        Promise.resolve().then(function () { failAdapter(cb, ud1, ud2); });
      },
      __wgpu_adapter_request_device: function (adapter, cb, ud1, ud2) {
        Promise.resolve().then(function () { failDevice(cb, ud1, ud2); });
      },
      __wgpu_device_get_queue: function () { return 0; },
      __wgpu_surface_get_preferred_format: function () { return 23; },
      __wgpu_surface_configure: function () {},
      __wgpu_surface_get_current_texture: function () { return 0; },
      __wgpu_surface_present: function () {},
      __wgpu_texture_create_view: function () { return 0; },
      __wgpu_device_create_shader_module_wgsl: function () { return 0; },
      __wgpu_device_create_render_pipeline: function () { return 0; },
      __wgpu_device_create_buffer: function () { return 0; },
      __wgpu_queue_write_buffer: function () {},
      __wgpu_render_pass_set_vertex_buffer: function () {},
      __wgpu_render_pass_set_index_buffer: function () {},
      __wgpu_render_pass_draw_indexed: function () {},
      __wgpu_render_pass_set_stencil_reference: function () {},
      __wgpu_device_create_bind_group_layout: function () { return 0; },
      __wgpu_device_create_pipeline_layout: function () { return 0; },
      __wgpu_device_create_bind_group: function () { return 0; },
      __wgpu_render_pass_set_bind_group: function () {},
      __wgpu_device_create_texture: function () { return 0; },
      __wgpu_device_create_sampler: function () { return 0; },
      __wgpu_queue_write_texture: function () {},
      __wgpu_cmd_copy_texture_to_buffer: function () {},
      __wgpu_buffer_map_async: function (buffer, mode, offset, size, cb, ud1, ud2) {
        const fn = ctx && ctx.getExports() && ctx.getExports().__wgpu_call_buffer_map_cb;
        Promise.resolve().then(function () { if (fn) fn(cb, WGPU_MAP_ERROR, ud1, ud2); });
      },
      __wgpu_buffer_get_size: function () { return 0; },
      __wgpu_buffer_get_mapped_range: function () {},
      __wgpu_buffer_unmap: function () {},
      __wgpu_cmd_copy_buffer_to_buffer: function () {},
      __wgpu_device_create_compute_pipeline: function () { return 0; },
      __wgpu_command_encoder_begin_compute_pass: function () { return 0; },
      __wgpu_compute_pass_set_pipeline: function () {},
      __wgpu_compute_pass_set_bind_group: function () {},
      __wgpu_compute_pass_dispatch: function () {},
      __wgpu_compute_pass_end: function () {},
      __wgpu_device_push_error_scope: function () {},
      __wgpu_device_pop_error_scope: function (device, cb, ud1, ud2) {
        const fn = ctx && ctx.getExports() && ctx.getExports().__wgpu_call_pop_error_cb;
        Promise.resolve().then(function () { if (fn) fn(cb, 1, 1, ud1, ud2); });  /* success, NoError */
      },
      __wgpu_device_create_command_encoder: function () { return 0; },
      __wgpu_command_encoder_begin_render_pass: function () { return 0; },
      __wgpu_render_pass_set_pipeline: function () {},
      __wgpu_render_pass_draw: function () {},
      __wgpu_render_pass_end: function () {},
      __wgpu_command_encoder_finish: function () { return 0; },
      __wgpu_queue_submit_one: function () {},
      __wgpu_release: function () {},
    },
  };
}

/**
 * SDL_WEB — the shared DOM↔SDL input bridge.
 *
 * The pure (transport-free) half of the web SDL glue, factored out so the two
 * frontends that drive the SDL backend share ONE implementation instead of
 * keeping drifting copies:
 *   - the compiler-emitted self-contained .html page (single worker; glue baked
 *     into the page template + worker script), and
 *   - an external embedder app (workspace-owner worker + disposable run worker;
 *     its own DOM capture glue).
 *
 * host.js is loaded in every context that needs this (emitted page main thread,
 * emitted worker, embedder main thread via loadHostMedia, run worker via loadHost),
 * so this is the natural single home. It is pure: it makes NO assumption about
 * worker topology, transfers, or message channels — each frontend keeps its own.
 * DOM access is duck-typed and only happens inside the mappers (called in-browser
 * only), so requiring host.js in Node stays side-effect-free.
 *
 * Flow: a frontend's DOM listener turns an event into a canonical descriptor
 * (`keyMsg`/`mouseButtonMsg`/`mouseMoveMsg`/`wheelMsg`), posts it across whatever
 * channel it uses, and the worker side feeds it into the live SDL object with
 * `dispatch(sdl, descriptor)`. Descriptor shape:
 *   { kind:'key'|'mousebutton'|'mousemove'|'wheel'|'quit',
 *     eventType?, scancode?, sym?, button?, x?, y? }
 */
const SDL_WEB = (function () {
  /* SDL2/SDL3 event type codes (these values are stable across SDL2 and SDL3). */
  const KEYDOWN = 0x300, KEYUP = 0x301;
  const MOUSEMOTION = 0x400, MOUSEBUTTONDOWN = 0x401, MOUSEBUTTONUP = 0x402, MOUSEWHEEL = 0x403;
  const QUIT = 0x100;

  const NAMED_KEYSYMS = {
    'Enter': 13, 'Escape': 27, 'Backspace': 8, 'Tab': 9, ' ': 32, 'Delete': 127,
  };
  // DOM KeyboardEvent.code → SDL_Scancode (USB-HID usage page, the same numbers
  // SDL uses). Complete enough for real games: letters, digits, punctuation,
  // nav/edit, function, keypad, and modifiers. Previously only arrows/mods/F-keys
  // were mapped, so every letter/digit reported scancode 0 (WASD was dead).
  const SCANCODE_MAP = (function () {
    const m = {
      'Enter': 40, 'Escape': 41, 'Backspace': 42, 'Tab': 43, 'Space': 44,
      'Minus': 45, 'Equal': 46, 'BracketLeft': 47, 'BracketRight': 48, 'Backslash': 49,
      'Semicolon': 51, 'Quote': 52, 'Backquote': 53, 'Comma': 54, 'Period': 55, 'Slash': 56,
      'CapsLock': 57,
      'PrintScreen': 70, 'ScrollLock': 71, 'Pause': 72, 'Insert': 73, 'Home': 74,
      'PageUp': 75, 'Delete': 76, 'End': 77, 'PageDown': 78,
      'ArrowRight': 79, 'ArrowLeft': 80, 'ArrowDown': 81, 'ArrowUp': 82,
      'NumLock': 83, 'NumpadDivide': 84, 'NumpadMultiply': 85, 'NumpadSubtract': 86,
      'NumpadAdd': 87, 'NumpadEnter': 88, 'NumpadDecimal': 99,
      'IntlBackslash': 100, 'ContextMenu': 101,
      'ControlLeft': 224, 'ShiftLeft': 225, 'AltLeft': 226, 'MetaLeft': 227,
      'ControlRight': 228, 'ShiftRight': 229, 'AltRight': 230, 'MetaRight': 231,
    };
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function (c, i) { m['Key' + c] = 4 + i; });   // A=4 … Z=29
    for (let d = 1; d <= 9; d++) { m['Digit' + d] = 29 + d; m['Numpad' + d] = 88 + d; }            // 1=30…9=38, KP1=89…KP9=97
    m['Digit0'] = 39; m['Numpad0'] = 98;
    for (let f = 1; f <= 12; f++) m['F' + f] = 57 + f;                                             // F1=58 … F12=69
    return m;
  })();

  // Numeric keypad keys: SDL reports the KP_* keycode (scancode | mask), not the
  // ASCII digit the DOM resolves them to (e.g. NumLock '1' → SDLK_KP_1, not '1').
  const KP_CODES = {
    'Numpad0': 1, 'Numpad1': 1, 'Numpad2': 1, 'Numpad3': 1, 'Numpad4': 1,
    'Numpad5': 1, 'Numpad6': 1, 'Numpad7': 1, 'Numpad8': 1, 'Numpad9': 1,
    'NumpadDecimal': 1, 'NumpadEnter': 1, 'NumpadAdd': 1, 'NumpadSubtract': 1,
    'NumpadMultiply': 1, 'NumpadDivide': 1,
  };
  function keysym(e) {
    if (e.code && KP_CODES[e.code]) return (SCANCODE_MAP[e.code] || 0) | 0x40000000;
    /* SDL3 keycodes are MODIFIER-APPLIED (unlike SDL2): the event keycode is
       SDL_GetKeyFromScancode(scancode, modstate, true), so Shift+a => SDLK_A
       (65), plain a => 97, Shift+1 => '!' (33). DOM e.key is exactly that
       produced character. Do NOT "fix" this to unshifted SDL2 semantics — see
       todos/SDL3.md (audit false positive) and tests/browser/
       sdl-shifted-keysym-check.mjs, which pins this. */
    if (typeof e.key === 'string' && e.key.length === 1) return e.key.charCodeAt(0);
    /* Astral chars (host IME emoji etc.) arrive as one surrogate pair; the
       ring's keysym word is Int32, so the full code point (≤ U+10FFFF, below
       the 0x40000000 named-key bit) rides it directly. */
    if (typeof e.key === 'string' && e.key.length === 2 &&
        e.key.charCodeAt(0) >= 0xD800 && e.key.charCodeAt(0) <= 0xDBFF)
      return e.key.codePointAt(0);
    if (NAMED_KEYSYMS[e.key] !== undefined) return NAMED_KEYSYMS[e.key];
    return (SCANCODE_MAP[e.code] || 0) | 0x40000000;
  }
  function scancode(e) { return SCANCODE_MAP[e.code] || 0; }

  // DOM modifier state → SDL_Keymod bitmask (SDL_KMOD_*). getModifierState can't
  // tell left vs right, so report the left variant (programs test SDL_KMOD_SHIFT
  // etc, which OR both). AltGraph → RALT, matching SDL's AltGr handling.
  function keymod(e) {
    if (!e || typeof e.getModifierState !== 'function') return 0;
    let m = 0;
    if (e.getModifierState('Shift')) m |= 0x0001;      // KMOD_LSHIFT
    if (e.getModifierState('Control')) m |= 0x0040;    // KMOD_LCTRL
    if (e.getModifierState('Alt')) m |= 0x0100;        // KMOD_LALT
    if (e.getModifierState('Meta')) m |= 0x0400;       // KMOD_LGUI
    if (e.getModifierState('AltGraph')) m |= 0x0200;   // KMOD_RALT
    if (e.getModifierState('CapsLock')) m |= 0x2000;   // KMOD_CAPS
    if (e.getModifierState('NumLock')) m |= 0x1000;    // KMOD_NUM
    if (e.getModifierState('ScrollLock')) m |= 0x8000; // KMOD_SCROLL
    return m;
  }

  // DOM MouseEvent.buttons bitmask → SDL motion-state button mask. The bit order
  // differs: DOM is left=1, right=2, middle=4; SDL is SDL_BUTTON_MASK(b)=1<<(b-1)
  // with left=1, middle=2, right=3.
  function buttonMask(e) {
    const b = (e && e.buttons) | 0;
    let s = 0;
    if (b & 1) s |= 1;    // left   → 1<<0
    if (b & 2) s |= 4;    // right  → 1<<2
    if (b & 4) s |= 2;    // middle → 1<<1
    if (b & 8) s |= 8;    // X1     → 1<<3
    if (b & 16) s |= 16;  // X2     → 1<<4
    return s;
  }

  /* Browser pixel coords → logical SDL window coords, accounting for the
   * canvas's CSS scaling and letterboxing (object-fit: contain). `logical` is
   * the SDL window's {w,h} (e.g. from a notifyWindow event); falls back to the
   * canvas's own size, then its CSS box. */
  function canvasCoords(canvas, e, logical) {
    const rect = canvas.getBoundingClientRect();
    const cw = (logical && logical.w) || canvas.width || rect.width;
    const ch = (logical && logical.h) || canvas.height || rect.height;
    const aspect = cw / ch;
    let rw, rh, ox, oy;
    if (rect.width / rect.height > aspect) {
      rh = rect.height; rw = rh * aspect; ox = (rect.width - rw) / 2; oy = 0;
    } else {
      rw = rect.width; rh = rw / aspect; ox = 0; oy = (rect.height - rh) / 2;
    }
    // SDL mouse coordinates are float (sub-pixel); don't round.
    return {
      x: (e.offsetX - ox) * cw / rw,
      y: (e.offsetY - oy) * ch / rh,
    };
  }

  return {
    KEYDOWN: KEYDOWN, KEYUP: KEYUP,
    MOUSEMOTION: MOUSEMOTION, MOUSEBUTTONDOWN: MOUSEBUTTONDOWN,
    MOUSEBUTTONUP: MOUSEBUTTONUP, MOUSEWHEEL: MOUSEWHEEL, QUIT: QUIT,
    keysym: keysym,
    scancode: scancode,
    canvasCoords: canvasCoords,

    /* DOM event → canonical descriptor. Carries the DOM-only fields the C layer
     * can't derive (mod, repeat, button-mask state, wheel direction); C fills in
     * timestamp, which, xrel/yrel, click-count, and the wheel's mouse position. */
    keyMsg: function (e, down) {
      return { kind: 'key', eventType: down ? KEYDOWN : KEYUP, scancode: scancode(e), sym: keysym(e), mod: keymod(e), repeat: e.repeat ? 1 : 0 };
    },
    mouseButtonMsg: function (canvas, e, down, logical) {
      const c = canvasCoords(canvas, e, logical);
      return { kind: 'mousebutton', eventType: down ? MOUSEBUTTONDOWN : MOUSEBUTTONUP, button: e.button + 1, x: c.x, y: c.y };
    },
    mouseMoveMsg: function (canvas, e, logical) {
      const c = canvasCoords(canvas, e, logical);
      return { kind: 'mousemove', x: c.x, y: c.y, state: buttonMask(e) };
    },
    /* Pointer-locked motion (todos/0018): movementX/Y are CSS-pixel deltas;
     * scale them to logical SDL pixels with the same letterbox math as
     * canvasCoords so sensitivity doesn't change with the CSS zoom. */
    mouseMoveRelMsg: function (canvas, e, logical) {
      const rect = canvas.getBoundingClientRect();
      const cw = (logical && logical.w) || canvas.width || rect.width;
      const ch = (logical && logical.h) || canvas.height || rect.height;
      const aspect = cw / ch;
      const rw = (rect.width / rect.height > aspect) ? rect.height * aspect : rect.width;
      const scale = rw > 0 ? cw / rw : 1;
      return { kind: 'mousemoverel', dx: (e.movementX || 0) * scale, dy: (e.movementY || 0) * scale, state: buttonMask(e) };
    },
    wheelMsg: function (e) {
      // SDL wheel units are NOTCHES (±1 per detent), not pixels: convert DOM
      // deltas per mode — pixels ~100/notch (Chrome), lines 3/notch, pages
      // ~3 notches each.
      const notch = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
      const dx = e.deltaX * notch, dy = e.deltaY * notch;
      // SDL_MouseWheelEvent: +y is AWAY from the user (scroll up), +x is to the
      // right. DOM WheelEvent.deltaY is +down and deltaX is +right, so negate Y
      // and keep X. Values are float (sub-notch precision); direction is NORMAL.
      return { kind: 'wheel', x: dx, y: -dy, direction: 0 };
    },

    /* Worker side: feed a canonical descriptor into the live SDL object. The
     * SDL window handle is always 1 (single-window today, both frontends). */
    dispatch: function (sdl, m) {
      if (!sdl || !m) return;
      switch (m.kind) {
        case 'key': sdl.pushKeyEvent(1, m.eventType, m.scancode, m.sym, m.mod | 0, m.repeat ? 1 : 0); break;
        case 'mousebutton': sdl.pushMouseButtonEvent(1, m.eventType, m.button, m.x, m.y); break;
        case 'mousemove': sdl.pushMouseMotionEvent(1, m.x, m.y, m.state | 0); break;
        case 'mousemoverel': sdl.pushMouseMotionRelEvent(1, m.dx, m.dy, m.state | 0); break;
        case 'wheel': sdl.pushMouseWheelEvent(1, m.x, m.y, m.direction | 0); break;
        case 'quit': sdl.pushQuitEvent(1); break;
      }
    },
  };
})();

/**
 * Create a shared audio buffer for worker-based audio.
 *
 * Layout of the SharedArrayBuffer:
 *   Bytes 0-3:   Int32 writePos (worker-only cursor, masked mod bufferSize)
 *   Bytes 4-7:   Int32 queuedBytes (updated by both sides via Atomics)
 *   Bytes 8-11:  Int32 playing (set by main thread)
 *   Bytes 12-15: (reserved)
 *   Bytes 16+:   PCM ring buffer data (bufferSize bytes)
 *
 * @param {number} bufferSize - Size of the PCM ring buffer in bytes (default 4MB)
 * @returns {{ sharedBuffer: SharedArrayBuffer, bufferSize: number }}
 */
/**
 * Create a shared console buffer for emulator terminal I/O (browser workers).
 * Layout (16-byte header + ring buffer):
 *   Int32[0]: writePos  (producer cursor, masked mod bufferSize; worker-only)
 *   Int32[1]: available (worker adds AFTER copying bytes in, main subtracts
 *             AFTER copying bytes out — the single SPSC synchronization cell)
 *   Int32[2]: termCols  (main writes, worker reads)
 *   Int32[3]: termRows  (main writes, worker reads)
 *   Bytes 16+: ring buffer data
 *
 * Overflow protocol (pty-style blocking backpressure): the producer writes
 * at most (bufferSize - available) bytes, then Atomics.wait()s on
 * `available` until the receiver drains and Atomics.notify()s. So a burst
 * larger than the ring blocks the program — like write(2) to a full pty —
 * instead of lapping the reader and permanently desyncing the stream.
 * The producer therefore MUST run off the receiver's thread (it does: the
 * console_write import lives in the process worker, the receiver on the
 * page's main thread — which couldn't Atomics.wait anyway).
 */
function createSharedConsoleBuffer(bufferSize) {
  bufferSize = bufferSize || 65536;
  const sab = new SharedArrayBuffer(16 + bufferSize);
  /* Set default terminal size */
  const control = new Int32Array(sab, 0, 4);
  Atomics.store(control, 2, 80);
  Atomics.store(control, 3, 24);
  return { sharedBuffer: sab, bufferSize: bufferSize };
}

/**
 * Create a console receiver on the main thread that reads from the shared
 * console buffer and delivers data to a callback (e.g. xterm.js).
 *
 * @param {object} options
 * @param {SharedArrayBuffer} options.sharedBuffer
 * @param {number} options.bufferSize
 * @param {function(Uint8Array)} options.onData - called with raw bytes
 * @returns {{ setTerminalSize, flush, close }}
 */
function createConsoleReceiver(options) {
  const sab = options.sharedBuffer;
  const bufferSize = options.bufferSize;
  const onData = options.onData;
  const control = new Int32Array(sab, 0, 4);
  const ringBuf = new Uint8Array(sab, 16, bufferSize);
  let readPos = 0;

  function flush() {
    const avail = Atomics.load(control, 1);
    if (avail <= 0) return;
    const buf = new Uint8Array(avail);
    for (let i = 0; i < avail; i++) {
      buf[i] = ringBuf[(readPos + i) % bufferSize];
    }
    readPos = (readPos + avail) % bufferSize;
    Atomics.sub(control, 1, avail);
    /* Wake a producer blocked on a full ring (see console_write). */
    Atomics.notify(control, 1);
    onData(buf);
  }

  const interval = setInterval(flush, 16);

  return {
    setTerminalSize: function (cols, rows) {
      Atomics.store(control, 2, cols);
      Atomics.store(control, 3, rows);
    },
    flush: flush,
    close: function () {
      clearInterval(interval);
      flush();
    },
  };
}


function createSharedAudioBuffer(bufferSize) {
  bufferSize = bufferSize || (4 * 1024 * 1024);
  const headerSize = WMAU_HDR_BYTES; /* 4 Int32 fields */
  const sab = new SharedArrayBuffer(headerSize + bufferSize);
  return { sharedBuffer: sab, bufferSize: bufferSize };
}

/**
 * Create an audio player on the main thread that reads from a SharedArrayBuffer
 * written to by a worker. This replicates the original same-thread audio path.
 *
 * @param {object} options
 * @param {SharedArrayBuffer} options.sharedBuffer - The shared audio buffer
 * @param {number} options.bufferSize - PCM ring buffer size
 * @returns {{ handleMessage: function(msg): void, close: function(): void }}
 */
function createAudioReceiver(options) {
  const sab = options.sharedBuffer;
  const bufferSize = options.bufferSize;
  const headerSize = WMAU_HDR_BYTES;
  const control = new Int32Array(sab, 0, headerSize >> 2); /* [writePos, queuedBytes, playing, reserved] */
  const ringData = new Uint8Array(sab, headerSize, bufferSize);

  let devices = {}; /* id -> { ctx, gain, freq, channels, bytesPerSample, isFloat, nextTime, ... } */
  let flushInterval = null;
  let masterVolume = 0.16;

  function handleMessage(msg) {
    if (msg.type === 'audio-open') {
      const ctx = new AudioContext({ sampleRate: msg.freq });
      let bytesPerSample = 2;
      let isFloat = false;
      if (msg.format === 0x8120) { bytesPerSample = 4; isFloat = true; }
      else if (msg.format === 0x8020) { bytesPerSample = 4; }
      else if (msg.format === 0x8008) { bytesPerSample = 1; }
      // Round batchBytes DOWN to a whole-frame boundary. A "frame" is
      // (channels * bytesPerSample) bytes — one sample per channel.
      // Without this, batchBytes can land mid-frame (e.g. 22050 Hz
      // stereo S16 gives 4410 bytes for 50 ms but a frame is 4 bytes,
      // so 4410 / 4 = 1102.5 → the per-sample decode loop ran 1103
      // iterations and read 2 bytes past the chunk's end. The
      // per-sample loop below now also floors `samples` defensively.
      const frameBytes = msg.channels * bytesPerSample;
      const batchBytes = Math.floor(0.05 * msg.freq) * frameBytes;
      const gain = ctx.createGain();
      gain.gain.value = masterVolume;
      gain.connect(ctx.destination);
      devices[msg.id] = {
        ctx: ctx, gain: gain, freq: msg.freq, channels: msg.channels,
        bytesPerSample: bytesPerSample, isFloat: isFloat,
        nextTime: 0, maxInflight: 3, inflight: 0,
        batchBytes: batchBytes,
      };
      if (!flushInterval) {
        flushInterval = setInterval(_flushAll, 20);
      }
    } else if (msg.type === 'audio-pause') {
      const dev = devices[msg.id];
      if (!dev) return;
      if (msg.pause) {
        Atomics.store(control, WMAU_PLAYING, 0);
        dev.ctx.suspend();
      } else {
        Atomics.store(control, WMAU_PLAYING, 1);
        dev.ctx.resume();
        dev.nextTime = dev.ctx.currentTime;
      }
    } else if (msg.type === 'audio-clear') {
      Atomics.store(control, WMAU_QUEUED, 0); /* reset queuedBytes */
      const dev = devices[msg.id];
      if (dev) { dev.inflight = 0; dev.nextTime = dev.ctx.currentTime; }
    } else if (msg.type === 'audio-close') {
      const dev = devices[msg.id];
      if (dev) {
        dev.ctx.close();
        delete devices[msg.id];
      }
    }
  }

  function _flushAll() {
    for (const id in devices) {
      _flushDevice(devices[id]);
    }
  }

  function _flushDevice(device) {
    if (!Atomics.load(control, WMAU_PLAYING)) return; /* not playing */

    const cap = bufferSize;
    while (device.inflight < device.maxInflight) {
      const queuedBytes = Atomics.load(control, WMAU_QUEUED);
      if (queuedBytes < device.batchBytes) break;

      const writePos = Atomics.load(control, WMAU_WPOS);
      const len = device.batchBytes;

      /* Read 'len' bytes from shared ring buffer */
      let readPos = (writePos - queuedBytes);
      readPos = ((readPos % cap) + cap) % cap;
      const chunk = new Uint8Array(len);
      const firstChunk = Math.min(len, cap - readPos);
      chunk.set(ringData.subarray(readPos, readPos + firstChunk));
      if (firstChunk < len) {
        chunk.set(ringData.subarray(0, len - firstChunk), firstChunk);
      }
      Atomics.sub(control, WMAU_QUEUED, len); /* decrement queuedBytes */

      /* Decode PCM into Web Audio buffer */
      // Floor defensively — even with batchBytes aligned to a frame,
      // a downstream caller could legitimately Queue a partial frame.
      const samples = Math.floor(len / (device.bytesPerSample * device.channels));
      const audioBuffer = device.ctx.createBuffer(device.channels, samples, device.freq);
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let ch = 0; ch < device.channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let s = 0; s < samples; s++) {
          const offset = (s * device.channels + ch) * device.bytesPerSample;
          if (device.isFloat) {
            channelData[s] = view.getFloat32(offset, true);
          } else if (device.bytesPerSample === 2) {
            channelData[s] = view.getInt16(offset, true) / 32768;
          } else if (device.bytesPerSample === 1) {
            channelData[s] = (view.getInt8(offset) - 128) / 128;
          } else {
            channelData[s] = view.getInt32(offset, true) / 2147483648;
          }
        }
      }
      const source = device.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(device.gain);
      const startTime = Math.max(device.nextTime, device.ctx.currentTime);
      source.start(startTime);
      device.nextTime = startTime + audioBuffer.duration;
      device.inflight++;
      source.onended = function () { device.inflight--; };
    }
  }

  function close() {
    if (flushInterval) { clearInterval(flushInterval); flushInterval = null; }
    for (const id in devices) {
      devices[id].ctx.close();
    }
    devices = {};
  }

  function setVolume(v) {
    masterVolume = v;
    for (const id in devices) devices[id].gain.gain.value = v;
  }

  return { handleMessage: handleMessage, close: close, setVolume: setVolume };
}

/* Die quietly on EPIPE (e.g. `prog | head`) like a native program killed
   by SIGPIPE (128+13), instead of crashing with an unhandled stream
   'error' event. Only installed for runModule's default writers — callers
   that pass their own writeOut/writeErr handle their own errors. Module
   scope (not per-run) so repeated runModule calls in one process don't
   stack listeners; installExitOnEpipe is idempotent per stream. */
function exitOnEpipe(e) {
  if (e && e.code === 'EPIPE') process.exit(141);
  throw e;
}
function installExitOnEpipe(stream) {
  if (stream.listeners('error').indexOf(exitOnEpipe) === -1) {
    stream.on('error', exitOnEpipe);
  }
}

/**
 * Instantiate and run a compiled WASM module.
 * @param {RunModuleOptions} options
 * @returns {Promise<number>} The exit code from main().
 */
// ───────────────────────────────────────────────────────────────────────────
// Self-service (.ss) module support.
//
// .ss programs are Wasm GC modules with a wholly different host contract than C:
// language values are GC structs/arrays and JS strings (externref via the
// js-string builtin), imports live under the "ss" / "suspend.ss" namespaces,
// and the entry point is _start (not main(argc, argv)). There is no linear-
// memory ABI to marshal — linear memory is used only for __embed/__static data.
//
// This is a faithful port of the *core* import env from the self-hosting repo's
// ss-runtime.js (createCoreEnv + the stdio streams + splitSuspendImports),
// enough to run compute / string / print programs. The JS-interop, OPFS,
// BigInt, SDL and GPU envs are intentionally not ported here — a program that
// needs them will fail to instantiate with a clear missing-import error naming
// exactly what to add next. Only standard Web/JS APIs are used, so this stays
// browser- and Node-portable per the runtime's portability rule.
// ───────────────────────────────────────────────────────────────────────────
function createSsCoreEnv(getInstance) {
  return {
    'str.__hash': function (s) {
      let h = 0x811c9dc5 | 0;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return h;
    },
    'str.fromUTF8Bytes': function (ptr, nbytes) {
      const bytes = new Uint8Array(getInstance().exports.memory.buffer, ptr, nbytes);
      return new TextDecoder().decode(bytes);
    },
    'str.indexOf': function (s, search) { return s.indexOf(search); },
    'str.lastIndexOf': function (s, search) { return s.lastIndexOf(search); },
    'str.includes': function (s, search) { return s.includes(search) ? 1 : 0; },
    'str.startsWith': function (s, prefix) { return s.startsWith(prefix) ? 1 : 0; },
    'str.endsWith': function (s, suffix) { return s.endsWith(suffix) ? 1 : 0; },
    'str._split': function (s, sep) { return s.split(sep); },
    'str.trim': function (s) { return s.trim(); },
    'str.trimStart': function (s) { return s.trimStart(); },
    'str.trimEnd': function (s) { return s.trimEnd(); },
    'str.toUpperCase': function (s) { return s.toUpperCase(); },
    'str.toLowerCase': function (s) { return s.toLowerCase(); },
    'str.repeat': function (s, count) { return s.repeat(count); },
    'str.replace': function (s, search, replacement) { return s.replace(search, replacement); },
    'str.replaceAll': function (s, search, replacement) { return s.replaceAll(search, replacement); },
    'str.padStart': function (s, len, pad) { return s.padStart(len, pad); },
    'str.padEnd': function (s, len, pad) { return s.padEnd(len, pad); },

    'Native.dtos': function (d) { return String(d); },
    'Native.ltos': function (n) { return String(n); },
    'Native.ultos': function (n) { return String(BigInt.asUintN(64, n)); },
    'Native.repr': function (s) { return JSON.stringify(s); },
    'Native.dtoFixed': function (d, prec) { return Number(d).toFixed(prec); },
    'Native.dtoExp': function (d, prec) { return Number(d).toExponential(prec); },
    'Native.fromCharCode': function (code) { return String.fromCharCode(code); },
    'Native.encodeUTF8': function (s, ptr, maxBytes) {
      const buf = new Uint8Array(getInstance().exports.memory.buffer, ptr, maxBytes);
      return new TextEncoder().encodeInto(s, buf).written;
    },
    'Native.computeUTF8Length': function (s) { return new TextEncoder().encode(s).length; },
    'Native.jsarrLen': function (arr) { return arr.length; },
    'Native.jsarrGetStr': function (arr, i) {
      const v = arr[i];
      if (typeof v !== 'string') throw new Error('jsarrGetStr: expected string, got ' + typeof v);
      return v;
    },
    'Native.pow': Math.pow,

    'JSBufferView.copyFromMemory': function (ptr, len) {
      const src = new Uint8Array(getInstance().exports.memory.buffer, ptr, len);
      const ab = new ArrayBuffer(len); new Uint8Array(ab).set(src); return new DataView(ab);
    },
    'JSBufferView.copyToMemory': function (dv, ptr) {
      const dst = new Uint8Array(getInstance().exports.memory.buffer, ptr, dv.byteLength);
      dst.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    },
    'JSBufferView.fromMemory': function (ptr, len) { return new DataView(getInstance().exports.memory.buffer, ptr, len); },
    'JSBufferView.copyInto': function (src, dst) {
      new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength)
        .set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
    },

    'Time._now': function () { return BigInt(Date.now()); },
    'Time._isoString': function (millis) { return new Date(Number(millis)).toISOString(); },

    'Math.PI': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.PI),
    'Math.E': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.E),
    'Math.TAU': new WebAssembly.Global({ value: 'f64', mutable: false }, 2 * Math.PI),
    'Math.LN2': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.LN2),
    'Math.LN10': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.LN10),
    'Math.LOG2E': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.LOG2E),
    'Math.LOG10E': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.LOG10E),
    'Math.SQRT2': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.SQRT2),
    'Math.SQRT1_2': new WebAssembly.Global({ value: 'f64', mutable: false }, Math.SQRT1_2),
    'Math.sin': Math.sin, 'Math.cos': Math.cos, 'Math.tan': Math.tan,
    'Math.asin': Math.asin, 'Math.acos': Math.acos, 'Math.atan': Math.atan, 'Math.atan2': Math.atan2,
    'Math.exp': Math.exp, 'Math.expm1': Math.expm1,
    'Math.log': Math.log, 'Math.log2': Math.log2, 'Math.log10': Math.log10, 'Math.log1p': Math.log1p,
    'Math.pow': Math.pow, 'Math.cbrt': Math.cbrt, 'Math.hypot': Math.hypot,
    'Math.sinh': Math.sinh, 'Math.cosh': Math.cosh, 'Math.tanh': Math.tanh,
    'Math.asinh': Math.asinh, 'Math.acosh': Math.acosh, 'Math.atanh': Math.atanh,
    'Math.random': Math.random,
  };
}

// Move Suspending-wrapped imports from "ss" into the "suspend.ss" namespace,
// matching the split the ss compiler emits (createEnv → splitSuspendImports).
function splitSsSuspendImports(imports) {
  if (!imports['ss']) return;
  const suspend = {};
  let count = 0;
  for (const k of Object.keys(imports['ss'])) {
    if (imports['ss'][k] instanceof WebAssembly.Suspending) { suspend[k] = imports['ss'][k]; delete imports['ss'][k]; count++; }
  }
  if (count > 0) imports['suspend.ss'] = Object.assign(imports['suspend.ss'] || {}, suspend);
}

async function runSsModule(bytes, opts) {
  const writeOut = opts.writeOut, writeErr = opts.writeErr, args = opts.args || [];
  const enc = new TextEncoder();
  const writeStdout = function (s) { writeOut(enc.encode(s)); return s.length; };
  const writeStderr = function (s) { writeErr(enc.encode(s)); return s.length; };

  let instance;
  const stdoutHandle = { __type: 'stdout' };
  const stderrHandle = { __type: 'stderr' };
  const stdinHandle = { __type: 'stdin' };
  const importObject = {
    'ss': {
      'stdin': stdinHandle,
      'stdout': stdoutHandle,
      'stderr': stderrHandle,
      'StandardWriteStream.writeString': function (handle, s) {
        if (handle === stdoutHandle) return writeStdout(s);
        if (handle === stderrHandle) return writeStderr(s);
        throw new Error('StandardWriteStream.writeString: unknown handle');
      },
      'StandardReadStream.readString': function () {
        throw new Error('StandardReadStream.readString: requires a filesystem backend (not ported)');
      },
      'System.args': args,
      'System.getenv': (typeof process !== 'undefined' && process.env)
        ? function (name) { return process.env[name] != null ? process.env[name] : null; }
        : function () { return null; },
      'System.cwd': (typeof process !== 'undefined' && process.cwd)
        ? function () { return process.cwd(); }
        : function () { return '/'; },
    },
  };
  Object.assign(importObject['ss'], createSsCoreEnv(function () { return instance; }));
  splitSsSuspendImports(importObject);

  const module = new WebAssembly.Module(bytes, { builtins: ['js-string'], importedStringConstants: '#' });
  instance = new WebAssembly.Instance(module, importObject);

  const start = instance.exports._start;
  if (typeof start !== 'function') throw new Error('ss module has no _start export');
  const needsAsync = !!importObject['suspend.ss'] && typeof WebAssembly.promising === 'function';
  await (needsAsync ? WebAssembly.promising(start) : start)();
  return 0;
}

async function runModule({
  bytes,
  // Pre-compiled Module (todos/0037): skips the parse+compile below. The
  // kernel ships one for read-only-volume binaries — compiled once
  // kernel-side, structured-cloned per spawn (Modules clone; Instances
  // don't). ss-flavored modules are never shipped this way (they recompile
  // from bytes with different options in runSsModule).
  module: precompiled,
  args,
  env,
  fs: fsModule,
  blockFsImports,
  blockFsFactory,
  stdinSab,
  requestStdin,
  requestTerminalSize,
  requestStdinReady,
  requestStdinNotify,
  sdl: sdlOverride,
  getBrowserSDL,
  onSdl,
  // Process model: { spawn, wait, kill } hooks (the c/ owner worker's process
  // kernel). Absent → createNullSpawn (ENOSYS), so modules linking __spawn still
  // instantiate without a runtime that can create processes.
  spawnHooks,
  // The runtime-minted pid/ppid this process reports via getpid()/getppid().
  // Absent → falls back to process.pid (Node) / 1 (browser).
  pid,
  ppid,
  // Optional LIVE ppid getter (todos/0179): kernel-spawned processes pass a
  // vDSO-page read so getppid() tracks orphan reparenting to init; a null
  // return falls back to the static ppid above.
  getppid,
  sharedAudioBuffer,
  notifyAudio,
  notifyWindow,
  sharedConsoleBuffer,
  notifyConsole,
  writeOut,
  writeErr,
  onReady,
}) {
  /* Default writers COPY the chunk (Buffer.from of a TypedArray copies):
     buf is a raw view into wasm memory, and stream.write queues chunks by
     reference — memory.grow detaches the view and the program reuses the
     region long before an async pipe flush (CONFORMANCE-REMAINING
     "non-copied views into wasm memory"). One memcpy per write, same as
     native stdio. */
  if (!writeOut && typeof process !== 'undefined' && process.stdout) {
    installExitOnEpipe(process.stdout);
    writeOut = function (buf) {
      process.stdout.write(ArrayBuffer.isView(buf) ? Buffer.from(buf) : buf);
    };
  }
  if (!writeErr && typeof process !== 'undefined' && process.stderr) {
    installExitOnEpipe(process.stderr);
    writeErr = function (buf) {
      process.stderr.write(ArrayBuffer.isView(buf) ? Buffer.from(buf) : buf);
    };
  }
  if (!writeOut) writeOut = function () {};
  if (!writeErr) writeErr = function () {};
  const compileOptions = { builtins: ['js-string'], importedStringConstants: '#' };   // MUST MATCH kernel.js _moduleFor
  const module = precompiled || new WebAssembly.Module(bytes, compileOptions);

  /* Flavor dispatch. A module that imports the "ss" namespace is a
     self-service (.ss) program, not C: it uses Wasm GC values + JS-string
     imports and a _start entry — a wholly different host contract from the
     linear-memory C ABI below. Delegate to the ss env and return its exit
     code, leaving the entire C path untouched. */
  if (WebAssembly.Module.imports(module).some(function (i) { return i.module === 'ss'; })) {
    // The ss path recompiles with importedStringConstants, so it needs the
    // bytes. The kernel never ships a pre-compiled Module without them for
    // ss-flavored binaries (its _moduleFor excludes them), so this only
    // trips on a caller passing `module` alone for an ss program.
    if (!bytes) throw new Error('runModule: ss modules require bytes (module option is C-only)');
    return await runSsModule(bytes, { writeOut: writeOut, writeErr: writeErr, args: args });
  }

  const hasJSPI = typeof WebAssembly.Suspending === 'function';

  /* Import object providing host functions */
  const utf8Decoder = new TextDecoder('utf-8');
  /* True ISO-8859-1: byte N -> char code N for ALL 256 values. NOT
   * TextDecoder('latin1'), which per the WHATWG encoding standard is
   * windows-1252 and remaps 0x80-0x9F (0x80 -> U+20AC, 0x94 -> U+201D,
   * ...) — the byte writer's charCodeAt&0xFF then corrupts exactly that
   * range, so one printf %s pass mangled UTF-8 continuation bytes (the
   * em dash e2 80 94 became e2 ac 1d; conformance
   * snprintf_highbyte_roundtrip pins this). */
  function latin1Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 4096)
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
    return out;
  }
  const heapEnd = 0; /* Will be initialized after instance creation */
  /* Helper to read a null-terminated string from WASM memory (UTF-8) */
  function readString(ptr) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer);
    let end = ptr;
    while (bytes[end] !== 0) end++;
    return utf8Decoder.decode(bytes.subarray(ptr, end));
  }

  /* Helper to read a bounded string from WASM memory [ptr, endPtr) (UTF-8) */
  function readStringBounded(ptr, endPtr) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer);
    return utf8Decoder.decode(bytes.subarray(ptr, endPtr));
  }

  /* Read a null-terminated byte string as Latin-1 (1:1 byte-to-char mapping).
   * Use for sprintf internals where bytes must round-trip exactly. */
  function readLatin1(ptr) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer);
    let end = ptr;
    while (bytes[end] !== 0) end++;
    return latin1Decode(bytes.subarray(ptr, end));
  }

  /* Read a bounded byte string as Latin-1. Use for scanf input, where
   * arbitrary (non-UTF-8) bytes must round-trip exactly. */
  function readLatin1Bounded(ptr, endPtr) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer);
    return latin1Decode(bytes.subarray(ptr, endPtr));
  }

  /* Correctly-rounded construction of a float from an exact value
   * M * 2^e2 (M a positive BigInt), rounded to `mantBits` of precision
   * (53 for double, 24 for float) with round-half-even, denormal
   * handling, and overflow to Infinity. `sticky` indicates the exact
   * value had additional nonzero bits below M (e.g. a nonzero division
   * remainder). */
  function roundBinaryExact(M, e2, mantBits, minExp, sticky) {
    if (M === 0n) return 0;
    const bitlen = (x) => x.toString(2).length;
    const emax = mantBits === 53 ? 1023 : 127;
    const lsbMin = minExp - (mantBits - 1); // double: -1074, float: -149
    // Result is R * 2^lsb with R < 2^mantBits and lsb >= lsbMin.
    const lead = bitlen(M) - 1 + e2;        // exponent of M's leading bit
    let lsb = lead - mantBits + 1;
    if (lsb < lsbMin) lsb = lsbMin;         // denormal clamp
    const drop = lsb - e2;                  // low bits of M to discard
    let R;
    if (drop <= 0) {
      R = M << BigInt(-drop);
      // exact; sticky only from the caller (division remainder)
      if (sticky) { /* value sits strictly between representables only
                       when bits were dropped; with none dropped the
                       sticky can't flip rounding of an exact R */ }
    } else {
      const rem = M & ((1n << BigInt(drop)) - 1n);
      R = M >> BigInt(drop);
      const half = 1n << BigInt(drop - 1);
      const roundUp = rem > half ||
        (rem === half && (sticky || (R & 1n) === 1n));
      if (roundUp) R += 1n;
      if (bitlen(R) > mantBits) { R >>= 1n; lsb += 1; } // carry overflow
    }
    if (R === 0n) return 0;                  // rounded down to zero
    const el = bitlen(R) - 1 + lsb;          // exponent of leading bit
    if (el > emax) return Infinity;
    if (mantBits === 53) {
      const dv = new DataView(new ArrayBuffer(8));
      if (el < minExp) {
        // denormal: raw significand = R shifted to lsb 2^-1074
        dv.setBigUint64(0, R << BigInt(lsb - lsbMin), false);
      } else {
        // normal: pad R to exactly 53 bits, drop the implicit leading 1
        const Rn = R << BigInt(mantBits - bitlen(R));
        dv.setBigUint64(0, (BigInt(el + 1023) << 52n) | (Rn & ((1n << 52n) - 1n)), false);
      }
      return dv.getFloat64(0, false);
    } else {
      const dv = new DataView(new ArrayBuffer(4));
      if (el < minExp) {
        dv.setUint32(0, Number(R << BigInt(lsb - lsbMin)), false);
      } else {
        const Rn = R << BigInt(mantBits - bitlen(R));
        dv.setUint32(0, ((el + 127) << 23) | Number(Rn & ((1n << 23n) - 1n)), false);
      }
      return dv.getFloat32(0, false);
    }
  }

  /* Exact decimal D * 10^e10 -> correctly-rounded binary float. */
  function decimalToBinary(D, e10, mantBits, minExp) {
    if (D === 0n) return 0;
    if (e10 >= 0) {
      return roundBinaryExact(D * 10n ** BigInt(e10), 0, mantBits, minExp, false);
    }
    // D / 10^-e10: scale the numerator up so the quotient carries the
    // full target precision plus guard bits, then divide exactly.
    const den = 10n ** BigInt(-e10);
    const guard = mantBits + 3 + den.toString(2).length;
    let shift = guard + den.toString(2).length - D.toString(2).length;
    if (shift < 0) shift = 0;
    const num = D << BigInt(shift);
    const q = num / den;
    const sticky = num % den !== 0n;
    return roundBinaryExact(q, -shift, mantBits, minExp, sticky);
  }

  /* Match a C99 strtod-style floating constant at the start of `rest`.
   * Handles decimal, hex floats (0x1.8p1), and inf/infinity/nan forms,
   * with correct single rounding to the target precision (mantBits:
   * 53 = double, 24 = float). Returns { value, length, special } or
   * null. Shared by strtod/strtof and scanf %f. */
  function matchFloatToken(rest, mantBits) {
    if (mantBits === undefined) mantBits = 53;
    const minExp = mantBits === 53 ? -1022 : -126;
    let m = rest.match(/^[+-]?inf(inity)?/i);
    if (m) {
      return { value: m[0][0] === '-' ? -Infinity : Infinity, length: m[0].length, special: true };
    }
    m = rest.match(/^[+-]?nan(\([0-9a-zA-Z_]*\))?/i);
    if (m) {
      return { value: NaN, length: m[0].length, special: true };
    }
    m = rest.match(/^([+-]?)0[xX]([0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)([pP][+-]?\d+)?/);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      const [ip, fp = ''] = m[2].split('.');
      let M = 0n;
      for (const c of ip + fp) M = M * 16n + BigInt(parseInt(c, 16));
      const exp = (m[3] ? parseInt(m[3].substring(1), 10) : 0) - 4 * fp.length;
      const v = roundBinaryExact(M, exp, mantBits, minExp, false);
      return { value: sign * v, length: m[0].length, special: false };
    }
    m = rest.match(/^([+-]?)(\d+)\.?(\d*)([eE]([+-]?\d+))?/);
    if (!m) m = rest.match(/^([+-]?)()\.(\d+)([eE]([+-]?\d+))?/);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      const D = BigInt((m[2] || '0') + m[3]);
      const e10 = (m[5] ? parseInt(m[5], 10) : 0) - m[3].length;
      const v = decimalToBinary(D, e10, mantBits, minExp);
      return { value: sign * v, length: m[0].length, special: false };
    }
    return null;
  }

  /* --- Exact decimal float formatting (printf %f/%e/%g) ---
   *
   * JS toFixed/toExponential/toPrecision round ties away from zero and
   * drop the sign of -0; C printf rounds the EXACT binary value with
   * ties-to-even. A double is m·2^e, so its decimal expansion is finite
   * and exactly computable with BigInt (2^-k scales to 5^k/10^k); we
   * round that expansion at the requested digit. */

  /* |val| = int / 10^frac, exactly. Finite val only. */
  function floatExactDecimal(val) {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = val;
    const bits = new DataView(buf).getBigUint64(0, true);
    const expBits = Number((bits >> 52n) & 0x7ffn);
    let mant = bits & 0xfffffffffffffn;
    let e2;
    if (expBits === 0) { e2 = -1074; /* denormal */ }
    else { mant |= 0x10000000000000n; e2 = expBits - 1075; }
    if (e2 >= 0) return { int: mant << BigInt(e2), frac: 0 };
    return { int: mant * 5n ** BigInt(-e2), frac: -e2 };
  }

  /* round(I / 10^(frac-p)) with ties-to-even — i.e. I/10^frac rounded to
   * p fractional digits, returned scaled by 10^p. */
  function roundDecimalHalfEven(I, frac, p) {
    if (frac <= p) return I * 10n ** BigInt(p - frac);
    const pow = 10n ** BigInt(frac - p);
    let q = I / pow;
    const r = I % pow;
    const half = pow / 2n;
    if (r > half || (r === half && (q & 1n) === 1n)) q += 1n;
    return q;
  }

  /* %f body for |val| with `prec` fractional digits (no sign). */
  function fmtFixedExact(val, prec) {
    const { int: I, frac } = floatExactDecimal(val);
    const q = roundDecimalHalfEven(I, frac, prec).toString();
    if (prec === 0) return q;
    const s = q.padStart(prec + 1, '0');
    return s.slice(0, -prec) + '.' + s.slice(-prec);
  }

  /* %e body for |val|: mantissa with `prec` fractional digits + decimal
   * exponent. Returns { mant, exp }. */
  function fmtExpExact(val, prec) {
    const { int: I, frac } = floatExactDecimal(val);
    if (I === 0n) {
      return { mant: prec > 0 ? '0.' + '0'.repeat(prec) : '0', exp: 0 };
    }
    let s = I.toString();
    let E = (s.length - 1) - frac;
    const need = prec + 1; /* significant digits */
    if (s.length > need) {
      let qs = roundDecimalHalfEven(I, s.length, need).toString();
      if (qs.length > need) { E += qs.length - need; qs = qs.slice(0, need); }
      s = qs;
    } else if (s.length < need) {
      s = s + '0'.repeat(need - s.length);
    }
    return { mant: prec > 0 ? s[0] + '.' + s.slice(1) : s[0], exp: E };
  }

  /* Render a decimal exponent C-style: at least two digits, always signed. */
  function fmtExponent(E) {
    const a = Math.abs(E).toString().padStart(2, '0');
    return (E < 0 ? '-' : '+') + a;
  }

  /* Create a varargs reader closure for the given va_args pointer */
  function createVaReader(va_args_ptr) {
    let arg_offset = 0;
    return function readArg(type) {
      const memory = instance.exports.memory;
      const view = new DataView(memory.buffer);
      const ptr = va_args_ptr + arg_offset;
      arg_offset += 8;
      switch (type) {
        case 'i32': return view.getInt32(ptr, true);
        case 'u32': return view.getUint32(ptr, true);
        case 'i64': return view.getBigInt64(ptr, true);
        case 'u64': return view.getBigUint64(ptr, true);
        case 'f64': return view.getFloat64(ptr, true);
        case 'ptr': return view.getUint32(ptr, true);
        default: return view.getInt32(ptr, true);
      }
    };
  }

  /*
   * Format a string using printf-style format specifiers.
   *
   * Parameters:
   *   fmt_ptr: pointer to format string in WASM memory
   *   va_args_ptr: pointer to variadic arguments area (8-byte aligned slots)
   *   onN: optional callback for %n specifier: onN(ptr, charsWrittenSoFar)
   *
   * Returns: the formatted string
   */
  function formatString(fmt_ptr, va_args_ptr, onN) {
    const fmt = readLatin1(fmt_ptr);
    let output = "";
    const readArg = createVaReader(va_args_ptr);

    let i = 0;
    while (i < fmt.length) {
      if (fmt[i] !== '%') {
        output += fmt[i++];
        continue;
      }
      i++; /* skip '%' */
      if (i >= fmt.length) break;

      /* Parse flags */
      const flags = { minus: false, plus: false, space: false, hash: false, zero: false };
      while (i < fmt.length) {
        if (fmt[i] === '-') flags.minus = true;
        else if (fmt[i] === '+') flags.plus = true;
        else if (fmt[i] === ' ') flags.space = true;
        else if (fmt[i] === '#') flags.hash = true;
        else if (fmt[i] === '0') flags.zero = true;
        else break;
        i++;
      }

      /* Parse width */
      let width = 0;
      if (fmt[i] === '*') {
        width = readArg('i32');
        /* C11 7.21.6.1p5: a negative field width argument is taken as a
           '-' flag followed by a positive field width. */
        if (width < 0) {
          flags.minus = true;
          width = -width;
        }
        i++;
      } else {
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
          width = width * 10 + (fmt[i].charCodeAt(0) - 48);
          i++;
        }
      }

      /* Parse precision */
      let precision = -1;
      if (fmt[i] === '.') {
        i++;
        precision = 0;
        if (fmt[i] === '*') {
          precision = readArg('i32');
          i++;
        } else {
          while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
            precision = precision * 10 + (fmt[i].charCodeAt(0) - 48);
            i++;
          }
        }
      }

      /* Parse length modifier */
      let length = '';
      if (fmt[i] === 'h') {
        length = 'h';
        i++;
        if (fmt[i] === 'h') { length = 'hh'; i++; }
      } else if (fmt[i] === 'l') {
        length = 'l';
        i++;
        if (fmt[i] === 'l') { length = 'll'; i++; }
      } else if (fmt[i] === 'z' || fmt[i] === 't' || fmt[i] === 'j') {
        length = fmt[i++];
      } else if (fmt[i] === 'L') {
        /* long double — f64 on this target, same va slot as double */
        length = 'L';
        i++;
      }

      /* Parse specifier */
      const spec = fmt[i++];
      let str = '';

      /* C-style formatting for special float values (inf, nan, -0) */
      function fmtSpecialFloat(val, upper) {
        if (isNaN(val)) return upper ? 'NAN' : 'nan';
        if (!isFinite(val)) return (val < 0 ? '-' : '') + (upper ? 'INF' : 'inf');
        return null;
      }

      switch (spec) {
        case '%':
          str = '%';
          break;
        case 'd':
        case 'i': {
          let val;
          if (length === 'll' || length === 'j') {
            val = readArg('i64');
            str = val.toString();
          } else {
            val = readArg('i32');
            if (length === 'hh') val = (val << 24) >> 24;
            else if (length === 'h') val = (val << 16) >> 16;
            str = val.toString();
          }
          /* Apply precision: minimum number of digits; precision 0 + value 0 = empty */
          if (precision >= 0) {
            let sign = '';
            let digits = str;
            if (digits[0] === '-') { sign = '-'; digits = digits.substring(1); }
            if (precision === 0 && digits === '0') digits = '';
            else if (digits.length < precision) digits = '0'.repeat(precision - digits.length) + digits;
            str = sign + digits;
          }
          if (val >= 0 && flags.plus) str = '+' + str;
          else if (val >= 0 && flags.space) str = ' ' + str;
          break;
        }
        case 'u': {
          let val;
          if (length === 'll' || length === 'j') {
            val = readArg('u64');
            str = val.toString();
          } else {
            val = readArg('u32');
            if (length === 'hh') val = val & 0xFF;
            else if (length === 'h') val = val & 0xFFFF;
            str = val.toString();
          }
          if (precision === 0 && str === '0') str = '';
          else if (precision >= 0 && str.length < precision) {
            str = '0'.repeat(precision - str.length) + str;
          }
          break;
        }
        case 'x':
        case 'X': {
          let val;
          if (length === 'll' || length === 'j') {
            val = readArg('u64');
            str = val.toString(16);
          } else {
            val = readArg('u32');
            if (length === 'hh') val = val & 0xFF;
            else if (length === 'h') val = val & 0xFFFF;
            str = val.toString(16);
          }
          if (precision === 0 && (str === '0' || str === '0n')) str = '';
          else if (precision >= 0 && str.length < precision) {
            str = '0'.repeat(precision - str.length) + str;
          }
          if (spec === 'X') str = str.toUpperCase();
          if (flags.hash && val !== 0n && val !== 0) str = (spec === 'X' ? '0X' : '0x') + str;
          break;
        }
        case 'o': {
          let val;
          if (length === 'll' || length === 'j') {
            val = readArg('u64');
            str = val.toString(8);
          } else {
            val = readArg('u32');
            if (length === 'hh') val = val & 0xFF;
            else if (length === 'h') val = val & 0xFFFF;
            str = val.toString(8);
          }
          if (precision === 0 && (str === '0' || str === '0n')) str = '';
          else if (precision >= 0 && str.length < precision) {
            str = '0'.repeat(precision - str.length) + str;
          }
          if (flags.hash && str[0] !== '0') str = '0' + str;
          break;
        }
        case 'c': {
          const val = readArg('i32');
          str = String.fromCharCode(val & 0xFF);
          break;
        }
        case 's': {
          const ptr = readArg('ptr');
          if (ptr === 0) {
            str = '(null)';
          } else if (length === 'l') {
            /* %ls: a wchar_t (32-bit little-endian code point) string.
               Convert each wide char to multibyte (UTF-8, matching
               wcrtomb) — the output pipeline is Latin-1 byte-transparent,
               so encode the bytes as individual char codes. */
            const view = new DataView(instance.exports.memory.buffer);
            for (let p = ptr; ; p += 4) {
              const wc = view.getUint32(p, true);
              if (wc === 0) break;
              if (wc < 0x80) str += String.fromCharCode(wc);
              else if (wc < 0x800) str += String.fromCharCode(0xC0 | (wc >> 6), 0x80 | (wc & 0x3F));
              else if (wc < 0x10000) str += String.fromCharCode(0xE0 | (wc >> 12), 0x80 | ((wc >> 6) & 0x3F), 0x80 | (wc & 0x3F));
              else str += String.fromCharCode(0xF0 | (wc >> 18), 0x80 | ((wc >> 12) & 0x3F), 0x80 | ((wc >> 6) & 0x3F), 0x80 | (wc & 0x3F));
            }
          } else {
            str = readLatin1(ptr);
          }
          if (precision >= 0 && str.length > precision) {
            str = str.substring(0, precision);
          }
          break;
        }
        case 'p': {
          const ptr = readArg('ptr');
          str = '0x' + ptr.toString(16);
          break;
        }
        case 'f':
        case 'F': {
          const val = readArg('f64');
          const prec = precision >= 0 ? precision : 6;
          const special = fmtSpecialFloat(val, spec === 'F');
          if (special) {
            str = special;
          } else {
            const neg = val < 0 || (val === 0 && 1 / val === -Infinity);
            str = (neg ? '-' : '') + fmtFixedExact(val, prec);
          }
          if (flags.hash && str.indexOf('.') === -1) str += '.';
          if (str[0] !== '-') {
            if (flags.plus) str = '+' + str;
            else if (flags.space) str = ' ' + str;
          }
          break;
        }
        case 'e':
        case 'E': {
          const val = readArg('f64');
          const prec = precision >= 0 ? precision : 6;
          const special = fmtSpecialFloat(val, spec === 'E');
          if (special) {
            str = special;
          } else {
            const neg = val < 0 || (val === 0 && 1 / val === -Infinity);
            const { mant, exp } = fmtExpExact(val, prec);
            str = (neg ? '-' : '') + mant + 'e' + fmtExponent(exp);
            if (spec === 'E') str = str.toUpperCase();
          }
          if (flags.hash && str.indexOf('.') === -1) {
            str = str.replace(/([eE])/, '.$1');
          }
          if (str[0] !== '-') {
            if (flags.plus) str = '+' + str;
            else if (flags.space) str = ' ' + str;
          }
          break;
        }
        case 'g':
        case 'G': {
          const val = readArg('f64');
          let prec = precision >= 0 ? precision : 6;
          if (prec === 0) prec = 1;
          const special = fmtSpecialFloat(val, spec === 'G');
          if (special) {
            str = special;
          } else {
            const neg = val < 0 || (val === 0 && 1 / val === -Infinity);
            /* C99 7.19.6.1: with exponent X of the value rounded to
               `prec` significant digits, use %e style iff X < -4 or
               X >= prec; otherwise %f style with prec-1-X fractional
               digits. Trailing zeros are stripped unless # is given. */
            const { mant, exp } = fmtExpExact(val, prec - 1);
            if (exp < -4 || exp >= prec) {
              let m = mant;
              if (!flags.hash && m.indexOf('.') !== -1) m = m.replace(/\.?0+$/, '');
              /* C11 7.21.6.1p6: '#' with g/G — the result ALWAYS has a
                 decimal point (even with no fraction digits left). */
              if (flags.hash && m.indexOf('.') === -1) m += '.';
              str = m + 'e' + fmtExponent(exp);
            } else {
              str = fmtFixedExact(val, Math.max(0, prec - 1 - exp));
              if (!flags.hash && str.indexOf('.') !== -1) str = str.replace(/\.?0+$/, '');
              if (flags.hash && str.indexOf('.') === -1) str += '.';
            }
            str = (neg ? '-' : '') + str;
            if (spec === 'G') str = str.toUpperCase();
          }
          if (str[0] !== '-') {
            if (flags.plus) str = '+' + str;
            else if (flags.space) str = ' ' + str;
          }
          break;
        }
        case 'a':
        case 'A': {
          const val = readArg('f64');
          const prec = precision >= 0 ? precision : -1;
          const neg = (1 / val < 0); /* detects -0.0 */
          if (!isFinite(val)) {
            if (isNaN(val)) str = spec === 'A' ? 'NAN' : 'nan';
            else str = (neg ? '-' : '') + (spec === 'A' ? 'INF' : 'inf');
          } else if (val === 0) {
            str = (neg ? '-' : '') + (spec === 'A' ? '0X0' : '0x0');
            if (prec > 0) str += '.' + '0'.repeat(prec);
            else if (prec < 0) { /* no trailing dot */ }
            str += (spec === 'A' ? 'P+0' : 'p+0');
          } else {
            const abs = neg ? -val : val;
            const buf = new ArrayBuffer(8);
            new Float64Array(buf)[0] = abs;
            const bits = new DataView(buf).getBigUint64(0, true);
            let exp = Number((bits >> 52n) & 0x7FFn) - 1023;
            const mantissa = bits & 0xFFFFFFFFFFFFFn;
            let lead;
            if (exp === -1023) { /* denormal */
              exp = -1022;
              lead = '0';
            } else {
              lead = '1';
            }
            /* mantissa is 52 bits = 13 hex digits */
            let hexMant = mantissa.toString(16).padStart(13, '0');
            /* Remove trailing zeros unless precision specified */
            if (prec < 0) {
              hexMant = hexMant.replace(/0+$/, '');
            } else if (prec < 13) {
              hexMant = hexMant.substring(0, prec);
            } else if (prec > 13) {
              hexMant += '0'.repeat(prec - 13);
            }
            const prefix = spec === 'A' ? '0X' : '0x';
            const pChar = spec === 'A' ? 'P' : 'p';
            const expSign = exp >= 0 ? '+' : '';
            str = (neg ? '-' : '') + prefix + lead;
            if (hexMant.length > 0) str += '.' + hexMant;
            if (spec === 'A') str = str.toUpperCase();
            str += pChar + expSign + exp;
          }
          if (flags.plus && !neg) str = '+' + str;
          else if (flags.space && !neg) str = ' ' + str;
          break;
        }
        case 'n': {
          /* Store number of characters written so far */
          const ptr = readArg('ptr');
          if (onN) {
            onN(ptr, output.length, length);
          }
          continue;
        }
        default:
          str = '%' + spec;
      }

      /* Apply width padding */
      if (width > str.length) {
        const pad = width - str.length;
        const isFloat = (spec === 'f' || spec === 'F' || spec === 'e' || spec === 'E' ||
                       spec === 'g' || spec === 'G' || spec === 'a' || spec === 'A');
        /* The 0 flag is ignored for infinities and NaNs (consensus libc
           behavior, made normative in C23): space-pad instead. */
        const floatSpecial = isFloat && /inf|nan/i.test(str);
        const padChar = (flags.zero && !flags.minus && !floatSpecial && (isFloat || precision < 0)) ? '0' : ' ';
        if (flags.minus) {
          str = str + ' '.repeat(pad);
        } else if (padChar === '0' && (str[0] === '-' || str[0] === '+' || str[0] === ' ')) {
          str = str[0] + '0'.repeat(pad) + str.substring(1);
        } else if (padChar === '0' && str.startsWith('0x')) {
          str = '0x' + '0'.repeat(pad) + str.substring(2);
        } else if (padChar === '0' && str.startsWith('0X')) {
          str = '0X' + '0'.repeat(pad) + str.substring(2);
        } else {
          str = padChar.repeat(pad) + str;
        }
      }

      output += str;
    }

    return output;
  }

  /* Helper to write a string to WASM memory, returns bytes written (excluding null) */
  function writeString(ptr, str, maxLen) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer);
    const writeLen = maxLen !== undefined ? Math.min(str.length, maxLen - 1) : str.length;
    for (let i = 0; i < writeLen; i++) {
      bytes[ptr + i] = str.charCodeAt(i) & 0xFF;
    }
    bytes[ptr + writeLen] = 0; /* null terminator */
    return writeLen;
  }

  /* Default %n handler: writes to WASM memory */
  function defaultOnN(ptr, count, length) {
    const memory = instance.exports.memory;
    const view = new DataView(memory.buffer);
    /* %n stores through the declared width — %hhn/%hn must not clobber
       the bytes beyond it. */
    if (length === 'hh') view.setInt8(ptr, count);
    else if (length === 'h') view.setInt16(ptr, count, true);
    else if (length === 'll' || length === 'j') view.setBigInt64(ptr, BigInt(count), true);
    else view.setInt32(ptr, count, true);
  }

  /* Helper to write a parsed scanf value to a WASM memory pointer */
  function writeToPtr(ptr, type, value, length) {
    const memory = instance.exports.memory;
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    switch (type) {
      case 'int':
        if (length === 'hh') view.setInt8(ptr, Number(value));
        else if (length === 'h') view.setInt16(ptr, Number(value), true);
        else if (length === 'll') view.setBigInt64(ptr, BigInt(value), true);
        else view.setInt32(ptr, Number(value), true);
        break;
      case 'uint':
        if (length === 'hh') view.setUint8(ptr, Number(value));
        else if (length === 'h') view.setUint16(ptr, Number(value), true);
        else if (length === 'll') view.setBigUint64(ptr, BigInt(value), true);
        else view.setUint32(ptr, Number(value), true);
        break;
      case 'float':
        if (length === 'l') view.setFloat64(ptr, Number(value), true);
        else view.setFloat32(ptr, Number(value), true);
        break;
      case 'char': {
        const s = String(value);
        for (let ci = 0; ci < s.length; ci++) bytes[ptr + ci] = s.charCodeAt(ci);
        break;
      }
      case 'string': {
        /* The input was decoded as Latin-1 (byte == char code); write it
           back the same way so arbitrary bytes round-trip exactly. */
        const s = String(value);
        for (let si = 0; si < s.length; si++) bytes[ptr + si] = s.charCodeAt(si) & 0xff;
        bytes[ptr + s.length] = 0;
        break;
      }
      case 'n':
        if (length === 'hh') view.setInt8(ptr, Number(value));
        else if (length === 'h') view.setInt16(ptr, Number(value), true);
        else if (length === 'll') view.setBigInt64(ptr, BigInt(value), true);
        else view.setInt32(ptr, Number(value), true);
        break;
    }
  }

  /*
   * Scan a string using scanf-style format specifiers.
   *
   * Parameters:
   *   str: the JS string to scan from
   *   fmt_ptr: pointer to format string in WASM memory
   *   va_args_ptr: pointer to variadic arguments area (8-byte aligned slots)
   *
   * Returns: { matched, consumed }
   */
  function scanString(str, fmt_ptr, va_args_ptr) {
    const fmt = readLatin1(fmt_ptr);
    const readArg = createVaReader(va_args_ptr);
    let matched = 0;
    let si = 0; /* position in input string */
    let fi = 0; /* position in format string */
    let firstConversion = true;

    while (fi < fmt.length) {
      /* Whitespace in format: skip any whitespace in input */
      if (" \t\n\r\f\v".indexOf(fmt[fi]) >= 0) {
        fi++;
        while (fi < fmt.length && " \t\n\r\f\v".indexOf(fmt[fi]) >= 0) fi++;
        while (si < str.length && " \t\n\r\f\v".indexOf(str[si]) >= 0) si++;
        continue;
      }

      /* Non-% literal: match exactly */
      if (fmt[fi] !== '%') {
        if (si >= str.length || str[si] !== fmt[fi]) break;
        si++;
        fi++;
        continue;
      }

      fi++; /* skip '%' */
      if (fi >= fmt.length) break;

      /* %% — match literal % */
      if (fmt[fi] === '%') {
        if (si >= str.length || str[si] !== '%') break;
        si++;
        fi++;
        continue;
      }

      /* Parse suppression flag */
      let suppress = false;
      if (fmt[fi] === '*') { suppress = true; fi++; }

      /* Parse width */
      let width = 0;
      while (fi < fmt.length && fmt[fi] >= '0' && fmt[fi] <= '9') {
        width = width * 10 + (fmt[fi].charCodeAt(0) - 48);
        fi++;
      }

      /* Parse length modifier */
      let length = '';
      if (fmt[fi] === 'h') {
        length = 'h'; fi++;
        if (fmt[fi] === 'h') { length = 'hh'; fi++; }
      } else if (fmt[fi] === 'l') {
        length = 'l'; fi++;
        if (fmt[fi] === 'l') { length = 'll'; fi++; }
      }

      /* Parse specifier */
      const spec = fmt[fi++];

      /* %n: store consumed count, no match increment */
      if (spec === 'n') {
        if (!suppress) {
          const nptr = readArg('ptr');
          writeToPtr(nptr, 'n', si, length);
        }
        continue;
      }

      /* For all specifiers except %c and %[, skip leading whitespace */
      if (spec !== 'c' && spec !== '[') {
        while (si < str.length && " \t\n\r\f\v".indexOf(str[si]) >= 0) si++;
      }

      /* Check for input exhaustion */
      if (si >= str.length) {
        if (firstConversion && matched === 0) return { matched: -1, consumed: si };
        break;
      }

      firstConversion = false;
      let extracted = '';
      const maxChars = width > 0 ? width : Infinity;

      switch (spec) {
        case 'd': {
          /* Signed decimal */
          const start = si;
          if (si < str.length && (str[si] === '+' || str[si] === '-')) si++;
          if (si >= str.length) { si = start; return { matched: matched || -1, consumed: si }; }
          if (str[si] < '0' || str[si] > '9') { si = start; return { matched: matched, consumed: si }; }
          while (si < str.length && str[si] >= '0' && str[si] <= '9' && (si - start) < maxChars) si++;
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'int', parseInt(extracted, 10), length);
            matched++;
          }
          break;
        }
        case 'u': {
          /* Unsigned decimal. C11 7.21.6.2p12: matches an OPTIONALLY
             SIGNED decimal integer with strtoul semantics — a leading
             '-' is accepted and the value wraps in unsigned arithmetic
             (writeToPtr's setUint32/setBigUint64 wrap negatives). */
          const start = si;
          if (si < str.length && (str[si] === '+' || str[si] === '-')) si++;
          if (si >= str.length) { si = start; return { matched: matched || -1, consumed: si }; }
          if (str[si] < '0' || str[si] > '9') { si = start; return { matched: matched, consumed: si }; }
          while (si < str.length && str[si] >= '0' && str[si] <= '9' && (si - start) < maxChars) si++;
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'uint', parseInt(extracted, 10), length);
            matched++;
          }
          break;
        }
        case 'i': {
          /* Auto-detect base */
          const start = si;
          if (si < str.length && (str[si] === '+' || str[si] === '-')) si++;
          if (si >= str.length) { si = start; return { matched: matched || -1, consumed: si }; }
          if (!(str[si] >= '0' && str[si] <= '9')) { si = start; return { matched: matched, consumed: si }; }
          let base = 10;
          if (str[si] === '0') {
            if (si + 1 < str.length && (str[si + 1] === 'x' || str[si + 1] === 'X') && (si + 1 - start) < maxChars) {
              base = 16; si += 2;
              /* scanf semantics (unlike strtol): the input item is the
                 longest prefix of a matching sequence — once "0x" is
                 consumed, a missing hex digit (absent or width-cut) makes
                 the whole item invalid: matching failure, no backtrack to
                 the plain "0". */
              const hexOk = si < str.length && (si - start) < maxChars &&
                            '0123456789abcdefABCDEF'.indexOf(str[si]) >= 0;
              if (!hexOk) return { matched: matched, consumed: si };
            } else {
              base = 8;
            }
          }
          const digitChars = base === 16 ? '0123456789abcdefABCDEF' : base === 8 ? '01234567' : '0123456789';
          while (si < str.length && digitChars.indexOf(str[si]) >= 0 && (si - start) < maxChars) si++;
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'int', parseInt(extracted, base === 10 ? undefined : base), length);
            matched++;
          }
          break;
        }
        case 'x': case 'X': {
          /* Hex */
          const start = si;
          if (si < str.length && (str[si] === '+' || str[si] === '-')) si++;
          /* Skip optional 0x prefix */
          const sawPrefix = si + 1 < str.length && str[si] === '0' &&
            (str[si + 1] === 'x' || str[si + 1] === 'X') && (si + 2 - start) <= maxChars;
          if (sawPrefix) si += 2;
          /* A consumed "0x" with no hex digit is an invalid item: matching
             failure with the item left CONSUMED (C99 7.19.6.2) — the
             stream stays at the failure point, no backtrack. */
          if (si >= str.length || '0123456789abcdefABCDEF'.indexOf(str[si]) < 0) {
            if (!sawPrefix) si = start;
            return { matched: matched, consumed: si };
          }
          while (si < str.length && '0123456789abcdefABCDEF'.indexOf(str[si]) >= 0 && (si - start) < maxChars) si++;
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'uint', parseInt(extracted, 16), length);
            matched++;
          }
          break;
        }
        case 'o': {
          /* Octal */
          const start = si;
          if (si < str.length && (str[si] === '+' || str[si] === '-')) si++;
          if (si >= str.length) { si = start; return { matched: matched || -1, consumed: si }; }
          if (str[si] < '0' || str[si] > '7') { si = start; return { matched: matched, consumed: si }; }
          while (si < str.length && str[si] >= '0' && str[si] <= '7' && (si - start) < maxChars) si++;
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'uint', parseInt(extracted, 8), length);
            matched++;
          }
          break;
        }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
          /* Float — same matcher as __strtod_impl (incl. hex/inf/nan),
             rounded once to the target width (%f is float, %lf double) */
          const rest = width > 0 ? str.substring(si, si + width) : str.substring(si);
          const m = matchFloatToken(rest, length === 'l' || length === 'L' ? 53 : 24);
          if (!m) return { matched: matched, consumed: si };
          /* scanf semantics: the input item is the longest prefix of a
             matching sequence. A dangling exponent introducer ("10e",
             "0x1p", "10e+") extends the item and makes it invalid —
             matching failure, and per C99 7.19.6.2 the item stays
             CONSUMED (the stream is left at the failure point; only a
             one-character pushback is guaranteed). */
          if (!m.special) {
            const nxt = rest[m.length];
            const isHex = /^[+-]?0[xX]/.test(rest);
            if (nxt && (isHex ? (nxt === 'p' || nxt === 'P') : (nxt === 'e' || nxt === 'E'))) {
              let itemLen = m.length + 1;
              const sgn = rest[itemLen];
              if (sgn === '+' || sgn === '-') itemLen++;
              return { matched: matched, consumed: si + itemLen };
            }
          }
          si += m.length;
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'float', m.value, length);
            matched++;
          }
          break;
        }
        case 's': {
          /* Non-whitespace string */
          const start = si;
          while (si < str.length && " \t\n\r\f\v".indexOf(str[si]) < 0 && (si - start) < maxChars) si++;
          if (si === start) return { matched: matched, consumed: si };
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'string', extracted, length);
            matched++;
          }
          break;
        }
        case 'c': {
          /* Exactly N chars (default 1), no whitespace skip */
          const count = width > 0 ? width : 1;
          if (si + count > str.length) return { matched: matched || -1, consumed: si };
          extracted = str.substring(si, si + count);
          si += count;
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'char', extracted, length);
            matched++;
          }
          break;
        }
        case '[': {
          /* Scanset */
          let negate = false;
          if (fi < fmt.length && fmt[fi] === '^') { negate = true; fi++; }
          let scanset = '';
          /* ] as first char is literal */
          if (fi < fmt.length && fmt[fi] === ']') { scanset += ']'; fi++; }
          while (fi < fmt.length && fmt[fi] !== ']') {
            /* Handle ranges like a-z */
            if (fi + 2 < fmt.length && fmt[fi + 1] === '-' && fmt[fi + 2] !== ']') {
              const lo = fmt[fi].charCodeAt(0);
              const hi = fmt[fi + 2].charCodeAt(0);
              for (let ci = lo; ci <= hi; ci++) scanset += String.fromCharCode(ci);
              fi += 3;
            } else {
              scanset += fmt[fi++];
            }
          }
          if (fi < fmt.length) fi++; /* skip closing ] */
          const start = si;
          while (si < str.length && (si - start) < maxChars) {
            const inSet = scanset.indexOf(str[si]) >= 0;
            if (negate ? inSet : !inSet) break;
            si++;
          }
          if (si === start) return { matched: matched, consumed: si };
          extracted = str.substring(start, si);
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'string', extracted, length);
            matched++;
          }
          break;
        }
        default:
          /* Unknown specifier, stop */
          return { matched: matched, consumed: si };
      }
    }

    return { matched: matched, consumed: si };
  }

  /* Map Node.js error codes to our errno constants */
  const errnoMap = {
    'EPERM': 1, 'ENOENT': 2, 'ESRCH': 3, 'EINTR': 4, 'EIO': 5,
    'ENXIO': 6, 'E2BIG': 7, 'ENOEXEC': 8, 'EBADF': 9, 'ECHILD': 10,
    'EAGAIN': 11, 'ENOMEM': 12, 'EACCES': 13, 'EFAULT': 14, 'EBUSY': 16,
    'EEXIST': 17, 'EXDEV': 18, 'ENODEV': 19, 'ENOTDIR': 20, 'EISDIR': 21,
    'EINVAL': 22, 'ENFILE': 23, 'EMFILE': 24, 'ENOTTY': 25, 'EFBIG': 27,
    'ENOSPC': 28, 'ESPIPE': 29, 'EROFS': 30, 'EPIPE': 32, 'EDOM': 33,
    'ERANGE': 34, 'ENAMETOOLONG': 36, 'ENOSYS': 38, 'ENOTEMPTY': 39,
    'ELOOP': 40,   // symlink cycle — realpathPhysical (todos/0263) is the first setter
    // Socket family (todos/0008) — numbers match <errno.h> in the libc.
    'ENOTSOCK': 88, 'EDESTADDRREQ': 89, 'EPROTOTYPE': 91, 'EPROTONOSUPPORT': 93,
    'EOPNOTSUPP': 95, 'EAFNOSUPPORT': 97, 'EADDRINUSE': 98, 'ECONNABORTED': 103,
    'ECONNRESET': 104, 'ENOBUFS': 105, 'EISCONN': 106, 'ENOTCONN': 107,
    'ETIMEDOUT': 110, 'ECONNREFUSED': 111
  };

  function setErrno(e) {
    if (instance.exports.__errno_set) {
      const code = (e && e.code && errnoMap[e.code]) || errnoMap['EIO'];
      instance.exports.__errno_set(code);
    }
  }

  function setErrnoName(name) {
    if (!(name in errnoMap)) throw new Error("Unknown errno name: " + name);
    if (instance.exports.__errno_set) {
      instance.exports.__errno_set(errnoMap[name]);
    }
  }

  function ExitStatus(code) { this.code = code; }

  /* log(Γ(x)) for x >= 0.5 — Lanczos approximation, g=7, n=9. Hoisted out
     of the import object because wasm invokes imports with `this`
     undefined, so sibling-method calls via `this.lgamma` would throw. */
  function lgammaCore(x) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
               771.32342877765313, -176.61502916214059, 12.507343278686905,
               -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function lgammaImpl(x) {
    if (x < 0.5) {
      /* Reflection: Γ(x)Γ(1−x) = π/sin(πx). lgamma is log|Γ(x)|, so take
         the magnitude — sin(πx) is negative for some x < 0. */
      return Math.log(Math.abs(Math.PI / Math.sin(Math.PI * x))) - lgammaImpl(1 - x);
    }
    return lgammaCore(x);
  }
  function tgammaImpl(x) {
    if (x < 0.5) {
      /* Sign-aware reflection: Γ(x) = π / (sin(πx) · Γ(1−x)). */
      return Math.PI / (Math.sin(Math.PI * x) * tgammaImpl(1 - x));
    }
    return Math.exp(lgammaCore(x));
  }

  /* clock_gettime latch state — see __clock_ns_hi/__clock_ns_lo below. */
  let clockNsLatchLo = 0;
  let clockMonoLastMs = 0;

  const imports = {
    [ENV_KEY]: {
      __exit: function (status) {
        throw new ExitStatus(status);
      },
      sprintf: function (buf_ptr, fmt_ptr, va_args_ptr) {
        const str = formatString(fmt_ptr, va_args_ptr, defaultOnN);
        writeString(buf_ptr, str);
        return str.length;
      },
      snprintf: function (buf_ptr, size, fmt_ptr, va_args_ptr) {
        const str = formatString(fmt_ptr, va_args_ptr, defaultOnN);
        if (size > 0) {
          writeString(buf_ptr, str, size);
        }
        return str.length; /* returns what would have been written */
      },
      vsnprintf: function (buf_ptr, size, fmt_ptr, ap_ptr) {
        const memory = instance.exports.memory;
        const view = new DataView(memory.buffer);
        const va_args_ptr = view.getUint32(ap_ptr, true);
        const str = formatString(fmt_ptr, va_args_ptr, defaultOnN);
        if (size > 0) {
          writeString(buf_ptr, str, size);
        }
        return str.length;
      },
      __vsscanf_impl: function (str_ptr, str_len, fmt_ptr, consumed_ptr, ap_ptr) {
        const memory = instance.exports.memory;
        const view = new DataView(memory.buffer);
        /* Latin-1: scanf input is bytes, not UTF-8 — 0xE9 must stay 0xE9,
           not become U+FFFD. */
        const str = readLatin1Bounded(str_ptr, str_ptr + str_len);
        const va_args_ptr = view.getUint32(ap_ptr, true);
        const result = scanString(str, fmt_ptr, va_args_ptr);
        view.setInt32(consumed_ptr, result.consumed, true);
        return result.matched;
      },
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      asin: Math.asin,
      acos: Math.acos,
      atan: Math.atan,
      atan2: Math.atan2,
      sinh: Math.sinh,
      cosh: Math.cosh,
      tanh: Math.tanh,
      asinh: Math.asinh,
      acosh: Math.acosh,
      atanh: Math.atanh,
      exp: Math.exp,
      expm1: Math.expm1,
      log: Math.log,
      log2: Math.log2,
      log10: Math.log10,
      log1p: Math.log1p,
      pow: function (x, y) {
        /* C99 F.9.4.4: pow(x, ±0) and pow(+1, y) are 1.0 even when the
           other operand is NaN, and pow(-1, ±inf) is 1.0; JS Math.pow
           returns NaN for all of those. */
        if (y === 0 || x === 1) return 1;
        if (x === -1 && (y === Infinity || y === -Infinity)) return 1;
        return Math.pow(x, y);
      },
      cbrt: Math.cbrt,
      hypot: Math.hypot,
      fmod: function (x, y) { return x % y; },
      // erf/erfc/tgamma/lgamma — JS Math doesn't provide these, so use
      // basic series approximations. Accurate enough for the float
      // precision MicroPython runs at.
      erf: function (x) {
        // Abramowitz & Stegun 7.1.26 approximation, max error ~1.5e-7.
        const t = 1 / (1 + 0.3275911 * Math.abs(x));
        const y = 1 - (((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t)
                      * Math.exp(-x*x);
        return x < 0 ? -y : y;
      },
      erfc: function (x) {
        const t = 1 / (1 + 0.3275911 * Math.abs(x));
        const y = (((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t)
                  * Math.exp(-x*x);
        return x < 0 ? 2 - y : y;
      },
      lgamma: lgammaImpl,
      tgamma: tgammaImpl,
      __strtof_impl: function (nptr, endptr, bound) {
        const str = readStringBounded(nptr, bound);
        let i = 0;
        while (i < str.length && " \t\n\r\f\v".indexOf(str[i]) >= 0) i++;
        const m = matchFloatToken(str.substring(i), 24);
        let val = 0.0, consumed = 0;
        if (m) {
          val = m.value;
          consumed = i + m.length;
          if (!isFinite(val) && !m.special) setErrnoName('ERANGE');
        }
        if (endptr) {
          const memory = instance.exports.memory;
          const view = new DataView(memory.buffer);
          view.setUint32(endptr, nptr + consumed, true);
        }
        return val;
      },
      __strtod_impl: function (nptr, endptr, bound) {
        const str = readStringBounded(nptr, bound);
        let i = 0;
        while (i < str.length && " \t\n\r\f\v".indexOf(str[i]) >= 0) i++;
        const m = matchFloatToken(str.substring(i));
        let val = 0.0, consumed = 0;
        if (m) {
          val = m.value;
          consumed = i + m.length;
          if (!isFinite(val) && !m.special) setErrnoName('ERANGE');
        }
        if (endptr) {
          const memory = instance.exports.memory;
          const view = new DataView(memory.buffer);
          view.setUint32(endptr, nptr + consumed, true);
        }
        return val;
      },
      // time_t is 64-bit: __time_now returns i64 (BigInt across the boundary),
      // so seconds-since-epoch never truncates at 2038.
      __time_now: function () {
        return BigInt(Math.floor(Date.now() / 1000));
      },
      __clock: function () {
        return Math.floor(performance.now());
      },
      // t arrives as an i64 BigInt (time_t); Number() it for the Date ctor.
      __timezone_offset: function (t) {
        return new Date(Number(t) * 1000).getTimezoneOffset() * -60;
      },
      /* POSIX time */
      __gettimeofday: function (secPtr, usecPtr) {
        const now = Date.now();
        const memory = instance.exports.memory;
        const view = new DataView(memory.buffer);
        // tv_sec is a 64-bit time_t — write all 8 bytes or the high word is
        // garbage; tv_usec stays 32-bit.
        view.setBigInt64(secPtr, BigInt(Math.floor(now / 1000)), true);
        view.setInt32(usecPtr, (now % 1000) * 1000, true);
        return 0;
      },
      /* POSIX clock_gettime — __clock_ns_hi(clk_id) latches ONE time sample
         as a 64-bit nanosecond count and returns its high 32 bits;
         __clock_ns_lo() returns the latched low 32 bits. Wasm is
         single-threaded between the two calls, so the pair always describes
         the same instant (two independent performance.now() samples used to
         step the clock backwards ~1s at second boundaries).
         CLOCK_REALTIME (0) is epoch-anchored via Date.now(); everything else
         is CLOCK_MONOTONIC via performance.now(), clamped to never go
         backwards. BigInt keeps the ns split exact (epoch ns exceed 2^53). */
      __clock_ns_hi: function (clk_id) {
        let ms;
        if (clk_id === 0) {
          ms = Date.now();
        } else {
          ms = performance.now();
          if (ms < clockMonoLastMs) ms = clockMonoLastMs;
          else clockMonoLastMs = ms;
        }
        const sec = Math.floor(ms / 1000);
        let nsec = Math.round((ms - sec * 1000) * 1e6);
        if (nsec > 999999999) nsec = 999999999;
        const ns = BigInt(sec) * 1000000000n + BigInt(nsec);
        clockNsLatchLo = Number(ns & 0xFFFFFFFFn);
        return Number(ns >> 32n);
      },
      __clock_ns_lo: function () {
        return clockNsLatchLo;
      },
      /* Emscripten compatibility stubs */
      __emscripten_async_call: function (funcPtr, argPtr, millis) {
        const table = instance.exports.__indirect_function_table;
        setTimeout(function () {
          const fn = table.get(funcPtr);
          if (typeof WebAssembly.promising === 'function') {
            WebAssembly.promising(fn)(argPtr);
          } else {
            fn(argPtr);
          }
        }, Math.max(millis, 0));
      },
      __emscripten_random: function () {
        return Math.random();
      },
      /* Base write for stdout/stderr (may be overridden by FS write) */
      write: function (fd, buf_ptr, count) {
        if (fd === 1 || fd === 2) {
          const memory = instance.exports.memory;
          const buf = new Uint8Array(memory.buffer, buf_ptr, count);
          if (fd === 1) {
            writeOut(buf);
          } else {
            writeErr(buf);
          }
          return count;
        }
        setErrnoName('EBADF');
        return -1;
      },
    }
  };

  /* Build runtime context and conditionally create filesystem imports */
  const ctx = {
    readString: readString,
    createVaReader: createVaReader,
    setErrno: setErrno,
    setErrnoName: setErrnoName,
    getMemory: function () { return instance.exports.memory; },
    getExports: function () { return instance.exports; },
    getIndirectFunctionTable: function () { return instance.exports.__indirect_function_table; },
    writeOut: writeOut,
    writeErr: writeErr,
    // Optional live-stdin SharedArrayBuffer ring (no-JSPI block-FS path); read
    // by BlockFS.toWasmEnv. Undefined → stdin stays pre-buffered/EOF.
    stdinSab: stdinSab,
    requestStdin: requestStdin,
    requestTerminalSize: requestTerminalSize,
    requestStdinReady: requestStdinReady,
    requestStdinNotify: requestStdinNotify,
    // Runtime-minted process ids for getpid()/getppid() (createPosix /
    // createBrowserPosix). Undefined → host default.
    pid: pid,
    ppid: ppid,
    getppid: getppid,
  };

  if (fsModule) {
    const fileSystem = createFileSystem({ fs: fsModule, ctx: ctx });
    Object.assign(imports[ENV_KEY], fileSystem[ENV_KEY]);
    const posix = createPosix({ ctx: ctx });
    Object.assign(imports[ENV_KEY], posix[ENV_KEY]);
  } else if (blockFsImports) {
    Object.assign(imports[ENV_KEY], blockFsImports[ENV_KEY]);
    const posix = typeof process !== "undefined"
      ? createPosix({ ctx: ctx })
      : createBrowserPosix({ ctx: ctx });
    Object.assign(imports[ENV_KEY], posix[ENV_KEY]);
  } else if (blockFsFactory) {
    const fileSystem = await blockFsFactory(ctx);
    Object.assign(imports[ENV_KEY], fileSystem[ENV_KEY]);
    const posix = typeof process !== "undefined"
      ? createPosix({ ctx: ctx })
      : createBrowserPosix({ ctx: ctx });
    Object.assign(imports[ENV_KEY], posix[ENV_KEY]);
  }

  let sdl = sdlOverride || null;
  if (!sdl && getBrowserSDL) {
    sdl = createBrowserSDL({ canvas: getBrowserSDL, ctx: ctx, sharedAudioBuffer: sharedAudioBuffer, notifyAudio: notifyAudio, notifyWindow: notifyWindow });
  }
  // OS process (kernel.js spawnHooks carry the surface ops) with no injected
  // canvas: SDL windows become kernel surfaces (todos/WM.md) — WebGPU onto a
  // worker-local OffscreenCanvas + ImageBitmap handoff in the browser, shm
  // framebuffer pixels headless.
  if (!sdl && spawnHooks && typeof spawnHooks.surfaceCreate === 'function') {
    sdl = createSurfaceSDL({ ctx: ctx, hooks: spawnHooks });
  }
  // No canvas, no override → null stubs so __sdl_* imports still resolve
  // (Node CLI, headless tests). Browser host always sets getBrowserSDL.
  if (!sdl) sdl = createNullSDL();
  Object.assign(imports[ENV_KEY], sdl[ENV_KEY]);
  // Expose the live SDL object to the host so an embedder can push input events
  // into it (sdl.pushKeyEvent / pushMouseButtonEvent / …). Used when the canvas
  // and event source live on the main thread but the run executes in a (possibly
  // nested) worker, so the embedder can't reach createBrowserSDL's return value
  // any other way. The push methods call wasm exports, so they only work once
  // the instance exists — the embedder invokes them later (during the frame
  // loop), not at import-build time.
  if (typeof onSdl === 'function') onSdl(sdl);

  /* ---- WebGPU backend ----
     Shares the SDL canvas (the transferred OffscreenCanvas) when there is one,
     but WebGPU does NOT require a canvas: compute pipelines and offscreen
     render→readback need only an adapter/device. So install the real binding
     whenever navigator.gpu exists (canvas may be null — only wgpuCreateSurface
     needs it); fall back to null stubs only in Node / engines without WebGPU.
     The async adapter/device/map callbacks are driven by the post-main loop
     (a program keeps alive via wgpuSetMainLoopCallback and stops it when done). */
  const hasGpu = (typeof navigator !== 'undefined' && navigator.gpu);
  // OS surface backend (createSurfaceSDL): the webgpu binding rides its config —
  // browser flavor shares the worker-local canvas + ImageBitmap present tail;
  // headless flavor gets the lazy Dawn probe + shm readback tail (todos/0016).
  const wCfg = (sdl && sdl.webgpuConfig) || null;
  const webgpu = wCfg
    ? createBrowserWebGPU({ canvas: wCfg.canvas || null, ctx: ctx, notifyWindow: notifyWindow,
                            resolveGpu: wCfg.resolveGpu, shmSurface: wCfg.shmSurface, onPresent: wCfg.onPresent,
                            bindWindow: wCfg.bindWindow })
    : (getBrowserSDL || hasGpu)
      ? createBrowserWebGPU({ canvas: getBrowserSDL || null, ctx: ctx, notifyWindow: notifyWindow })
      : createNullWebGPU(ctx);
  Object.assign(imports[ENV_KEY], webgpu[ENV_KEY]);

  /* ---- Process model: __spawn / __spawn_wait / __spawn_kill ----
     Real hooks when the embedder can create processes; ENOSYS stubs otherwise
     (so the imports always resolve). */
  const spawnImports = spawnHooks ? createSpawn(ctx, spawnHooks) : createNullSpawn(ctx);
  Object.assign(imports[ENV_KEY], spawnImports[ENV_KEY]);

  /* ---- System clipboard (todos/0090): kernel slot via spawnHooks, or a
     process-local slot with the same semantics when there's no kernel. */
  Object.assign(imports[ENV_KEY], createClipboard(ctx, spawnHooks || null)[ENV_KEY]);

  /* ---- HTTP transport (todos/0172): kernel fetch via spawnHooks; ENOSYS
     (fail-loud) with no kernel. Under the libcurl veneer (0173) + /bin/code. */
  Object.assign(imports[ENV_KEY], createHttp(ctx, spawnHooks || null)[ENV_KEY]);

  /* ---- Emulator console/display/networking imports ---- */
  /* These are used by TinyEMU and similar emulators. They are no-ops
   * unless the WASM module actually imports them. */

  /* Console I/O */
  if (sharedConsoleBuffer) {
    /* Browser worker path: use SharedArrayBuffer ring buffer */
    const conSab = sharedConsoleBuffer.sharedBuffer || sharedConsoleBuffer;
    const conBufSize = sharedConsoleBuffer.bufferSize || (conSab.byteLength - 16);
    const conControl = new Int32Array(conSab, 0, 4);
    const conRingBuf = new Uint8Array(conSab, 16, conBufSize);

    imports[ENV_KEY].console_write = function (opaque, bufPtr, len) {
      /* Blocking SPSC producer (see createSharedConsoleBuffer): write at
         most the free space, then park on `available` until the receiver
         drains and notifies. Never overruns the reader — a burst larger
         than the ring blocks the program, pty-style. A single write
         larger than the whole ring proceeds in chunks. Runs on the
         process worker, where Atomics.wait is legal (same contract as
         the stdin ring's futex wait); no wasm executes in this worker
         while we're parked, so memory.buffer can't move under us. */
      const memory = instance.exports.memory;
      let off = 0;
      while (off < len) {
        const avail = Atomics.load(conControl, 1);
        const free = conBufSize - avail;
        if (free <= 0) {
          /* Bounded wait + re-check: a lost notify can't wedge us;
             semantically we still block until there's space. */
          Atomics.wait(conControl, 1, avail, 100);
          continue;
        }
        const n = Math.min(len - off, free);
        const src = new Uint8Array(memory.buffer, bufPtr + off, n);
        const writePos = Atomics.load(conControl, 0);
        const first = Math.min(n, conBufSize - writePos);
        conRingBuf.set(src.subarray(0, first), writePos);
        if (first < n) conRingBuf.set(src.subarray(first), 0);
        Atomics.store(conControl, 0, (writePos + n) % conBufSize);
        Atomics.add(conControl, 1, n);
        off += n;
        /* Per-chunk nudge so the page can drain while we're still
           feeding a multi-chunk write. */
        if (notifyConsole) notifyConsole();
      }
    };
    imports[ENV_KEY].console_get_size = function (pwPtr, phPtr) {
      const memory = instance.exports.memory;
      const view = new DataView(memory.buffer);
      view.setInt32(pwPtr, Atomics.load(conControl, 2), true);
      view.setInt32(phPtr, Atomics.load(conControl, 3), true);
    };
  } else {
    /* Node.js path: direct stdout */
    imports[ENV_KEY].console_write = function (opaque, bufPtr, len) {
      const memory = instance.exports.memory;
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      writeOut(buf);
    };
    imports[ENV_KEY].console_get_size = function (pwPtr, phPtr) {
      const memory = instance.exports.memory;
      const view = new DataView(memory.buffer);
      let cols = 80, rows = 24;
      if (typeof process !== 'undefined' && process.stdout) {
        cols = process.stdout.columns || 80;
        rows = process.stdout.rows || 24;
      }
      view.setInt32(pwPtr, cols, true);
      view.setInt32(phPtr, rows, true);
    };
  }

  /* Framebuffer display (for graphical emulation) */
  let emuDisplay = null;
  imports[ENV_KEY].fb_refresh = function (opaque, dataPtr, x, y, w, h, stride) {
    const memory = instance.exports.memory;
    const displayWidth = stride / 4;

    /* Lazy-init display on first call */
    if (!emuDisplay) {
      if (getBrowserSDL) {
        /* Browser: use OffscreenCanvas */
        const canvas = (typeof getBrowserSDL === 'object' && getBrowserSDL.getContext)
          ? getBrowserSDL : null;
        if (canvas) {
          canvas.width = displayWidth;
          canvas.height = y + h; /* best guess from first refresh */
          const ctx2d = canvas.getContext('2d');
          emuDisplay = {
            type: 'canvas',
            ctx: ctx2d,
            image: ctx2d.createImageData(displayWidth, canvas.height),
            width: displayWidth,
            height: canvas.height,
          };
        }
      }
      /* Node has no display target — caller must hook into TinyEMU's
       * refresh callback themselves if they want headless capture. */
    }

    if (!emuDisplay) return;

    /* Copy pixels from WASM memory with BGRx → RGBA swizzle.
     * WASM (LE): bytes are B, G, R, X per pixel.
     * ImageData / RGBA: bytes are R, G, B, A per pixel. */
    const src = new Uint8Array(memory.buffer);

    if (emuDisplay.type === 'canvas') {
      const dst = emuDisplay.image.data;
      for (let row = 0; row < h; row++) {
        let srcOff = dataPtr + row * stride;
        let dstOff = ((y + row) * emuDisplay.width + x) * 4;
        for (let col = 0; col < w; col++) {
          dst[dstOff]     = src[srcOff + 2]; /* R */
          dst[dstOff + 1] = src[srcOff + 1]; /* G */
          dst[dstOff + 2] = src[srcOff];     /* B */
          dst[dstOff + 3] = 255;             /* A */
          srcOff += 4;
          dstOff += 4;
        }
      }
      emuDisplay.ctx.putImageData(emuDisplay.image, 0, 0, x, y, w, h);
    }
  };

  /* Networking stubs — return 0/NULL, no-op */
  imports[ENV_KEY].net_recv_packet = function () {};
  imports[ENV_KEY].fs_net_init = function () { return 0; };
  imports[ENV_KEY].fs_net_set_pwd = function () {};
  imports[ENV_KEY].block_device_init_http = function () { return 0; };

  imports[ENV_KEY].__jsstr = function (ptr) {
    return readString(ptr);
  };
  imports[ENV_KEY].__jsstr2 = function (ptr, len) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  };
  imports[ENV_KEY].__jsgetattr = function (obj, key) {
    return obj[key];
  };
  imports[ENV_KEY].__jslog = function (val) {
    console.log(val);
  };
  imports[ENV_KEY].__jsglobal = function () {
    return globalThis;
  };
  imports[ENV_KEY].__jsstr_utf8len = function (str) {
    return new TextEncoder().encode(str).length;
  };
  imports[ENV_KEY].__jsstr_read = function (str, bufPtr, maxlen, writtenPtr) {
    const memory = instance.exports.memory;
    const buf = new Uint8Array(memory.buffer, bufPtr, maxlen);
    const { read, written } = new TextEncoder().encodeInto(str, buf);
    if (read === str.length && written < maxlen) buf[written] = 0;
    new DataView(memory.buffer).setInt32(writtenPtr, written, true);
    return (read === str.length) ? 1 : 0;
  };

  /* ---- Kernel signal delivery (todos/KERNEL.md Phase 2) ----
     With a kernel attached (spawnHooks.sigpoll), every env import return is
     a SAFE POINT: claim the deliverable pending signals off the kernel page
     and run the C handlers through the module's __sig_dispatch export.
     ctx.deliverSignals returns null (nothing ran) / true (every delivered
     action allows transparent restart, SA_RESTART) / false. Math
     passthroughs are skipped — hot, pure, and never a place a C program can
     block. Zero cost without a kernel (block never entered). */
  if (spawnHooks && spawnHooks.sigpoll) {
    let sigDispatchFn = null;   // bound after instantiation
    let inSigDispatch = false;  // C handlers make syscalls; don't re-enter
    ctx.deliverSignals = function () {
      if (inSigDispatch || !sigDispatchFn) return null;
      let delivered = false;
      let restartOk = true;
      for (;;) {
        const m = spawnHooks.sigpoll();
        if (!m) break;
        inSigDispatch = true;
        try {
          for (let s = 1; s < 32; s++) {
            if (m & (1 << (s - 1))) {
              delivered = true;
              if (!sigDispatchFn(s)) restartOk = false;
            }
          }
        } finally { inSigDispatch = false; }
      }
      return delivered ? restartOk : null;
    };
    ctx.bindSigDispatch = function (exp) { sigDispatchFn = exp.__sig_dispatch || null; };
    const envImports = imports[ENV_KEY];
    Object.keys(envImports).forEach(function (name) {
      const fn = envImports[name];
      if (typeof fn !== 'function' || Math[name] === fn) return;
      envImports[name] = function () {
        const r = fn.apply(this, arguments);
        ctx.deliverSignals();
        return r;
      };
    });
  }
  /* Ordered exit handshake: report the status to the kernel BEFORE
     unwinding (all earlier output messages are already ahead of it on the
     worker channel), so waiters see the status only after the output. The
     kernel tears the worker down; the throw is the no-kernel fallback. */
  if (spawnHooks && spawnHooks.exit) {
    const innerExit = imports[ENV_KEY].__exit;
    imports[ENV_KEY].__exit = function (status) {
      try { spawnHooks.exit(status | 0); } catch (e) { /* kernel gone — fall through */ }
      return innerExit(status);
    };
  }

  const instance = new WebAssembly.Instance(module, imports);

  if (ctx.bindSigDispatch) ctx.bindSigDispatch(instance.exports);
  if (onReady) onReady({ sdl: sdl, instance: instance });

  let exitCode;
  try {
    // Seed the process environment: build a NULL-terminated char** block in
    // wasm memory (same shape as argv) and hand it to the libc via
    // __set_environ — the libc owns `environ` from here on. The same pointer is
    // passed to main() as the optional third (envp) argument; a program with a
    // 2-arg main simply ignores it. Skipped when no env is supplied or the
    // module predates __set_environ (environ then stays empty, as before).
    let envpPtr = 0;
    if (env && instance.exports.__set_environ && instance.exports.alloca) {
      const allocaE = instance.exports.alloca;
      const memoryE = instance.exports.memory;
      const encoderE = new TextEncoder();
      const envPtrs = [];
      for (const k of Object.keys(env)) {
        const encoded = encoderE.encode(k + '=' + env[k]);
        const ptr = allocaE(encoded.length + 1);
        const bytesE = new Uint8Array(memoryE.buffer);
        bytesE.set(encoded, ptr);
        bytesE[ptr + encoded.length] = 0;
        envPtrs.push(ptr);
      }
      envpPtr = allocaE((envPtrs.length + 1) * 4);
      const viewE = new DataView(memoryE.buffer);
      for (let i = 0; i < envPtrs.length; i++) {
        viewE.setInt32(envpPtr + i * 4, envPtrs[i], true);
      }
      viewE.setInt32(envpPtr + envPtrs.length * 4, 0, true);
      instance.exports.__set_environ(envpPtr);
    }

    // crt0 static init: run C++ global constructors (.init_array) before main.
    // lld emits __wasm_call_ctors when a module has global ctors; command-model
    // modules normally get it called from a synthesized _start, but this host
    // enters at main() directly, so we invoke it here. Guarded: a no-op for the
    // many modules that don't export it (e.g. this project's own C output).
    if (typeof instance.exports.__wasm_call_ctors === 'function') {
      instance.exports.__wasm_call_ctors();
    }

    if (args && args.length > 0) {
      // Set up argc/argv via alloca
      const argc = args.length;
      const alloca = instance.exports.alloca;
      const memory = instance.exports.memory;
      const encoder = new TextEncoder();

      // Allocate and write each string
      const argPtrs = [];
      for (let i = 0; i < argc; i++) {
        const encoded = encoder.encode(args[i]);
        const ptr = alloca(encoded.length + 1);
        const bytes = new Uint8Array(memory.buffer);
        bytes.set(encoded, ptr);
        bytes[ptr + encoded.length] = 0;
        argPtrs.push(ptr);
      }

      // Allocate argv pointer array (argc+1, last is NULL)
      const argvPtr = alloca((argc + 1) * 4);
      const view = new DataView(memory.buffer);
      for (let i = 0; i < argc; i++) {
        view.setInt32(argvPtr + i * 4, argPtrs[i], true);
      }
      view.setInt32(argvPtr + argc * 4, 0, true);

      if (hasJSPI) {
        exitCode = await WebAssembly.promising(instance.exports.main)(argc, argvPtr, envpPtr);
      } else {
        exitCode = instance.exports.main(argc, argvPtr, envpPtr);
      }
    } else {
      if (hasJSPI) {
        exitCode = await WebAssembly.promising(instance.exports.main)();
      } else {
        exitCode = instance.exports.main();
      }
    }
    /* NO_EXIT_RUNTIME: if the program defined and exported
     * __no_exit_runtime, it has registered async work (timers,
     * indirect-call dispatch, etc.) that must keep running after main
     * returns. Skip exit()/atexits (those tear down stdio + abort),
     * wire stdin → console_queue_char if present, then await forever
     * so the outer harness doesn't call process.exit. The process
     * exits naturally when nothing is left to do, or when the program
     * explicitly calls exit() from inside its async callbacks. */
    if (instance.exports.__no_exit_runtime) {
      const cqc = instance.exports.console_queue_char;
      if (cqc && typeof process !== 'undefined' && process.stdin) {
        try {
          if (process.stdin.isTTY && process.stdin.setRawMode) {
            process.stdin.setRawMode(true);
          }
          process.stdin.resume();
          process.stdin.on('data', (chunk) => {
            for (const byte of chunk) cqc(byte);
          });
        } catch (_) { /* ignore stdin attach failures */ }
      }
      await new Promise(() => { /* await indefinitely */ });
    }
    if (sdl && sdl.getAnimationFrameFunc()) {
      // emscripten_set_main_loop semantics: main returned with a frame
      // callback registered, so the runtime stays alive — the C exit path
      // (atexits, and under kernel.js the ordered EXIT handshake, which
      // tears the process down) runs AFTER the frame loop stops, below.
      // Calling it here killed OS processes before their first frame.
    } else if (instance.exports.exit) {
      // Dawn tier: settle pending GPU promises before the EXIT handshake —
      // the kernel terminates the worker on EXIT, and worker.terminate() with
      // pending Dawn events aborts the whole Node process (WM.md spike S3).
      if (ctx.gpuDrain) { try { await ctx.gpuDrain(); } catch (e) {} }
      instance.exports.exit(exitCode);
    } else if (instance.exports.__run_atexits) {
      instance.exports.__run_atexits();
    }
  } catch (e) {
    if (e instanceof ExitStatus) {
      exitCode = e.code;
    } else {
      throw e;
    }
  }

  if (sdl && sdl.getAnimationFrameFunc()) {
    const table = ctx.getIndirectFunctionTable();
    const raf = sdl.requestAnimationFrame;
    const FRAME_MS = 1000 / 60;
    let nextDue = 0;
    await new Promise(function (resolve) {
      function scheduleFrame() {
        const doFrame = async function () {
          const animFunc = sdl.getAnimationFrameFunc();
          if (!animFunc) {
            resolve();
            return;
          }
          // OS surface backend: pull kernel-routed input from the ring into
          // the wasm event queue before the frame runs (todos/WM.md).
          if (sdl.drainInput) {
            try { sdl.drainInput(); } catch (e) { /* exports gone mid-teardown */ }
          }
          try {
            if (hasJSPI) {
              await WebAssembly.promising(table.get(animFunc))();
            } else {
              table.get(animFunc)();
            }
          } catch (e) {
            if (e instanceof ExitStatus) {
              exitCode = e.code;
              resolve();
              return;
            }
            throw e;
          }
          if (sdl.getAnimationFrameFunc()) {
            scheduleFrame();
          } else {
            resolve();
          }
        };
        if (raf) {
          raf(doFrame);
        } else {
          // Deadline-based pacer: a fixed setTimeout(16) AFTER the callback
          // makes the tick period 16ms + callback time — an app whose frame
          // work takes ~10ms then ticks at ~26ms while its own catch-up
          // logic keeps game-time real, i.e. it silently presents only
          // every other frame. Aim at an absolute 60Hz schedule instead;
          // when the callback overruns a whole period, fire immediately
          // and restart the cadence from now.
          const now = Date.now();
          if (nextDue <= now) {
            nextDue = now + FRAME_MS;
            setTimeout(doFrame, 0);
          } else {
            const delay = nextDue - now;
            nextDue += FRAME_MS;
            setTimeout(doFrame, delay);
          }
        }
      }
      scheduleFrame();
    });
    // The loop stopped (frame func cleared, or exit() unwound a frame): now
    // run the deferred C exit path — atexits, and under kernel.js the EXIT
    // handshake. ExitStatus is how a host __exit stub reports the code.
    // Dawn tier: drain pending GPU promises FIRST (see the gpuDrain comment
    // above) — this is why Dawn apps quit via SDL_Quit(), not exit(): exit()
    // inside a frame tick fires the EXIT handshake before any drain can run.
    if (ctx.gpuDrain) { try { await ctx.gpuDrain(); } catch (e) {} }
    try {
      if (instance.exports.exit) {
        instance.exports.exit(exitCode);
      } else if (instance.exports.__run_atexits) {
        instance.exports.__run_atexits();
      }
    } catch (e) {
      if (e instanceof ExitStatus) exitCode = e.code;
      else throw e;
    }
  }

  return exitCode;
}

// @cc-strip-below — single-file emit boundary. compiler.js's emitters
// (prepareEmbeddedHostJs) inline host.js's source into .js/.html output and
// cut it at this EXACT marker line: everything below is the STANDALONE tail
// (run-if-main CLI, module/window/worker exports) that would double-execute
// inside a Node bundle. The strip keys on the marker, not prose, and the
// compiler FAILS LOUD if the marker vanishes — reword the comments freely,
// but keep the `// @cc-strip-below` line itself intact (CD15).
// --------------------------------------------------------------------------
// Dual-purpose logic: Run if Main (Node), Export if Module (Node/Browser)
// --------------------------------------------------------------------------

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  // We are in Node.js AND we are the main script
  const fs = require('fs');
  const wasmPath = process.argv[2] || 'a.wasm';
  const bytes = fs.readFileSync(wasmPath);

  /* Drain stdout/stderr before exiting. process.exit() discards writes
     still queued in the stream (pipes flush asynchronously), so
     `prog | grep` lost everything past ~one pipe buffer AFTER write()
     had already returned success to the C program
     (CONFORMANCE-REMAINING "Piped stdout truncated at exit"). A
     zero-length write's callback fires only once everything queued
     before it has been flushed — like native stdio, this blocks for as
     long as the pipe consumer takes to read. EPIPE during the drain is
     handled by the installed exit-on-EPIPE listener (exit 141). */
  function flushAndExit(code) {
    var pending = 2;
    function done() { if (--pending === 0) process.exit(code); }
    process.stdout.write('', done);
    process.stderr.write('', done);
  }

  // --block-fs: use the synchronous block filesystem instead of the
  // real Node.js filesystem.  Pass --block-fs=<path> to back it with a
  // real file; bare --block-fs uses an ephemeral in-memory store.
  var useBlockFS = false;
  var blockFSPath = null;
  var args = process.argv.slice(2);
  for (var ai = 0; ai < args.length; ai++) {
    if (args[ai] === '--block-fs') { useBlockFS = true; args.splice(ai, 1); ai--; }
    else if (args[ai].startsWith('--block-fs=')) {
      useBlockFS = true; blockFSPath = args[ai].substring('--block-fs='.length);
      args.splice(ai, 1); ai--;
    }
  }

  if (useBlockFS) {
    var store;
    if (blockFSPath) {
      // File-backed store: read the whole file into memory, then
      // flush back on exit.  For large files we'd want mmap-style
      // paging, but this is fine for tests.
      var fileBuf = new Uint8Array(0);
      try {
        fileBuf = fs.readFileSync(blockFSPath);
      } catch (e) {
        // ENOENT is the one legitimate "create a new image" case. Any
        // other read failure (EACCES, EIO, ...) must NOT fall through to
        // a fresh empty image: the writeFileSync at exit would overwrite
        // the original — a transient error on startup would silently
        // destroy the user's image.
        if (e.code !== 'ENOENT') {
          process.stderr.write('BlockFS: cannot read image ' + blockFSPath + ': ' + e.message + '\n');
          process.exit(1);
        }
      }
      // MemoryByteStore needs an ArrayBuffer — copy in
      // Start with 1MB initial store; TLSF grows via _growPool as needed.
      var store = new BLOCK_FS.MemoryByteStore(Math.max(fileBuf.length, 1024 * 1024));
      if (fileBuf.length > 0) store.setBytes(0, fileBuf);
    } else {
      var store = new BLOCK_FS.MemoryByteStore(1024 * 1024);
    }
    try {
      var blockFS = BLOCK_FS.create(store);
    } catch (e) {
      process.stderr.write('BlockFS init failed: ' + e.message + '\n');
      process.exit(1);
    }

    // Create /tmp so programs that expect it (SQLite, Lua, etc.) work.
    blockFS.mkdir('/tmp', 0o777);

    // Read stdin synchronously and feed it to BlockFS.  When stdin is
    // a pipe (e.g. `echo "..." | node host.js ... --block-fs`), readSync
    // on fd 0 returns the data.  When it's a TTY, skip — the program
    // will get an empty stdin, which is correct for interactive use.
    if (!process.stdin.isTTY) {
      try {
        var stdinBuf = Buffer.alloc(65536);
        while (true) {
          var nr = fs.readSync(0, stdinBuf, 0, stdinBuf.length);
          if (nr === 0) break;
          blockFS.setStdin(stdinBuf.subarray(0, nr)); // setStdin appends; ByteQueue copies
        }
      } catch (e) {
        // fd 0 might be closed or a TTY after all — fine.
      }
    }

    runModule({
      bytes: bytes,
      args: args,
      env: process.env,
      blockFsFactory: async function (ctx) {
        return { c: blockFS.toWasmEnv(ctx) };
      },
      fs: undefined,
    }).then(function (exitCode) {
      // If file-backed, flush to disk
      if (blockFSPath) {
        try {
          var size = store.size();
          // Find the smallest non-zero region to write (avoid writing
          // the whole 64MB if only a small portion is used)
          var data = store.getBytes(0, size);
          fs.writeFileSync(blockFSPath, data);
        } catch (e) {
          process.stderr.write('BlockFS flush failed: ' + e.message + '\n');
        }
      }
      flushAndExit(exitCode);
    }).catch(function (e) {
      process.stderr.write('Fatal: ' + e.message + '\n');
      if (e.stack) process.stderr.write(e.stack + '\n');
      flushAndExit(1);
    });
  } else {
    runModule({
      bytes,
      // Always pass at least argv[0] — the wasm path. Many programs (SQLite,
      // anything POSIX-y) assert `argc >= 1` at entry.
      args: args,
      env: process.env,
      fs: fs,
    }).then(function (exitCode) {
      flushAndExit(exitCode);
    }).catch(function (e) {
      process.stderr.write('Fatal: ' + e.message + '\n');
      if (e.stack) process.stderr.write(e.stack + '\n');
      flushAndExit(1);
    });
  }

} else if (typeof module !== 'undefined') {
  // We are being imported (Node or bundler)
  module.exports = runModule;
  // Test exports: BLOCK_FS components
  module.exports.BLOCK_FS = BLOCK_FS;
  // Test export: the native-fs env (tests inject a NodeFS-shaped fake fs)
  module.exports.createFileSystem = createFileSystem;
  module.exports.SDL_WEB = SDL_WEB;
  module.exports.createBrowserWebGPU = createBrowserWebGPU;
  // Test exports: SAB ring endpoints (console + audio)
  module.exports.createSharedConsoleBuffer = createSharedConsoleBuffer;
  module.exports.createConsoleReceiver = createConsoleReceiver;
  module.exports.createSharedAudioBuffer = createSharedAudioBuffer;
  module.exports.createBrowserSDL = createBrowserSDL;
  module.exports.createNullSDL = createNullSDL;
  // Test export: the OS kernel-surface SDL flavor (per-window GPU present, A4)
  module.exports.createSurfaceSDL = createSurfaceSDL;
}

// Browser global exports
if (typeof window !== 'undefined') {
  window.createSharedAudioBuffer = createSharedAudioBuffer;
  window.createAudioReceiver = createAudioReceiver;
  window.createSharedConsoleBuffer = createSharedConsoleBuffer;
  window.createConsoleReceiver = createConsoleReceiver;
  window.SDL_WEB = SDL_WEB;
}

// Worker global exports
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof module === 'undefined') {
  self.runModule = runModule;
  self.createBrowserSDL = createBrowserSDL;
  self.createBrowserWebGPU = createBrowserWebGPU;
  self.BLOCK_FS = BLOCK_FS;
  self.SDL_WEB = SDL_WEB;
}
