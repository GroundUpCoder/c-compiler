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
 * @property {Uint8Array | ArrayBuffer} bytes - The WASM module bytes.
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
    { nativeFd: 1, position: null },  /* fd 1 = stdout (not seekable) */
    { nativeFd: 2, position: null },  /* fd 2 = stderr (not seekable) */
  ];
  const stdinBuf = [];
  let stdinEOF = false;
  let stdinWaiters = [];
  let stdinListening = false;
  function ensureStdinListening() {
    if (stdinListening || typeof process === 'undefined' || !process.stdin) return;
    stdinListening = true;
    process.stdin.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) stdinBuf.push(chunk[i]);
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
        n = Math.min(count, stdinBuf.length);
        for (let i = 0; i < n; i++) buf[i] = stdinBuf[i];
        stdinBuf.splice(0, n);
        return n;
      } else if (entry.position === null) {
        if (entry.nativeFd === undefined) throw new Error("read: fd " + fd + " has no nativeFd");
        n = fs.readSync(entry.nativeFd, buf);
      } else {
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
          } catch (e) { }
        }
        return allocFd(entry);
      },
      close: function (fd) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        if (fd < 3) {
          /* POSIX allows closing std fds. Drop the table entry (further
             use is EBADF) without closing the host process's streams. */
          fdTable[fd] = null;
          return 0;
        }
        const entry = fdTable[fd];
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
        if (fd === 1 || fd === 2) {
          const memory = getMemory();
          const buf = new Uint8Array(memory.buffer, buf_ptr, count);
          if (fd === 1) {
            writeOut(buf);
          } else {
            writeErr(buf);
          }
          return count;
        }
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        const memory = getMemory();
        const buf = new Uint8Array(memory.buffer, buf_ptr, count);
        const entry = fdTable[fd];
        try {
          let n;
          if (entry.append) {
            /* O_APPEND: every write lands at current EOF, regardless of any
               seek. The fd was opened with O_APPEND, so an unpositioned
               write lets the kernel append; resync our position to EOF. */
            n = fs.writeSync(entry.nativeFd, buf, 0, count);
            try { entry.position = fs.fstatSync(entry.nativeFd).size; } catch (e) { }
          } else {
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
        /* Create an in-memory pipe: two fds sharing a buffer */
        const pipe = { buffer: [], closed: { read: false, write: false } };
        const readFd = allocFd({ type: 'pipe', pipe: pipe, pipeEnd: 'read', position: null });
        const writeFd = allocFd({ type: 'pipe', pipe: pipe, pipeEnd: 'write', position: null });
        const memory = getMemory();
        const view = new DataView(memory.buffer);
        view.setInt32(pipefd_ptr, readFd, true);
        view.setInt32(pipefd_ptr + 4, writeFd, true);
        return 0;
      },
      dup: function (oldfd) {
        if (oldfd < 0 || oldfd >= fdTable.length || !fdTable[oldfd]) { setErrnoName('EBADF'); return -1; }
        const entry = fdTable[oldfd];
        /* For pipe fds, share the same pipe object */
        if (entry.type === 'pipe') {
          return allocFd({ type: 'pipe', pipe: entry.pipe, pipeEnd: entry.pipeEnd, position: null });
        }
        /* POSIX: dup'd fds share one open file description — including the
           file offset. Alias the same entry object and refcount it so the
           native fd is only closed when the last alias closes. */
        entry.refs = (entry.refs || 1) + 1;
        return allocFd(entry);
      },
      dup2: function (oldfd, newfd) {
        if (oldfd < 0 || oldfd >= fdTable.length || !fdTable[oldfd]) { setErrnoName('EBADF'); return -1; }
        if (newfd < 0) { setErrnoName('EBADF'); return -1; }
        if (oldfd === newfd) return newfd;
        /* Close newfd if open */
        if (newfd < fdTable.length && fdTable[newfd]) {
          const entry = fdTable[newfd];
          if (entry.nativeFd !== undefined && newfd >= 3) {
            if (entry.refs && entry.refs > 1) entry.refs--;
            else try { fs.closeSync(entry.nativeFd); } catch (e) { }
          }
          fdTable[newfd] = null;
        }
        /* Extend table if needed */
        while (fdTable.length <= newfd) fdTable.push(null);
        const src = fdTable[oldfd];
        if (src.type === 'pipe') {
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
      __ioctl_tiocgwinsz: function (fd, rows_ptr, cols_ptr) {
        if (fd < 0 || fd > 2) { setErrnoName('ENOTTY'); return -1; }
        const mem = new DataView(getMemory().buffer);
        mem.setInt32(rows_ptr, process.stdout.rows || 24, true);
        mem.setInt32(cols_ptr, process.stdout.columns || 80, true);
        return 0;
      },
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
      const entry = fdTable[fd];
      const pipe = entry.pipe;
      if (pipe.buffer.length === 0) {
        if (pipe.closed.write) return 0; /* EOF */
        return 0; /* No data available (non-blocking for now) */
      }
      const n = Math.min(count, pipe.buffer.length);
      const memory = getMemory();
      const dest = new Uint8Array(memory.buffer, buf_ptr, n);
      for (let i = 0; i < n; i++) dest[i] = pipe.buffer[i];
      pipe.buffer.splice(0, n);
      return n;
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
      for (let i = 0; i < count; i++) pipe.buffer.push(src[i]);
      return count;
    }
    return origWrite(fd, buf_ptr, count);
  };

  result[ENV_KEY].close = function (fd) {
    if (fd >= 0 && fd < fdTable.length && fdTable[fd] && fdTable[fd].type === 'pipe') {
      const entry = fdTable[fd];
      entry.pipe.closed[entry.pipeEnd] = true;
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

  // Wraps a store so every write throws — used to mount the legacy v3 image as a
  // strictly read-only "view" (the toggle), so it can never be mutated.
  function ReadOnlyStore(inner) { this._i = inner; }
  ReadOnlyStore.prototype.getUint32 = function (o) { return this._i.getUint32(o); };
  ReadOnlyStore.prototype.getBytes = function (o, l) { return this._i.getBytes(o, l); };
  ReadOnlyStore.prototype.size = function () { return this._i.size(); };
  ReadOnlyStore.prototype.setUint32 = function () { throw new Error('EROFS: read-only filesystem'); };
  ReadOnlyStore.prototype.setBytes = function () { throw new Error('EROFS: read-only filesystem'); };
  ReadOnlyStore.prototype.resize = function () { throw new Error('EROFS: read-only filesystem'); };

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
      sz = (sz + (1 << (t - SL_LOG2)) - 1) >>> 0;
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

    // Round up so mapping_search can find this block
    if (blockSz >= (1 << (FL_SHIFT + 1))) {
      var t = 31 - this._clz32(blockSz);
      blockSz = (blockSz + (1 << (t - SL_LOG2)) - 1) >>> 0;
    }
    // Round up to alignment
    blockSz = (blockSz + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
    newEnd = poolEnd + blockSz;

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
      // Too large even for search — grow directly
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

    var block = ptr - BLOCK_OVERHEAD;
    var oldPayload = this._blockSize(block) - BLOCK_OVERHEAD;

    // If new size fits in current block, keep it
    if (newSize <= oldPayload) return ptr;

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
    var block = ptr - BLOCK_OVERHEAD64;
    var oldPayload = this._blockSize(block) - BLOCK_OVERHEAD64;
    if (newSize <= oldPayload) return ptr;
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
    this._stdinBuffer = [];
    this._stdinEOF = false;
    // Optional live-stdin SAB ring (main-thread producer → this worker
    // consumer). Null unless wired by setStdinSab()/toWasmEnv(). See the
    // "Live interactive stdin" block below for the layout.
    this._stdinSab = null;
    this._stdinCtrl = null;
    this._stdinRing = null;
    this._fdTable = [
      { position: null }, // 0 = stdin
      { position: null }, // 1 = stdout
      { position: null }, // 2 = stderr
    ];
    this._dirTable = [];

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

  // Get the inode for a path. Returns { inoId, ino } or null.
  BlockFS.prototype._walkPath = function (path) {
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
      inoId = found.inodeId;
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

    if (w) {
      // Exists
      if ((w.ino.mode & S_IFMT) === S_IFDIR) return this._setErr('EISDIR');
      if (excl && create) return this._setErr('EEXIST');
      if ((w.ino.mode & S_IFMT) === S_IFCHR) {
        // Character device: no data extent, O_TRUNC is a no-op. I/O is
        // dispatched by device number, not by reading/writing the (absent)
        // extent. Keep inoId so fstat() returns the S_IFCHR inode + rdev.
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
      var inoId = this._allocInode(DEFAULT_FILE_MODE);
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
    var fd = this._allocFd({
      inoId: w.inoId, position: position, append: append, path: resolved
    });
    return fd;
  };

  BlockFS.prototype.close = function (fd) {
    if (fd < 3 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];
    if (entry.type === 'pipe') {
      entry.pipe.closed[entry.pipeEnd] = true;
      this._fdTable[fd] = null;
      return 0;
    }
    this._fdTable[fd] = null;
    return 0;
  };

  BlockFS.prototype.read = function (fd, buf, count) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd])
      return this._setErr('EBADF');
    var entry = this._fdTable[fd];

    if (entry.type === 'pipe') {
      var pipe = entry.pipe;
      if (pipe.buffer.length === 0) return 0;
      var n = Math.min(count, pipe.buffer.length);
      for (var i = 0; i < n; i++) buf[i] = pipe.buffer[i];
      pipe.buffer.splice(0, n);
      return n;
    }
    if (entry.type === 'dev') return this._readDev(entry, buf, count);
    if (entry.position === null) {
      // stdin — drain any pre-buffered bytes first (Node CLI setStdin path),
      // then block on the live-stdin sab ring if one is wired (interactive
      // page), else return 0 (EOF) as before.
      if (this._stdinBuffer.length > 0) {
        var n = Math.min(count, this._stdinBuffer.length);
        for (var i = 0; i < n; i++) buf[i] = this._stdinBuffer[i];
        this._stdinBuffer.splice(0, n);
        return n;
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
    if (fd === 1 || fd === 2) return count; // stdout/stderr handled externally

    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd]) {
      return this._setErr('EBADF');
    }
    var entry = this._fdTable[fd];

    if (entry.type === 'pipe') {
      if (entry.pipe.closed.read) return this._setErr('EPIPE');
      for (var pi = 0; pi < count; pi++) entry.pipe.buffer.push(buf[pi]);
      return count;
    }
    if (entry.type === 'dev') return this._writeDev(entry, buf, count);
    if (entry.inoId === undefined) return this._setErr('EBADF');

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
    var w = this._walkPath(resolved);
    if (!w) return this._setErr('ENOENT');
    if ((w.ino.mode & S_IFMT) === S_IFDIR) return this._setErr('EPERM');

    var parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    var fileName = resolved.substring(resolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');

    dirRemove(this._s, pw.ino.extentOffset, pw.ino.dataSize, fileName);
    pw.ino.dataSize -= DIR_ENT_HEADER + encodeStr(fileName).length;
    pw.ino.mtime = this._now();
    pw.ino.nlink--;
    this._inodes.write(pw.inoId, pw.ino);

    // Drop one reference to the file; only reclaim the inode (and its data
    // extent) when the last hard link is gone. Previously the inode was freed
    // unconditionally, which dangled any remaining hard links.
    w.ino.nlink--;
    if (w.ino.nlink <= 0) {
      this._freeInode(w.inoId);
    } else {
      w.ino.ctime = this._now(); // link-count change updates ctime
      this._inodes.write(w.inoId, w.ino);
    }
    return 0;
  };

  BlockFS.prototype.remove = BlockFS.prototype.unlink; // alias

  BlockFS.prototype.rename = function (oldPath, newPath) {
    var oldResolved = this._resolvePath(oldPath);
    var newResolved = this._resolvePath(newPath);
    if (oldResolved === newResolved) return 0;

    var oldW = this._walkPath(oldResolved);
    if (!oldW) return this._setErr('ENOENT');

    // Remove old directory entry
    var oldParentPath = oldResolved.substring(0, oldResolved.lastIndexOf('/')) || '/';
    var oldName = oldResolved.substring(oldResolved.lastIndexOf('/') + 1);
    var oldPW = this._walkPath(oldParentPath);
    if (!oldPW) return this._setErr('ENOENT');

    dirRemove(this._s, oldPW.ino.extentOffset, oldPW.ino.dataSize, oldName);
    oldPW.ino.dataSize -= DIR_ENT_HEADER + encodeStr(oldName).length;
    oldPW.ino.mtime = this._now();
    oldPW.ino.nlink--;
    this._inodes.write(oldPW.inoId, oldPW.ino);

    // If target exists, remove it first
    var newW = this._walkPath(newResolved);
    if (newW) {
      if ((newW.ino.mode & S_IFMT) === S_IFDIR) {
        if (newW.ino.extentOffset && newW.ino.dataSize > 0) {
          var ent = dirList(this._s, newW.ino.extentOffset,
            newW.ino.dataSize);
          if (ent.length > 0) {
            // Restore old entry
            dirInsert(this._s, oldPW.ino.extentOffset,
              oldPW.ino.dataSize, oldW.inoId, oldName);
            oldPW.ino.dataSize += DIR_ENT_HEADER + encodeStr(oldName).length;
            oldPW.ino.nlink++;
            this._inodes.write(oldPW.inoId, oldPW.ino);
            return this._setErr('ENOTEMPTY');
          }
        }
      }
      // Remove new entry from its parent
      var newParentPath = newResolved.substring(0,
        newResolved.lastIndexOf('/')) || '/';
      var newName = newResolved.substring(
        newResolved.lastIndexOf('/') + 1);
      var newPW = this._walkPath(newParentPath);
      if (newPW) {
        dirRemove(this._s, newPW.ino.extentOffset,
          newPW.ino.dataSize, newName);
        newPW.ino.dataSize -= DIR_ENT_HEADER + encodeStr(newName).length;
        newPW.ino.nlink--;
        this._inodes.write(newPW.inoId, newPW.ino);
      }
      this._freeInode(newW.inoId);
    }

    // Add new entry pointing to old inode
    var newParentPath = newResolved.substring(0,
      newResolved.lastIndexOf('/')) || '/';
    var newName = newResolved.substring(newResolved.lastIndexOf('/') + 1);
    var newPW = this._walkPath(newParentPath);
    if (!newPW) {
      // Try to restore old entry
      dirInsert(this._s, oldPW.ino.extentOffset,
        oldPW.ino.dataSize, oldW.inoId, oldName);
      oldPW.ino.dataSize += DIR_ENT_HEADER + encodeStr(oldName).length;
      oldPW.ino.nlink++;
      this._inodes.write(oldPW.inoId, oldPW.ino);
      return this._setErr('ENOENT');
    }
    if ((newPW.ino.mode & S_IFMT) !== S_IFDIR) {
      return this._setErr('ENOTDIR');
    }

    var entSize = DIR_ENT_HEADER + encodeStr(newName).length;
    if (!newPW.ino.extentOffset ||
        newPW.ino.dataSize + entSize > newPW.ino.extentCapacity) {
      if (this._growExtent(newPW.ino,
          (newPW.ino.dataSize || 0) + Math.max(entSize, 256)) === null) {
        // Restore old entry
        dirInsert(this._s, oldPW.ino.extentOffset,
          oldPW.ino.dataSize, oldW.inoId, oldName);
        oldPW.ino.dataSize += DIR_ENT_HEADER + encodeStr(oldName).length;
        oldPW.ino.nlink++;
        this._inodes.write(oldPW.inoId, oldPW.ino);
        return this._setErr('ENOSPC');
      }
    }
    dirInsert(this._s, newPW.ino.extentOffset,
      newPW.ino.dataSize || 0, oldW.inoId, newName);
    newPW.ino.dataSize = (newPW.ino.dataSize || 0) + entSize;
    newPW.ino.mtime = this._now();
    newPW.ino.nlink++;
    this._inodes.write(newPW.inoId, newPW.ino);
    return 0;
  };

  BlockFS.prototype.stat = function (path) {
    var w = this._walkPath(this._resolvePath(path));
    if (!w) return this._setErr('ENOENT');
    // Native unit -> whole seconds + sub-second nanoseconds. v3 stores seconds
    // (nsec always 0); v4 stores ms (nsec = ms-remainder * 1e6), which is what
    // lets build tools distinguish writes within the same second.
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

  BlockFS.prototype.lstat = function (path) {
    return this.stat(path); // no symlinks
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
    var pipe = { buffer: [], closed: { read: false, write: false } };
    var readFd = this._allocFd({
      type: 'pipe', pipe: pipe, pipeEnd: 'read', position: null
    });
    var writeFd = this._allocFd({
      type: 'pipe', pipe: pipe, pipeEnd: 'write', position: null
    });
    return [readFd, writeFd];
  };

  BlockFS.prototype.dup = function (oldfd) {
    if (oldfd < 0 || oldfd >= this._fdTable.length || !this._fdTable[oldfd])
      return this._setErr('EBADF');
    var entry = this._fdTable[oldfd];
    if (entry.type === 'pipe') {
      return this._allocFd({
        type: 'pipe', pipe: entry.pipe,
        pipeEnd: entry.pipeEnd, position: null
      });
    }
    return this._allocFd(entry);
  };

  BlockFS.prototype.dup2 = function (oldfd, newfd) {
    if (oldfd < 0 || oldfd >= this._fdTable.length || !this._fdTable[oldfd])
      return this._setErr('EBADF');
    if (newfd < 0) return this._setErr('EBADF');
    if (oldfd === newfd) return newfd;
    if (newfd < this._fdTable.length && this._fdTable[newfd] !== null) {
      this._fdTable[newfd] = null;
    }
    while (this._fdTable.length <= newfd) this._fdTable.push(null);
    var src = this._fdTable[oldfd];
    if (src.type === 'pipe') {
      this._fdTable[newfd] = {
        type: 'pipe', pipe: src.pipe,
        pipeEnd: src.pipeEnd, position: null
      };
    } else {
      this._fdTable[newfd] = src;
    }
    return newfd;
  };

  BlockFS.prototype.isatty = function (fd) {
    if (fd < 0 || fd >= this._fdTable.length || !this._fdTable[fd]) return 0;
    if (fd <= 2) return 1;
    return 0;
  };

  // ftruncate(fd, size) — truncate or extend an open file.
  BlockFS.prototype.ftruncate = function (fd, size) {
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
    w.ino.mode = (w.ino.mode & S_IFMT) | (mode & 0o7777);
    w.ino.ctime = this._now();
    this._inodes.write(w.inoId, w.ino);
    return 0;
  };

  // fchmod(fd, mode) — change mode on an open file.
  BlockFS.prototype.fchmod = function (fd, mode) {
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
    var sc = this._fmt.timeScale; // seconds (ABI) -> native unit
    w.ino.atime = atime !== undefined ? atime * sc : this._now();
    w.ino.mtime = mtime !== undefined ? mtime * sc : this._now();
    w.ino.ctime = this._now();
    this._inodes.write(w.inoId, w.ino);
    return 0;
  };

  // futime(fd, atime, mtime) — like utime() but on an open fd.
  BlockFS.prototype.futime = function (fd, atime, mtime) {
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
    if (this._walkPath(linkResolved)) return this._setErr('EEXIST');

    var parentPath = linkResolved.substring(0, linkResolved.lastIndexOf('/')) || '/';
    var linkName = linkResolved.substring(linkResolved.lastIndexOf('/') + 1);
    var pw = this._walkPath(parentPath);
    if (!pw) return this._setErr('ENOENT');
    if ((pw.ino.mode & S_IFMT) !== S_IFDIR) return this._setErr('ENOTDIR');

    var inoId = this._allocInode(S_IFREG | 0o777);
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
    this._inodes.write(pw.inoId, pw.ino);
    return 0;
  };

  // readlink(path, buf, bufsize) — read symlink target into buf.
  BlockFS.prototype.readlink = function (path, buf, bufsize) {
    var w = this._walkPath(this._resolvePath(path));
    if (!w) return this._setErr('ENOENT');
    if (!w.ino.extentOffset || w.ino.dataSize === 0) return 0;
    var n = Math.min(w.ino.dataSize, bufsize);
    var data = this._s.getBytes(w.ino.extentOffset, n);
    for (var i = 0; i < n; i++) buf[i] = data[i];
    return n;
  };

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

    if (entry.type === 'pipe') {
      this._fdTable[newfd] = {
        type: 'pipe', pipe: entry.pipe,
        pipeEnd: entry.pipeEnd, position: null
      };
    } else {
      this._fdTable[newfd] = entry;
    }
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
  // from fd 0.  data is an array of byte values.  Call before runModule.
  BlockFS.prototype.setStdin = function (data) {
    for (var i = 0; i < data.length; i++) this._stdinBuffer.push(data[i]);
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
      Atomics.wait(ctrl, SI_SEQ, seq); // wake on next producer push/EOF
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
        if (fd === 1 || fd === 2) {
          var memory = getMemory();
          var buf = new Uint8Array(memory.buffer, buf_ptr, count);
          if (fd === 1) writeOut(buf);
          else writeErr(buf);
          return count;
        }
        var memory = getMemory();
        var buf = new Uint8Array(memory.buffer, buf_ptr, count);
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
              } else if (entry.position === null) {
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
            }
            return commit(scan());
          }
          for (;;) {
            var seq2 = Atomics.load(ctrl, SI_SEQ);
            if (self._stdinSabReady()) break;
            Atomics.wait(ctrl, SI_SEQ, seq2);
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
        // Read the real terminal size from the live-stdin sab when wired (the
        // page keeps COLS/ROWS current); otherwise fall back to 80x24.
        var rows = 24, cols = 80;
        if (self._stdinSab) {
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

      // ---- additional POSIX ops ----
      realpath: wrap(function (path_ptr, resolved_ptr) {
        var path = readString(path_ptr);
        var resolved = this._resolvePath(path);
        var encoded = encodeStr(resolved);
        if (resolved_ptr) {
          var memory = getMemory();
          var bytes = new Uint8Array(memory.buffer);
          for (var ri = 0; ri < encoded.length; ri++)
            bytes[resolved_ptr + ri] = encoded[ri];
          bytes[resolved_ptr + encoded.length] = 0;
        }
        return resolved_ptr;
      }),
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
      fcntl: wrap(function (fd, cmd) {
        // F_DUPFD (cmd == 0)
        if (cmd === 0) {
          var arg = arguments[2] || 0;
          return this.fcntl_dupfd(fd, arg);
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
      fsync: wrap(function (fd) { return 0; }),
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

    var v4 = await open(v4name, true);
    if (BlockFS.isMigrationComplete(v4.store)) {
      return { fs: BlockFS.createV4(v4.store), mode: 'v4', handles: [v4.handle] };
    }
    // v4 absent/incomplete: migrate forward from a legacy v3 image if present.
    var legacy = await open(v3name, false);
    if (legacy && isV3(legacy.store)) {
      v4.handle.truncate(0);                       // discard any partial v4, clean retry
      BlockFS.migrateV3toV4(legacy.store, v4.store); // legacy is read-only inside migrate
      legacy.handle.close();                       // release v3 handle; file kept as rollback
      return { fs: BlockFS.createV4(v4.store), mode: 'migrated', handles: [v4.handle] };
    }
    if (legacy) legacy.handle.close();
    return { fs: BlockFS.createV4(v4.store), mode: 'fresh', handles: [v4.handle] };
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
  BlockFS.createV4 = function (store) {
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
      fs.ensureDevNodes();
      return fs;
    }
    alloc = new TLSF64Allocator(store, SUPERBLOCK_SIZE, 0); // load existing metadata
    inodeTable = new InodeTable128(alloc);
    fs = new BlockFS(store, alloc, inodeTable, store.getUint32(SB_ROOT_INODE), false, FMT_V4);
    fs.ensureDevNodes(); // self-heal /dev on every v4 mount (idempotent)
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
        var st = src.stat(sp);
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
        } else {
          // Regular file (symlinks are stored as regular files whose content is
          // the target, so a byte copy migrates them correctly too).
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
  // Module exports
  // =================================================================

  return {
    init: BlockFS.init,
    openWorkspace: BlockFS.openWorkspace,
    create: BlockFS.create,
    createV4: BlockFS.createV4,
    migrateV3toV4: BlockFS.migrateV3toV4,
    isMigrationComplete: BlockFS.isMigrationComplete,
    MemoryByteStore: MemoryByteStore,
    ReadOnlyStore: ReadOnlyStore,
    TLSFAllocator: TLSFAllocator,
    TLSF64Allocator: TLSF64Allocator,
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
  const pid = process.pid;
  return {
    [ENV_KEY]: {
      getpid: function () { return pid; },
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
  const nextPid = 1;
  return {
    [ENV_KEY]: {
      getpid: function () { return nextPid; },
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
function createNullSDL() {
  let animationFrameFunc = null;
  return {
    getAnimationFrameFunc: function () { return animationFrameFunc; },
    [ENV_KEY]: {
      __sdl_init: function () { return 0; },
      __sdl_quit: function () { animationFrameFunc = null; },
      __sdl_create_window: function () { return 1; },
      __sdl_destroy_window: function () {},
      __sdl_set_window_title: function () {},
      __sdl_update_window_surface: function () { return 0; },
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
      __sdl_get_ticks: function () { return Date.now() & 0xffffffff; },
      __sdl_delay: function () {},
    },
  };
}

/**
 * Create SDL WASM imports backed by HTML5 Canvas and Web Audio API.
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas - The canvas element for rendering.
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createBrowserSDL({ canvas, ctx, sharedAudioBuffer, notifyAudio, notifyWindow }) {
  const { readString, getMemory, getExports } = ctx;

  const sdlWindows = [];
  const sdlAudioDevices = [];
  let animationFrameFunc = null;

  return {
    [ENV_KEY]: {
      __sdl_init: function (flags) { return 0; },
      __sdl_quit: function () { animationFrameFunc = null; },

      __sdl_create_window: function (title_ptr, x, y, w, h, flags) {
        canvas.width = w;
        canvas.height = h;
        const canvasCtx = canvas.getContext('2d');
        sdlWindows.push({ canvas: canvas, ctx2d: canvasCtx, width: w, height: h });
        const handle = sdlWindows.length;
        if (notifyWindow) notifyWindow({ type: 'sdl-window', width: w, height: h });
        return handle;
      },
      __sdl_destroy_window: function (handle) {
        if (handle > 0 && sdlWindows[handle - 1]) {
          sdlWindows[handle - 1] = null;
        }
      },
      __sdl_set_window_title: function (handle, title_ptr) {
      },

      __sdl_update_window_surface: function (handle, pixelsPtr, w, h, pitch) {
        const winInfo = sdlWindows[handle - 1];
        if (!winInfo) return -1;
        const memory = getMemory();
        const src = new Uint8Array(memory.buffer, pixelsPtr, pitch * h);
        const imageData = winInfo.ctx2d.createImageData(w, h);
        /* pitch may differ from w*4 if there's padding; copy row by row */
        const rowBytes = w * 4;
        for (let row = 0; row < h; row++) {
          imageData.data.set(
            src.subarray(row * pitch, row * pitch + rowBytes),
            row * rowBytes
          );
        }
        winInfo.ctx2d.putImageData(imageData, 0, 0);
        return 0;
      },

      /* ---- Audio ---- */
      /* PCM is written into a SharedArrayBuffer ring buffer. The main thread
       * reads from the same buffer and handles AudioContext scheduling.
       *
       * SharedArrayBuffer layout (see createSharedAudioBuffer):
       *   Int32[0] = writePos, Int32[1] = queuedBytes, Int32[2] = playing
       *   Bytes 16+ = PCM ring buffer data
       */
      __sdl_open_audio_device: function (freq, format, channels) {
        sdlAudioDevices.push({ freq: freq, channels: channels });
        const id = sdlAudioDevices.length;
        if (notifyAudio) notifyAudio({ type: 'audio-open', id: id, freq: freq, format: format, channels: channels });
        return id;
      },
      __sdl_queue_audio: function (dev, dataPtr, len) {
        if (!sharedAudioBuffer) return 0;
        const sab = sharedAudioBuffer.sharedBuffer;
        const cap = sharedAudioBuffer.bufferSize;
        const control = new Int32Array(sab, 0, 4);
        const ringData = new Uint8Array(sab, 16, cap);
        const queuedBytes = Atomics.load(control, 1);
        if (queuedBytes + len > cap) return 0; /* buffer full */
        const memory = getMemory();
        // Defend against the wasm passing a bad (dataPtr, len) pair —
        // drop the chunk rather than crash the worker.
        if (dataPtr < 0 || len < 0 ||
            (dataPtr >>> 0) + (len >>> 0) > memory.buffer.byteLength) {
          return 0;
        }
        const src = new Uint8Array(memory.buffer, dataPtr, len);
        const writePos = Atomics.load(control, 0) % cap;
        const firstChunk = Math.min(len, cap - writePos);
        ringData.set(src.subarray(0, firstChunk), writePos);
        if (firstChunk < len) {
          ringData.set(src.subarray(firstChunk), 0);
        }
        Atomics.add(control, 0, len); /* advance writePos */
        Atomics.add(control, 1, len); /* increment queuedBytes */
        return 0;
      },
      __sdl_get_queued_audio_size: function (dev) {
        if (!sharedAudioBuffer) return 0x7FFFFFFF;
        const control = new Int32Array(sharedAudioBuffer.sharedBuffer, 0, 4);
        return Atomics.load(control, 1);
      },
      __sdl_clear_queued_audio: function (dev) {
        if (!sharedAudioBuffer) return;
        const control = new Int32Array(sharedAudioBuffer.sharedBuffer, 0, 4);
        Atomics.store(control, 1, 0);
        if (notifyAudio) notifyAudio({ type: 'audio-clear', id: dev });
      },
      __sdl_pause_audio_device: function (dev, pause_on) {
        if (notifyAudio) notifyAudio({ type: 'audio-pause', id: dev, pause: !!pause_on });
      },
      __sdl_close_audio_device: function (dev) {
        if (notifyAudio) notifyAudio({ type: 'audio-close', id: dev });
      },

      __sdl_delay: (typeof WebAssembly.Suspending === 'function')
        ? new WebAssembly.Suspending(async function (ms) {
          await new Promise(function (r) { setTimeout(r, ms); });
        })
        : function (ms) { /* no-op without JSPI */ },
      __sdl_get_ticks: function () { return Math.floor(performance.now()); },
      __sdl_set_animation_frame_func: function (callbackPtr) {
        animationFrameFunc = callbackPtr;
      },
    },
    getAnimationFrameFunc: function () { return animationFrameFunc; },
    requestAnimationFrame: typeof requestAnimationFrame === 'function'
      ? function (cb) { requestAnimationFrame(cb); }
      : null,
    /* Push a key event from external source (e.g. worker message) */
    pushKeyEvent: function (handle, eventType, scancode, sym) {
      const fn = getExports().__sdl_push_key_event;
      if (fn) fn(handle, eventType, scancode, sym);
    },
    pushQuitEvent: function (handle) {
      const fn = getExports().__sdl_push_quit_event;
      if (fn) fn(handle);
    },
    pushMouseButtonEvent: function (handle, eventType, button, x, y) {
      const fn = getExports().__sdl_push_mouse_button_event;
      if (fn) fn(handle, eventType, button, x, y);
    },
    pushMouseMotionEvent: function (handle, x, y) {
      const fn = getExports().__sdl_push_mouse_motion_event;
      if (fn) fn(handle, x, y);
    },
    pushMouseWheelEvent: function (handle, x, y) {
      const fn = getExports().__sdl_push_mouse_wheel_event;
      if (fn) fn(handle, x, y);
    },
  };

}

/**
 * Create a shared audio buffer for worker-based audio.
 *
 * Layout of the SharedArrayBuffer:
 *   Bytes 0-3:   Int32 writePos (updated by worker via Atomics)
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
 *   Int32[0]: writePos  (worker writes, main reads)
 *   Int32[1]: available (worker increments via Atomics.add, main decrements)
 *   Int32[2]: termCols  (main writes, worker reads)
 *   Int32[3]: termRows  (main writes, worker reads)
 *   Bytes 16+: ring buffer data
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
  const headerSize = 16; /* 4 Int32 fields */
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
  const headerSize = 16;
  const control = new Int32Array(sab, 0, 4); /* [writePos, queuedBytes, playing, reserved] */
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
        Atomics.store(control, 2, 0);
        dev.ctx.suspend();
      } else {
        Atomics.store(control, 2, 1);
        dev.ctx.resume();
        dev.nextTime = dev.ctx.currentTime;
      }
    } else if (msg.type === 'audio-clear') {
      Atomics.store(control, 1, 0); /* reset queuedBytes */
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
    if (!Atomics.load(control, 2)) return; /* not playing */

    const cap = bufferSize;
    while (device.inflight < device.maxInflight) {
      const queuedBytes = Atomics.load(control, 1);
      if (queuedBytes < device.batchBytes) break;

      const writePos = Atomics.load(control, 0);
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
      Atomics.sub(control, 1, len); /* decrement queuedBytes */

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

/**
 * Instantiate and run a compiled WASM module.
 * @param {RunModuleOptions} options
 * @returns {Promise<number>} The exit code from main().
 */
async function runModule({
  bytes,
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
  sharedAudioBuffer,
  notifyAudio,
  notifyWindow,
  sharedConsoleBuffer,
  notifyConsole,
  writeOut,
  writeErr,
  onReady,
}) {
  /* Die quietly on EPIPE (e.g. `prog | head`) like a native program killed
     by SIGPIPE (128+13), instead of crashing with an unhandled stream
     'error' event. Only installed for the default writers — callers that
     pass their own writeOut/writeErr handle their own errors. */
  function exitOnEpipe(e) {
    if (e && e.code === 'EPIPE') process.exit(141);
    throw e;
  }
  if (!writeOut && typeof process !== 'undefined' && process.stdout) {
    process.stdout.on('error', exitOnEpipe);
    writeOut = function (buf) { process.stdout.write(buf); };
  }
  if (!writeErr && typeof process !== 'undefined' && process.stderr) {
    process.stderr.on('error', exitOnEpipe);
    writeErr = function (buf) { process.stderr.write(buf); };
  }
  if (!writeOut) writeOut = function () {};
  if (!writeErr) writeErr = function () {};
  const compileOptions = { builtins: ['js-string'] };
  const module = new WebAssembly.Module(bytes, compileOptions);
  const hasJSPI = typeof WebAssembly.Suspending === 'function';

  /* Import object providing host functions */
  const utf8Decoder = new TextDecoder('utf-8');
  const latin1Decoder = new TextDecoder('latin1');
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
    return latin1Decoder.decode(bytes.subarray(ptr, end));
  }

  /* Read a bounded byte string as Latin-1. Use for scanf input, where
   * arbitrary (non-UTF-8) bytes must round-trip exactly. */
  function readLatin1Bounded(ptr, endPtr) {
    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer);
    return latin1Decoder.decode(bytes.subarray(ptr, endPtr));
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
              str = m + 'e' + fmtExponent(exp);
            } else {
              str = fmtFixedExact(val, Math.max(0, prec - 1 - exp));
              if (!flags.hash && str.indexOf('.') !== -1) str = str.replace(/\.?0+$/, '');
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
        const padChar = (flags.zero && !flags.minus && (isFloat || precision < 0)) ? '0' : ' ';
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
    else if (length === 'll') view.setBigInt64(ptr, BigInt(count), true);
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
          /* Unsigned decimal */
          const start = si;
          if (si < str.length && str[si] === '+') si++;
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
    'ERANGE': 34, 'ENAMETOOLONG': 36, 'ENOSYS': 38, 'ENOTEMPTY': 39
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
      /* POSIX clock_gettime */
      __clock_ns_hi: function () {
        const now = performance.now();
        return Math.floor(now / 1000);
      },
      __clock_ns_lo: function () {
        const now = performance.now();
        const secs = Math.floor(now / 1000);
        return Math.floor((now - secs * 1000) * 1000000);
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
      const memory = instance.exports.memory;
      const src = new Uint8Array(memory.buffer, bufPtr, len);
      const writePos = Atomics.load(conControl, 0);
      for (let i = 0; i < len; i++) {
        conRingBuf[(writePos + i) % conBufSize] = src[i];
      }
      Atomics.store(conControl, 0, (writePos + len) % conBufSize);
      Atomics.add(conControl, 1, len);
      if (notifyConsole) notifyConsole();
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

  const instance = new WebAssembly.Instance(module, imports);

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
    if (instance.exports.exit) {
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
    await new Promise(function (resolve) {
      function scheduleFrame() {
        const doFrame = async function () {
          const animFunc = sdl.getAnimationFrameFunc();
          if (!animFunc) {
            resolve();
            return;
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
          setTimeout(doFrame, 16);
        }
      }
      scheduleFrame();
    });
  }

  return exitCode;
}

// --------------------------------------------------------------------------
// Dual-purpose logic: Run if Main (Node), Export if Module (Node/Browser)
// --------------------------------------------------------------------------

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  // We are in Node.js AND we are the main script
  const fs = require('fs');
  const wasmPath = process.argv[2] || 'a.wasm';
  const bytes = fs.readFileSync(wasmPath);

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
      try { fileBuf = fs.readFileSync(blockFSPath); } catch (e) {}
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
        var stdinChunks = [];
        var stdinBuf = Buffer.alloc(65536);
        while (true) {
          var nr = fs.readSync(0, stdinBuf, 0, stdinBuf.length);
          if (nr === 0) break;
          for (var si = 0; si < nr; si++) stdinChunks.push(stdinBuf[si]);
        }
      } catch (e) {
        // fd 0 might be closed or a TTY after all — fine.
      }
      if (stdinChunks.length > 0) {
        blockFS.setStdin(stdinChunks);
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
      process.exit(exitCode);
    }).catch(function (e) {
      process.stderr.write('Fatal: ' + e.message + '\n');
      if (e.stack) process.stderr.write(e.stack + '\n');
      process.exit(1);
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
      process.exit(exitCode);
    }).catch(function (e) {
      process.stderr.write('Fatal: ' + e.message + '\n');
      if (e.stack) process.stderr.write(e.stack + '\n');
      process.exit(1);
    });
  }

} else if (typeof module !== 'undefined') {
  // We are being imported (Node or bundler)
  module.exports = runModule;
  // Test exports: BLOCK_FS components
  module.exports.BLOCK_FS = BLOCK_FS;
}

// Browser global exports
if (typeof window !== 'undefined') {
  window.createSharedAudioBuffer = createSharedAudioBuffer;
  window.createAudioReceiver = createAudioReceiver;
  window.createSharedConsoleBuffer = createSharedConsoleBuffer;
  window.createConsoleReceiver = createConsoleReceiver;
}

// Worker global exports
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof module === 'undefined') {
  self.runModule = runModule;
  self.createBrowserSDL = createBrowserSDL;
  self.BLOCK_FS = BLOCK_FS;
}
