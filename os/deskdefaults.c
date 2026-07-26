/* deskdefaults.c — /usr/bin/desktop-defaults (win32 source-lib design §6.2,
 * Lane D): the additive "restore my default Desktop icons" reconcile.
 *
 * Phase 1 walks the baked default rendering /usr/share/desktop/default
 * (foldDesktopDefaults in os-common.js — the image manifest's Desktop set,
 * version-locked into the sealed blob) against the live /root/Desktop:
 *   - target absent            -> plant it (fo_copy semantics: symlinks copy
 *                                 AS links, dirs mkdir+recurse, files
 *                                 byte-copy preserving mode) — one `added`
 *                                 per planted node, wholesale
 *   - both sides directories   -> recurse (the additive folder merge: a new
 *                                 default deck lands INSIDE the user's
 *                                 existing Presentations/ without touching
 *                                 their files)
 *   - any other same-name clash -> skip, counted `kept`
 * NEVER overwrites, NEVER deletes, never touches .icons (new names
 * auto-flow via wm.c desk_place; the 1s desk poll picks them up).
 *
 * Phase 1 is a thin walk over fileops.h's fo_merge — the ONE additive merge
 * engine, shared with gucman's `seed` content plant so the two can't drift.
 *
 * Phases 2 and 3 also re-plant declared `seed` CONTENT (the gucman content
 * resource design §3.4): a package's user-owned copies come back when
 * missing, edited ones are kept, and every reconcile plant is recorded into
 * the DB record (with its sha256) so `gucman remove` still unplants it.
 * Phase 3 does the same for BAKED packages off /usr/opt/<name>/control.json,
 * recording nothing — a built-in has no record and is not removable.
 *
 * Phase 2 re-plants installed packages' icons: for every gucman DB record
 * /var/lib/gucman/<name>.json, /opt/<name>/control.json declaring
 * `desktop: {cmd}` (explicit eligibility, design §5) gets
 * /root/Desktop/<name> -> /usr/local/bin/<cmd> when absent. This explicit
 * user action deliberately IGNORES the global desktop_shortcuts
 * install-time flag — the user just asked for icons. A planted link is
 * recorded into the DB record's `desktop` array (atomic rewrite) so
 * `gucman remove`'s reverse replay unplants it like an install-time one;
 * a failed record is a loud warning, never a failed plant.
 *
 * Output: "desktop-defaults: added N, kept M existing" (the e2e assertion
 * surface). Exit 0 even when N=0 (nothing to do is success); exit 1 only
 * when an actual operation FAILED (copy/plant error, defaults dir
 * missing) — every failure is named on stderr first.
 */
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "fileops.h"
#include "sha256.h"
#include "cJSON.h"

#define DD_DEFAULTS "/usr/share/desktop/default"
#define DD_DESKTOP  "/root/Desktop"
#define DD_HOME     "/root"                  /* seed dests root here (§2.1) */
#define DD_DB_DIR   "/var/lib/gucman"
#define DD_BIN_DIR  "/usr/local/bin"
#define DD_OPT_DIR  "/opt"                   /* installed package payloads */
#define DD_USR_OPT  "/usr/opt"               /* baked (folded) package payloads */
#define DD_OS_RELEASE "/usr/share/os-release"

static int dd_added = 0, dd_kept = 0, dd_errors = 0;

static void dd_warn(const char *what, const char *path) {
    fprintf(stderr, "desktop-defaults: %s %s: %s\n", what, path,
            strerror(errno));
    dd_errors++;
}

/* ---- phase 1: the additive default merge ---- */

/* The counting callback over fileops.h's fo_merge (the ONE additive merge
 * engine, `seed` design §3.1): one `added` per wholesale-planted NODE, one
 * `kept` per same-name clash (dir+dir pairs included — they are the merge
 * recursion points). The per-node FILE/DIR/LINK events phase 1 does not
 * count; the seed phases below record them. */
static void dd_count_ev(int ev, const char *path, void *ud) {
    (void)ud;
    if (ev == FO_MERGE_NODE) dd_added++;
    else if (ev == FO_MERGE_KEPT) dd_kept++;
    else if (ev == FO_MERGE_ERR) dd_warn("merging", path);
}

static void dd_merge(const char *dflt, const char *target) {
    DIR *d = opendir(dflt);
    if (!d) { dd_warn("opening", dflt); return; }
    struct dirent *de;
    while ((de = readdir(d))) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, ".."))
            continue;
        char s[FO_PATH_MAX], t[FO_PATH_MAX];
        if (snprintf(s, sizeof s, "%s/%s", dflt, de->d_name) >= (int)sizeof s ||
            snprintf(t, sizeof t, "%s/%s", target, de->d_name) >= (int)sizeof t) {
            errno = ENAMETOOLONG;
            dd_warn("naming", de->d_name);
            continue;
        }
        fo_merge(s, t, dd_count_ev, NULL);
    }
    closedir(d);
}

