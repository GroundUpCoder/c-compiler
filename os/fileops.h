/* fileops.h — file operations + the clipboard file list, ONE implementation
 * in ONE place (todos/0092).
 *
 * Header-only by design (the openwith.h precedent): wm.c (desktop icon
 * Cut/Copy + desktop Paste) and os/win32/shell32.c (the SHFile* veneer
 * helpers behind fileman's ops) share these static functions by textual
 * inclusion and must stay behaviorally identical through them.
 *
 * File ops are plain POSIX. fo_copy is recursive (files by a read/write
 * loop preserving the mode; directories entry-by-entry; symlinks copied AS
 * LINKS — a Desktop launcher copies like a Windows shortcut) and refuses
 * to copy a directory into itself. fo_move is rename(2) with an EXDEV
 * copy+delete fallback, refusing an existing destination (no silent
 * overwrite — the 0103 EEXIST rule). fo_delete is recursive (what
 * SHFileOperation FO_DELETE does). All return 0 or -1 with errno set; the
 * caller surfaces strerror(errno) (fileman: MessageBox). fo_merge is the
 * additive "plant what's missing, never overwrite" engine shared by
 * desktop-defaults and gucman's `seed` resource kind (see its block below).
 *
 * The clipboard file list rides the ONE kernel slot (todos/0090) as format
 * FO_CLIP_FMT (fmt 1 is UTF-8 text — last write wins across formats, the
 * Windows-ish rule). Payload: a "cut\n" or "copy\n" header line, then one
 * absolute path per '\n'-terminated line — the CF_HDROP idea kept textual.
 * Cut-paste is a move and clears the slot on success (a cut pastes once);
 * copy-paste duplicates, uniquifying a name clash Win95-style ("Copy of X",
 * "Copy (2) of X", ...).
 *
 * The trash store (todos/0093) is /root/.recycle — files/ holds the moved
 * entries (name clashes uniquified "x", "x 2", ...), info/ holds one
 * sidecar per entry under the SAME stored name (line 1: the original
 * absolute path; line 2: the delete time as decimal Unix seconds — the
 * Win95 INFO2 idea kept textual). The files/info split means a trashed
 * file can never collide with its own metadata. fo_trash refuses paths
 * already inside the store (delete-in-trash is permanent, the caller's
 * job); restore refuses an occupied original path with EEXIST so the
 * caller can prompt. Unbounded until fo_trash_empty — the recorded 0093
 * non-goal (no quota, like early Win95).
 */
#ifndef FILEOPS_H
#define FILEOPS_H

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define FO_CLIP_FMT  2               /* kernel clipboard slot format tag */
#define FO_CLIP_MAX  8192            /* whole-list byte cap (v1) */
#define FO_PATH_MAX  768

/* The host clipboard primitives (todos/0090, host.js createClipboard) —
 * redeclaring the __SDL.c imports is fine, imports dedup by name. */
__import int __clip_set(int fmt, const void *bytes, int len);
__import int __clip_get(int fmt, void *out, int cap);
__import int __clip_has(int fmt);

/* ---- the clipboard file list ---- */

/* Put `n` absolute paths on the clipboard, marked cut or copy. */
static int fo_clip_set(int cut, const char *const *paths, int n) {
    char buf[FO_CLIP_MAX];
    int len = snprintf(buf, sizeof buf, "%s\n", cut ? "cut" : "copy");
    for (int i = 0; i < n; i++) {
        int w = snprintf(buf + len, sizeof buf - (size_t)len, "%s\n", paths[i]);
        if (w < 0 || len + w >= (int)sizeof buf) { errno = ENOMEM; return -1; }
        len += w;
    }
    return __clip_set(FO_CLIP_FMT, buf, len) == 0 ? 0 : -1;
}

static int fo_clip_clear(void) { return __clip_set(0, 0, 0); }

/* True when a file list is on the clipboard (the Paste gate). A PEEK —
 * fileman/wm.c call this per context-menu open, so it must serve the
 * cached slot and never park on the clipboard seam's host refresh. */
static int fo_clip_has(void) { return __clip_has(FO_CLIP_FMT) > 0; }

