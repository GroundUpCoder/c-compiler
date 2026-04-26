#!/usr/bin/env node

const ENV_KEY = "c.mtots.com";

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
 * @property {function(): SDLLib} [getSDL] - Lazy getter for the SDL library (require on demand).
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
    { nativeFd: 0, position: null },  /* fd 0 = stdin  (not seekable) */
    { nativeFd: 1, position: null },  /* fd 1 = stdout (not seekable) */
    { nativeFd: 2, position: null },  /* fd 2 = stderr (not seekable) */
  ];

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

  /* Helper to write struct stat fields into WASM memory at buf_ptr.
     Layout: st_dev(4) st_ino(4) st_mode(4) st_nlink(4) st_size(4) st_atime(4) st_mtime(4) st_ctime(4) */
  function writeStatBuf(buf_ptr, st) {
    const memory = getMemory();
    const view = new DataView(memory.buffer);
    view.setUint32(buf_ptr + 0, 0, true);                              /* st_dev */
    view.setUint32(buf_ptr + 4, st.ino || 0, true);                    /* st_ino */
    let mode = 0;
    if (st.isFile()) mode = 0o100000;
    else if (st.isDirectory()) mode = 0o040000;
    else if (st.isSymbolicLink()) mode = 0o120000;
    mode |= (st.mode & 0o7777);
    view.setUint32(buf_ptr + 8, mode, true);                           /* st_mode */
    view.setUint32(buf_ptr + 12, st.nlink || 1, true);                 /* st_nlink */
    view.setUint32(buf_ptr + 16, st.size || 0, true);                  /* st_size */
    view.setInt32(buf_ptr + 20, Math.floor((st.atimeMs || 0) / 1000), true);  /* st_atime */
    view.setInt32(buf_ptr + 24, Math.floor((st.mtimeMs || 0) / 1000), true);  /* st_mtime */
    view.setInt32(buf_ptr + 28, Math.floor((st.ctimeMs || 0) / 1000), true);  /* st_ctime */
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
          try {
            const stat = fs.fstatSync(fd);
            entry.position = stat.size;
          } catch (e) { }
        }
        return allocFd(entry);
      },
      close: function (fd) {
        if (fd < 3 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        try {
          fs.closeSync(fdTable[fd].nativeFd);
        } catch (e) {
          setErrno(e);
          return -1;
        }
        fdTable[fd] = null;
        return 0;
      },
      read: function (fd, buf_ptr, count) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
        const memory = getMemory();
        const buf = new Uint8Array(memory.buffer, buf_ptr, count);
        const entry = fdTable[fd];
        try {
          let n;
          if (entry.position === null) {
            /* stdin or non-seekable */
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
      },
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
          const n = fs.writeSync(entry.nativeFd, buf, 0, count, entry.position);
          if (entry.position !== null) entry.position += n;
          return n;
        } catch (e) {
          setErrno(e);
          return -1;
        }
      },
      lseek: function (fd, offset, whence) {
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
      },
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
        /* For regular file fds, dup the native fd and share the position */
        try {
          const newNativeFd = fs.openSync('/dev/fd/' + entry.nativeFd, entry.position !== null ? 'r+' : 'r');
          return allocFd({ nativeFd: newNativeFd, position: entry.position });
        } catch (e) {
          /* Fallback: share the same native fd (not ideal but functional) */
          return allocFd({ nativeFd: entry.nativeFd, position: entry.position });
        }
      },
      dup2: function (oldfd, newfd) {
        if (oldfd < 0 || oldfd >= fdTable.length || !fdTable[oldfd]) { setErrnoName('EBADF'); return -1; }
        if (newfd < 0) { setErrnoName('EBADF'); return -1; }
        if (oldfd === newfd) return newfd;
        /* Close newfd if open */
        if (newfd < fdTable.length && fdTable[newfd]) {
          const entry = fdTable[newfd];
          if (entry.nativeFd !== undefined && newfd >= 3) {
            try { fs.closeSync(entry.nativeFd); } catch (e) { }
          }
          fdTable[newfd] = null;
        }
        /* Extend table if needed */
        while (fdTable.length <= newfd) fdTable.push(null);
        const src = fdTable[oldfd];
        if (src.type === 'pipe') {
          fdTable[newfd] = { type: 'pipe', pipe: src.pipe, pipeEnd: src.pipeEnd, position: null };
        } else {
          fdTable[newfd] = { nativeFd: src.nativeFd, position: src.position };
        }
        return newfd;
      },
      isatty: function (fd) {
        if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return 0; }
        if (fd <= 2) return 1; /* stdin/stdout/stderr are ttys */
        return 0;
      },
    },
  };

  /* Patch read/write/close to handle pipe fds */
  const origRead = result[ENV_KEY].read;
  const origWrite = result[ENV_KEY].write;
  const origClose = result[ENV_KEY].close;

  result[ENV_KEY].read = function (fd, buf_ptr, count) {
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
    return origRead(fd, buf_ptr, count);
  };

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

