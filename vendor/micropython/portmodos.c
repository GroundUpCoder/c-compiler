// gucOS MicroPython port — the bodies extmod/modos.c asks the port for, plus
// the POSIX filesystem surface and the `os.path` submodule (todos/0117 R2).
//
// Named by MICROPY_PY_OS_INCLUDEFILE and #included INTO extmod/modos.c, so it
// declares no includes of its own and is not in bin.json's sources. Upstream's
// counterpart is ports/unix/modos.c; the env/system/errno bodies below are
// that file, minus its _WIN32 branches.
//
// WHY THE FS HALF IS HERE AND NOT UPSTREAM'S
// -----------------------------------------
// Upstream ships listdir/stat/mkdir/remove/rename/getcwd/chdir as `os`
// re-exports of the VFS module's functions — every one of them is behind
// `#if MICROPY_VFS` in modos.c's globals table. This port has no VFS on
// purpose: gucOS's kernel already owns mounting (todos/KERNEL.md), and a
// second mount table inside MicroPython would be two filesystems disagreeing
// about the same paths. R1 hit the same wall for file objects and resolved it
// the same way — file.c is upstream's extmod/vfs_posix_file.c lifted out of
// the VFS. This is that decision applied to the directory operations: the
// bodies are extmod/vfs_posix.c's, with the `self`/root-prefix plumbing (the
// only genuinely VFS-shaped part) dropped, since gucOS paths are already
// absolute in the kernel's namespace.
//
// The one-hunk patch this needs in modos.c is `#if MICROPY_PY_OS_POSIX_FS`
// added to its globals table; see README.md's patch table.

#include <dirent.h>
#include <errno.h>
#include <stdio.h>      // rename(2)
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "py/objtuple.h"
#include "py/objlist.h"

// --- environment / process ------------------------------------------------