/* Load the list into `buf`: each path NUL-terminated in place, *cut set
 * from the header. Returns the path count, 0 when the slot holds no file
 * list. Walk with fo_clip_path(). */
static int fo_clip_load(char *buf, int cap, int *cut) {
    int total = __clip_get(FO_CLIP_FMT, buf, cap - 1);
    if (total <= 0 || total > cap - 1) return 0;
    buf[total] = 0;
    char *nl = strchr(buf, '\n');
    if (!nl) return 0;
    *nl = 0;
    *cut = strcmp(buf, "cut") == 0;
    int n = 0;
    for (char *p = nl + 1; *p; ) {
        char *e = strchr(p, '\n');
        if (!e) break;
        *e = 0;
        if (*p) n++;
        p = e + 1;
    }
    return n;
}

/* The i-th path of a loaded list (buf as fo_clip_load left it). */
static const char *fo_clip_path(const char *buf, int i) {
    const char *p = buf + strlen(buf) + 1;       /* past the header */
    while (i-- > 0) p += strlen(p) + 1;
    return p;
}

/* ---- file operations ---- */

static int fo_copy_file(const char *src, const char *dst, mode_t mode) {
    int in = open(src, O_RDONLY);
    if (in < 0) return -1;
    int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, mode & 0777);
    if (out < 0) { int e = errno; close(in); errno = e; return -1; }
    static char buf[32768];                      /* the wasm stack is 64KB */
    int rc = 0;
    for (;;) {
        ssize_t r = read(in, buf, sizeof buf);
        if (r < 0) { rc = -1; break; }
        if (r == 0) break;
        for (ssize_t off = 0; off < r; ) {
            ssize_t w = write(out, buf + off, (size_t)(r - off));
            if (w <= 0) { rc = -1; r = 0; break; }
            off += w;
        }
        if (rc) break;
    }
    int e = errno;
    close(in);
    if (close(out) != 0 && rc == 0) { rc = -1; e = errno; }
    errno = e;
    return rc;
}

/* Recursive copy: file, symlink (as a link), or directory tree. Refuses
 * dst inside src (a directory pasted into itself would recurse forever). */
static int fo_copy(const char *src, const char *dst) {
    size_t sl = strlen(src);
    if (strncmp(dst, src, sl) == 0 && (dst[sl] == '/' || dst[sl] == 0)) {
        errno = EINVAL;
        return -1;
    }
    struct stat st;
    if (lstat(src, &st) != 0) return -1;
    if (S_ISLNK(st.st_mode)) {
        char tgt[FO_PATH_MAX];
        ssize_t n = readlink(src, tgt, sizeof tgt - 1);
        if (n < 0) return -1;
        tgt[n] = 0;
        return symlink(tgt, dst);
    }
    if (!S_ISDIR(st.st_mode)) return fo_copy_file(src, dst, st.st_mode);
    if (mkdir(dst, st.st_mode & 0777) != 0) return -1;
    DIR *d = opendir(src);
    if (!d) return -1;
    int rc = 0;
    struct dirent *de;
    while (rc == 0 && (de = readdir(d))) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        char s[FO_PATH_MAX], t[FO_PATH_MAX];
        if (snprintf(s, sizeof s, "%s/%s", src, de->d_name) >= (int)sizeof s ||
            snprintf(t, sizeof t, "%s/%s", dst, de->d_name) >= (int)sizeof t) {
            errno = ENAMETOOLONG;
            rc = -1;
            break;
        }
        rc = fo_copy(s, t);
    }
    int e = errno;
    closedir(d);
    errno = e;
    return rc;
}