/* ---- phase 2: installed desktop-eligible packages ---- */

static char *dd_slurp(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0 || n > 1 << 20) { fclose(f); return NULL; }
    char *buf = malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = 0;
    return buf;
}

/* Read the gucman DB record, or NULL with a loud line (a plant we cannot
 * record is a plant `gucman remove` will not unplant — the user must hear
 * about it). */
static cJSON *dd_db_load(const char *dbp) {
    char *text = dd_slurp(dbp);
    cJSON *db = text ? cJSON_Parse(text) : NULL;
    free(text);
    if (!db)
        fprintf(stderr, "desktop-defaults: %s unreadable — planted but not "
                "recorded (gucman remove will not unplant it)\n", dbp);
    return db;
}

/* Publish a modified DB record: tmp + rename (the gucman
 * gm_write_file_atomic rule). Consumes nothing; the caller deletes `db`. */
static void dd_db_save(const char *dbp, cJSON *db, const char *what) {
    char *out = cJSON_Print(db);
    if (!out) return;
    char tmp[FO_PATH_MAX];
    int rc = -1;
    if (snprintf(tmp, sizeof tmp, "%s.tmp", dbp) < (int)sizeof tmp) {
        FILE *f = fopen(tmp, "w");
        if (f) {
            size_t len = strlen(out);
            int wok = fwrite(out, 1, len, f) == len;
            if ((fclose(f) == 0) && wok && rename(tmp, dbp) == 0) rc = 0;
        }
    } else {
        errno = ENAMETOOLONG;
    }
    if (rc != 0) {
        unlink(tmp);
        fprintf(stderr, "desktop-defaults: recording %s in %s failed: %s\n",
                what, dbp, strerror(errno));
    }
    free(out);
}

/* The record's array `key`, created on demand (old records simply lack the
 * newer keys — no migration, the phase-2 precedent). */
static cJSON *dd_db_array(cJSON *db, const char *key) {
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(db, key);
    if (!cJSON_IsArray(arr)) arr = cJSON_AddArrayToObject(db, key);
    return arr;
}

/* Record `link` into the DB record's `desktop` array so gucman remove's
 * reverse replay unplants it exactly like an install-time shortcut. */
static void dd_db_record(const char *dbp, const char *link) {
    cJSON *db = dd_db_load(dbp);
    if (!db) return;
    cJSON *arr = dd_db_array(db, "desktop");
    if (!arr) { cJSON_Delete(db); return; }
    cJSON *it;
    cJSON_ArrayForEach(it, arr) {
        if (cJSON_IsString(it) && strcmp(it->valuestring, link) == 0) {
            cJSON_Delete(db);
            return;                      /* already recorded */
        }
    }
    cJSON_AddItemToArray(arr, cJSON_CreateString(link));
    dd_db_save(dbp, db, link);
    cJSON_Delete(db);
}

/* ---- the seed reconcile (gucman `seed` design §3.4) ---- *
 *
 * "…and maybe copy them over again if missing" for the CONTENT resource
 * kind: for every package declaring `seed`, re-run the plant with fo_merge's
 * absent-only rule, which IS "re-plant what's missing" — present files,
 * edited or not, are KEPT. Each newly planted file/dir is recorded back into
 * the gucman DB record (with a fresh sha256) so a later `gucman remove`
 * unplants reconcile-planted seeds exactly like install-planted ones.
 * Baked (built-in) packages have no DB record and are not removable, so
 * their pass records nothing. */

struct dd_seedctx {
    cJSON *files;                        /* new {path, sha256}, or NULL: don't record */
    cJSON *dirs;                         /* new created dirs, or NULL */
};

static void dd_seed_ev(int ev, const char *path, void *ud) {
    struct dd_seedctx *c = (struct dd_seedctx *)ud;
    char hex[65];
    switch (ev) {
    case FO_MERGE_NODE: dd_added++; break;
    case FO_MERGE_KEPT: dd_kept++; break;
    case FO_MERGE_ERR:  dd_warn("seeding", path); break;
    case FO_MERGE_FILE:
    case FO_MERGE_LINK:
        if (!c->files) break;
        if (sha256_path(path, hex) != 0) { dd_warn("hashing", path); break; }
        {
            cJSON *o = cJSON_CreateObject();
            if (!o) break;
            cJSON_AddStringToObject(o, "path", path);
            cJSON_AddStringToObject(o, "sha256", hex);
            cJSON_AddItemToArray(c->files, o);
        }
        break;
    case FO_MERGE_DIR:
        if (c->dirs) cJSON_AddItemToArray(c->dirs, cJSON_CreateString(path));
        break;
    default: break;
    }
}