/**
 * Create file-system WASM imports backed by the Origin Private File System (OPFS).
 * File open/stat/mkdir/etc. use async OPFS APIs via JSPI (WebAssembly.Suspending).
 * Read/write/lseek/close use the sync OPFS access handle API (no JSPI needed).
 * Stdin uses JSPI to await input from the main thread via requestStdin callback.
 * @param {object} options
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createBrowserFileSystem({ ctx }) {
  const { readString, createVaReader, setErrnoName, getMemory, writeOut, writeErr, requestStdin } = ctx;
  const hasJSPI = typeof WebAssembly.Suspending === 'function';

  let cwd = '/';
  const encoder = new TextEncoder();

  /* fd table: entries for 0/1/2 (stdin/stdout/stderr) */
  const fdTable = [
    { position: null }, /* fd 0 = stdin */
    { position: null }, /* fd 1 = stdout */
    { position: null }, /* fd 2 = stderr */
  ];

  function allocFd(entry) {
    for (let i = 3; i < fdTable.length; i++) {
      if (fdTable[i] === null) { fdTable[i] = entry; return i; }
    }
    fdTable.push(entry);
    return fdTable.length - 1;
  }

  /* Directory handle table for opendir/readdir/closedir */
  const dirTable = [];
  function allocDirHandle(entry) {
    for (let i = 0; i < dirTable.length; i++) {
      if (dirTable[i] === null) { dirTable[i] = entry; return i; }
    }
    dirTable.push(entry);
    return dirTable.length - 1;
  }

  /* Resolve a possibly-relative path against cwd */
  function resolvePath(path) {
    if (path.charAt(0) !== '/') {
      path = cwd + (cwd.endsWith('/') ? '' : '/') + path;
    }
    /* Normalize: split, resolve . and .., rejoin */
    const parts = path.split('/');
    const resolved = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') continue;
      if (parts[i] === '..') { resolved.pop(); continue; }
      resolved.push(parts[i]);
    }
    return '/' + resolved.join('/');
  }

  /* Walk OPFS directory handles to reach a path.
     Returns { parent: FileSystemDirectoryHandle, name: string } or the handle itself.
     If getLeaf is true, returns the final handle (file or dir). */
  async function walkPath(path, opts) {
    const create = opts && opts.create;
    const getLeaf = opts && opts.getLeaf;
    const resolved = resolvePath(path);
    const parts = resolved.split('/').filter(function (p) { return p.length > 0; });
    const root = await navigator.storage.getDirectory();
    if (parts.length === 0) {
      if (getLeaf) return root;
      return { parent: root, name: '' };
    }
    let dir = root;
    const dirParts = getLeaf ? parts : parts.slice(0, -1);
    for (let i = 0; i < dirParts.length; i++) {
      try {
        dir = await dir.getDirectoryHandle(dirParts[i], { create: !!create });
      } catch (e) {
        return null;
      }
    }
    if (getLeaf) return dir;
    return { parent: dir, name: parts[parts.length - 1] };
  }

  /* Get a file handle, trying file first then directory */
  async function getHandle(path) {
    const info = await walkPath(path);
    if (!info) return null;
    if (info.name === '') return { kind: 'directory', handle: info.parent };
    try {
      const fh = await info.parent.getFileHandle(info.name);
      return { kind: 'file', handle: fh, parent: info.parent, name: info.name };
    } catch (e) {}
    try {
      const dh = await info.parent.getDirectoryHandle(info.name);
      return { kind: 'directory', handle: dh, parent: info.parent, name: info.name };
    } catch (e) {}
    return null;
  }

  function writeStatBuf(buf_ptr, size, isDir) {
    const memory = getMemory();
    const view = new DataView(memory.buffer);
    const now = Math.floor(Date.now() / 1000);
    view.setUint32(buf_ptr + 0, 0, true);                          /* st_dev */
    view.setUint32(buf_ptr + 4, 0, true);                          /* st_ino */
    view.setUint32(buf_ptr + 8, isDir ? 0o040755 : 0o100644, true); /* st_mode */
    view.setUint32(buf_ptr + 12, 1, true);                         /* st_nlink */
    view.setUint32(buf_ptr + 16, size, true);                      /* st_size */
    view.setInt32(buf_ptr + 20, now, true);                        /* st_atime */
    view.setInt32(buf_ptr + 24, now, true);                        /* st_mtime */
    view.setInt32(buf_ptr + 28, now, true);                        /* st_ctime */
  }

  function wrapAsync(fn) {
    if (hasJSPI) return new WebAssembly.Suspending(fn);
    /* Fallback: return a sync stub that returns -1 */
    return function () { setErrnoName('ENOSYS'); return -1; };
  }

  const env = {
    __open_impl: wrapAsync(async function (path_ptr, flags, mode) {
      const path = readString(path_ptr);
      const create = !!(flags & 0x40); /* O_CREAT */
      const trunc = !!(flags & 0x200); /* O_TRUNC */
      const append = !!(flags & 0x400); /* O_APPEND */
      const excl = !!(flags & 0x80);   /* O_EXCL */

      try {
        const info = await walkPath(path, { create: create });
        if (!info) { setErrnoName('ENOENT'); return -1; }
        if (info.name === '') { setErrnoName('EISDIR'); return -1; }

        if (excl && create) {
          let exists = true;
          try { await info.parent.getFileHandle(info.name); } catch (e) { exists = false; }
          if (exists) { setErrnoName('EEXIST'); return -1; }
        }
        const fileHandle = await info.parent.getFileHandle(info.name, { create: create });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        if (trunc) syncHandle.truncate(0);
        const position = append ? syncHandle.getSize() : 0;

        return allocFd({ syncHandle: syncHandle, position: position, path: path });
      } catch (e) {
        setErrnoName('ENOENT');
        return -1;
      }
    }),

    close: function (fd) {
      if (fd < 3 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
      const entry = fdTable[fd];
      if (entry.type === 'pipe') {
        entry.pipe.closed[entry.pipeEnd] = true;
        fdTable[fd] = null;
        return 0;
      }
      if (entry.syncHandle) {
        entry.syncHandle.flush();
        entry.syncHandle.close();
      }
      fdTable[fd] = null;
      return 0;
    },

    read: wrapAsync(async function (fd, buf_ptr, count) {
      if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
      const entry = fdTable[fd];
      if (entry.type === 'pipe') {
        const pipe = entry.pipe;
        if (pipe.buffer.length === 0) return 0;
        const n = Math.min(count, pipe.buffer.length);
        const memory = getMemory();
        const dest = new Uint8Array(memory.buffer, buf_ptr, n);
        for (let i = 0; i < n; i++) dest[i] = pipe.buffer[i];
        pipe.buffer.splice(0, n);
        return n;
      }
      if (entry.position === null) {
        /* stdin */
        if (!requestStdin) return 0;
        const data = await requestStdin(count);
        if (!data || data.length === 0) return 0;
        const n = Math.min(count, data.length);
        const memory = getMemory();
        const dest = new Uint8Array(memory.buffer, buf_ptr, n);
        dest.set(data.subarray(0, n));
        return n;
      }
      const buf = new Uint8Array(count);
      const n = entry.syncHandle.read(buf, { at: entry.position });
      if (n <= 0) return 0;
      const memory = getMemory();
      const dest = new Uint8Array(memory.buffer, buf_ptr, n);
      dest.set(buf.subarray(0, n));
      entry.position += n;
      return n;
    }),

    write: function (fd, buf_ptr, count) {
      if (fd === 1 || fd === 2) {
        const memory = getMemory();
        const buf = new Uint8Array(memory.buffer, buf_ptr, count);
        if (fd === 1) { writeOut(buf); } else { writeErr(buf); }
        return count;
      }
      if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
      const entry = fdTable[fd];
      if (entry.type === 'pipe') {
        if (entry.pipe.closed.read) { setErrnoName('EPIPE'); return -1; }
        const memory = getMemory();
        const src = new Uint8Array(memory.buffer, buf_ptr, count);
        for (let i = 0; i < count; i++) entry.pipe.buffer.push(src[i]);
        return count;
      }
      const memory = getMemory();
      const src = new Uint8Array(memory.buffer, buf_ptr, count);
      const n = entry.syncHandle.write(src, { at: entry.position });
      entry.position += n;
      return n;
    },

    lseek: function (fd, offset, whence) {
      if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
      const entry = fdTable[fd];
      if (entry.position === null) { setErrnoName('ESPIPE'); return -1; }
      let newPos;
      switch (whence) {
        case 0: newPos = offset; break;
        case 1: newPos = entry.position + offset; break;
        case 2: newPos = entry.syncHandle.getSize() + offset; break;
        default: setErrnoName('EINVAL'); return -1;
      }
      if (newPos < 0) { setErrnoName('EINVAL'); return -1; }
      entry.position = newPos;
      return newPos;
    },

    mkdir: wrapAsync(async function (path_ptr, mode) {
      const path = readString(path_ptr);
      try {
        const info = await walkPath(path);
        if (!info || info.name === '') { setErrnoName('EEXIST'); return -1; }
        await info.parent.getDirectoryHandle(info.name, { create: true });
        return 0;
      } catch (e) {
        setErrnoName('EIO');
        return -1;
      }
    }),

    remove: wrapAsync(async function (path_ptr) {
      const path = readString(path_ptr);
      try {
        const info = await walkPath(path);
        if (!info || info.name === '') { setErrnoName('ENOENT'); return -1; }
        await info.parent.removeEntry(info.name);
        return 0;
      } catch (e) {
        setErrnoName('ENOENT');
        return -1;
      }
    }),

    rename: wrapAsync(async function (oldpath_ptr, newpath_ptr) {
      const oldpath = readString(oldpath_ptr);
      const newpath = readString(newpath_ptr);
      try {
        /* OPFS has no rename — copy + delete */
        const oldInfo = await walkPath(oldpath);
        const newInfo = await walkPath(newpath, { create: true });
        if (!oldInfo || !newInfo || oldInfo.name === '' || newInfo.name === '') {
          setErrnoName('ENOENT'); return -1;
        }
        const oldHandle = await oldInfo.parent.getFileHandle(oldInfo.name);
        const file = await oldHandle.getFile();
        const data = await file.arrayBuffer();
        const newHandle = await newInfo.parent.getFileHandle(newInfo.name, { create: true });
        const writable = await newHandle.createWritable();
        await writable.write(data);
        await writable.close();
        await oldInfo.parent.removeEntry(oldInfo.name);
        return 0;
      } catch (e) {
        setErrnoName('EIO');
        return -1;
      }
    }),

    __opendir: wrapAsync(async function (path_ptr) {
      const path = readString(path_ptr);
      try {
        const dirHandle = await walkPath(path, { getLeaf: true });
        if (!dirHandle || dirHandle.kind === 'file') { setErrnoName('ENOTDIR'); return -1; }
        /* Eagerly collect entries since OPFS iteration is async */
        const entries = [];
        for await (const entry of dirHandle.entries()) {
          entries.push({ name: entry[0], kind: entry[1].kind });
        }
        return allocDirHandle({ entries: entries, index: 0, dotState: 0 });
      } catch (e) {
        setErrnoName('ENOENT');
        return -1;
      }
    }),

    __readdir: function (handle, dirent_ptr) {
      if (handle < 0 || handle >= dirTable.length || !dirTable[handle]) {
        setErrnoName('EBADF');
        return -1;
      }
      const memory = getMemory();
      const view = new DataView(memory.buffer);
      const bytes = new Uint8Array(memory.buffer);
      const dirEntry = dirTable[handle];

      /* Synthesize "." and ".." */
      if (dirEntry.dotState < 2) {
        const dotName = dirEntry.dotState === 0 ? "." : "..";
        dirEntry.dotState++;
        view.setInt32(dirent_ptr + 0, 0, true);
        view.setInt32(dirent_ptr + 4, 4, true); /* DT_DIR */
        const enc = encoder.encode(dotName);
        for (let i = 0; i < enc.length; i++) bytes[dirent_ptr + 8 + i] = enc[i];
        bytes[dirent_ptr + 8 + enc.length] = 0;
        return 0;
      }

      if (dirEntry.index >= dirEntry.entries.length) return -1;
      const entry = dirEntry.entries[dirEntry.index++];
      view.setInt32(dirent_ptr + 0, 0, true);
      view.setInt32(dirent_ptr + 4, entry.kind === 'directory' ? 4 : 8, true);
      const nameBytes = encoder.encode(entry.name);
      const nameLen = Math.min(nameBytes.length, 255);
      for (let i = 0; i < nameLen; i++) bytes[dirent_ptr + 8 + i] = nameBytes[i];
      bytes[dirent_ptr + 8 + nameLen] = 0;
      return 0;
    },

    __closedir: function (handle) {
      if (handle < 0 || handle >= dirTable.length || !dirTable[handle]) {
        setErrnoName('EBADF'); return -1;
      }
      dirTable[handle] = null;
      return 0;
    },

    stat: wrapAsync(async function (path_ptr, buf_ptr) {
      const path = readString(path_ptr);
      try {
        const h = await getHandle(path);
        if (!h) { setErrnoName('ENOENT'); return -1; }
        let size = 0;
        if (h.kind === 'file') {
          const file = await h.handle.getFile();
          size = file.size;
        }
        writeStatBuf(buf_ptr, size, h.kind === 'directory');
        return 0;
      } catch (e) {
        setErrnoName('ENOENT');
        return -1;
      }
    }),

    lstat: wrapAsync(async function (path_ptr, buf_ptr) {
      /* No symlinks in OPFS — same as stat */
      const path = readString(path_ptr);
      try {
        const h = await getHandle(path);
        if (!h) { setErrnoName('ENOENT'); return -1; }
        let size = 0;
        if (h.kind === 'file') {
          const file = await h.handle.getFile();
          size = file.size;
        }
        writeStatBuf(buf_ptr, size, h.kind === 'directory');
        return 0;
      } catch (e) {
        setErrnoName('ENOENT');
        return -1;
      }
    }),

    fstat: function (fd, buf_ptr) {
      if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return -1; }
      const entry = fdTable[fd];
      writeStatBuf(buf_ptr, entry.buffer ? entry.buffer.length : 0, false);
      return 0;
    },

    getcwd: function (buf_ptr, size) {
      const encoded = encoder.encode(cwd);
      if (encoded.length + 1 > size) { setErrnoName('ERANGE'); return 0; }
      const memory = getMemory();
      const bytes = new Uint8Array(memory.buffer);
      for (let i = 0; i < encoded.length; i++) bytes[buf_ptr + i] = encoded[i];
      bytes[buf_ptr + encoded.length] = 0;
      return buf_ptr;
    },

    chdir: function (path_ptr) {
      const path = readString(path_ptr);
      cwd = resolvePath(path);
      return 0;
    },

    access: wrapAsync(async function (path_ptr, mode) {
      const path = readString(path_ptr);
      const h = await getHandle(path);
      if (!h) { setErrnoName('ENOENT'); return -1; }
      return 0;
    }),

    rmdir: wrapAsync(async function (path_ptr) {
      const path = readString(path_ptr);
      try {
        const info = await walkPath(path);
        if (!info || info.name === '') { setErrnoName('ENOENT'); return -1; }
        await info.parent.removeEntry(info.name, { recursive: true });
        return 0;
      } catch (e) {
        setErrnoName('EIO');
        return -1;
      }
    }),

    unlink: wrapAsync(async function (path_ptr) {
      const path = readString(path_ptr);
      try {
        const info = await walkPath(path);
        if (!info || info.name === '') { setErrnoName('ENOENT'); return -1; }
        await info.parent.removeEntry(info.name);
        return 0;
      } catch (e) {
        setErrnoName('ENOENT');
        return -1;
      }
    }),
    pipe: function (pipefd_ptr) {
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
      if (entry.type === 'pipe') {
        return allocFd({ type: 'pipe', pipe: entry.pipe, pipeEnd: entry.pipeEnd, position: null });
      }
      return allocFd({ fileHandle: entry.fileHandle, buffer: entry.buffer, position: entry.position, dirty: entry.dirty, path: entry.path });
    },
    dup2: function (oldfd, newfd) {
      if (oldfd < 0 || oldfd >= fdTable.length || !fdTable[oldfd]) { setErrnoName('EBADF'); return -1; }
      if (newfd < 0) { setErrnoName('EBADF'); return -1; }
      if (oldfd === newfd) return newfd;
      if (newfd < fdTable.length && fdTable[newfd]) fdTable[newfd] = null;
      while (fdTable.length <= newfd) fdTable.push(null);
      const src = fdTable[oldfd];
      if (src.type === 'pipe') {
        fdTable[newfd] = { type: 'pipe', pipe: src.pipe, pipeEnd: src.pipeEnd, position: null };
      } else {
        fdTable[newfd] = { fileHandle: src.fileHandle, buffer: src.buffer, position: src.position, dirty: src.dirty, path: src.path };
      }
      return newfd;
    },
    isatty: function (fd) {
      if (fd < 0 || fd >= fdTable.length || !fdTable[fd]) { setErrnoName('EBADF'); return 0; }
      if (fd <= 2) return 1;
      return 0;
    },
  };

  return { [ENV_KEY]: env };
}