/* ---- fo_merge: the ONE additive merge engine (gucman `seed` design §3.1) ----
 *
 * "Copy these files to this destination, and copy them over again if
 * missing" — never overwrite, never delete, directories merge. It existed
 * privately as deskdefaults.c's dd_merge; it lives here now because gucman's
 * `seed` resource kind plants with exactly these semantics, and the two must
 * not drift.
 *
 *   dst ABSENT      -> plant src wholesale (fo_copy's rules: symlinks copy AS
 *                      links, dirs mkdir+recurse, files byte-copy preserving
 *                      mode), firing FILE/LINK/DIR per planted node and ONE
 *                      NODE for the subtree root once it lands whole
 *   both DIRS       -> KEPT for the pair, then recurse (the additive folder
 *                      merge: a new default deck lands INSIDE the user's
 *                      existing folder without touching their files)
 *   any other clash -> KEPT, skip (the user's file always wins)
 *
 * The two granularities both exist because the two consumers need different
 * ones: desktop-defaults counts `added` per wholesale NODE (its shipped
 * output contract), gucman records per FILE (a sha256 each — the checksum
 * gate its remove depends on) and per created DIR (rmdir-if-empty on
 * remove). Events fire through `cb` (NULL for none); errno is live at the
 * callback for FO_MERGE_ERR.
 *
 * Every file publishes ATOMICALLY (tmp + rename, fo_copy_file_atomic below),
 * so a crash mid-plant leaves whole files plus at most one invisible
 * `.fotmp.*` dotfile — never a torn destination. Re-running converges: the
 * already-planted files are KEPT and the missing tail is planted.
 *
 * Returns 0, or -1 if ANY node failed (the merge still visits its siblings —
 * one unreadable default must not stop the rest; a wholesale plant, like
 * fo_copy, abandons its own subtree at the first error).
 */
/* One relative-path safety check: not absolute, no empty segment, no "."
 * or ".." component, no trailing slash. gucman's gm_safe_rel is this (it
 * moved here so desktop-defaults' reconcile validates payload paths through
 * the SAME code — a second copy would be a place for the rules to drift). */
static int fo_safe_rel(const char *rel) {
    if (!rel || !*rel || rel[0] == '/') return 0;
    const char *p = rel;
    while (*p) {
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t sl = (size_t)(p - seg);
        if (sl == 0) return 0;                                   /* "//" */
        if (sl == 1 && seg[0] == '.') return 0;
        if (sl == 2 && seg[0] == '.' && seg[1] == '.') return 0;
        if (*p) p++;
        if (*p == 0 && p[-1] == '/') return 0;                   /* trailing slash */
    }
    return 1;
}

/* A `seed` DESTINATION under /root: fo_safe_rel PLUS "no component may
 * start with '.'" — the design §2.1 rule that keeps a package out of hidden
 * user config (~/.config/openwith is the HIGHEST cfgstore layer, ~/.win32reg
 * the registry hive). MUST MATCH os-common.js validateSeedShape. */
static int fo_safe_seed_rel(const char *rel) {
    if (!fo_safe_rel(rel)) return 0;
    if (rel[0] == '.') return 0;
    for (const char *p = rel; *p; p++)
        if (p[0] == '/' && p[1] == '.') return 0;
    return 1;
}

#define FO_MERGE_NODE  0   /* a wholesale-absent subtree root was planted */
#define FO_MERGE_FILE  1   /* one file was planted (incl. inside a NODE) */
#define FO_MERGE_DIR   2   /* one directory was created */
#define FO_MERGE_KEPT  3   /* same-name clash skipped (or dir+dir merged) */
#define FO_MERGE_LINK  4   /* one symlink was planted (copied AS a link) */
#define FO_MERGE_ERR   5   /* this path failed; errno is set */

typedef void (*fo_merge_cb)(int ev, const char *path, void *ud);

/* Copy `src` onto `dst` with an ATOMIC publish: the bytes land in
 * "<dir>/.fotmp.<name>" and rename(2) into place. A stale tmp from an
 * interrupted run is truncated by fo_copy_file's O_TRUNC. dst is re-checked
 * absent immediately before the rename — this is crash protection, not
 * concurrency protection (single-writer world). */
static int fo_copy_file_atomic(const char *src, const char *dst, mode_t mode) {
    const char *base = strrchr(dst, '/');
    char tmp[FO_PATH_MAX];
    int w = base ? snprintf(tmp, sizeof tmp, "%.*s/.fotmp.%s",
                            (int)(base - dst), dst, base + 1)
                 : snprintf(tmp, sizeof tmp, ".fotmp.%s", dst);
    if (w < 0 || w >= (int)sizeof tmp) { errno = ENAMETOOLONG; return -1; }
    if (fo_copy_file(src, tmp, mode) != 0) { int e = errno; unlink(tmp); errno = e; return -1; }
    struct stat st;
    if (lstat(dst, &st) == 0) { unlink(tmp); errno = EEXIST; return -1; }
    if (rename(tmp, dst) != 0) { int e = errno; unlink(tmp); errno = e; return -1; }
    return 0;
}