/* mkdir -p the parent chain of /root/<dest>, recording dirs WE create. */
static int dd_seed_parents(const char *dest, struct dd_seedctx *c) {
    char p[FO_PATH_MAX];
    struct stat st;
    if (snprintf(p, sizeof p, DD_HOME "/%s", dest) >= (int)sizeof p) {
        errno = ENAMETOOLONG;
        dd_warn("naming", dest);
        return -1;
    }
    for (char *s = p + strlen(DD_HOME) + 1; *s; s++) {
        if (*s != '/') continue;
        *s = 0;
        if (lstat(p, &st) != 0) {
            if (mkdir(p, 0755) != 0) { dd_warn("creating", p); *s = '/'; return -1; }
            if (c->dirs) cJSON_AddItemToArray(c->dirs, cJSON_CreateString(p));
        }
        *s = '/';
    }
    return 0;
}

/* Re-plant one package's declared seeds from `root` (/opt/<name> for an
 * installed package, /usr/opt/<name> for a baked one). `dbp` NULL = don't
 * record (baked packages have no record). */
static void dd_seeds(cJSON *control, const char *root, const char *dbp) {
    cJSON *seed = cJSON_GetObjectItemCaseSensitive(control, "seed");
    if (!seed || !cJSON_IsObject(seed)) return;
    cJSON *newf = dbp ? cJSON_CreateArray() : NULL;
    cJSON *newd = dbp ? cJSON_CreateArray() : NULL;
    struct dd_seedctx ctx = { newf, newd };
    cJSON *it;
    cJSON_ArrayForEach(it, seed) {
        if (!cJSON_IsString(it) || !it->string ||
            !fo_safe_seed_rel(it->string) || !fo_safe_rel(it->valuestring)) {
            fprintf(stderr, "desktop-defaults: %s/control.json has a malformed "
                    "seed entry — skipped\n", root);
            continue;
        }
        char s[FO_PATH_MAX], t[FO_PATH_MAX];
        struct stat st;
        if (snprintf(s, sizeof s, "%s/%s", root, it->valuestring) >= (int)sizeof s ||
            snprintf(t, sizeof t, DD_HOME "/%s", it->string) >= (int)sizeof t) {
            errno = ENAMETOOLONG;
            dd_warn("naming", it->string);
            continue;
        }
        if (lstat(s, &st) != 0) continue;         /* payload gone — nothing to plant */
        if (dd_seed_parents(it->string, &ctx) != 0) continue;
        fo_merge(s, t, dd_seed_ev, &ctx);
    }
    if (dbp && (cJSON_GetArraySize(newf) || cJSON_GetArraySize(newd))) {
        cJSON *db = dd_db_load(dbp);
        if (db) {
            cJSON *sf = dd_db_array(db, "seeds");
            cJSON *sd = dd_db_array(db, "seed_dirs");
            cJSON *e;
            cJSON_ArrayForEach(e, newf) {
                cJSON *p = cJSON_GetObjectItemCaseSensitive(e, "path");
                if (!cJSON_IsString(p)) continue;
                /* A path can already be recorded: install planted it, the
                 * user deleted it, this reconcile put it back. Replace the
                 * stale record so the sha is the one just planted. */
                for (int i = cJSON_GetArraySize(sf) - 1; i >= 0; i--) {
                    cJSON *hp = cJSON_GetObjectItemCaseSensitive(
                        cJSON_GetArrayItem(sf, i), "path");
                    if (cJSON_IsString(hp) && strcmp(hp->valuestring, p->valuestring) == 0)
                        cJSON_DeleteItemFromArray(sf, i);
                }
                cJSON_AddItemToArray(sf, cJSON_Duplicate(e, 1));
            }
            cJSON_ArrayForEach(e, newd) {
                cJSON *have, *dup = NULL;
                cJSON_ArrayForEach(have, sd)
                    if (cJSON_IsString(have) && strcmp(have->valuestring, e->valuestring) == 0)
                        { dup = have; break; }
                if (!dup) cJSON_AddItemToArray(sd, cJSON_CreateString(e->valuestring));
            }
            dd_db_save(dbp, db, "seeds");
            cJSON_Delete(db);
        }
    }
    cJSON_Delete(newf);
    cJSON_Delete(newd);
}

