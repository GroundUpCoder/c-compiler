/* kernel32.c — the kernel32 subset over POSIX (todos/0059, design
 * todos/WIN32.md "Coexistence with POSIX").
 *
 * Pure user-space translation, the Wine/Cygwin model: HANDLE wraps an fd
 * (or a pid / find-state / mapping object), CreateFile->open,
 * FindFirstFile->opendir+wildcard, CreateProcess->the owner-brokered
 * __spawn spec (fd-actions from STARTF_USESTDHANDLES, cwd honored),
 * GetTickCount/QueryPerformanceCounter->clock_gettime. No kernel change.
 *
 * Charset model: kernel32 is W-NATIVE (see the windows.h section note) —
 * the corpus that demands it is UNICODE-only, so the W names are the real
 * symbols and the UTF-16<->UTF-8 boundary lives here (MultiByteToWideChar
 * treats CP_ACP as UTF-8: this OS is a UTF-8 world).
 *
 * Windows paths map: '\' flips to '/', a leading drive ("C:") strips to
 * the fs root. POSIX paths pass through untouched, so in-OS callers can
 * hand either flavor to any path-taking entry.
 *
 * Deliberate 0059 simplifications (per the todo item; grow on PORTS.md
 * demand):
 *   - CreateThread fails with ERROR_CALL_NOT_IMPLEMENTED (WIN32.md
 *     friction #1: single-threaded apps only — processes parallelize)
 *   - LoadLibrary fails with ERROR_CALL_NOT_IMPLEMENTED (static-link
 *     world; calc's uxtheme/htmlhelp binding degrades gracefully)
 *   - MapViewOfFile is a read-into-heap copy; FILE_MAP_WRITE views write
 *     back on UnmapViewOfFile (notepad only reads through views)
 *   - WaitForSingleObject takes process handles only
 *   - Global/Local/Heap alloc are one headered malloc (like modern
 *     Windows, where they all sit on the same process heap)
 */

/* The veneer is implemented ANSI-side internally (0060 convention). */
#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include "win32_internal.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <stdarg.h>

/* __win32_unsupported (the 0211 fail-loud sink) lives in gdi32.c since
 * M4 (0259): gdi32 is the base layer every veneer link set shares — wm.c
 * links gdi32+menucore without kernel32. */

/* ============================================================ last error */

static DWORD g_lastError;

DWORD GetLastError(void) { return g_lastError; }
void SetLastError(DWORD err) { g_lastError = err; }

static DWORD err_from_errno(int e) {
    switch (e) {
    case ENOENT:       return ERROR_FILE_NOT_FOUND;
    case ENOTDIR:      return ERROR_PATH_NOT_FOUND;
    case EACCES:       return ERROR_ACCESS_DENIED;
    case EPERM:        return ERROR_ACCESS_DENIED;
    case EEXIST:       return ERROR_ALREADY_EXISTS;
    case ENOMEM:       return ERROR_NOT_ENOUGH_MEMORY;
    case EINVAL:       return ERROR_INVALID_PARAMETER;
    case EBADF:        return ERROR_INVALID_HANDLE;
    case ENOTEMPTY:    return ERROR_DIR_NOT_EMPTY;
    case EROFS:        return ERROR_WRITE_PROTECT;
    case ENOSPC:       return ERROR_DISK_FULL;
    case EPIPE:        return ERROR_BROKEN_PIPE;
    case EMFILE:       return ERROR_TOO_MANY_OPEN_FILES;
    case ENAMETOOLONG: return ERROR_FILENAME_EXCED_RANGE;
    case EISDIR:       return ERROR_ACCESS_DENIED;
    default:           return ERROR_GEN_FAILURE;
    }
}

static void set_err_errno(void) { g_lastError = err_from_errno(errno); }

/* ================================================= the UTF-16/8 boundary */