/**
 * Create POSIX WASM imports backed by Node.js APIs.
 * Provides: getenv, setenv, unsetenv, getpid, isatty, system.
 * @param {object} options
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createPosix({ ctx }) {
  const { readString, setErrnoName, getMemory } = ctx;
  const encoder = new TextEncoder();
  const pid = process.pid;

  return {
    [ENV_KEY]: {
      __getenv: function (name_ptr, buf_ptr, buf_size) {
        const name = readString(name_ptr);
        const val = process.env[name];
        if (val === undefined) return -1;
        const encoded = encoder.encode(val);
        if (encoded.length + 1 > buf_size) { setErrnoName('ERANGE'); return -1; }
        const memory = getMemory();
        const bytes = new Uint8Array(memory.buffer);
        bytes.set(encoded, buf_ptr);
        bytes[buf_ptr + encoded.length] = 0;
        return encoded.length;
      },
      __setenv: function (name_ptr, value_ptr, overwrite) {
        const name = readString(name_ptr);
        if (!name || name.indexOf('=') >= 0) { setErrnoName('EINVAL'); return -1; }
        if (!overwrite && process.env[name] !== undefined) return 0;
        const value = readString(value_ptr);
        process.env[name] = value;
        return 0;
      },
      __unsetenv: function (name_ptr) {
        const name = readString(name_ptr);
        if (!name || name.indexOf('=') >= 0) { setErrnoName('EINVAL'); return -1; }
        delete process.env[name];
        return 0;
      },
      getpid: function () { return pid; },
    },
  };
}

/**
 * Create POSIX WASM imports for the browser environment.
 * Environment variables are backed by an in-memory Map (optionally persisted to localStorage).
 * @param {object} options
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY.
 */