/* Plant an absent node wholesale, firing one event per planted node. */
static int fo_plant(const char *src, const char *dst, fo_merge_cb cb, void *ud) {
    struct stat st;
    if (lstat(src, &st) != 0) { if (cb) cb(FO_MERGE_ERR, src, ud); return -1; }
    if (S_ISLNK(st.st_mode)) {
        char tgt[FO_PATH_MAX];
        ssize_t n = readlink(src, tgt, sizeof tgt - 1);
        if (n < 0) { if (cb) cb(FO_MERGE_ERR, src, ud); return -1; }
        tgt[n] = 0;
        if (symlink(tgt, dst) != 0) { if (cb) cb(FO_MERGE_ERR, dst, ud); return -1; }
        if (cb) cb(FO_MERGE_LINK, dst, ud);
        return 0;
    }
    if (!S_ISDIR(st.st_mode)) {
        if (fo_copy_file_atomic(src, dst, st.st_mode) != 0) {
            if (cb) cb(FO_MERGE_ERR, dst, ud);
            return -1;
        }
        if (cb) cb(FO_MERGE_FILE, dst, ud);
        return 0;
    }
    if (mkdir(dst, st.st_mode & 0777) != 0) { if (cb) cb(FO_MERGE_ERR, dst, ud); return -1; }
    if (cb) cb(FO_MERGE_DIR, dst, ud);
    DIR *d = opendir(src);
    if (!d) { if (cb) cb(FO_MERGE_ERR, src, ud); return -1; }
    int rc = 0;
    struct dirent *de;
    while (rc == 0 && (de = readdir(d))) {       /* fo_copy's rule: first error ends the subtree */
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        char s[FO_PATH_MAX], t[FO_PATH_MAX];
        if (snprintf(s, sizeof s, "%s/%s", src, de->d_name) >= (int)sizeof s ||
            snprintf(t, sizeof t, "%s/%s", dst, de->d_name) >= (int)sizeof t) {
            errno = ENAMETOOLONG;
            if (cb) cb(FO_MERGE_ERR, de->d_name, ud);
            rc = -1;
            break;
        }
        rc = fo_plant(s, t, cb, ud);
    }
    int e = errno;
    closedir(d);
    errno = e;
    return rc;
}

static int fo_merge(const char *src, const char *dst, fo_merge_cb cb, void *ud) {
    struct stat ss, ds;
    if (lstat(src, &ss) != 0) { if (cb) cb(FO_MERGE_ERR, src, ud); return -1; }
    if (lstat(dst, &ds) != 0) {
        if (fo_plant(src, dst, cb, ud) != 0) return -1;
        if (cb) cb(FO_MERGE_NODE, dst, ud);      /* only once it landed whole */
        return 0;
    }
    if (cb) cb(FO_MERGE_KEPT, dst, ud);
    if (!S_ISDIR(ss.st_mode) || !S_ISDIR(ds.st_mode)) return 0;   /* clash: skip */
    DIR *d = opendir(src);
    if (!d) { if (cb) cb(FO_MERGE_ERR, src, ud); return -1; }
    int rc = 0;
    struct dirent *de;
    while ((de = readdir(d))) {                  /* dd_merge's rule: visit every sibling */
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        char s[FO_PATH_MAX], t[FO_PATH_MAX];
        if (snprintf(s, sizeof s, "%s/%s", src, de->d_name) >= (int)sizeof s ||
            snprintf(t, sizeof t, "%s/%s", dst, de->d_name) >= (int)sizeof t) {
            errno = ENAMETOOLONG;
            if (cb) cb(FO_MERGE_ERR, de->d_name, ud);
            rc = -1;
            continue;
        }
        if (fo_merge(s, t, cb, ud) != 0) rc = -1;
    }
    int e = errno;
    closedir(d);
    errno = e;
    return rc;
}