/* Encode one code point as UTF-8 into dst (cap-checked); returns bytes. */
static int u8_put(unsigned cp, char *dst, int cap) {
    if (cp < 0x80) { if (cap >= 1) dst[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        if (cap >= 2) { dst[0] = (char)(0xC0 | (cp >> 6)); dst[1] = (char)(0x80 | (cp & 0x3F)); }
        return 2;
    }
    if (cp < 0x10000) {
        if (cap >= 3) {
            dst[0] = (char)(0xE0 | (cp >> 12));
            dst[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
            dst[2] = (char)(0x80 | (cp & 0x3F));
        }
        return 3;
    }
    if (cap >= 4) {
        dst[0] = (char)(0xF0 | (cp >> 18));
        dst[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        dst[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        dst[3] = (char)(0x80 | (cp & 0x3F));
    }
    return 4;
}

/* Decode one UTF-8 code point at src[*i] (advances *i; lone/invalid bytes
 * decode as U+FFFD to keep the boundary total). */
static unsigned u8_get(const char *src, int len, int *i) {
    unsigned char c = (unsigned char)src[(*i)++];
    if (c < 0x80) return c;
    int need = (c >= 0xF0) ? 3 : (c >= 0xE0) ? 2 : (c >= 0xC0) ? 1 : -1;
    if (need < 0) return 0xFFFD;
    unsigned cp = c & (0x3F >> need);
    for (int k = 0; k < need; k++) {
        if (*i >= len || ((unsigned char)src[*i] & 0xC0) != 0x80) return 0xFFFD;
        cp = (cp << 6) | ((unsigned char)src[(*i)++] & 0x3F);
    }
    return cp;
}

int MultiByteToWideChar(UINT cp, DWORD flags, LPCSTR src, int srcLen,
                        LPWSTR dst, int dstLen) {
    (void)cp; (void)flags;   /* CP_ACP == CP_UTF8 in this OS */
    if (!src || srcLen == 0) { g_lastError = ERROR_INVALID_PARAMETER; return 0; }
    if (srcLen < 0) srcLen = (int)strlen(src) + 1;   /* include the NUL */
    int o = 0, i = 0;
    while (i < srcLen) {
        unsigned u = u8_get(src, srcLen, &i);
        int units = (u >= 0x10000) ? 2 : 1;
        if (dstLen > 0) {
            if (o + units > dstLen) { g_lastError = ERROR_INSUFFICIENT_BUFFER; return 0; }
            if (units == 2) {
                dst[o] = (WCHAR)(0xD800 + ((u - 0x10000) >> 10));
                dst[o + 1] = (WCHAR)(0xDC00 + ((u - 0x10000) & 0x3FF));
            } else {
                dst[o] = (WCHAR)u;
            }
        }
        o += units;
    }
    return o;
}

int WideCharToMultiByte(UINT cp, DWORD flags, LPCWSTR src, int srcLen,
                        LPSTR dst, int dstLen, LPCSTR defChar, LPBOOL used) {
    (void)cp; (void)flags; (void)defChar;
    if (used) *used = FALSE;
    if (!src || srcLen == 0) { g_lastError = ERROR_INVALID_PARAMETER; return 0; }
    if (srcLen < 0) { srcLen = 0; while (src[srcLen]) srcLen++; srcLen++; }
    int o = 0;
    for (int i = 0; i < srcLen; i++) {
        unsigned u = src[i];
        if (u >= 0xD800 && u < 0xDC00 && i + 1 < srcLen &&
            src[i + 1] >= 0xDC00 && src[i + 1] < 0xE000) {
            u = 0x10000 + ((u - 0xD800) << 10) + (src[i + 1] - 0xDC00);
            i++;
        } else if (u >= 0xD800 && u < 0xE000) {
            u = 0xFFFD;                          /* unpaired surrogate */
            if (used) *used = TRUE;
        }
        char tmp[4];
        int n = u8_put(u, tmp, 4);
        if (dstLen > 0) {
            if (o + n > dstLen) { g_lastError = ERROR_INSUFFICIENT_BUFFER; return 0; }
            memcpy(dst + o, tmp, (size_t)n);
        }
        o += n;
    }
    return o;
}

/* Internal: NUL-terminated conversions into caller buffers. Return the
 * char/WCHAR count EXCLUDING the terminator (truncating, always NUL). */
static int w2u8(LPCWSTR w, char *out, int cap) {
    if (!w) { if (cap > 0) out[0] = 0; return 0; }
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, out, cap, NULL, NULL);
    if (n <= 0 && cap > 0) out[cap - 1] = 0;
    return n > 0 ? n - 1 : (int)strlen(out);
}

static int u82w(const char *s, LPWSTR out, int cap) {
    if (!s) { if (cap > 0) out[0] = 0; return 0; }
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, out, cap);
    if (n <= 0 && cap > 0) { out[cap - 1] = 0; n = 1; }
    return n > 0 ? n - 1 : 0;
}

/* ============================================================ lstr / dbg */

int lstrlenW(LPCWSTR s) { int n = 0; if (s) while (s[n]) n++; return n; }
int lstrlenA(LPCSTR s) { return s ? (int)strlen(s) : 0; }

LPWSTR lstrcpyW(LPWSTR dst, LPCWSTR src) {
    WCHAR *d = dst;
    while ((*d++ = *src++)) {}
    return dst;
}

LPWSTR lstrcpynW(LPWSTR dst, LPCWSTR src, int n) {
    if (n <= 0) return dst;
    int i = 0;
    for (; i < n - 1 && src[i]; i++) dst[i] = src[i];
    dst[i] = 0;
    return dst;
}

LPWSTR lstrcatW(LPWSTR dst, LPCWSTR src) {
    return lstrcpyW(dst + lstrlenW(dst), src);
}

int lstrcmpW(LPCWSTR a, LPCWSTR b) {
    while (*a && *a == *b) { a++; b++; }
    return (int)*a - (int)*b;
}

static WCHAR wupper(WCHAR c) { return (c >= 'a' && c <= 'z') ? (WCHAR)(c - 32) : c; }

int lstrcmpiW(LPCWSTR a, LPCWSTR b) {
    while (*a && wupper(*a) == wupper(*b)) { a++; b++; }
    return (int)wupper(*a) - (int)wupper(*b);
}

void OutputDebugStringW(LPCWSTR s) {
    char buf[1024];
    w2u8(s, buf, sizeof buf);
    fprintf(stderr, "%s", buf);
}

/* ============================================================== paths */

/* Windows path -> POSIX path: flip backslashes, strip a drive letter to
 * the fs root. Forward-slash POSIX paths pass through untouched.
 * Returns 1, or 0 when the path does not fit — the old void version
 * silently prefix-truncated an over-long path and every path API then
 * operated on the WRONG file while reporting success (#319 gap #35). */
static int path_from_w(LPCWSTR w, char *out, int cap) {
    char raw[1024];
    if (!w) { if (cap > 0) out[0] = 0; return 1; }
    if (WideCharToMultiByte(CP_UTF8, 0, w, -1, raw, sizeof raw, NULL, NULL) <= 0)
        return 0;                                 /* over the 1023-byte cap */
    const char *p = raw;
    if (((raw[0] >= 'A' && raw[0] <= 'Z') || (raw[0] >= 'a' && raw[0] <= 'z')) &&
        raw[1] == ':')
        p = raw + 2;                              /* "C:\x" -> "\x" */
    int o = 0;
    if (p != raw && *p != '\\' && *p != '/') { if (o < cap - 1) out[o++] = '/'; }
    for (; *p && o < cap - 1; p++) out[o++] = (*p == '\\') ? '/' : *p;
    if (o == 0 && p != raw && o < cap - 1) out[o++] = '/';  /* bare "C:" */
    out[o] = 0;
    return *p == 0;                               /* 0: out cap ran out */
}

/* path_from_w for an API argument: failure sets the Windows error the
 * caller reports (ERROR_FILENAME_EXCED_RANGE, like a >MAX_PATH name). */
static int path_arg(LPCWSTR w, char *out, int cap) {
    if (path_from_w(w, out, cap)) return 1;
    g_lastError = ERROR_FILENAME_EXCED_RANGE;
    return 0;
}

/* ======================================================== handle table */

#define K32_MAGIC 0x4B333268u

enum { HK_FILE = 1, HK_FIND = 2, HK_MAP = 3, HK_PROC = 4 };

typedef struct {
    unsigned magic;
    int kind;
    int is_static;      /* std handles: closeable fd, non-freeable object */
    int fd;             /* HK_FILE / HK_MAP (private dup) */
    /* HK_FIND */
    DIR *dir;
    char *findDir;      /* utf8 dir prefix ("" = cwd) */
    char *findPat;      /* utf8 wildcard */
    /* HK_MAP */
    DWORD mapProtect;
    /* HK_PROC */
    int pid;
    int exited;
    DWORD exitCode;
} K32Obj;

static K32Obj *h_alloc(int kind) {
    K32Obj *o = (K32Obj *)calloc(1, sizeof(K32Obj));
    if (!o) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    o->magic = K32_MAGIC;
    o->kind = kind;
    return o;
}

static K32Obj *h_get(HANDLE h, int kind) {
    K32Obj *o = (K32Obj *)h;
    if (!o || h == INVALID_HANDLE_VALUE || o->magic != K32_MAGIC ||
        (kind && o->kind != kind)) {
        g_lastError = ERROR_INVALID_HANDLE;
        return NULL;
    }
    return o;
}

BOOL CloseHandle(HANDLE h) {
    K32Obj *o = h_get(h, 0);
    if (!o) return FALSE;
    switch (o->kind) {
    case HK_FILE:
    case HK_MAP:
        if (o->fd >= 0) close(o->fd);
        break;
    case HK_FIND:
        if (o->dir) closedir(o->dir);
        free(o->findDir);
        free(o->findPat);
        break;
    case HK_PROC:
        /* Windows: closing a process handle does NOT kill the process.
         * An unreaped child is reaped by the kernel's auto-reap on our
         * exit; nothing to do here. */
        break;
    }
    if (o->is_static) return TRUE;
    o->magic = 0;
    free(o);
    return TRUE;
}

static K32Obj g_std[3] = {
    { K32_MAGIC, HK_FILE, 1, 0, NULL, NULL, NULL, 0, 0, 0, 0 },
    { K32_MAGIC, HK_FILE, 1, 1, NULL, NULL, NULL, 0, 0, 0, 0 },
    { K32_MAGIC, HK_FILE, 1, 2, NULL, NULL, NULL, 0, 0, 0, 0 },
};

HANDLE GetStdHandle(DWORD which) {
    switch (which) {
    case STD_INPUT_HANDLE:  return (HANDLE)&g_std[0];
    case STD_OUTPUT_HANDLE: return (HANDLE)&g_std[1];
    case STD_ERROR_HANDLE:  return (HANDLE)&g_std[2];
    }
    g_lastError = ERROR_INVALID_PARAMETER;
    return INVALID_HANDLE_VALUE;
}

/* ============================================================== files */

HANDLE CreateFileW(LPCWSTR name, DWORD acc, DWORD share, void *sa,
                   DWORD creation, DWORD flagsAttrs, HANDLE template_) {
    (void)share; (void)sa; (void)flagsAttrs; (void)template_;
    char p[1024];
    if (!path_arg(name, p, sizeof p)) return INVALID_HANDLE_VALUE;

    int fl;
    if ((acc & GENERIC_READ) && (acc & GENERIC_WRITE)) fl = O_RDWR;
    else if (acc & GENERIC_WRITE) fl = O_WRONLY;
    else fl = O_RDONLY;

    int existed = access(p, 0) == 0;
    switch (creation) {
    case CREATE_NEW:        fl |= O_CREAT | O_EXCL; break;
    case CREATE_ALWAYS:     fl |= O_CREAT | O_TRUNC; break;
    case OPEN_EXISTING:     break;
    case OPEN_ALWAYS:                /* create only when MISSING: POSIX
                                      * open(O_CREAT) on an existing file on
                                      * a read-only volume is EROFS, but
                                      * Windows OPEN_ALWAYS opens existing
                                      * files on write-protected media fine
                                      * (notepad viewing /usr, todos/0202) */
        if (!existed) fl |= O_CREAT;
        break;
    case TRUNCATE_EXISTING: fl |= O_TRUNC; break;
    default:
        g_lastError = ERROR_INVALID_PARAMETER;
        return INVALID_HANDLE_VALUE;
    }

    int fd = open(p, fl, 0666);
    if (fd < 0) { set_err_errno(); return INVALID_HANDLE_VALUE; }
    K32Obj *o = h_alloc(HK_FILE);
    if (!o) { close(fd); return INVALID_HANDLE_VALUE; }
    o->fd = fd;
    /* Windows quirk callers rely on: CREATE_ALWAYS/OPEN_ALWAYS report
     * whether the file pre-existed via last-error. */
    g_lastError = ((creation == CREATE_ALWAYS || creation == OPEN_ALWAYS) && existed)
                      ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS;
    return (HANDLE)o;
}

BOOL ReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD nread, void *ov) {
    (void)ov;
    K32Obj *o = h_get(h, HK_FILE);
    if (!o) return FALSE;
    long r = read(o->fd, buf, n);
    if (r < 0) { set_err_errno(); return FALSE; }
    if (nread) *nread = (DWORD)r;                 /* EOF: TRUE with 0 read */
    return TRUE;
}

BOOL WriteFile(HANDLE h, LPCVOID buf, DWORD n, LPDWORD written, void *ov) {
    (void)ov;
    K32Obj *o = h_get(h, HK_FILE);
    if (!o) return FALSE;
    DWORD done = 0;
    const char *p = (const char *)buf;
    while (done < n) {
        long r = write(o->fd, p + done, n - done);
        if (r < 0) { set_err_errno(); if (written) *written = done; return FALSE; }
        if (r == 0) break;
        done += (DWORD)r;
    }
    if (written) *written = done;
    return TRUE;
}

DWORD SetFilePointer(HANDLE h, LONG dist, PLONG distHigh, DWORD method) {
    K32Obj *o = h_get(h, HK_FILE);
    if (!o) return INVALID_SET_FILE_POINTER;
    long long off = distHigh ? (((long long)*distHigh << 32) | (DWORD)dist)
                             : (long long)dist;
    int whence = (method == FILE_END) ? 2 : (method == FILE_CURRENT) ? 1 : 0;
    long long r = lseek(o->fd, off, whence);
    if (r < 0) { g_lastError = ERROR_NEGATIVE_SEEK; return INVALID_SET_FILE_POINTER; }
    if (distHigh) *distHigh = (LONG)(r >> 32);
    g_lastError = ERROR_SUCCESS;
    return (DWORD)r;
}

DWORD GetFileSize(HANDLE h, LPDWORD sizeHigh) {
    K32Obj *o = h_get(h, HK_FILE);
    if (!o) return INVALID_FILE_SIZE;
    struct stat st;
    if (fstat(o->fd, &st) != 0) { set_err_errno(); return INVALID_FILE_SIZE; }
    if (sizeHigh) *sizeHigh = (DWORD)(st.st_size >> 32);
    g_lastError = ERROR_SUCCESS;
    return (DWORD)st.st_size;
}

BOOL SetEndOfFile(HANDLE h) {
    K32Obj *o = h_get(h, HK_FILE);
    if (!o) return FALSE;
    long long pos = lseek(o->fd, 0, 1);
    if (pos < 0 || ftruncate(o->fd, pos) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

BOOL FlushFileBuffers(HANDLE h) {
    K32Obj *o = h_get(h, HK_FILE);
    if (!o) return FALSE;
    if (fsync(o->fd) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

BOOL DeleteFileW(LPCWSTR name) {
    char p[1024];
    if (!path_arg(name, p, sizeof p)) return FALSE;
    if (unlink(p) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

BOOL MoveFileW(LPCWSTR from, LPCWSTR to) {
    char a[1024], b[1024];
    if (!path_arg(from, a, sizeof a)) return FALSE;
    if (!path_arg(to, b, sizeof b)) return FALSE;
    if (access(b, 0) == 0) { g_lastError = ERROR_ALREADY_EXISTS; return FALSE; }
    if (rename(a, b) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

BOOL CreateDirectoryW(LPCWSTR path, void *sa) {
    (void)sa;
    char p[1024];
    if (!path_arg(path, p, sizeof p)) return FALSE;
    if (mkdir(p, 0777) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

BOOL RemoveDirectoryW(LPCWSTR path) {
    char p[1024];
    if (!path_arg(path, p, sizeof p)) return FALSE;
    if (rmdir(p) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

static DWORD attrs_from_stat(const struct stat *st) {
    DWORD a = 0;
    if ((st->st_mode & 0170000) == 0040000) a |= FILE_ATTRIBUTE_DIRECTORY;
    if (!(st->st_mode & 0200)) a |= FILE_ATTRIBUTE_READONLY;
    if (a == 0) a = FILE_ATTRIBUTE_NORMAL;
    return a;
}

DWORD GetFileAttributesW(LPCWSTR name) {
    char p[1024];
    if (!path_arg(name, p, sizeof p)) return INVALID_FILE_ATTRIBUTES;
    struct stat st;
    if (stat(p, &st) != 0) { set_err_errno(); return INVALID_FILE_ATTRIBUTES; }
    return attrs_from_stat(&st);
}

BOOL SetFileAttributesW(LPCWSTR name, DWORD attrs) {
    char p[1024];
    if (!path_arg(name, p, sizeof p)) return FALSE;
    struct stat st;
    if (stat(p, &st) != 0) { set_err_errno(); return FALSE; }
    int mode = (int)(st.st_mode & 07777);
    mode = (attrs & FILE_ATTRIBUTE_READONLY) ? (mode & ~0222) : (mode | 0200);
    if (chmod(p, mode) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

DWORD GetCurrentDirectoryW(DWORD n, LPWSTR buf) {
    char cwd[1024];
    if (!getcwd(cwd, sizeof cwd)) { set_err_errno(); return 0; }
    WCHAR w[1024];
    int len = u82w(cwd, w, 1024);
    if (n == 0 || !buf) return (DWORD)(len + 1);
    if ((int)n <= len) return (DWORD)(len + 1);   /* needed incl. NUL */
    lstrcpyW(buf, w);
    return (DWORD)len;
}

BOOL SetCurrentDirectoryW(LPCWSTR path) {
    char p[1024];
    if (!path_arg(path, p, sizeof p)) return FALSE;
    if (chdir(p) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

DWORD GetFullPathNameW(LPCWSTR name, DWORD n, LPWSTR buf, LPWSTR *filePart) {
    char p[1024], full[1024];
    if (!path_arg(name, p, sizeof p)) return 0;
    if (p[0] == '/') {
        strcpy(full, p);
    } else {
        char cwd[512];
        if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "/");
        snprintf(full, sizeof full, "%s/%s", strcmp(cwd, "/") == 0 ? "" : cwd, p);
    }
    /* normalize "." and ".." components in place */
    char norm[1024];
    int o = 0;
    for (char *seg = strtok(full, "/"); seg; seg = strtok(NULL, "/")) {
        if (strcmp(seg, ".") == 0) continue;
        if (strcmp(seg, "..") == 0) {
            while (o > 0 && norm[o - 1] != '/') o--;
            if (o > 0) o--;
            continue;
        }
        norm[o++] = '/';
        for (char *c = seg; *c && o < (int)sizeof norm - 1; c++) norm[o++] = *c;
    }
    if (o == 0) norm[o++] = '/';
    norm[o] = 0;

    WCHAR w[1024];
    int len = u82w(norm, w, 1024);
    if (n == 0 || !buf) return (DWORD)(len + 1);
    if ((int)n <= len) return (DWORD)(len + 1);
    lstrcpyW(buf, w);
    if (filePart) {
        WCHAR *last = buf;
        for (WCHAR *c = buf; *c; c++)
            if (*c == '/' && c[1]) last = c + 1;
        *filePart = last;
    }
    return (DWORD)len;
}

/* ========================================================= find (glob) */

/* Case-insensitive ASCII wildcard match: '*' any run, '?' any one char.
 * The DOS-heritage rule (0211): "*.*" means ALL files, dot or not —
 * callers normalize it to "*" before matching. */
static int wild_match(const char *pat, const char *s) {
    if (!*pat) return !*s;
    if (*pat == '*') {
        for (;;) {
            if (wild_match(pat + 1, s)) return 1;
            if (!*s) return 0;
            s++;
        }
    }
    if (!*s) return 0;
    char a = *pat, b = *s;
    if (a >= 'a' && a <= 'z') a -= 32;
    if (b >= 'a' && b <= 'z') b -= 32;
    if (a != '?' && a != b) return 0;
    return wild_match(pat + 1, s + 1);
}

static ULONGLONG filetime_from_unix(long long t) {
    return ((ULONGLONG)t + 11644473600ull) * 10000000ull;
}

static void find_fill(K32Obj *o, const char *name, WIN32_FIND_DATAW *fd) {
    memset(fd, 0, sizeof *fd);
    char full[1024];
    snprintf(full, sizeof full, "%s%s", o->findDir, name);
    struct stat st;
    if (stat(full, &st) == 0) {
        fd->dwFileAttributes = attrs_from_stat(&st);
        fd->nFileSizeLow = (DWORD)st.st_size;
        fd->nFileSizeHigh = (DWORD)(st.st_size >> 32);
        ULONGLONG ft = filetime_from_unix(st.st_mtime);
        fd->ftLastWriteTime.dwLowDateTime = (DWORD)ft;
        fd->ftLastWriteTime.dwHighDateTime = (DWORD)(ft >> 32);
        fd->ftCreationTime = fd->ftLastAccessTime = fd->ftLastWriteTime;
    } else {
        fd->dwFileAttributes = FILE_ATTRIBUTE_NORMAL;
    }
    u82w(name, fd->cFileName, MAX_PATH);
}

static int find_next_match(K32Obj *o, char *nameOut, int cap) {
    struct dirent *de;
    while ((de = readdir(o->dir)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        if (wild_match(o->findPat, de->d_name)) {
            snprintf(nameOut, (size_t)cap, "%s", de->d_name);
            return 1;
        }
    }
    return 0;
}

HANDLE FindFirstFileW(LPCWSTR pattern, WIN32_FIND_DATAW *fd) {
    char p[1024];
    if (!path_arg(pattern, p, sizeof p)) return INVALID_HANDLE_VALUE;
    const char *slash = strrchr(p, '/');
    char dir[1024], pat[256];
    if (slash) {
        int dlen = (int)(slash - p) + 1;          /* keep the trailing '/' */
        memcpy(dir, p, (size_t)dlen);
        dir[dlen] = 0;
        snprintf(pat, sizeof pat, "%s", slash + 1);
    } else {
        dir[0] = 0;
        snprintf(pat, sizeof pat, "%s", p);
    }
    if (strcmp(pat, "*.*") == 0) snprintf(pat, sizeof pat, "*");   /* DOS rule (0211) */
    DIR *d = opendir(dir[0] ? dir : ".");
    if (!d) { set_err_errno(); return INVALID_HANDLE_VALUE; }
    K32Obj *o = h_alloc(HK_FIND);
    if (!o) { closedir(d); return INVALID_HANDLE_VALUE; }
    o->dir = d;
    o->findDir = strdup(dir);
    o->findPat = strdup(pat);
    char name[256];
    if (!find_next_match(o, name, sizeof name)) {
        CloseHandle((HANDLE)o);
        g_lastError = ERROR_FILE_NOT_FOUND;
        return INVALID_HANDLE_VALUE;
    }
    find_fill(o, name, fd);
    return (HANDLE)o;
}

BOOL FindNextFileW(HANDLE h, WIN32_FIND_DATAW *fd) {
    K32Obj *o = h_get(h, HK_FIND);
    if (!o) return FALSE;
    char name[256];
    if (!find_next_match(o, name, sizeof name)) {
        g_lastError = ERROR_NO_MORE_FILES;
        return FALSE;
    }
    find_fill(o, name, fd);
    return TRUE;
}

BOOL FindClose(HANDLE h) {
    if (!h_get(h, HK_FIND)) return FALSE;
    return CloseHandle(h);
}

/* ========================================================= file mapping */

/* A mapping is a private dup of the file's fd; a view is a heap copy of
 * the mapped range (read in at MapViewOfFile, written back at
 * UnmapViewOfFile when the view is writable). Real shared memory needs
 * MAP_SHARED which wasm has no analog for — a copy is exactly what the
 * corpus (notepad's read-only file view) needs. */

#define MAX_VIEWS 32
static struct {
    void *base;
    int fd;
    long long off;
    DWORD len;
    int writable;
} g_views[MAX_VIEWS];

HANDLE CreateFileMappingW(HANDLE file, void *sa, DWORD protect,
                          DWORD sizeHigh, DWORD sizeLow, LPCWSTR name) {
    (void)sa; (void)sizeHigh; (void)sizeLow;
    if (name)
        WIN32_UNSUPPORTED("named file mappings (created PRIVATE, never shared)");
    K32Obj *f = h_get(file, HK_FILE);
    if (!f) return NULL;                          /* NB: NULL, not IHV */
    int fd = dup(f->fd);
    if (fd < 0) { set_err_errno(); return NULL; }
    K32Obj *o = h_alloc(HK_MAP);
    if (!o) { close(fd); return NULL; }
    o->fd = fd;
    o->mapProtect = protect;
    return (HANDLE)o;
}

LPVOID MapViewOfFile(HANDLE mapping, DWORD acc, DWORD offHigh,
                     DWORD offLow, SIZE_T bytes) {
    K32Obj *o = h_get(mapping, HK_MAP);
    if (!o) return NULL;
    if ((acc & FILE_MAP_WRITE) && o->mapProtect == PAGE_READONLY) {
        /* real MapViewOfFile refuses a write view of a read-only mapping;
         * we silently DROPPED the data at unmap instead (0211). */
        g_lastError = ERROR_ACCESS_DENIED;
        return NULL;
    }
    long long off = ((long long)offHigh << 32) | offLow;
    struct stat st;
    if (fstat(o->fd, &st) != 0) { set_err_errno(); return NULL; }
    if (bytes == 0) {
        if (off >= st.st_size) { g_lastError = ERROR_INVALID_PARAMETER; return NULL; }
        bytes = (SIZE_T)(st.st_size - off);
    }
    int slot = -1;
    for (int i = 0; i < MAX_VIEWS; i++)
        if (!g_views[i].base) { slot = i; break; }
    if (slot < 0) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    char *buf = (char *)malloc(bytes ? bytes : 1);
    if (!buf) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    if (lseek(o->fd, off, 0) < 0) { free(buf); set_err_errno(); return NULL; }
    SIZE_T got = 0;
    while (got < bytes) {
        long r = read(o->fd, buf + got, bytes - got);
        if (r < 0) { free(buf); set_err_errno(); return NULL; }
        if (r == 0) break;
        got += (SIZE_T)r;
    }
    if (got < bytes) memset(buf + got, 0, bytes - got);
    g_views[slot].base = buf;
    g_views[slot].fd = dup(o->fd);
    g_views[slot].off = off;
    g_views[slot].len = (DWORD)bytes;
    g_views[slot].writable = (acc & FILE_MAP_WRITE) ? 1 : 0;
    return buf;
}

BOOL UnmapViewOfFile(LPCVOID base) {
    for (int i = 0; i < MAX_VIEWS; i++) {
        if (g_views[i].base == base) {
            if (g_views[i].writable) {
                lseek(g_views[i].fd, g_views[i].off, 0);
                DWORD done = 0;
                while (done < g_views[i].len) {
                    long r = write(g_views[i].fd, (const char *)base + done,
                                   g_views[i].len - done);
                    if (r <= 0) {
                        __win32_unsupported("UnmapViewOfFile write-back "
                                            "failed at %u/%u bytes",
                                            (unsigned)done,
                                            (unsigned)g_views[i].len);
                        break;
                    }
                    done += (DWORD)r;
                }
            }
            close(g_views[i].fd);
            free(g_views[i].base);
            g_views[i].base = NULL;
            return TRUE;
        }
    }
    g_lastError = ERROR_INVALID_PARAMETER;
    return FALSE;
}

/* ============================================================== memory */

/* Global/Local/Heap share one headered malloc — on modern Windows they
 * all land on the same process heap too. The header keeps GlobalSize and
 * HeapReAlloc(HEAP_ZERO_MEMORY) honest. */

typedef struct {
    SIZE_T size;
    unsigned magic;
    unsigned pad_[2];                             /* keep 16-byte payload align */
} MemHdr;

#define MEM_MAGIC 0x4D454D68u

static void *mem_alloc(SIZE_T n, int zero) {
    MemHdr *h = (MemHdr *)malloc(sizeof(MemHdr) + (n ? n : 1));
    if (!h) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    h->size = n;
    h->magic = MEM_MAGIC;
    if (zero) memset(h + 1, 0, n);
    return h + 1;
}

static MemHdr *mem_hdr(void *p) {
    if (!p) return NULL;
    MemHdr *h = (MemHdr *)p - 1;
    return h->magic == MEM_MAGIC ? h : NULL;
}

HGLOBAL GlobalAlloc(UINT flags, SIZE_T bytes) {
    return (HGLOBAL)mem_alloc(bytes, flags & GMEM_ZEROINIT);
}
LPVOID GlobalLock(HGLOBAL h) { return mem_hdr(h) ? (LPVOID)h : NULL; }
BOOL GlobalUnlock(HGLOBAL h) { (void)h; return TRUE; }
SIZE_T GlobalSize(HGLOBAL h) {
    MemHdr *hd = mem_hdr(h);
    return hd ? hd->size : 0;
}
HGLOBAL GlobalFree(HGLOBAL h) {
    MemHdr *hd = mem_hdr(h);
    if (!hd) { g_lastError = ERROR_INVALID_HANDLE; return h; }
    hd->magic = 0;
    free(hd);
    return NULL;
}

HLOCAL LocalAlloc(UINT flags, SIZE_T bytes) {
    return (HLOCAL)mem_alloc(bytes, flags & LMEM_ZEROINIT);
}
LPVOID LocalLock(HLOCAL h) { return GlobalLock((HGLOBAL)h); }
BOOL LocalUnlock(HLOCAL h) { (void)h; return TRUE; }
HLOCAL LocalFree(HLOCAL h) { return (HLOCAL)GlobalFree((HGLOBAL)h); }

HANDLE GetProcessHeap(void) { return (HANDLE)0x1; }

LPVOID HeapAlloc(HANDLE heap, DWORD flags, SIZE_T bytes) {
    (void)heap;
    return mem_alloc(bytes, flags & HEAP_ZERO_MEMORY);
}

LPVOID HeapReAlloc(HANDLE heap, DWORD flags, LPVOID p, SIZE_T bytes) {
    (void)heap;
    MemHdr *hd = mem_hdr(p);
    if (!hd) return HeapAlloc(heap, flags, bytes);
    SIZE_T old = hd->size;
    MemHdr *nh = (MemHdr *)realloc(hd, sizeof(MemHdr) + (bytes ? bytes : 1));
    if (!nh) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    nh->size = bytes;
    if ((flags & HEAP_ZERO_MEMORY) && bytes > old)
        memset((char *)(nh + 1) + old, 0, bytes - old);
    return nh + 1;
}

BOOL HeapFree(HANDLE heap, DWORD flags, LPVOID p) {
    (void)heap; (void)flags;
    MemHdr *hd = mem_hdr(p);
    if (!hd) { g_lastError = ERROR_INVALID_PARAMETER; return FALSE; }
    hd->magic = 0;
    free(hd);
    return TRUE;
}

/* VirtualAlloc: heap-backed (wasm linear memory has no page protection).
 * A side table remembers bases so MEM_RELEASE can free by address. */
#define MAX_VALLOC 64
static struct { void *base; SIZE_T size; } g_valloc[MAX_VALLOC];

LPVOID VirtualAlloc(LPVOID addr, SIZE_T size, DWORD type, DWORD protect) {
    (void)protect;
    if (addr != NULL || size == 0 || !(type & (MEM_COMMIT | MEM_RESERVE))) {
        g_lastError = ERROR_INVALID_PARAMETER;
        return NULL;
    }
    int slot = -1;
    for (int i = 0; i < MAX_VALLOC; i++)
        if (!g_valloc[i].base) { slot = i; break; }
    if (slot < 0) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    void *p = calloc(1, size);
    if (!p) { g_lastError = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
    g_valloc[slot].base = p;
    g_valloc[slot].size = size;
    return p;
}

BOOL VirtualFree(LPVOID addr, SIZE_T size, DWORD type) {
    (void)size;
    if (type != MEM_RELEASE) { g_lastError = ERROR_INVALID_PARAMETER; return FALSE; }
    for (int i = 0; i < MAX_VALLOC; i++) {
        if (g_valloc[i].base == addr) {
            free(addr);
            g_valloc[i].base = NULL;
            return TRUE;
        }
    }
    g_lastError = ERROR_INVALID_PARAMETER;
    return FALSE;
}

/* ================================================================ time */

static void systemtime_from_tm(const struct tm *tm, WORD ms, SYSTEMTIME *st) {
    st->wYear = (WORD)(tm->tm_year + 1900);
    st->wMonth = (WORD)(tm->tm_mon + 1);
    st->wDayOfWeek = (WORD)tm->tm_wday;
    st->wDay = (WORD)tm->tm_mday;
    st->wHour = (WORD)tm->tm_hour;
    st->wMinute = (WORD)tm->tm_min;
    st->wSecond = (WORD)tm->tm_sec;
    st->wMilliseconds = ms;
}

void GetSystemTime(SYSTEMTIME *st) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    time_t t = (time_t)ts.tv_sec;
    systemtime_from_tm(gmtime(&t), (WORD)(ts.tv_nsec / 1000000), st);
}

void GetLocalTime(SYSTEMTIME *st) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    time_t t = (time_t)ts.tv_sec;
    systemtime_from_tm(localtime(&t), (WORD)(ts.tv_nsec / 1000000), st);
}

DWORD GetTickCount(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (DWORD)((ULONGLONG)ts.tv_sec * 1000ull + (ULONGLONG)ts.tv_nsec / 1000000ull);
}

BOOL QueryPerformanceCounter(LARGE_INTEGER *out) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    out->QuadPart = (LONGLONG)ts.tv_sec * 1000000000ll + ts.tv_nsec;
    return TRUE;
}

BOOL QueryPerformanceFrequency(LARGE_INTEGER *out) {
    out->QuadPart = 1000000000ll;                 /* the counter is in ns */
    return TRUE;
}

void Sleep(DWORD ms) {
    struct timespec req = { (long)(ms / 1000u), (long)(ms % 1000u) * 1000000L };
    nanosleep(&req, NULL);
}

/* ============================================================= process */

void ExitProcess(UINT code) { exit((int)code); }

HANDLE CreateThread(void *sa, SIZE_T stack, LPTHREAD_START_ROUTINE fn,
                    LPVOID param, DWORD flags, LPDWORD tid) {
    /* WIN32.md friction #1: single-threaded apps only — a clear failure,
     * never a silent success, and LOUD like the rest of the policy (#318;
     * a thread that never runs is a feature the app thinks it has). */
    (void)sa; (void)stack; (void)fn; (void)param; (void)flags; (void)tid;
    WIN32_UNSUPPORTED("CreateThread (single-threaded world; returning NULL)");
    g_lastError = ERROR_CALL_NOT_IMPLEMENTED;
    return NULL;
}

HANDLE GetCurrentProcess(void) { return (HANDLE)(LONG_PTR)-1; }
DWORD GetCurrentProcessId(void) { return (DWORD)getpid(); }

/* Split a command line into argv, Windows-style: whitespace separates,
 * double quotes group, backslash-quote escapes a literal quote. */
static int cmdline_split(char *s, char **argv, int cap) {
    int argc = 0;
    while (*s) {
        while (*s == ' ' || *s == '\t') s++;
        if (!*s) break;
        if (argc >= cap - 1) break;
        char *out = s;
        argv[argc++] = out;
        int quoted = 0;
        while (*s && (quoted || (*s != ' ' && *s != '\t'))) {
            if (*s == '\\' && s[1] == '"') { *out++ = '"'; s += 2; }
            else if (*s == '"') { quoted = !quoted; s++; }
            else *out++ = *s++;
        }
        if (*s) s++;
        *out = 0;
    }
    argv[argc] = NULL;
    return argc;
}

/* posix_spawnp-style PATH search for a bare program name. */
static void path_resolve(const char *file, char *out, int cap) {
    if (strchr(file, '/')) { snprintf(out, (size_t)cap, "%s", file); return; }
    const char *pathenv = getenv("PATH");
    if (!pathenv) pathenv = "/usr/local/bin:/bin";
    const char *p = pathenv;
    while (*p) {
        const char *colon = strchr(p, ':');
        int dlen = colon ? (int)(colon - p) : (int)strlen(p);
        snprintf(out, (size_t)cap, "%.*s/%s", dlen, p, file);
        if (access(out, 0) == 0) return;
        p = colon ? colon + 1 : p + strlen(p);
    }
    snprintf(out, (size_t)cap, "%s", file);       /* unfound: child exits 127 */
}

BOOL CreateProcessW(LPCWSTR app, LPWSTR cmdLine, void *psa, void *tsa,
                    BOOL inheritHandles, DWORD flags, LPVOID env,
                    LPCWSTR cwdW, STARTUPINFOW *si, PROCESS_INFORMATION *pi) {
    (void)psa; (void)tsa; (void)inheritHandles; (void)flags; (void)env;
    char line[1024];
    if (cmdLine) w2u8(cmdLine, line, sizeof line);
    else if (app) { if (!path_arg(app, line, sizeof line)) return FALSE; }
    else { g_lastError = ERROR_INVALID_PARAMETER; return FALSE; }

    char *argv[64];
    int argc = cmdline_split(line, argv, 64);
    if (argc == 0) { g_lastError = ERROR_INVALID_PARAMETER; return FALSE; }

    char prog[1024];
    if (app) { if (!path_arg(app, prog, sizeof prog)) return FALSE; }
    else {
        char conv[1024];                          /* argv[0] may be windowsy */
        WCHAR wtmp[512];
        u82w(argv[0], wtmp, 512);
        if (!path_arg(wtmp, conv, sizeof conv)) return FALSE;
        path_resolve(conv, prog, sizeof prog);
    }

    struct __fd_action acts[3];
    int na = 0;
    if (si && (si->dwFlags & STARTF_USESTDHANDLES)) {
        HANDLE hs[3] = { si->hStdInput, si->hStdOutput, si->hStdError };
        for (int i = 0; i < 3; i++) {
            K32Obj *o = (K32Obj *)hs[i];
            if (o && hs[i] != INVALID_HANDLE_VALUE && o->magic == K32_MAGIC &&
                o->kind == HK_FILE) {
                acts[na].op = 0;                  /* DUP2: arg -> fd */
                acts[na].fd = i;                  /* the child's std fd */
                acts[na].arg = o->fd;             /* our open fd */
                acts[na].path = NULL;
                acts[na].mode = 0;
                na++;
            }
        }
    }

    char cwd[1024];
    const char *cwdp = NULL;
    if (cwdW) { if (!path_arg(cwdW, cwd, sizeof cwd)) return FALSE; cwdp = cwd; }

    struct __spawn_spec spec = { prog, argv, NULL, cwdp, acts, na, 0, 0, -1 };
    int pid = __spawn(&spec);
    if (pid < 0) { set_err_errno(); return FALSE; }

    K32Obj *o = h_alloc(HK_PROC);
    if (!o) return FALSE;                         /* child runs; handle lost */
    o->pid = pid;
    if (pi) {
        pi->hProcess = (HANDLE)o;
        pi->hThread = NULL;
        pi->dwProcessId = (DWORD)pid;
        pi->dwThreadId = (DWORD)pid;
    }
    return TRUE;
}

void GetStartupInfoW(STARTUPINFOW *si) {
    memset(si, 0, sizeof *si);
    si->cb = sizeof *si;
}

static void proc_reap(K32Obj *o, int block) {
    if (o->exited) return;
    int st;
    int r = waitpid(o->pid, &st, block ? 0 : WNOHANG);
    if (r == o->pid) {
        o->exited = 1;
        o->exitCode = WIFEXITED(st) ? (DWORD)WEXITSTATUS(st)
                                    : (DWORD)(128 + WTERMSIG(st));
    }
}

DWORD WaitForSingleObject(HANDLE h, DWORD ms) {
    K32Obj *o = h_get(h, HK_PROC);
    if (!o) return WAIT_FAILED;
    if (o->exited) return WAIT_OBJECT_0;
    if (ms == INFINITE) {
        proc_reap(o, 1);
        return o->exited ? WAIT_OBJECT_0 : WAIT_FAILED;
    }
    DWORD start = GetTickCount();
    for (;;) {
        proc_reap(o, 0);
        if (o->exited) return WAIT_OBJECT_0;
        if (GetTickCount() - start >= ms) return WAIT_TIMEOUT;
        Sleep(5);
    }
}

BOOL GetExitCodeProcess(HANDLE h, LPDWORD code) {
    K32Obj *o = h_get(h, HK_PROC);
    if (!o) return FALSE;
    proc_reap(o, 0);
    if (code) *code = o->exited ? o->exitCode : STILL_ACTIVE;
    return TRUE;
}

BOOL TerminateProcess(HANDLE h, UINT code) {
    (void)code;
    K32Obj *o = h_get(h, HK_PROC);
    if (!o) return FALSE;
    if (o->exited) return TRUE;
    if (kill(o->pid, 9) != 0) { set_err_errno(); return FALSE; }
    return TRUE;
}

/* ================================================== module / cmdline */

static char g_argv0[512];
static WCHAR g_cmdlineW[1024];
static int g_procInfoInit;

/* Identity via the synthetic /proc (todos/0043): argv rides
 * /proc/<pid>/cmdline in Linux NUL-separated format. */
static void proc_info_init(void) {
    if (g_procInfoInit) return;
    g_procInfoInit = 1;
    strcpy(g_argv0, "/unknown.exe");
    u82w(g_argv0, g_cmdlineW, 1024);

    char path[64], buf[1024];
    snprintf(path, sizeof path, "/proc/%d/cmdline", getpid());
    int fd = open(path, O_RDONLY);
    if (fd < 0) return;
    long n = read(fd, buf, sizeof buf - 2);
    close(fd);
    if (n <= 0) return;
    buf[n] = 0;
    buf[n + 1] = 0;

    /* argv0 -> a full path, the way the exec actually resolved it: a BARE
     * name came through a PATH search (hush, the wm's spawn_path), so
     * GetModuleFileName must re-run that search — cwd-joining it invents
     * a file that never existed (0048 fix: notepad's New Window spawns
     * GetModuleFileName's answer). Relative WITH a slash is cwd-based. */
    if (buf[0] == '/') {
        snprintf(g_argv0, sizeof g_argv0, "%s", buf);
    } else if (!strchr(buf, '/')) {
        path_resolve(buf, g_argv0, sizeof g_argv0);
    } else {
        snprintf(g_argv0, sizeof g_argv0, "%s", buf);
    }
    if (g_argv0[0] != '/') {                     /* relative or unfound */
        char cwd[256];
        if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "/");
        snprintf(g_argv0, sizeof g_argv0, "%s%s%s",
                 cwd, strcmp(cwd, "/") == 0 ? "" : "/", buf);
    }

    /* The full line: argv0 quoted only when it has spaces, every LATER
     * arg ALWAYS quoted (0111: a bare absolute POSIX path reads as a
     * /-option to ports that parse Windows switches — notepad's
     * HandleCommandLine ate "/r" off "/root/…"; a "…"-first arg skips
     * their option loop and takes the standard quote-strip path).
     * Embedded quotes ride as \" — cmdline_split's escape. */
    char line[1024];
    int o = 0, argi = 0;
    for (long i = 0; i < n; argi++) {
        const char *arg = buf + i;
        int alen = (int)strlen(arg);
        int quote = argi > 0 || strchr(arg, ' ') != NULL;
        if (o && o < (int)sizeof line - 1) line[o++] = ' ';
        if (quote && o < (int)sizeof line - 1) line[o++] = '"';
        for (int k = 0; k < alen && o < (int)sizeof line - 2; k++) {
            if (arg[k] == '"') line[o++] = '\\';
            line[o++] = arg[k];
        }
        if (quote && o < (int)sizeof line - 1) line[o++] = '"';
        i += alen + 1;
    }
    line[o] = 0;
    u82w(line, g_cmdlineW, 1024);
}

HMODULE GetModuleHandleW(LPCWSTR name) {
    if (name) {
        /* single-module world: a NAMED lookup faked success and handed a
         * "loaded" handle for any DLL name (0211) — now honest: NULL +
         * ERROR_MOD_NOT_FOUND, with a loud note. */
        __win32_unsupported("GetModuleHandleW(name) — no DLLs; returning NULL");
        g_lastError = 126;                        /* ERROR_MOD_NOT_FOUND */
        return NULL;
    }
    return (HMODULE)0x400000;                     /* the classic exe base */
}

LPWSTR GetCommandLineW(void) {
    proc_info_init();
    return g_cmdlineW;
}

DWORD GetModuleFileNameW(HMODULE mod, LPWSTR buf, DWORD n) {
    (void)mod;
    proc_info_init();
    if (!buf || n == 0) return 0;
    WCHAR w[512];
    int len = u82w(g_argv0, w, 512);
    if ((DWORD)len >= n) {
        memcpy(buf, w, (n - 1) * sizeof(WCHAR));
        buf[n - 1] = 0;
        g_lastError = ERROR_INSUFFICIENT_BUFFER;
        return n - 1;
    }
    lstrcpyW(buf, w);
    return (DWORD)len;
}

/* ================================================= loadlib (stubbed) */

HMODULE LoadLibraryW(LPCWSTR name) {
    /* Static-link world: a clear failure; callers (calc's uxtheme/
     * htmlhelp binding) degrade gracefully on NULL. Loud since #318 —
     * GetModuleHandleW(name) already was, and an app that NEEDS its DLL
     * must read as missing a DLL, not mystery-degrade. calc's two boot
     * probes each cost one line, by design. */
    (void)name;
    WIN32_UNSUPPORTED("LoadLibraryW (no DLLs; returning NULL)");
    g_lastError = ERROR_CALL_NOT_IMPLEMENTED;
    return NULL;
}

FARPROC GetProcAddress(HMODULE mod, LPCSTR name) {
    (void)mod;
    /* name may be a MAKEINTRESOURCE ordinal — %s on it would fault; the
     * conservative low-64K test misreads a stack string as an ordinal at
     * worst (harmless), never the reverse (a crash). */
    if ((UINT_PTR)name < 0x10000)
        WIN32_UNSUPPORTED("GetProcAddress(#%u) (no DLLs; returning NULL)",
                          (unsigned)(UINT_PTR)name);
    else
        WIN32_UNSUPPORTED("GetProcAddress(\"%s\") (no DLLs; returning NULL)",
                          name);
    g_lastError = ERROR_PROC_NOT_FOUND;
    return NULL;
}

BOOL FreeLibrary(HMODULE mod) {
    if (!mod) { g_lastError = ERROR_INVALID_HANDLE; return FALSE; }
    return TRUE;
}

/* ============================================================ version */

BOOL GetVersionExW(OSVERSIONINFOW *vi) {
    if (!vi || vi->dwOSVersionInfoSize < sizeof(OSVERSIONINFOW)) {
        g_lastError = ERROR_INVALID_PARAMETER;
        return FALSE;
    }
    vi->dwMajorVersion = 5;                       /* report XP-class NT */
    vi->dwMinorVersion = 1;
    vi->dwBuildNumber = 2600;
    vi->dwPlatformId = VER_PLATFORM_WIN32_NT;
    vi->szCSDVersion[0] = 0;
    return TRUE;
}

/* ================================================================ NLS */

LANGID GetUserDefaultLangID(void) { return 0x0409; }      /* en-US */
LANGID GetUserDefaultUILanguage(void) { return 0x0409; }
LCID GetUserDefaultLCID(void) { return 0x0409; }

int GetLocaleInfoW(LCID lcid, LCTYPE type, LPWSTR buf, int n) {
    (void)lcid;
    const char *s;
    switch (type) {
    case LOCALE_SDECIMAL:  s = "."; break;
    case LOCALE_STHOUSAND: s = ","; break;
    default:               s = ""; break;
    }
    int need = (int)strlen(s) + 1;
    if (n == 0 || !buf) return need;
    if (n < need) { g_lastError = ERROR_INSUFFICIENT_BUFFER; return 0; }
    u82w(s, buf, n);
    return need;
}

static const char *const MONTHS_L[12] = {
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December" };
static const char *const DAYS_L[7] = {
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday" };

/* The en-US picture formatter shared by GetDateFormatW/GetTimeFormatW:
 * d/M/y/h/H/m/s/t runs plus 'quoted' literals (LOCALE_USER_DEFAULT only
 * — this OS has one locale). */
static int nls_format(const SYSTEMTIME *st, const char *pic, char *out, int cap) {
    int o = 0;
    #define EMIT(...) o += snprintf(out + o, (size_t)(o < cap ? cap - o : 0), __VA_ARGS__)
    for (const char *p = pic; *p;) {
        char c = *p;
        if (c == '\'') {
            p++;
            while (*p && *p != '\'') EMIT("%c", *p++);
            if (*p) p++;
            continue;
        }
        int run = 0;
        while (p[run] == c) run++;
        int hr12 = st->wHour % 12; if (hr12 == 0) hr12 = 12;
        switch (c) {
        case 'd':
            if (run >= 4) EMIT("%s", DAYS_L[st->wDayOfWeek % 7]);
            else if (run == 3) EMIT("%.3s", DAYS_L[st->wDayOfWeek % 7]);
            else EMIT(run == 2 ? "%02u" : "%u", st->wDay);
            break;
        case 'M':
            if (run >= 4) EMIT("%s", MONTHS_L[(st->wMonth - 1) % 12]);
            else if (run == 3) EMIT("%.3s", MONTHS_L[(st->wMonth - 1) % 12]);
            else EMIT(run == 2 ? "%02u" : "%u", st->wMonth);
            break;
        case 'y':
            if (run >= 3) EMIT("%u", st->wYear);
            else EMIT("%02u", st->wYear % 100);
            break;
        case 'h': EMIT(run >= 2 ? "%02d" : "%d", hr12); break;
        case 'H': EMIT(run >= 2 ? "%02u" : "%u", st->wHour); break;
        case 'm': EMIT(run >= 2 ? "%02u" : "%u", st->wMinute); break;
        case 's': EMIT(run >= 2 ? "%02u" : "%u", st->wSecond); break;
        case 't': EMIT(run >= 2 ? "%s" : "%.1s", st->wHour < 12 ? "AM" : "PM"); break;
        default:
            for (int k = 0; k < run; k++) EMIT("%c", c);
            break;
        }
        p += run;
    }
    #undef EMIT
    if (o < cap) out[o] = 0; else if (cap > 0) out[cap - 1] = 0;
    return o;
}

static int nls_out(const SYSTEMTIME *stArg, const char *pic, LPWSTR buf, int n) {
    SYSTEMTIME now;
    if (!stArg) { GetLocalTime(&now); stArg = &now; }
    char tmp[256];
    nls_format(stArg, pic, tmp, sizeof tmp);
    int need = (int)strlen(tmp) + 1;
    if (n == 0 || !buf) return need;
    if (n < need) { g_lastError = ERROR_INSUFFICIENT_BUFFER; return 0; }
    u82w(tmp, buf, n);
    return need;
}

int GetDateFormatW(LCID lcid, DWORD flags, const SYSTEMTIME *st,
                   LPCWSTR fmt, LPWSTR buf, int n) {
    (void)lcid;
    char pic[128];
    if (fmt) w2u8(fmt, pic, sizeof pic);
    else strcpy(pic, (flags & DATE_LONGDATE) ? "dddd, MMMM d, yyyy" : "M/d/yyyy");
    return nls_out(st, pic, buf, n);
}

int GetTimeFormatW(LCID lcid, DWORD flags, const SYSTEMTIME *st,
                   LPCWSTR fmt, LPWSTR buf, int n) {
    (void)lcid; (void)flags;
    char pic[128];
    if (fmt) w2u8(fmt, pic, sizeof pic);
    else strcpy(pic, "h:mm:ss tt");
    return nls_out(st, pic, buf, n);
}

BOOL IsTextUnicode(LPCVOID buf, int len, LPINT result) {
    const unsigned char *b = (const unsigned char *)buf;
    int found = 0;
    if (len >= 2) {
        if (b[0] == 0xFF && b[1] == 0xFE) found |= IS_TEXT_UNICODE_SIGNATURE;
        if (b[0] == 0xFE && b[1] == 0xFF) found |= IS_TEXT_UNICODE_REVERSE_SIGNATURE;
        /* statistics: UTF-16LE ASCII text has NUL high bytes at odd
         * offsets; require a strong majority over the sample */
        int sample = len > 256 ? 256 : (len & ~1);
        int zeroOdd = 0, zeroEven = 0;
        for (int i = 0; i + 1 < sample; i += 2) {
            if (b[i + 1] == 0) zeroOdd++;
            if (b[i] == 0) zeroEven++;
        }
        int pairs = sample / 2;
        if (pairs > 0 && zeroOdd > pairs / 2 && zeroEven < pairs / 4)
            found |= IS_TEXT_UNICODE_STATISTICS | IS_TEXT_UNICODE_ASCII16;
        if (pairs > 0 && zeroEven > pairs / 2 && zeroOdd < pairs / 4)
            found |= IS_TEXT_UNICODE_REVERSE_STATISTICS | IS_TEXT_UNICODE_REVERSE_ASCII16;
    }
    int mask = result ? *result : ~0;
    found &= mask;
    if (result) *result = found;
    return found != 0;
}

/* ====================================================== FormatMessage */

static const struct { DWORD code; const char *text; } SYS_MESSAGES[] = {
    { ERROR_SUCCESS,            "The operation completed successfully." },
    { ERROR_FILE_NOT_FOUND,     "The system cannot find the file specified." },
    { ERROR_PATH_NOT_FOUND,     "The system cannot find the path specified." },
    { ERROR_ACCESS_DENIED,      "Access is denied." },
    { ERROR_INVALID_HANDLE,     "The handle is invalid." },
    { ERROR_NOT_ENOUGH_MEMORY,  "Not enough memory resources are available." },
    { ERROR_WRITE_PROTECT,      "The media is write protected." },
    { ERROR_INVALID_PARAMETER,  "The parameter is incorrect." },
    { ERROR_DISK_FULL,          "There is not enough space on the disk." },
    { ERROR_CALL_NOT_IMPLEMENTED, "This function is not supported." },
    { ERROR_ALREADY_EXISTS,     "Cannot create a file when that file already exists." },
    { ERROR_DIR_NOT_EMPTY,      "The directory is not empty." },
};

DWORD FormatMessageW(DWORD flags, LPCVOID src, DWORD msgId, DWORD langId,
                     LPWSTR buf, DWORD n, va_list *args) {
    (void)src; (void)langId; (void)args;
    if (!(flags & FORMAT_MESSAGE_FROM_SYSTEM)) {
        g_lastError = ERROR_CALL_NOT_IMPLEMENTED;
        return 0;
    }
    char msg[256];
    const char *found = NULL;
    for (unsigned i = 0; i < sizeof SYS_MESSAGES / sizeof SYS_MESSAGES[0]; i++)
        if (SYS_MESSAGES[i].code == msgId) { found = SYS_MESSAGES[i].text; break; }
    if (found) snprintf(msg, sizeof msg, "%s", found);
    else snprintf(msg, sizeof msg, "Unknown error %u.", msgId);

    DWORD len = (DWORD)strlen(msg);
    if (flags & FORMAT_MESSAGE_ALLOCATE_BUFFER) {
        LPWSTR mem = (LPWSTR)LocalAlloc(LPTR, (len + 1) * sizeof(WCHAR));
        if (!mem) return 0;
        u82w(msg, mem, (int)len + 1);
        *(LPWSTR *)buf = mem;
        return len;
    }
    if (n == 0 || !buf) { g_lastError = ERROR_INSUFFICIENT_BUFFER; return 0; }
    if (len >= n) len = n - 1;
    char cut[256];
    snprintf(cut, sizeof cut, "%.*s", (int)len, msg);
    u82w(cut, buf, (int)n);
    return len;
}

/* ============================================== profile (win.ini shim) */

/* Windows maps win.ini onto the registry; so do we — the hive key is
 * HKCU\Software\Win32Ini\<app>, the value is <key> as REG_SZ (UTF-16). */

static void profile_key(LPCWSTR app, WCHAR *out) {
    static const WCHAR PFX[] = u"Software\\Win32Ini\\";
    lstrcpyW(out, PFX);
    lstrcatW(out, app);
}

UINT GetProfileIntW(LPCWSTR app, LPCWSTR key, INT deflt) {
    WCHAR kp[256];
    profile_key(app, kp);
    HKEY h;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kp, 0, KEY_READ, &h) != ERROR_SUCCESS)
        return (UINT)deflt;
    WCHAR val[64];
    DWORD type = 0, cb = sizeof val - sizeof(WCHAR);
    LONG r = RegQueryValueExW(h, key, NULL, &type, (LPBYTE)val, &cb);
    RegCloseKey(h);
    if (r != ERROR_SUCCESS || type != REG_SZ) return (UINT)deflt;
    val[cb / sizeof(WCHAR)] = 0;
    int neg = 0, i = 0;
    long acc = 0;
    if (val[0] == '-') { neg = 1; i = 1; }
    if (!(val[i] >= '0' && val[i] <= '9')) return (UINT)deflt;
    for (; val[i] >= '0' && val[i] <= '9'; i++) acc = acc * 10 + (val[i] - '0');
    return (UINT)(neg ? -acc : acc);
}

BOOL WriteProfileStringW(LPCWSTR app, LPCWSTR key, LPCWSTR value) {
    WCHAR kp[256];
    profile_key(app, kp);
    HKEY h;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kp, 0, NULL, 0, KEY_WRITE, NULL,
                        &h, NULL) != ERROR_SUCCESS)
        return FALSE;
    LONG r;
    if (!value) r = RegDeleteValueW(h, key);
    else r = RegSetValueExW(h, key, 0, REG_SZ, (const BYTE *)value,
                            (DWORD)(lstrlenW(value) + 1) * sizeof(WCHAR));
    RegCloseKey(h);
    return r == ERROR_SUCCESS;
}