function createBrowserPosix({ ctx }) {
  const { readString, setErrnoName, getMemory } = ctx;
  const encoder = new TextEncoder();
  const envVars = new Map();
  const nextPid = 1;

  /* Load persisted env vars from localStorage */
  try {
    const stored = localStorage.getItem('__posix_env');
    if (stored) {
      const obj = JSON.parse(stored);
      for (const k in obj) envVars.set(k, obj[k]);
    }
  } catch (e) { /* localStorage not available */ }

  function persistEnv() {
    try {
      const obj = {};
      envVars.forEach(function (v, k) { obj[k] = v; });
      localStorage.setItem('__posix_env', JSON.stringify(obj));
    } catch (e) { /* best effort */ }
  }

  return {
    [ENV_KEY]: {
      __getenv: function (name_ptr, buf_ptr, buf_size) {
        const name = readString(name_ptr);
        const val = envVars.get(name);
        if (val === undefined) return -1;
        const encoded = encoder.encode(val);
        if (encoded.length + 1 > buf_size) { setErrnoName('ERANGE'); return -1; }
        const memory = getMemory();
        const bytes = new Uint8Array(memory.buffer);
        bytes.set(encoded, buf_ptr);
        bytes[buf_ptr + encoded.length] = 0;
        return encoded.length;
      },
      __setenv: function (name_ptr, value_ptr, overwrite) {
        const name = readString(name_ptr);
        if (!name || name.indexOf('=') >= 0) { setErrnoName('EINVAL'); return -1; }
        if (!overwrite && envVars.has(name)) return 0;
        const value = readString(value_ptr);
        envVars.set(name, value);
        persistEnv();
        return 0;
      },
      __unsetenv: function (name_ptr) {
        const name = readString(name_ptr);
        if (!name || name.indexOf('=') >= 0) { setErrnoName('EINVAL'); return -1; }
        envVars.delete(name);
        persistEnv();
        return 0;
      },
      getpid: function () { return nextPid; },
    },
  };
}