/* Recursive delete: unlink, or depth-first rmdir for a directory. */
static int fo_delete(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return -1;
    if (!S_ISDIR(st.st_mode)) return unlink(path);
    DIR *d = opendir(path);
    if (!d) return -1;
    int rc = 0;
    struct dirent *de;
    while (rc == 0 && (de = readdir(d))) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        char p[FO_PATH_MAX];
        if (snprintf(p, sizeof p, "%s/%s", path, de->d_name) >= (int)sizeof p) {
            errno = ENAMETOOLONG;
            rc = -1;
            break;
        }
        rc = fo_delete(p);
    }
    int e = errno;
    closedir(d);
    errno = e;
    return rc == 0 ? rmdir(path) : rc;
}

/* Move: same-path no-op, rename(2), EXDEV falls back to copy+delete.
 * An existing destination refuses with EEXIST — no silent overwrite. */
static int fo_move(const char *src, const char *dst) {
    if (strcmp(src, dst) == 0) return 0;
    struct stat st;
    if (lstat(dst, &st) == 0) { errno = EEXIST; return -1; }
    if (rename(src, dst) == 0) return 0;
    if (errno != EXDEV) return -1;
    if (fo_copy(src, dst) != 0) return -1;
    return fo_delete(src);
}

/* A free destination for pasting `name` into `dir`: the name itself, then
 * "Copy of name", "Copy (2) of name", ... (the Win95 clash rule). */
static int fo_paste_dest(const char *dir, const char *name,
                         char *out, size_t cap) {
    struct stat st;
    for (int k = 0; k <= 99; k++) {
        int w;
        if (k == 0) w = snprintf(out, cap, "%s/%s", dir, name);
        else if (k == 1) w = snprintf(out, cap, "%s/Copy of %s", dir, name);
        else w = snprintf(out, cap, "%s/Copy (%d) of %s", dir, k, name);
        if (w < 0 || w >= (int)cap) { errno = ENAMETOOLONG; return -1; }
        if (lstat(out, &st) != 0) return 0;
    }
    errno = EEXIST;
    return -1;
}

/* A free "base", "base 2", "base 3", ... child of `dir` with an optional
 * extension — the New Folder / New Text File uniquifier (the 0091 rule,
 * wm.c ctx_new_entry is the desktop's copy). */
static int fo_new_dest(const char *dir, const char *base, const char *ext,
                       char *out, size_t cap) {
    struct stat st;
    for (int k = 1; k <= 99; k++) {
        int w;
        if (k == 1) w = snprintf(out, cap, "%s/%s%s", dir, base, ext);
        else w = snprintf(out, cap, "%s/%s %d%s", dir, base, k, ext);
        if (w < 0 || w >= (int)cap) { errno = ENAMETOOLONG; return -1; }
        if (lstat(out, &st) != 0) return 0;
    }
    errno = EEXIST;
    return -1;
}

/* ---- the trash store (todos/0093) ---- */

#define FO_TRASH       "/root/.recycle"
#define FO_TRASH_FILES FO_TRASH "/files"
#define FO_TRASH_INFO  FO_TRASH "/info"

/* Idempotent store creation (mkdir -p by hand — two levels). */
static void fo_trash_init(void) {
    mkdir(FO_TRASH, 0755);
    mkdir(FO_TRASH_FILES, 0755);
    mkdir(FO_TRASH_INFO, 0755);
}

/* Inside the store (any level)? Trashing there is refused — deleting an
 * already-trashed entry is permanent (the Win95 rule). */
static int fo_in_trash(const char *path) {
    size_t l = strlen(FO_TRASH);
    return strncmp(path, FO_TRASH, l) == 0 && (path[l] == '/' || path[l] == 0);
}

/* Live entries in the store (the full/empty glyph + Empty gray gate). */
static int fo_trash_count(void) {
    DIR *d = opendir(FO_TRASH_FILES);
    if (!d) return 0;
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)))
        if (strcmp(de->d_name, ".") && strcmp(de->d_name, "..")) n++;
    closedir(d);
    return n;
}

