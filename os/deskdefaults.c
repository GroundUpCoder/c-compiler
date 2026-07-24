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
#include "cJSON.h"

#define DD_DEFAULTS "/usr/share/desktop/default"
#define DD_DESKTOP  "/root/Desktop"
#define DD_DB_DIR   "/var/lib/gucman"
#define DD_BIN_DIR  "/usr/local/bin"

static int dd_added = 0, dd_kept = 0, dd_errors = 0;

static void dd_warn(const char *what, const char *path) {
    fprintf(stderr, "desktop-defaults: %s %s: %s\n", what, path,
            strerror(errno));
    dd_errors++;
}

/* ---- phase 1: the additive default merge ---- */

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
        struct stat ss, ts;
        if (lstat(s, &ss) != 0) { dd_warn("stat", s); continue; }
        if (lstat(t, &ts) != 0) {
            if (fo_copy(s, t) == 0) dd_added++;
            else dd_warn("planting", t);
        } else if (S_ISDIR(ss.st_mode) && S_ISDIR(ts.st_mode)) {
            dd_kept++;                   /* the additive folder merge */
            dd_merge(s, t);
        } else {
            dd_kept++;                   /* same-name clash: never overwrite */
        }
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

/* Record `link` into the DB record's `desktop` array so gucman remove's
 * reverse replay unplants it exactly like an install-time shortcut. */
static void dd_db_record(const char *dbp, const char *link) {
    char *text = dd_slurp(dbp);
    cJSON *db = text ? cJSON_Parse(text) : NULL;
    free(text);
    if (!db) {
        fprintf(stderr, "desktop-defaults: %s unreadable — icon planted but "
                "not recorded (gucman remove will not unplant it)\n", dbp);
        return;
    }
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(db, "desktop");
    if (!cJSON_IsArray(arr)) {
        arr = cJSON_AddArrayToObject(db, "desktop");
        if (!arr) { cJSON_Delete(db); return; }
    }
    cJSON *it;
    cJSON_ArrayForEach(it, arr) {
        if (cJSON_IsString(it) && strcmp(it->valuestring, link) == 0) {
            cJSON_Delete(db);
            return;                      /* already recorded */
        }
    }
    cJSON_AddItemToArray(arr, cJSON_CreateString(link));
    char *out = cJSON_Print(db);
    cJSON_Delete(db);
    if (!out) return;
    /* tmp + rename — the gucman gm_write_file_atomic rule */
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
                link, dbp, strerror(errno));
    }
    free(out);
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
        snprintf(cpath, sizeof cpath, "/opt/%s/control.json", name);
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
        cJSON_Delete(control);
    }
    closedir(d);
}

int main(void) {
    mkdir(DD_DESKTOP, 0755);             /* idempotent — a repaired home */
    dd_merge(DD_DEFAULTS, DD_DESKTOP);
    dd_packages();
    printf("desktop-defaults: added %d, kept %d existing\n",
           dd_added, dd_kept);
    return dd_errors ? 1 : 0;
}