static void dd_packages(void) {
    DIR *d = opendir(DD_DB_DIR);
    if (!d) return;                      /* no gucman DB — nothing installed */
    struct dirent *de;
    while ((de = readdir(d))) {
        size_t n = strlen(de->d_name);
        if (n <= 5 || n >= 128 || strcmp(de->d_name + n - 5, ".json") != 0)
            continue;
        char name[128];
        memcpy(name, de->d_name, n - 5);
        name[n - 5] = 0;
        char cpath[FO_PATH_MAX], dbp[FO_PATH_MAX];
        char root[FO_PATH_MAX];
        snprintf(root, sizeof root, DD_OPT_DIR "/%s", name);
        snprintf(cpath, sizeof cpath, "%s/control.json", root);
        snprintf(dbp, sizeof dbp, DD_DB_DIR "/%s", de->d_name);
        char *text = dd_slurp(cpath);
        if (!text) continue;             /* orphan record — gucman territory */
        cJSON *control = cJSON_Parse(text);
        free(text);
        if (!control) {
            fprintf(stderr, "desktop-defaults: %s is not valid JSON — "
                    "skipped\n", cpath);
            continue;
        }
        cJSON *desk = cJSON_GetObjectItemCaseSensitive(control, "desktop");
        cJSON *cmd = desk ? cJSON_GetObjectItemCaseSensitive(desk, "cmd")
                          : NULL;
        /* absent field = desktop-ineligible (design §5) — never an icon */
        if (cJSON_IsString(cmd) && cmd->valuestring[0] &&
            !strchr(cmd->valuestring, '/')) {
            char link[FO_PATH_MAX], bin[FO_PATH_MAX];
            snprintf(link, sizeof link, DD_DESKTOP "/%s", name);
            struct stat st;
            if (lstat(link, &st) == 0) {
                dd_kept++;               /* icon (or a clash) already there */
            } else {
                snprintf(bin, sizeof bin, DD_BIN_DIR "/%s", cmd->valuestring);
                if (symlink(bin, link) == 0) {
                    dd_added++;
                    dd_db_record(dbp, link);
                } else {
                    dd_warn("planting", link);
                }
            }
        }
        dd_seeds(control, root, dbp);     /* §3.4: re-plant missing content */
        cJSON_Delete(control);
    }
    closedir(d);
}

/* ---- phase 3: BAKED (built-in) packages ---- *
 *
 * The packages folded into the sealed blob (os-release PACKAGES=) carry no
 * DB record and are not removable, so their seeds are re-planted from
 * /usr/opt/<name>/control.json and recorded nowhere. A name that DOES have
 * a record is installed over the base twin — phase 2 already handled it.
 * This is what makes "restore the demos I deleted" work on a stock image
 * with zero installs. Icons are not phase 3's business: a baked package's
 * Desktop entry, if any, is an image.json user entry and comes back through
 * phase 1. */
static void dd_baked(void) {
    char *rel = dd_slurp(DD_OS_RELEASE);
    if (!rel) return;
    char *m = strstr(rel, "PACKAGES=");
    if (!m || (m != rel && m[-1] != '\n')) { free(rel); return; }
    char *list = m + 9;
    char *end = strchr(list, '\n');
    if (end) *end = 0;
    for (char *p = list; *p; ) {
        char *c = strchr(p, ',');
        size_t l = c ? (size_t)(c - p) : strlen(p);
        char name[128];
        if (l && l < sizeof name) {
            memcpy(name, p, l);
            name[l] = 0;
            char dbp[FO_PATH_MAX], root[FO_PATH_MAX], cpath[FO_PATH_MAX];
            snprintf(dbp, sizeof dbp, DD_DB_DIR "/%s.json", name);
            snprintf(root, sizeof root, DD_USR_OPT "/%s", name);
            snprintf(cpath, sizeof cpath, "%s/control.json", root);
            struct stat st;
            if (lstat(dbp, &st) != 0) {           /* not installed over */
                char *text = dd_slurp(cpath);
                if (text) {
                    cJSON *control = cJSON_Parse(text);
                    free(text);
                    if (!control)
                        fprintf(stderr, "desktop-defaults: %s is not valid JSON — "
                                "skipped\n", cpath);
                    else {
                        dd_seeds(control, root, NULL);
                        cJSON_Delete(control);
                    }
                }
            }
        }
        p = c ? c + 1 : p + l;
    }
    free(rel);
}

int main(void) {
    mkdir(DD_DESKTOP, 0755);             /* idempotent — a repaired home */
    dd_merge(DD_DEFAULTS, DD_DESKTOP);
    dd_packages();
    dd_baked();
    printf("desktop-defaults: added %d, kept %d existing\n",
           dd_added, dd_kept);
    return dd_errors ? 1 : 0;
}