/* Move `path` (absolute) into the store with a sidecar. A failed sidecar
 * write rolls the move back — an entry without its original path could
 * never be restored. */
static int fo_trash(const char *path) {
    if (fo_in_trash(path)) { errno = EINVAL; return -1; }
    fo_trash_init();
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    char dst[FO_PATH_MAX];
    if (fo_new_dest(FO_TRASH_FILES, base, "", dst, sizeof dst) != 0) return -1;
    if (fo_move(path, dst) != 0) {
        /* fo_move's EXDEV path can leave a copied dst behind (e.g. the
         * source delete failed EROFS): sweep it so a failed trash never
         * strands a store entry. */
        int e = errno;
        struct stat st;
        if (lstat(dst, &st) == 0) fo_delete(dst);
        errno = e;
        return -1;
    }
    char info[FO_PATH_MAX];
    snprintf(info, sizeof info, "%s/%s", FO_TRASH_INFO,
             strrchr(dst, '/') + 1);
    FILE *f = fopen(info, "w");
    if (!f || fprintf(f, "%s\n%ld\n", path, (long)time(NULL)) < 0 ||
        fclose(f) != 0) {
        int e = errno;
        if (f) fclose(f);
        unlink(info);
        fo_move(dst, path);                      /* roll back */
        errno = e;
        return -1;
    }
    return 0;
}

/* The recorded original path of stored entry `stored` (its full path in
 * files/), from the sidecar. */
static int fo_restore_target(const char *stored, char *out, size_t cap) {
    const char *base = strrchr(stored, '/');
    base = base ? base + 1 : stored;
    char info[FO_PATH_MAX];
    snprintf(info, sizeof info, "%s/%s", FO_TRASH_INFO, base);
    FILE *f = fopen(info, "r");
    if (!f) return -1;
    int ok = fgets(out, (int)cap, f) != NULL;
    fclose(f);
    if (!ok) { errno = EINVAL; return -1; }
    size_t l = strlen(out);
    while (l > 0 && (out[l - 1] == '\n' || out[l - 1] == '\r')) out[--l] = 0;
    if (!l || out[0] != '/') { errno = EINVAL; return -1; }
    return 0;
}

/* Drop the sidecar of stored entry `stored` — the permanent-delete-in-
 * store companion (a deleted entry must not orphan its metadata). */
static void fo_trash_forget(const char *stored) {
    const char *base = strrchr(stored, '/');
    base = base ? base + 1 : stored;
    char info[FO_PATH_MAX];
    snprintf(info, sizeof info, "%s/%s", FO_TRASH_INFO, base);
    unlink(info);
}

/* Return `stored` to its recorded original path. An occupied target is
 * EEXIST (fo_move's rule) — the caller prompts, deletes, retries. The
 * sidecar goes with a clean restore. */
static int fo_restore(const char *stored) {
    char orig[FO_PATH_MAX];
    if (fo_restore_target(stored, orig, sizeof orig) != 0) return -1;
    if (fo_move(stored, orig) != 0) return -1;
    const char *base = strrchr(stored, '/');
    base = base ? base + 1 : stored;
    char info[FO_PATH_MAX];
    snprintf(info, sizeof info, "%s/%s", FO_TRASH_INFO, base);
    unlink(info);
    return 0;
}

/* Empty the store: every files/ entry and every info/ sidecar, the dirs
 * themselves kept. First failure stops and reports. */
static int fo_trash_empty(void) {
    static const char *const dirs[2] = { FO_TRASH_FILES, FO_TRASH_INFO };
    for (int k = 0; k < 2; k++) {
        DIR *d = opendir(dirs[k]);
        if (!d) continue;
        int rc = 0;
        struct dirent *de;
        while (rc == 0 && (de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            char p[FO_PATH_MAX];
            if (snprintf(p, sizeof p, "%s/%s", dirs[k], de->d_name) >=
                (int)sizeof p) { errno = ENAMETOOLONG; rc = -1; break; }
            rc = fo_delete(p);
        }
        int e = errno;
        closedir(d);
        errno = e;
        if (rc != 0) return -1;
    }
    return 0;
}

#endif /* FILEOPS_H */