/**
 * Create SDL WASM imports backed by a lazy-loaded SDL library.
 * @param {object} options
 * @param {function(): SDLLib} options.getSDL - Lazy getter for the SDL library.
 * @param {RuntimeContext} options.ctx - Runtime helpers shared with the host.
 * @returns {Object} Object with WASM imports keyed by ENV_KEY and a getter for the
 *   animation frame callback pointer.
 */
function createSDL({ getSDL, ctx }) {
  const { readString, getMemory, getExports } = ctx;

  /* Resource tables — handles are 1-based indices into these arrays.
     The C side receives opaque integer handles cast to void pointers. */
  const sdlWindows = [];     /* { native, width, height } */
  const sdlAudioDevices = []; /* @kmamal/sdl AudioPlaybackInstance */
  let animationFrameFunc = null;

  /* Convert @kmamal/sdl key event to SDL2 SDLK_* keysym integer.
     SDL2 rule: printable keys use their ASCII code; non-printable keys
     use scancode | 0x40000000 (the SDLK_SCANCODE_MASK).
     Some named keys (return, escape, etc.) have ASCII keysyms in SDL2. */
  const sdlNamedKeysyms = {
    'return': 13, 'escape': 27, 'backspace': 8, 'tab': 9, 'space': 32,
    'delete': 127,
  };
  function sdlKeysym(e) {
    const key = e.key;
    const sc = e.scancode || 0;
    if (typeof key === 'string' && key.length === 1) {
      return key.charCodeAt(0);
    }
    if (typeof key === 'string' && sdlNamedKeysyms[key] !== undefined) {
      return sdlNamedKeysyms[key];
    }
    return sc | 0x40000000;
  }

  return {
    [ENV_KEY]: {
      /* ---- Init / Quit ---- */
      __sdl_init: function (flags) {
        getSDL();
        return 0;
      },
      __sdl_quit: function () {
        animationFrameFunc = null;
      },

      /* ---- Window management ---- */
      __sdl_create_window: function (title_ptr, x, y, w, h, flags) {
        const sdl = getSDL();
        const title = readString(title_ptr);
        const win = sdl.video.createWindow({ title: title, width: w, height: h });
        sdlWindows.push({ native: win, width: w, height: h });
        const handle = sdlWindows.length; /* 1-based handle, also used as window ID */
        win.on('close', function () {
          getExports().__sdl_push_quit_event(handle);
          animationFrameFunc = null;
        });
        win.on('keyDown', function (e) {
          const sym = sdlKeysym(e);
          getExports().__sdl_push_key_event(handle, 0x300, e.scancode || 0, sym);
        });
        win.on('keyUp', function (e) {
          const sym = sdlKeysym(e);
          getExports().__sdl_push_key_event(handle, 0x301, e.scancode || 0, sym);
        });
        return handle;
      },
      __sdl_destroy_window: function (handle) {
        if (handle > 0 && sdlWindows[handle - 1]) {
          sdlWindows[handle - 1].native.destroy();
          sdlWindows[handle - 1] = null;
        }
      },
      __sdl_set_window_title: function (handle, title_ptr) {
        const w = sdlWindows[handle - 1];
        if (w) w.native.setTitle(readString(title_ptr));
      },

      /* ---- Window surface ---- */
      __sdl_update_window_surface: function (handle, pixelsPtr, w, h, pitch) {
        const winInfo = sdlWindows[handle - 1];
        if (!winInfo) return -1;
        const memory = getMemory();
        const buf = Buffer.from(new Uint8Array(memory.buffer, pixelsPtr, pitch * h));
        winInfo.native.render(w, h, pitch, 'rgba32', buf);
        return 0;
      },

      /* ---- Audio ---- */
      __sdl_open_audio_device: function (freq, format, channels) {
        const sdl = getSDL();
        const fmtMap = { 0x8008: 's8', 0x8010: 's16', 0x8020: 's32', 0x8120: 'f32' };
        const fmtStr = fmtMap[format];
        if (!fmtStr) return 0;
        const device = sdl.audio.openDevice({ type: 'playback' }, {
          frequency: freq,
          format: fmtStr,
          channels: channels,
        });
        sdlAudioDevices.push(device);
        return sdlAudioDevices.length; /* 1-based handle */
      },
      __sdl_queue_audio: function (dev, dataPtr, len) {
        const device = sdlAudioDevices[dev - 1];
        if (!device) return -1;
        const memory = getMemory();
        const buf = Buffer.from(new Uint8Array(memory.buffer, dataPtr, len));
        device.enqueue(buf);
        return 0;
      },
      __sdl_get_queued_audio_size: function (dev) {
        const device = sdlAudioDevices[dev - 1];
        if (!device) return 0;
        return device.queued;
      },
      __sdl_clear_queued_audio: function (dev) {
        const device = sdlAudioDevices[dev - 1];
        if (device) device.clearQueue();
      },
      __sdl_pause_audio_device: function (dev, pause_on) {
        const device = sdlAudioDevices[dev - 1];
        if (!device) return;
        if (pause_on) { device.pause(); } else { device.play(); }
      },
      __sdl_close_audio_device: function (dev) {
        const device = sdlAudioDevices[dev - 1];
        if (device) {
          device.close();
          sdlAudioDevices[dev - 1] = null;
        }
      },

      /* ---- Timing ---- */
      __sdl_delay: (typeof WebAssembly.Suspending === 'function')
        ? new WebAssembly.Suspending(async function (ms) {
          await new Promise(function (r) { setTimeout(r, ms); });
        })
        : function (ms) { /* no-op without JSPI */ },
      __sdl_get_ticks: function () {
        return Math.floor(performance.now());
      },

      /* ---- Animation frame callback ---- */
      __sdl_set_animation_frame_func: function (callbackPtr) {
        animationFrameFunc = callbackPtr;
      },
    },
    getAnimationFrameFunc: function () { return animationFrameFunc; },
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
        if (!sharedAudioBuffer) return 0;
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

/**
 * Read a WASM custom section by name. Returns the content as a string, or null.
 */
function getWasmCustomSection(bytes, name) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  let offset = 8; /* skip magic + version */
  while (offset < buf.length) {
    const id = buf[offset++];
    let size = 0, shift = 0, byte;
    do { byte = buf[offset++]; size |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    const sectionEnd = offset + size;
    if (id === 0) {
      let nl = 0; shift = 0; let noff = offset;
      do { byte = buf[noff++]; nl |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
      const sectionName = new TextDecoder().decode(buf.subarray(noff, noff + nl));
      if (sectionName === name) {
        return new TextDecoder().decode(buf.subarray(noff + nl, sectionEnd));
      }
    }
    offset = sectionEnd;
  }
  return null;
}

/**
 * Read all com.mtots.c.* custom sections from a WASM module.
 * Returns an object like { NO_EXIT_RUNTIME: "1" }.
 */
function getWasmSettings(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  const settings = {};
  const prefix = 'com.mtots.c.';
  let offset = 8;
  while (offset < buf.length) {
    const id = buf[offset++];
    let size = 0, shift = 0, byte;
    do { byte = buf[offset++]; size |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    const sectionEnd = offset + size;
    if (id === 0) {
      let nl = 0; shift = 0; let noff = offset;
      do { byte = buf[noff++]; nl |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
      const name = new TextDecoder().decode(buf.subarray(noff, noff + nl));
      if (name.startsWith(prefix)) {
        settings[name.substring(prefix.length)] = new TextDecoder().decode(buf.subarray(noff + nl, sectionEnd));
      }
    }
    offset = sectionEnd;
  }
  return settings;
}

/**
 * High-level wrapper around runModule that reads WASM custom sections
 * (e.g. NO_EXIT_RUNTIME) and handles the runtime lifecycle accordingly.
 *
 * For NO_EXIT_RUNTIME modules: main() runs, returns, but the runtime stays
 * alive so async callbacks (emscripten_async_call, setTimeout chains) keep
 * firing. On Node.js, stdin is wired up to console_queue_char if exported.
 *
 * @param {object} options - Same as runModule options, plus:
 *   onInstance(instance) - called with the WASM instance after instantiation
 * @returns {Promise<number>} exit code (for normal modules) or never resolves (for NO_EXIT_RUNTIME)
 */
async function runModuleAuto(options) {
  const settings = getWasmSettings(options.bytes);
  const noExit = settings.NO_EXIT_RUNTIME === '1';

  if (noExit) {
    options.noExitRuntime = true;
  }

  let inst = null;
  const origOnReady = options.onReady;
  options.onReady = function (info) {
    inst = info.instance;
    if (origOnReady) origOnReady(info);
    if (options.onInstance) options.onInstance(inst);
  };

  let exitCode = await runModule(options);

  if (noExit && inst) {
    /* Wire up Node.js stdin → console_queue_char if available */
    if (typeof process !== 'undefined' && process.stdin && inst.exports.console_queue_char) {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on('data', function (data) {
        for (let i = 0; i < data.length; i++) {
          inst.exports.console_queue_char(data[i]);
        }
      });
    }
    /* Keep alive forever — async callbacks drive the runtime */
    await new Promise(function () {});
  }

  return exitCode;
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

  let devices = {}; /* id -> { ctx, freq, channels, bytesPerSample, isFloat, nextTime, ... } */
  let flushInterval = null;

  function handleMessage(msg) {
    if (msg.type === 'audio-open') {
      const ctx = new AudioContext({ sampleRate: msg.freq });
      let bytesPerSample = 2;
      let isFloat = false;
      if (msg.format === 0x8120) { bytesPerSample = 4; isFloat = true; }
      else if (msg.format === 0x8020) { bytesPerSample = 4; }
      else if (msg.format === 0x8008) { bytesPerSample = 1; }
      const batchBytes = Math.floor(0.05 * msg.freq * msg.channels * bytesPerSample);
      devices[msg.id] = {
        ctx: ctx, freq: msg.freq, channels: msg.channels,
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
      const readPos = (writePos - queuedBytes);
      readPos = ((readPos % cap) + cap) % cap;
      const chunk = new Uint8Array(len);
      const firstChunk = Math.min(len, cap - readPos);
      chunk.set(ringData.subarray(readPos, readPos + firstChunk));
      if (firstChunk < len) {
        chunk.set(ringData.subarray(0, len - firstChunk), firstChunk);
      }
      Atomics.sub(control, 1, len); /* decrement queuedBytes */

      /* Decode PCM into Web Audio buffer */
      const samples = len / (device.bytesPerSample * device.channels);
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
      source.connect(device.ctx.destination);
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

  return { handleMessage: handleMessage, close: close };
}

/**
 * Instantiate and run a compiled WASM module.
 * @param {RunModuleOptions} options
 * @returns {Promise<number>} The exit code from main().
 */
async function runModule({
  bytes,
  args,
  fs: fsModule,
  useBrowserFS,
  requestStdin,
  getSDL,
  sdl: sdlOverride,
  getBrowserSDL,
  sharedAudioBuffer,
  notifyAudio,
  notifyWindow,
  sharedConsoleBuffer,
  notifyConsole,
  noExitRuntime,
  writeOut,
  writeErr,
  onReady,
}) {
  if (!writeOut && typeof process !== 'undefined' && process.stdout) {
    writeOut = function (buf) { process.stdout.write(buf); };
  }
  if (!writeErr && typeof process !== 'undefined' && process.stderr) {
    writeErr = function (buf) { process.stderr.write(buf); };
  }
  if (!writeOut) writeOut = function () {};
  if (!writeErr) writeErr = function () {};
  const module = new WebAssembly.Module(bytes);
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
            str = val.toFixed(prec);
            /* toFixed returns scientific notation for |val| >= 1e21; fix it */
            if (str.indexOf('e') !== -1 || str.indexOf('E') !== -1) {
              const neg = val < 0;
              const abs = neg ? -val : val;
              const intStr = BigInt(Math.floor(abs)).toString();
              str = (neg ? '-' : '') + intStr;
              if (prec > 0) str += '.' + '0'.repeat(prec);
            }
          }
          if (flags.hash && str.indexOf('.') === -1) str += '.';
          if (flags.plus && val >= 0) str = '+' + str;
          else if (flags.space && val >= 0) str = ' ' + str;
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
            str = val.toExponential(prec);
            /* C requires at least 2 exponent digits */
            str = str.replace(/e([+-])(\d)$/, 'e$10$2');
            if (spec === 'E') str = str.toUpperCase();
          }
          if (flags.hash && str.indexOf('.') === -1) {
            str = str.replace(/([eE])/, '.$1');
          }
          if (flags.plus && val >= 0) str = '+' + str;
          else if (flags.space && val >= 0) str = ' ' + str;
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
            const neg = (1 / val === -Infinity); /* detect -0 */
            str = val.toPrecision(prec);
            /* Remove trailing zeros after decimal point (unless # flag) */
            if (!flags.hash && str.indexOf('.') !== -1 && str.indexOf('e') === -1) {
              str = str.replace(/\.?0+$/, '');
            }
            /* C requires at least 2 exponent digits */
            str = str.replace(/e([+-])(\d)$/, 'e$10$2');
            if (neg && str[0] !== '-') str = '-' + str;
            if (spec === 'G') str = str.toUpperCase();
          }
          if (flags.plus && val >= 0) str = '+' + str;
          else if (flags.space && val >= 0) str = ' ' + str;
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
            onN(ptr, output.length);
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
  function defaultOnN(ptr, count) {
    const memory = instance.exports.memory;
    const view = new DataView(memory.buffer);
    view.setInt32(ptr, count, true);
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
        const encoder = new TextEncoder();
        const encoded = encoder.encode(String(value));
        for (let si = 0; si < encoded.length; si++) bytes[ptr + si] = encoded[si];
        bytes[ptr + encoded.length] = 0;
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
          if (si + 1 < str.length && str[si] === '0' && (str[si + 1] === 'x' || str[si + 1] === 'X') && (si + 2 - start) <= maxChars) si += 2;
          if (si >= str.length) { si = start; return { matched: matched || -1, consumed: si }; }
          if ('0123456789abcdefABCDEF'.indexOf(str[si]) < 0) { si = start; return { matched: matched, consumed: si }; }
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
          /* Float - use same regex pattern as __strtod_impl */
          const start = si;
          const rest = width > 0 ? str.substring(si, si + width) : str.substring(si);
          const m = rest.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
          if (!m) return { matched: matched, consumed: si };
          si += m[0].length;
          if (!suppress) {
            const ptr = readArg('ptr');
            writeToPtr(ptr, 'float', parseFloat(m[0]), length);
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
        const str = readStringBounded(str_ptr, str_ptr + str_len);
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
      pow: Math.pow,
      cbrt: Math.cbrt,
      hypot: Math.hypot,
      fmod: function (x, y) { return x % y; },
      __strtod_impl: function (nptr, endptr, bound) {
        const str = readStringBounded(nptr, bound);
        let i = 0;
        while (i < str.length && " \t\n\r\f\v".indexOf(str[i]) >= 0) i++;
        const rest = str.substring(i);
        const m = rest.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
        let val = 0.0, consumed = 0;
        if (m) {
          val = parseFloat(m[0]);
          consumed = i + m[0].length;
          if (!isFinite(val)) setErrnoName('ERANGE');
        }
        if (endptr) {
          const memory = instance.exports.memory;
          const view = new DataView(memory.buffer);
          view.setUint32(endptr, nptr + consumed, true);
        }
        return val;
      },
      __time_now: function () {
        return Math.floor(Date.now() / 1000);
      },
      __clock: function () {
        return Math.floor(performance.now());
      },
      __timezone_offset: function (t) {
        return new Date(t * 1000).getTimezoneOffset() * -60;
      },
      /* POSIX time */
      __gettimeofday: function (secPtr, usecPtr) {
        const now = Date.now();
        const memory = instance.exports.memory;
        const view = new DataView(memory.buffer);
        view.setInt32(secPtr, Math.floor(now / 1000), true);
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
    requestStdin: requestStdin,
  };

  if (fsModule) {
    const fileSystem = createFileSystem({ fs: fsModule, ctx: ctx });
    Object.assign(imports[ENV_KEY], fileSystem[ENV_KEY]);
    const posix = createPosix({ ctx: ctx });
    Object.assign(imports[ENV_KEY], posix[ENV_KEY]);
  } else if (useBrowserFS) {
    const fileSystem = createBrowserFileSystem({ ctx: ctx });
    Object.assign(imports[ENV_KEY], fileSystem[ENV_KEY]);
    const posix = createBrowserPosix({ ctx: ctx });
    Object.assign(imports[ENV_KEY], posix[ENV_KEY]);
  }

  let sdl = sdlOverride || null;
  if (!sdl && getSDL) {
    sdl = createSDL({ getSDL: getSDL, ctx: ctx });
  }
  if (!sdl && getBrowserSDL) {
    sdl = createBrowserSDL({ canvas: getBrowserSDL, ctx: ctx, sharedAudioBuffer: sharedAudioBuffer, notifyAudio: notifyAudio, notifyWindow: notifyWindow });
  }
  if (sdl) {
    Object.assign(imports[ENV_KEY], sdl[ENV_KEY]);
  }

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
      } else if (getSDL) {
        /* Node.js: use @kmamal/sdl */
        const _sdl = (typeof getSDL === 'function') ? getSDL() : getSDL;
        const win = _sdl.video.createWindow({
          title: 'TinyEMU',
          width: displayWidth,
          height: y + h,
        });
        emuDisplay = {
          type: 'sdl',
          sdl: _sdl,
          window: win,
          buffer: Buffer.alloc(displayWidth * (y + h) * 4),
          width: displayWidth,
          height: y + h,
        };
      }
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
    } else if (emuDisplay.type === 'sdl') {
      const buf = emuDisplay.buffer;
      for (let row = 0; row < h; row++) {
        let srcOff = dataPtr + row * stride;
        let dstOff = ((y + row) * emuDisplay.width + x) * 4;
        for (let col = 0; col < w; col++) {
          buf[dstOff]     = src[srcOff + 2]; /* R */
          buf[dstOff + 1] = src[srcOff + 1]; /* G */
          buf[dstOff + 2] = src[srcOff];     /* B */
          buf[dstOff + 3] = 255;             /* A */
          srcOff += 4;
          dstOff += 4;
        }
      }
      emuDisplay.window.render(emuDisplay.width, emuDisplay.height,
        emuDisplay.width * 4, 'rgba32', buf);
    }
  };

  /* Networking stubs — return 0/NULL, no-op */
  imports[ENV_KEY].net_recv_packet = function () {};
  imports[ENV_KEY].fs_net_init = function () { return 0; };
  imports[ENV_KEY].fs_net_set_pwd = function () {};
  imports[ENV_KEY].block_device_init_http = function () { return 0; };

  const instance = new WebAssembly.Instance(module, imports);

  if (onReady) onReady({ sdl: sdl, instance: instance });

  let exitCode;
  try {
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
        exitCode = await WebAssembly.promising(instance.exports.main)(argc, argvPtr);
      } else {
        exitCode = instance.exports.main(argc, argvPtr);
      }
    } else {
      if (hasJSPI) {
        exitCode = await WebAssembly.promising(instance.exports.main)();
      } else {
        exitCode = instance.exports.main();
      }
    }
    /* Call exit() to flush stdio and run atexit handlers.
     * exit() calls fflush(0), __run_atexits(), then __exit() which
     * throws ExitStatus — caught below.
     * Skip if noExitRuntime is set (emulator-style apps that run via async callbacks). */
    if (!noExitRuntime) {
      if (instance.exports.exit) {
        instance.exports.exit(exitCode);
      } else if (instance.exports.__run_atexits) {
        instance.exports.__run_atexits();
      }
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

  runModuleAuto({
    bytes,
    args: process.argv.length > 3 ? process.argv.slice(2) : undefined,
    fs: fs,
    getSDL: function () { return require('@kmamal/sdl'); },
  }).then(function (exitCode) {
    process.exit(exitCode);
  }).catch(function (e) {
    process.stderr.write('Fatal: ' + e.message + '\n');
    if (e.stack) process.stderr.write(e.stack + '\n');
    process.exit(1);
  });

} else if (typeof module !== 'undefined') {
  // We are being imported (Node or bundler)
  module.exports = runModule;
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
  self.runModuleAuto = runModuleAuto;
  self.getWasmCustomSection = getWasmCustomSection;
  self.getWasmSettings = getWasmSettings;
  self.createBrowserSDL = createBrowserSDL;
}
