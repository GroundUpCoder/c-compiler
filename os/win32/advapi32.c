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
 */

#undef UNICODE
#undef _UNICODE
#include <windows.h>
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
    struct RegVal *next;
} RegVal;

typedef struct RegKey {
    char *key;
    struct RegKey *next;
} RegKey;

static RegVal *g_vals;
static RegKey *g_keys;
static int g_loaded;

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

static void key_add(const char *path) {
    for (RegKey *k = g_keys; k; k = k->next)
        if (strcasecmp(k->key, path) == 0) return;
    RegKey *k = (RegKey *)malloc(sizeof *k);
    k->key = strdup(path);
    k->next = g_keys;
    g_keys = k;
}

static void hive_load(void) {
    if (g_loaded) return;
    g_loaded = 1;
    char hp[512];
    hive_path(hp, sizeof hp);
    FILE *f = fopen(hp, "r");
    if (!f) return;
    char line[2048];
    while (fgets(line, sizeof line, f)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        if (line[0] == 'k' && line[1] == ' ') {
            key_add(line + 2);
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
            int bad = 0;
            for (DWORD i = 0; i < len; i++) {
                int hi = hex_nib(hex[i * 2]), lo = hex_nib(hex[i * 2 + 1]);
                if (hi < 0 || lo < 0) { bad = 1; break; }
                data[i] = (BYTE)((hi << 4) | lo);
            }
            if (bad) { free(data); continue; }
            RegVal *v = (RegVal *)malloc(sizeof *v);
            v->key = strdup(key);
            v->name = strdup(name);
            v->type = (DWORD)strtoul(typs, NULL, 10);
            v->data = data;
            v->len = len;
            v->next = g_vals;
            g_vals = v;
            key_add(key);
        }
    }
    fclose(f);
}

static void hive_save(void) {
    char hp[512], tmp[520];
    hive_path(hp, sizeof hp);
    snprintf(tmp, sizeof tmp, "%s.tmp", hp);
    FILE *f = fopen(tmp, "w");
    if (!f) return;
    for (RegKey *k = g_keys; k; k = k->next)
        fprintf(f, "k %s\n", k->key);
    for (RegVal *v = g_vals; v; v = v->next) {
        fprintf(f, "v %s|%s|%u|", v->key, v->name, v->type);
        for (DWORD i = 0; i < v->len; i++) fprintf(f, "%02x", v->data[i]);
        fprintf(f, "\n");
    }
    fclose(f);
    rename(tmp, hp);
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
    for (RegVal *v = g_vals; v; v = v->next)
        if (strcasecmp(v->key, key) == 0 && strcasecmp(v->name, name) == 0)
            return v;
    return NULL;
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
        key_add(path);
        hive_save();
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
    RegVal *v = val_find(path, nm);
    if (!v) {
        v = (RegVal *)malloc(sizeof *v);
        if (!v) return ERROR_NOT_ENOUGH_MEMORY;
        v->key = strdup(path);
        v->name = strdup(nm);
        v->data = NULL;
        v->next = g_vals;
        g_vals = v;
        key_add(path);
    }
    BYTE *nd = (BYTE *)malloc(count ? count : 1);
    if (!nd) return ERROR_NOT_ENOUGH_MEMORY;
    if (count) memcpy(nd, data, count);
    free(v->data);
    v->data = nd;
    v->len = count;
    v->type = type;
    hive_save();
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
            free(v->key);
            free(v->name);
            free(v->data);
            free(v);
            hive_save();
            return ERROR_SUCCESS;
        }
    }
    return ERROR_FILE_NOT_FOUND;
}

LONG RegCloseKey(HKEY key) {
    if (root_name(key)) return ERROR_SUCCESS;    /* roots are never freed */
    RegHandle *h = (RegHandle *)key;
    if (!h || h->magic != REG_HMAGIC) return ERROR_INVALID_HANDLE;
    h->magic = 0;
    free(h);
    return ERROR_SUCCESS;
}
