/* advapi32.c — the registry as a small file-backed hive (todos/0059,
 * WIN32.md friction #3).
 *
 * One text hive per user at $HOME/.win32reg (HOME=/root in-OS), loaded
 * lazily and written through on every mutation (tmp + rename, so a
 * SIGKILL mid-save never truncates the hive). Format, one record per
 * line:
 *
 *   k <keypath>                       a key with no values yet
 *   v <keypath>|<name>|<type>|<hex>   a value (data hex-encoded, so
 *                                     REG_SZ's UTF-16 bytes round-trip)
 *
 * Key paths are stored as <ROOT>\sub\key with the root abbreviated
 * (HKCU/HKLM/HKCR/HKU); lookup is case-insensitive like Windows. HKEYs
 * are heap objects holding the canonical path; the four predefined
 * roots are recognized by value. Keys are a flat namespace (no
 * enumeration order, no security) — exactly enough for settings-reading
 * apps (winmine's board prefs, notepad's font, calc's layout via the
 * kernel32 profile shim). RegDeleteKey/RegEnumKey grow on PORTS.md
 * demand.
 *
 * ---------------------------------------------------------------------
 * CROSS-PROCESS SHARING — reload-merge at flush (todos/0288)
 *
 * The hive is ONE file shared by every win32 process on the system, and
 * several are live at once (winmine, notepad, calc are all seeded and
 * all write it). A flush therefore must NOT rewrite the file from the
 * snapshot this process loaded at startup — that is whole-file
 * last-writer-wins, and it silently reverts everything a peer wrote
 * while we ran (open winmine and notepad, close them in either order
 * and the second exiter used to eat the first's settings).
 *
 * So `hive_flush` RE-READS the hive and overlays only what THIS process
 * actually mutated:
 *
 *   - every value we set since load carries `dirty` and is written over
 *     its on-disk twin;
 *   - every value we deleted since load leaves a tombstone (`g_dels`)
 *     and is removed from the reloaded set;
 *   - keys are append-only here (no RegDeleteKey), so the key sets are
 *     unioned;
 *   - EVERY other record on disk survives byte-for-byte — including
 *     records for values this process merely read.
 *
 * CONFLICT RULE (decided in 0288, recorded here on purpose): when two
 * processes both dirty the SAME (key, name), the resolution is
 * **last-writer-wins per VALUE, decided at flush time** — the later
 * flush overwrites that one value and nothing else. That matches
 * Windows for an unsynchronised write pair (there is no merge to do on
 * one scalar) while making the old failure — a process reverting a
 * value it never touched — impossible. A delete is a write for this
 * purpose: our tombstone removes the value even if a peer re-created it
 * after our delete, because our delete is the later decision we hold.
 *
 * After a successful save the merged set BECOMES this process's
 * in-memory hive (dirty flags cleared, tombstones dropped), so the
 * process also picks up peer writes instead of drifting further from
 * the file with every flush. Reads are still served from that working
 * copy rather than re-reading the file per call, so a peer's brand-new
 * value becomes visible at our next flush, not instantly — settings
 * apps read at startup and write at exit, and a stat+parse per
 * RegQueryValueEx would buy nothing.
 *
 * Still deliberately not solved here (unchanged by 0288): writes since
 * the last flush are lost on SIGKILL — flushing is batched to
 * RegCloseKey/atexit so notepad's 27-value exit burst is one
 * tmp+rename, and there is no advisory lock, so two flushes landing in
 * the same instant still race on the rename (last rename wins, whole
 * file — the window is one re-read + one write, not a whole process
 * lifetime). A genuinely transactional store is `todos/0162`.
 */

#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

/* ------------------------------------------------------------ storage */

typedef struct RegVal {
    char *key;                /* canonical "HKCU\Software\..." */
    char *name;               /* value name, utf8 ("" = default value) */
    DWORD type;
    BYTE *data;
    DWORD len;
    int dirty;                /* THIS process set it since load/last flush */
    struct RegVal *next;
} RegVal;

typedef struct RegKey {
    char *key;
    struct RegKey *next;
} RegKey;

/* A value THIS process deleted since load/last flush. Kept separately so
 * the reload-merge can remove it from the peer's copy on disk — without
 * a tombstone a delete would simply be un-done by the re-read. */
typedef struct RegDel {
    char *key;
    char *name;
    struct RegDel *next;
} RegDel;

static RegVal *g_vals;
static RegKey *g_keys;
static RegDel *g_dels;
static int g_loaded;
static int g_dirty;              /* mutations pending flush to the hive file */
static void hive_flush(void);    /* fwd: batched write-back (see RegCloseKey) */