static mp_obj_t mp_os_getenv(size_t n_args, const mp_obj_t *args) {
    const char *s = getenv(mp_obj_str_get_str(args[0]));
    if (s == NULL) {
        return n_args == 2 ? args[1] : mp_const_none;
    }
    return mp_obj_new_str_from_cstr(s);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(mp_os_getenv_obj, 1, 2, mp_os_getenv);

static mp_obj_t mp_os_putenv(mp_obj_t key_in, mp_obj_t value_in) {
    if (setenv(mp_obj_str_get_str(key_in), mp_obj_str_get_str(value_in), 1) == -1) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_2(mp_os_putenv_obj, mp_os_putenv);

static mp_obj_t mp_os_unsetenv(mp_obj_t key_in) {
    if (unsetenv(mp_obj_str_get_str(key_in)) == -1) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_unsetenv_obj, mp_os_unsetenv);

// libc system() is posix_spawn("/bin/sh", "-c", cmd) + waitpid, so this really
// runs a command — /bin/sh is busybox hush on the image. The return value is
// the raw wait status, matching CPython's os.system.
static mp_obj_t mp_os_system(mp_obj_t cmd_in) {
    int r = system(mp_obj_str_get_str(cmd_in));
    if (r == -1) {
        mp_raise_OSError(errno);
    }
    return MP_OBJ_NEW_SMALL_INT(r);
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_system_obj, mp_os_system);

static mp_obj_t mp_os_errno(size_t n_args, const mp_obj_t *args) {
    if (n_args == 0) {
        return MP_OBJ_NEW_SMALL_INT(errno);
    }
    errno = mp_obj_get_int(args[0]);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(mp_os_errno_obj, 0, 1, mp_os_errno);

#if MICROPY_PY_OS_POSIX_FS

// --- helpers --------------------------------------------------------------

// An omitted path argument means the current directory, as in CPython.
static const char *path_or_cwd(size_t n_args, const mp_obj_t *args) {
    if (n_args == 0) {
        return ".";
    }
    const char *p = mp_obj_str_get_str(args[0]);
    return p[0] == '\0' ? "." : p;
}

// --- directory listing ----------------------------------------------------

// ilistdir yields (name, type, inode) 3-tuples. The iterator owns an open DIR,
// so it carries a finaliser: an abandoned `for x in os.ilistdir(...)` that
// breaks early must still close the handle, and MICROPY_ENABLE_FINALISER (R1)
// is what makes that fire.
typedef struct _ilistdir_it_t {
    mp_obj_base_t base;
    mp_fun_1_t iternext;
    mp_fun_1_t finaliser;
    bool is_str;
    DIR *dir;
} ilistdir_it_t;

static mp_obj_t ilistdir_it_iternext(mp_obj_t self_in) {
    ilistdir_it_t *self = MP_OBJ_TO_PTR(self_in);
    if (self->dir == NULL) {
        return MP_OBJ_STOP_ITERATION;
    }
    for (;;) {
        struct dirent *de = readdir(self->dir);
        if (de == NULL) {
            closedir(self->dir);
            self->dir = NULL;
            return MP_OBJ_STOP_ITERATION;
        }
        const char *fn = de->d_name;
        if (fn[0] == '.' && (fn[1] == 0 || (fn[1] == '.' && fn[2] == 0))) {
            continue;   // skip . and ..
        }
        mp_obj_tuple_t *t = MP_OBJ_TO_PTR(mp_obj_new_tuple(3, NULL));
        t->items[0] = self->is_str ? mp_obj_new_str_from_cstr(fn)
                                   : mp_obj_new_bytes((const byte *)fn, strlen(fn));
        // d_type is real in the gucOS libc (DT_REG/DT_DIR/DT_LNK); the tuple's
        // type field is the S_IFMT-shaped value CPython's scandir exposes.
        mp_int_t ty = 0;
        if (de->d_type == DT_DIR) {
            ty = S_IFDIR;
        } else if (de->d_type == DT_REG) {
            ty = S_IFREG;
        } else if (de->d_type == DT_LNK) {
            ty = S_IFLNK;
        }
        t->items[1] = MP_OBJ_NEW_SMALL_INT(ty);
        // NB d_ino is always 0 here — the gucOS libc's readdir does not carry
        // inode numbers (its own header says so). stat() is the way to get one.
        t->items[2] = MP_OBJ_NEW_SMALL_INT(de->d_ino);
        return MP_OBJ_FROM_PTR(t);
    }
}

static mp_obj_t ilistdir_it_del(mp_obj_t self_in) {
    ilistdir_it_t *self = MP_OBJ_TO_PTR(self_in);
    if (self->dir != NULL) {
        closedir(self->dir);
        self->dir = NULL;
    }
    return mp_const_none;
}

static mp_obj_t mp_os_ilistdir(size_t n_args, const mp_obj_t *args) {
    ilistdir_it_t *iter = mp_obj_malloc_with_finaliser(ilistdir_it_t, &mp_type_polymorph_iter_with_finaliser);
    iter->iternext = ilistdir_it_iternext;
    iter->finaliser = ilistdir_it_del;
    iter->is_str = n_args == 0 || mp_obj_get_type(args[0]) == &mp_type_str;
    iter->dir = opendir(path_or_cwd(n_args, args));
    if (iter->dir == NULL) {
        mp_raise_OSError(errno);
    }
    return MP_OBJ_FROM_PTR(iter);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(mp_os_ilistdir_obj, 0, 1, mp_os_ilistdir);

static mp_obj_t mp_os_listdir(size_t n_args, const mp_obj_t *args) {
    DIR *d = opendir(path_or_cwd(n_args, args));
    if (d == NULL) {
        mp_raise_OSError(errno);
    }
    mp_obj_t list = mp_obj_new_list(0, NULL);
    // A raise from mp_obj_list_append (out of memory) would leak the DIR, so
    // the whole walk is inside an NLR frame that closes it on the way out.
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL) {
            const char *fn = de->d_name;
            if (fn[0] == '.' && (fn[1] == 0 || (fn[1] == '.' && fn[2] == 0))) {
                continue;
            }
            mp_obj_list_append(list, mp_obj_new_str_from_cstr(fn));
        }
        nlr_pop();
        closedir(d);
        return list;
    }
    closedir(d);
    nlr_jump(nlr.ret_val);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(mp_os_listdir_obj, 0, 1, mp_os_listdir);

// --- mutation -------------------------------------------------------------

static mp_obj_t mp_os_mkdir(size_t n_args, const mp_obj_t *args) {
    mp_int_t mode = n_args >= 2 ? mp_obj_get_int(args[1]) : 0777;
    if (mkdir(mp_obj_str_get_str(args[0]), (mode_t)mode) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(mp_os_mkdir_obj, 1, 2, mp_os_mkdir);

static mp_obj_t mp_os_rmdir(mp_obj_t path_in) {
    if (rmdir(mp_obj_str_get_str(path_in)) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_rmdir_obj, mp_os_rmdir);

static mp_obj_t mp_os_remove(mp_obj_t path_in) {
    if (unlink(mp_obj_str_get_str(path_in)) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_remove_obj, mp_os_remove);

static mp_obj_t mp_os_rename(mp_obj_t old_in, mp_obj_t new_in) {
    if (rename(mp_obj_str_get_str(old_in), mp_obj_str_get_str(new_in)) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_2(mp_os_rename_obj, mp_os_rename);

// --- cwd ------------------------------------------------------------------

static mp_obj_t mp_os_chdir(mp_obj_t path_in) {
    if (chdir(mp_obj_str_get_str(path_in)) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_chdir_obj, mp_os_chdir);

static mp_obj_t mp_os_getcwd(void) {
    char buf[MICROPY_ALLOC_PATH_MAX + 1];
    if (getcwd(buf, sizeof buf) == NULL) {
        mp_raise_OSError(errno);
    }
    return mp_obj_new_str_from_cstr(buf);
}
static MP_DEFINE_CONST_FUN_OBJ_0(mp_os_getcwd_obj, mp_os_getcwd);

// --- stat -----------------------------------------------------------------

// The 10-tuple is CPython's os.stat_result field order. Times are seconds
// since the Epoch (this port is MICROPY_EPOCH_IS_1970), so they line up with
// time.localtime() without an offset.
static mp_obj_t stat_to_tuple(const struct stat *sb) {
    mp_obj_tuple_t *t = MP_OBJ_TO_PTR(mp_obj_new_tuple(10, NULL));
    t->items[0] = MP_OBJ_NEW_SMALL_INT(sb->st_mode);
    t->items[1] = mp_obj_new_int_from_uint(sb->st_ino);
    t->items[2] = mp_obj_new_int_from_uint(sb->st_dev);
    t->items[3] = mp_obj_new_int_from_uint(sb->st_nlink);
    t->items[4] = mp_obj_new_int_from_uint(sb->st_uid);
    t->items[5] = mp_obj_new_int_from_uint(sb->st_gid);
    t->items[6] = mp_obj_new_int_from_uint(sb->st_size);
    t->items[7] = mp_obj_new_int_from_uint(sb->st_atime);
    t->items[8] = mp_obj_new_int_from_uint(sb->st_mtime);
    t->items[9] = mp_obj_new_int_from_uint(sb->st_ctime);
    return MP_OBJ_FROM_PTR(t);
}

static mp_obj_t mp_os_stat(mp_obj_t path_in) {
    struct stat sb;
    if (stat(mp_obj_str_get_str(path_in), &sb) != 0) {
        mp_raise_OSError(errno);
    }
    return stat_to_tuple(&sb);
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_stat_obj, mp_os_stat);

// lstat does NOT follow the final symlink — the difference matters on this
// image, where /bin, /usr/local and every gucman-planted command are symlinks.
static mp_obj_t mp_os_lstat(mp_obj_t path_in) {
    struct stat sb;
    if (lstat(mp_obj_str_get_str(path_in), &sb) != 0) {
        mp_raise_OSError(errno);
    }
    return stat_to_tuple(&sb);
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_lstat_obj, mp_os_lstat);

// --- symlinks -------------------------------------------------------------

static mp_obj_t mp_os_symlink(mp_obj_t target_in, mp_obj_t path_in) {
    if (symlink(mp_obj_str_get_str(target_in), mp_obj_str_get_str(path_in)) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_2(mp_os_symlink_obj, mp_os_symlink);

static mp_obj_t mp_os_readlink(mp_obj_t path_in) {
    char buf[MICROPY_ALLOC_PATH_MAX + 1];
    ssize_t n = readlink(mp_obj_str_get_str(path_in), buf, sizeof buf - 1);
    if (n < 0) {
        mp_raise_OSError(errno);
    }
    return mp_obj_new_str(buf, (size_t)n);
}
static MP_DEFINE_CONST_FUN_OBJ_1(mp_os_readlink_obj, mp_os_readlink);

// --- os.path --------------------------------------------------------------
//
// A REAL submodule (MICROPY_MODULE_BUILTIN_SUBPACKAGES), so `import os.path`,
// `from os.path import join` and `os.path.join` all work — not an attribute
// that merely looks like one. CPython's posixpath is pure Python; here it is C
// because the alternative is vendoring micropython-lib, which is a separate
// supply-chain decision (see README.md's "Known gaps").

// "." and ".." as ROM string objects rather than MP_QSTR__dot_/MP_QSTR__dot__dot_.
// The qstr pool only carries the escaped spellings it is TOLD about (py/qstrdefs.h
// has Q(/), which is why os.sep can be MP_QSTR__slash_, but no Q(.) or Q(..)) —
// writing MP_QSTR__dot_ without adding it there silently interns the literal
// identifier "_dot_" instead, so normpath("") returned the five-character string
// "_dot_". Caught by a test, not by the compiler.
static const MP_DEFINE_STR_OBJ(path_curdir_obj, ".");
static const MP_DEFINE_STR_OBJ(path_pardir_obj, "..");

// join: a later absolute component discards everything before it, and a
// non-empty head gets exactly one separator. CPython's rule, including the
// awkward one — join("a/", "b") is "a/b", not "a//b".
static mp_obj_t path_join(size_t n_args, const mp_obj_t *args) {
    vstr_t vstr;
    vstr_init(&vstr, 32);
    for (size_t i = 0; i < n_args; i++) {
        size_t len;
        const char *s = mp_obj_str_get_data(args[i], &len);
        if (len > 0 && s[0] == '/') {
            vstr_reset(&vstr);
        } else if (vstr.len > 0 && vstr.buf[vstr.len - 1] != '/') {
            vstr_add_char(&vstr, '/');
        }
        vstr_add_strn(&vstr, s, len);
    }
    return mp_obj_new_str_from_vstr(&vstr);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR(path_join_obj, 1, path_join);

// Index one past the last '/', i.e. where the basename starts.
static size_t base_start(const char *s, size_t len) {
    size_t i = len;
    while (i > 0 && s[i - 1] != '/') {
        i--;
    }
    return i;
}

static mp_obj_t path_split(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    size_t i = base_start(s, len);
    // Strip trailing separators from the head, but keep a lone "/" as "/".
    size_t head = i;
    while (head > 1 && s[head - 1] == '/') {
        head--;
    }
    mp_obj_t items[2] = { mp_obj_new_str(s, head), mp_obj_new_str(s + i, len - i) };
    return mp_obj_new_tuple(2, items);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_split_obj, path_split);

static mp_obj_t path_dirname(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    size_t head = base_start(s, len);
    while (head > 1 && s[head - 1] == '/') {
        head--;
    }
    return mp_obj_new_str(s, head);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_dirname_obj, path_dirname);

static mp_obj_t path_basename(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    size_t i = base_start(s, len);
    return mp_obj_new_str(s + i, len - i);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_basename_obj, path_basename);

// splitext: a leading dot on the basename is not an extension (".bashrc" has
// none), and neither is a trailing one after the split point.
static mp_obj_t path_splitext(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    size_t b = base_start(s, len);
    size_t dot = len;
    for (size_t i = len; i > b + 1; i--) {
        if (s[i - 1] == '.') {
            dot = i - 1;
            break;
        }
    }
    mp_obj_t items[2] = { mp_obj_new_str(s, dot), mp_obj_new_str(s + dot, len - dot) };
    return mp_obj_new_tuple(2, items);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_splitext_obj, path_splitext);

static mp_obj_t path_isabs(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    return mp_obj_new_bool(len > 0 && s[0] == '/');
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_isabs_obj, path_isabs);

// normpath collapses "//", "." and a ".." that has something to eat. It is
// PURELY lexical, exactly like CPython's — it never touches the filesystem, so
// it can be wrong across a symlink. That is the documented posixpath contract;
// realpath() is the one that resolves links.
static mp_obj_t path_normpath(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    if (len == 0) {
        return MP_OBJ_FROM_PTR(&path_curdir_obj);
    }
    bool absolute = s[0] == '/';
    vstr_t out;
    vstr_init(&out, len + 1);
    // `out` accumulates the kept components separated by single '/'. ".." pops
    // by scanning back to the previous separator rather than keeping a stack of
    // offsets — a stack needs a depth cap, and a path deeper than the cap would
    // then collapse WRONGLY instead of loudly, which is the worst failure mode
    // for a function whose whole job is producing a path you then open.
    size_t i = 0;
    while (i < len) {
        while (i < len && s[i] == '/') {
            i++;
        }
        size_t j = i;
        while (j < len && s[j] != '/') {
            j++;
        }
        size_t clen = j - i;
        if (clen == 0) {
            break;
        }
        if (clen == 1 && s[i] == '.') {
            // drop
        } else if (clen == 2 && s[i] == '.' && s[i + 1] == '.') {
            // Pop the previous component — but only if there is one and it is
            // not itself a ".." (those accumulate: "../.." is already minimal).
            bool prev_is_dotdot = out.len >= 2
                && out.buf[out.len - 1] == '.' && out.buf[out.len - 2] == '.'
                && (out.len == 2 || out.buf[out.len - 3] == '/');
            if (out.len > 0 && !prev_is_dotdot) {
                size_t k = out.len;
                while (k > 0 && out.buf[k - 1] != '/') {
                    k--;
                }
                out.len = k > 0 ? k - 1 : 0;   // drop the separator too
            } else if (!absolute) {
                // A leading ".." in a relative path cannot be collapsed away.
                if (out.len > 0) {
                    vstr_add_char(&out, '/');
                }
                vstr_add_strn(&out, "..", 2);
            }
            // In an absolute path "/.." is "/" — pop nothing, add nothing.
        } else {
            if (out.len > 0) {
                vstr_add_char(&out, '/');
            }
            vstr_add_strn(&out, s + i, clen);
        }
        i = j;
    }
    if (absolute) {
        vstr_t full;
        vstr_init(&full, out.len + 2);
        vstr_add_char(&full, '/');
        vstr_add_strn(&full, out.buf, out.len);
        vstr_clear(&out);
        return mp_obj_new_str_from_vstr(&full);
    }
    if (out.len == 0) {
        vstr_clear(&out);
        return MP_OBJ_FROM_PTR(&path_curdir_obj);
    }
    return mp_obj_new_str_from_vstr(&out);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_normpath_obj, path_normpath);

static mp_obj_t path_abspath(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    if (len > 0 && s[0] == '/') {
        return path_normpath(path_in);
    }
    char cwd[MICROPY_ALLOC_PATH_MAX + 1];
    if (getcwd(cwd, sizeof cwd) == NULL) {
        mp_raise_OSError(errno);
    }
    mp_obj_t parts[2] = { mp_obj_new_str_from_cstr(cwd), path_in };
    return path_normpath(path_join(2, parts));
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_abspath_obj, path_abspath);

// realpath resolves symlinks for real (libc realpath, todos/0263). It is the
// answer when normpath's lexical ".." would be wrong.
static mp_obj_t path_realpath(mp_obj_t path_in) {
    char buf[MICROPY_ALLOC_PATH_MAX + 1];
    if (realpath(mp_obj_str_get_str(path_in), buf) == NULL) {
        mp_raise_OSError(errno);
    }
    return mp_obj_new_str_from_cstr(buf);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_realpath_obj, path_realpath);

// expanduser handles "~" and "~/..." only. CPython also resolves "~user" out
// of the password database; gucOS has no such database, so "~user" is returned
// unchanged — which is also what CPython does when the lookup fails.
static mp_obj_t path_expanduser(mp_obj_t path_in) {
    size_t len;
    const char *s = mp_obj_str_get_data(path_in, &len);
    if (len == 0 || s[0] != '~' || (len > 1 && s[1] != '/')) {
        return path_in;
    }
    const char *home = getenv("HOME");
    if (home == NULL) {
        return path_in;
    }
    vstr_t vstr;
    vstr_init(&vstr, len + 16);
    vstr_add_str(&vstr, home);
    // "~" alone -> HOME; "~/x" -> HOME + "/x" without doubling the separator.
    if (len > 1) {
        size_t hl = strlen(home);
        if (hl > 0 && vstr.buf[hl - 1] == '/') {
            vstr.len = hl - 1;
        }
        vstr_add_strn(&vstr, s + 1, len - 1);
    }
    return mp_obj_new_str_from_vstr(&vstr);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_expanduser_obj, path_expanduser);

// exists/isfile/isdir/islink. exists() follows symlinks and answers False for
// a dangling one, as CPython does; lexists() is the un-followed twin.
static mp_obj_t path_exists(mp_obj_t path_in) {
    struct stat sb;
    return mp_obj_new_bool(stat(mp_obj_str_get_str(path_in), &sb) == 0);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_exists_obj, path_exists);

static mp_obj_t path_lexists(mp_obj_t path_in) {
    struct stat sb;
    return mp_obj_new_bool(lstat(mp_obj_str_get_str(path_in), &sb) == 0);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_lexists_obj, path_lexists);

static mp_obj_t path_isfile(mp_obj_t path_in) {
    struct stat sb;
    return mp_obj_new_bool(stat(mp_obj_str_get_str(path_in), &sb) == 0 && S_ISREG(sb.st_mode));
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_isfile_obj, path_isfile);

static mp_obj_t path_isdir(mp_obj_t path_in) {
    struct stat sb;
    return mp_obj_new_bool(stat(mp_obj_str_get_str(path_in), &sb) == 0 && S_ISDIR(sb.st_mode));
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_isdir_obj, path_isdir);

static mp_obj_t path_islink(mp_obj_t path_in) {
    struct stat sb;
    return mp_obj_new_bool(lstat(mp_obj_str_get_str(path_in), &sb) == 0 && S_ISLNK(sb.st_mode));
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_islink_obj, path_islink);

static mp_obj_t path_getsize(mp_obj_t path_in) {
    struct stat sb;
    if (stat(mp_obj_str_get_str(path_in), &sb) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_obj_new_int_from_uint(sb.st_size);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_getsize_obj, path_getsize);

static mp_obj_t path_getmtime(mp_obj_t path_in) {
    struct stat sb;
    if (stat(mp_obj_str_get_str(path_in), &sb) != 0) {
        mp_raise_OSError(errno);
    }
    return mp_obj_new_int_from_uint(sb.st_mtime);
}
static MP_DEFINE_CONST_FUN_OBJ_1(path_getmtime_obj, path_getmtime);

static const mp_rom_map_elem_t os_path_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_path) },
    { MP_ROM_QSTR(MP_QSTR_sep), MP_ROM_QSTR(MP_QSTR__slash_) },
    { MP_ROM_QSTR(MP_QSTR_curdir), MP_ROM_PTR(&path_curdir_obj) },
    { MP_ROM_QSTR(MP_QSTR_pardir), MP_ROM_PTR(&path_pardir_obj) },
    { MP_ROM_QSTR(MP_QSTR_join), MP_ROM_PTR(&path_join_obj) },
    { MP_ROM_QSTR(MP_QSTR_split), MP_ROM_PTR(&path_split_obj) },
    { MP_ROM_QSTR(MP_QSTR_splitext), MP_ROM_PTR(&path_splitext_obj) },
    { MP_ROM_QSTR(MP_QSTR_dirname), MP_ROM_PTR(&path_dirname_obj) },
    { MP_ROM_QSTR(MP_QSTR_basename), MP_ROM_PTR(&path_basename_obj) },
    { MP_ROM_QSTR(MP_QSTR_isabs), MP_ROM_PTR(&path_isabs_obj) },
    { MP_ROM_QSTR(MP_QSTR_normpath), MP_ROM_PTR(&path_normpath_obj) },
    { MP_ROM_QSTR(MP_QSTR_abspath), MP_ROM_PTR(&path_abspath_obj) },
    { MP_ROM_QSTR(MP_QSTR_realpath), MP_ROM_PTR(&path_realpath_obj) },
    { MP_ROM_QSTR(MP_QSTR_expanduser), MP_ROM_PTR(&path_expanduser_obj) },
    { MP_ROM_QSTR(MP_QSTR_exists), MP_ROM_PTR(&path_exists_obj) },
    { MP_ROM_QSTR(MP_QSTR_lexists), MP_ROM_PTR(&path_lexists_obj) },
    { MP_ROM_QSTR(MP_QSTR_isfile), MP_ROM_PTR(&path_isfile_obj) },
    { MP_ROM_QSTR(MP_QSTR_isdir), MP_ROM_PTR(&path_isdir_obj) },
    { MP_ROM_QSTR(MP_QSTR_islink), MP_ROM_PTR(&path_islink_obj) },
    { MP_ROM_QSTR(MP_QSTR_getsize), MP_ROM_PTR(&path_getsize_obj) },
    { MP_ROM_QSTR(MP_QSTR_getmtime), MP_ROM_PTR(&path_getmtime_obj) },
};
static MP_DEFINE_CONST_DICT(os_path_globals, os_path_globals_table);

static const mp_obj_module_t mp_module_os_path = {
    .base = { &mp_type_module },
    .globals = (mp_obj_dict_t *)&os_path_globals,
};

#endif // MICROPY_PY_OS_POSIX_FS