static void hive_path(char *out, int cap) {
    const char *home = getenv("HOME");
    if (!home || !home[0]) home = "/root";
    snprintf(out, (size_t)cap, "%s/.win32reg", home);
}

static int hex_nib(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Record a key path in `head` (idempotent). Returns 0, or -1 on OOM — the
 * caller decides whether that's ERROR_NOT_ENOUGH_MEMORY or best-effort. */
static int key_add_to(RegKey **head, const char *path) {
    for (RegKey *k = *head; k; k = k->next)
        if (strcasecmp(k->key, path) == 0) return 0;
    RegKey *k = (RegKey *)malloc(sizeof *k);
    if (!k) return -1;
    k->key = strdup(path);
    if (!k->key) { free(k); return -1; }
    k->next = *head;
    *head = k;
    return 0;
}

static int key_add(const char *path) { return key_add_to(&g_keys, path); }

static void val_free_one(RegVal *v) {
    free(v->key);
    free(v->name);
    free(v->data);
    free(v);
}

static void vals_free(RegVal *v) {
    while (v) { RegVal *n = v->next; val_free_one(v); v = n; }
}

static void keys_free(RegKey *k) {
    while (k) { RegKey *n = k->next; free(k->key); free(k); k = n; }
}

static void dels_free(RegDel *d) {
    while (d) { RegDel *n = d->next; free(d->key); free(d->name); free(d); d = n; }
}

static RegVal *val_find_in(RegVal *head, const char *key, const char *name) {
    for (RegVal *v = head; v; v = v->next)
        if (strcasecmp(v->key, key) == 0 && strcasecmp(v->name, name) == 0)
            return v;
    return NULL;
}

/* Upsert (key,name) into `head` with a private copy of the data. The result
 * is CLEAN (dirty = 0) — callers that mean "and it is MINE" say so. Returns
 * the live record, or NULL on OOM (never a half-built one: the list is only
 * touched once every allocation succeeded). */
static RegVal *val_set_in(RegVal **head, const char *key, const char *name,
                          DWORD type, const BYTE *data, DWORD len) {
    BYTE *nd = (BYTE *)malloc(len ? len : 1);
    if (!nd) return NULL;
    if (len) memcpy(nd, data, len);
    RegVal *v = val_find_in(*head, key, name);
    if (!v) {
        v = (RegVal *)malloc(sizeof *v);
        if (!v) { free(nd); return NULL; }
        v->key = strdup(key);
        v->name = strdup(name);
        if (!v->key || !v->name) {
            free(v->key); free(v->name); free(v); free(nd);
            return NULL;
        }
        v->data = NULL;
        v->next = *head;
        *head = v;
    }
    free(v->data);
    v->data = nd;
    v->len = len;
    v->type = type;
    v->dirty = 0;
    return v;
}

/* Drop (key,name) from `head` if present. */
static void val_del_in(RegVal **head, const char *key, const char *name) {
    for (RegVal **pp = head; *pp; ) {
        RegVal *v = *pp;
        if (strcasecmp(v->key, key) == 0 && strcasecmp(v->name, name) == 0) {
            *pp = v->next;
            val_free_one(v);
            return;
        }
        pp = &v->next;
    }
}

/* Parse the hive file into the given lists (appending). Returns 0 when the
 * file was read — or genuinely absent, which is an empty hive — and -1 when
 * it exists but could not be opened (a caller about to overwrite it must
 * NOT treat that as "empty", or it clobbers a hive it failed to read). */
static int hive_read(RegVal **vals, RegKey **keys) {
    char hp[512];
    hive_path(hp, sizeof hp);
    FILE *f = fopen(hp, "r");
    if (!f) return errno == ENOENT ? 0 : -1;
    int rc = 0;
    char line[2048];
    while (fgets(line, sizeof line, f)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        if (line[0] == 'k' && line[1] == ' ') {
            if (key_add_to(keys, line + 2) != 0) { rc = -1; break; }
        } else if (line[0] == 'v' && line[1] == ' ') {
            char *key = line + 2;
            char *p1 = strchr(key, '|');
            if (!p1) continue;
            char *name = p1 + 1;
            char *p2 = strchr(name, '|');
            if (!p2) continue;
            char *typs = p2 + 1;
            char *p3 = strchr(typs, '|');
            if (!p3) continue;
            *p1 = *p2 = *p3 = 0;
            char *hex = p3 + 1;
            DWORD len = (DWORD)(strlen(hex) / 2);
            BYTE *data = (BYTE *)malloc(len ? len : 1);
            if (!data) { rc = -1; break; }        /* OOM: the read is partial */
            int bad = 0;
            for (DWORD i = 0; i < len; i++) {
                int hi = hex_nib(hex[i * 2]), lo = hex_nib(hex[i * 2 + 1]);
                if (hi < 0 || lo < 0) { bad = 1; break; }
                data[i] = (BYTE)((hi << 4) | lo);
            }
            if (bad) { free(data); continue; }
            DWORD type = (DWORD)strtoul(typs, NULL, 10);
            int oom = val_set_in(vals, key, name, type, data, len) == NULL ||
                      key_add_to(keys, key) != 0;
            free(data);
            if (oom) { rc = -1; break; }
        }
    }
    fclose(f);
    return rc;
}

/* Load this process's working copy, once. Errors are best-effort here: a
 * partial or unreadable hive just means we start from what we could read —
 * hive_flush is where an incomplete read MUST abort (it would overwrite). */
static void hive_load(void) {
    if (g_loaded) return;
    g_loaded = 1;
    atexit(hive_flush);          /* backstop: persist deferred writes on clean exit */
    hive_read(&g_vals, &g_keys);
}

/* Write the whole hive out (tmp + rename). Returns 0 only when every
 * byte reached the store AND the rename landed — a short write on a full
 * disk or an EROFS home must not report success (todos/0234). */
static int hive_save(RegVal *vals, RegKey *keys) {
    char hp[512], tmp[520];
    hive_path(hp, sizeof hp);
    snprintf(tmp, sizeof tmp, "%s.tmp", hp);
    FILE *f = fopen(tmp, "w");
    if (!f) return -1;
    for (RegKey *k = keys; k; k = k->next)
        fprintf(f, "k %s\n", k->key);
    for (RegVal *v = vals; v; v = v->next) {
        fprintf(f, "v %s|%s|%u|", v->key, v->name, v->type);
        for (DWORD i = 0; i < v->len; i++) fprintf(f, "%02x", v->data[i]);
        fprintf(f, "\n");
    }
    int bad = ferror(f);
    if (fclose(f) != 0) bad = 1;
    if (bad || rename(tmp, hp) != 0) {
        int e = errno;
        remove(tmp);                 /* sweep the partial; keep the old hive */
        errno = e;
        return -1;
    }
    return 0;
}

/* Report a failed flush once, not per RegCloseKey — losing the user's
 * settings silently is the bug this guards against (todos/0234). */
static void flush_warn(const char *why) {
    static int warned;
    if (warned) return;
    warned = 1;
    char hp[512];
    hive_path(hp, sizeof hp);
    fprintf(stderr, "advapi32: cannot save registry hive %s: %s\n", hp, why);
}

/* Write the hive to disk only if something changed since the last flush.
 * Called from RegCloseKey and via atexit — collapses a burst of RegSetValueEx
 * (e.g. notepad writing 27 settings on exit) into ONE tmp+rename instead of a
 * full-hive rewrite per value. Windows persists lazily too; the in-memory
 * value RegSetValueEx set is already visible to this process regardless. The
 * rename keeps the save atomic, so the on-disk hive is never torn.
 *
 * The write is a RELOAD-MERGE, never a snapshot rewrite: see the
 * cross-process section of the file header for the rule and why. On ANY
 * failure g_dirty and the dirty/tombstone marks are kept, so the next flush
 * (RegCloseKey or atexit) retries the whole merge from current disk state. */
static void hive_flush(void) {
    if (!g_dirty) return;

    /* 1. the hive as it stands NOW — peers may have written since we loaded */
    RegVal *mvals = NULL;
    RegKey *mkeys = NULL;
    if (hive_read(&mvals, &mkeys) != 0) {
        vals_free(mvals); keys_free(mkeys);
        flush_warn("the hive could not be re-read for merging");
        return;
    }

    /* 2. our deletes, then our writes, over it — and nothing else */
    for (RegDel *d = g_dels; d; d = d->next)
        val_del_in(&mvals, d->key, d->name);
    int oom = 0;
    for (RegVal *v = g_vals; v && !oom; v = v->next)
        if (v->dirty)
            oom = val_set_in(&mvals, v->key, v->name, v->type, v->data,
                             v->len) == NULL;
    /* keys are append-only in this hive (no RegDeleteKey), so union them */
    for (RegKey *k = g_keys; k && !oom; k = k->next)
        oom = key_add_to(&mkeys, k->key) != 0;
    if (oom) {
        vals_free(mvals); keys_free(mkeys);
        flush_warn("out of memory merging the hive");
        return;
    }

    if (hive_save(mvals, mkeys) != 0) {
        int e = errno;
        vals_free(mvals); keys_free(mkeys);
        flush_warn(strerror(e));
        return;
    }

    /* 3. adopt the merged set: in-memory == on-disk, so this process now
     *    also sees what its peers wrote instead of drifting further away */
    vals_free(g_vals);
    keys_free(g_keys);
    dels_free(g_dels);
    g_vals = mvals;
    g_keys = mkeys;
    g_dels = NULL;
    g_dirty = 0;
}

/* ------------------------------------------------------------- handles */

#define REG_HMAGIC 0x52454748u

typedef struct {
    unsigned magic;
    char path[512];
} RegHandle;

static const char *root_name(HKEY key) {
    switch ((UINT_PTR)key) {
    case 0x80000000u: return "HKCR";
    case 0x80000001u: return "HKCU";
    case 0x80000002u: return "HKLM";
    case 0x80000003u: return "HKU";
    }
    return NULL;
}

/* Canonical path of parent+sub into out; 0 on bad handle. */
static int key_path(HKEY parent, LPCWSTR sub, char *out, int cap) {
    char sb[400] = "";
    if (sub) {
        /* value/key names are stored utf8; backslashes stay backslashes */
        int o = 0;
        for (int i = 0; sub[i] && o < (int)sizeof sb - 4; i++) {
            WCHAR c = sub[i];
            if (c < 0x80) sb[o++] = (char)c;
            else o += snprintf(sb + o, sizeof sb - (size_t)o, "u%04x", c);
        }
        sb[o] = 0;
    }
    const char *root = root_name(parent);
    if (root) {
        if (sb[0]) snprintf(out, (size_t)cap, "%s\\%s", root, sb);
        else snprintf(out, (size_t)cap, "%s", root);
        return 1;
    }
    RegHandle *h = (RegHandle *)parent;
    if (!h || h->magic != REG_HMAGIC) return 0;
    if (sb[0]) snprintf(out, (size_t)cap, "%s\\%s", h->path, sb);
    else snprintf(out, (size_t)cap, "%s", h->path);
    return 1;
}

static int key_exists(const char *path) {
    size_t n = strlen(path);
    for (RegKey *k = g_keys; k; k = k->next) {
        if (strcasecmp(k->key, path) == 0) return 1;
        if (strncasecmp(k->key, path, n) == 0 && k->key[n] == '\\') return 1;
    }
    return 0;
}

static HKEY handle_new(const char *path) {
    RegHandle *h = (RegHandle *)malloc(sizeof *h);
    if (!h) return NULL;
    h->magic = REG_HMAGIC;
    snprintf(h->path, sizeof h->path, "%s", path);
    return (HKEY)h;
}

static void name_u8(LPCWSTR name, char *out, int cap) {
    int o = 0;
    if (name)
        for (int i = 0; name[i] && o < cap - 4; i++) {
            WCHAR c = name[i];
            if (c < 0x80) out[o++] = (char)c;
            else o += snprintf(out + o, (size_t)(cap - o), "u%04x", c);
        }
    out[o] = 0;
}

static RegVal *val_find(const char *key, const char *name) {
    return val_find_in(g_vals, key, name);
}

/* Remember that THIS process deleted (key,name) so the reload-merge removes
 * it from the peer copy on disk. Best-effort: on OOM the delete is still
 * correct in memory, it just may not outlive a peer's concurrent rewrite. */
static void del_mark(const char *key, const char *name) {
    for (RegDel *d = g_dels; d; d = d->next)
        if (strcasecmp(d->key, key) == 0 && strcasecmp(d->name, name) == 0) return;
    RegDel *d = (RegDel *)malloc(sizeof *d);
    if (!d) return;
    d->key = strdup(key);
    d->name = strdup(name);
    if (!d->key || !d->name) { free(d->key); free(d->name); free(d); return; }
    d->next = g_dels;
    g_dels = d;
}

/* A re-set value is no longer deleted — drop its tombstone, or the merge
 * would delete the value we just wrote. */
static void del_unmark(const char *key, const char *name) {
    for (RegDel **pp = &g_dels; *pp; ) {
        RegDel *d = *pp;
        if (strcasecmp(d->key, key) == 0 && strcasecmp(d->name, name) == 0) {
            *pp = d->next;
            free(d->key); free(d->name); free(d);
            return;
        }
        pp = &d->next;
    }
}

/* ---------------------------------------------------------------- API */

LONG RegOpenKeyExW(HKEY key, LPCWSTR sub, DWORD options, REGSAM sam, PHKEY out) {
    (void)options; (void)sam;
    hive_load();
    if (!out) return ERROR_INVALID_PARAMETER;
    *out = NULL;
    char path[512];
    if (!key_path(key, sub, path, sizeof path)) return ERROR_INVALID_HANDLE;
    /* opening a real subkey requires existence; re-opening a root or a
     * live handle with an empty sub always succeeds */
    if (sub && sub[0] && !key_exists(path)) return ERROR_FILE_NOT_FOUND;
    HKEY h = handle_new(path);
    if (!h) return ERROR_NOT_ENOUGH_MEMORY;
    *out = h;
    return ERROR_SUCCESS;
}

LONG RegOpenKeyW(HKEY key, LPCWSTR sub, PHKEY out) {
    return RegOpenKeyExW(key, sub, 0, KEY_READ, out);
}

LONG RegCreateKeyExW(HKEY key, LPCWSTR sub, DWORD reserved, LPWSTR cls,
                     DWORD options, REGSAM sam, void *sa, PHKEY out,
                     LPDWORD disposition) {
    (void)reserved; (void)cls; (void)options; (void)sam; (void)sa;
    hive_load();
    if (!out) return ERROR_INVALID_PARAMETER;
    *out = NULL;
    char path[512];
    if (!key_path(key, sub, path, sizeof path)) return ERROR_INVALID_HANDLE;
    int existed = key_exists(path);
    if (!existed) {
        if (key_add(path) != 0) return ERROR_NOT_ENOUGH_MEMORY;
        g_dirty = 1;
    }
    if (disposition)
        *disposition = existed ? REG_OPENED_EXISTING_KEY : REG_CREATED_NEW_KEY;
    HKEY h = handle_new(path);
    if (!h) return ERROR_NOT_ENOUGH_MEMORY;
    *out = h;
    return ERROR_SUCCESS;
}

LONG RegQueryValueExW(HKEY key, LPCWSTR name, LPDWORD reserved, LPDWORD type,
                      LPBYTE data, LPDWORD count) {
    (void)reserved;
    hive_load();
    char path[512], nm[256];
    if (!key_path(key, NULL, path, sizeof path)) return ERROR_INVALID_HANDLE;
    name_u8(name, nm, sizeof nm);
    RegVal *v = val_find(path, nm);
    if (!v) return ERROR_FILE_NOT_FOUND;
    if (type) *type = v->type;
    if (!data) {
        if (count) *count = v->len;
        return ERROR_SUCCESS;
    }
    if (!count) return ERROR_INVALID_PARAMETER;
    if (*count < v->len) { *count = v->len; return ERROR_MORE_DATA; }
    memcpy(data, v->data, v->len);
    *count = v->len;
    return ERROR_SUCCESS;
}

LONG RegSetValueExW(HKEY key, LPCWSTR name, DWORD reserved, DWORD type,
                    const BYTE *data, DWORD count) {
    (void)reserved;
    hive_load();
    char path[512], nm[256];
    if (!key_path(key, NULL, path, sizeof path)) return ERROR_INVALID_HANDLE;
    if (!data && count) return ERROR_INVALID_PARAMETER;
    name_u8(name, nm, sizeof nm);
    RegVal *v = val_set_in(&g_vals, path, nm, type, data, count);
    if (!v) return ERROR_NOT_ENOUGH_MEMORY;
    v->dirty = 1;                   /* ours: the reload-merge writes it back */
    key_add(path);                  /* best-effort: the value itself is live */
    del_unmark(path, nm);
    g_dirty = 1;
    return ERROR_SUCCESS;
}

LONG RegDeleteValueW(HKEY key, LPCWSTR name) {
    hive_load();
    char path[512], nm[256];
    if (!key_path(key, NULL, path, sizeof path)) return ERROR_INVALID_HANDLE;
    name_u8(name, nm, sizeof nm);
    for (RegVal **pp = &g_vals; *pp; pp = &(*pp)->next) {
        RegVal *v = *pp;
        if (strcasecmp(v->key, path) == 0 && strcasecmp(v->name, nm) == 0) {
            *pp = v->next;
            val_free_one(v);
            del_mark(path, nm);     /* ours: the reload-merge removes it */
            g_dirty = 1;
            return ERROR_SUCCESS;
        }
    }
    return ERROR_FILE_NOT_FOUND;
}

LONG RegCloseKey(HKEY key) {
    hive_flush();                                /* persist any deferred writes */
    if (root_name(key)) return ERROR_SUCCESS;    /* roots are never freed */
    RegHandle *h = (RegHandle *)key;
    if (!h || h->magic != REG_HMAGIC) return ERROR_INVALID_HANDLE;
    h->magic = 0;
    free(h);
    return ERROR_SUCCESS;
}
