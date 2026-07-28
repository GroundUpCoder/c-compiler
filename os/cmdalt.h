/* cmdalt.h — command alternatives: ONE name, a switchable implementation
 * (todos/0338; design `todos/COMMAND-ALTERNATIVES.md`).
 *
 * Header-only by design, the openwith.h precedent: the image manifest's `c`
 * entries are single-source compiles, so the policy is static functions
 * shared by textual inclusion — cmdalt.c (the dispatcher + admin CLI) and
 * ctlpanel.c (the Default Programs picker) include this and must stay
 * behaviorally identical through it.
 *
 * The store is a fourth cfgstore.h store, three layers overlaid PER KEY:
 *   $HOME/.config/cmdalt   the user's pick   (ctlpanel / `cmdalt set`)
 *   /etc/cmdalt            package claims    (gucman install/remove)
 *   /usr/share/cmdalt      baked suggestion  (os/image.json)
 * Lines: KEY<ws>VALUE. KEY is a COMMAND NAME (`python`); VALUE is an argv
 * prefix whose bare first word resolves through /usr/local/bin:/bin. Two
 * reads, deliberately different:
 *   - the EFFECTIVE value is cfg_find's first match over the concat — user
 *     pick, else first package claim, else baked suggestion, so the
 *     earliest-installed implementation stays the default until the user
 *     says otherwise and a later install never silently steals the name;
 *   - the CANDIDATE set is cfg_each — EVERY line for the key, which is what
 *     the picker lists and what the not-installed error names.
 *
 * An unresolvable effective value is an ERROR, never a silent fallback to
 * another candidate: running MicroPython because the user's chosen CPython
 * is uninstalled would quietly run a script under the wrong dialect.
 *
 * A name that describes a ROLE ("what runs when you type this") is a cmdalt
 * key; a name that identifies an IMPLEMENTATION is a hard package claim
 * (jku, 2026-07-28). `python`/`python3` are keys; `cpython-clang` is a
 * package.
 */
#ifndef CMDALT_H
#define CMDALT_H

#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cfgstore.h"

#define CA_STORE     "cmdalt"
#define CA_ETC       "/etc/cmdalt"
#define CA_BAKED     "/usr/share/cmdalt"
#define CA_DISPATCH  "/usr/bin/cmdalt"      /* every dispatch link's inode */

#define CA_STORE_MAX CFG_STORE_MAX
#define CA_KEY_MAX   CFG_KEY_MAX
#define CA_VAL_MAX   CFG_VAL_MAX
#define CA_PATH_MAX  300

/* Overlay-load the store. 1 / 0 / -1 exactly like cfg_load3. */
static int ca_load(char *text, size_t sz) {
    char user[CA_PATH_MAX];
    cfg_user_path(user, sizeof user, CA_STORE);
    return cfg_load3(text, sz, user, CA_ETC, CA_BAKED);
}

/* The USER-layer delta writes — `cmdalt set` and the picker share these. */
static int ca_set(const char *key, const char *value) {
    return cfg_set(CA_STORE, key, value);
}
static int ca_reset(const char *key) {
    return cfg_unset(CA_STORE, key);
}

/* The program a VALUE names: its first word, PATH-resolved. */
static void ca_prog(const char *value, char *prog, size_t sz) {
    char word[CA_VAL_MAX];
    size_t i = 0;
    while (value[i] && value[i] != ' ' && value[i] != '\t' && i + 1 < sizeof word) {
        word[i] = value[i];
        i++;
    }
    word[i] = 0;
    if (!i) { if (sz) prog[0] = 0; return; }
    cfg_resolve_prog(word, prog, sz);
}

/* The first word of a VALUE — the thing to name in an install hint (a
 * baked suggestion's first word IS its package name by convention:
 * `python<TAB>cpython-clang` -> `gucman install cpython-clang`). */
static void ca_word0(const char *value, char *out, size_t sz) {
    size_t i = 0;
    while (value[i] && value[i] != ' ' && value[i] != '\t' && i + 1 < sz) {
        out[i] = value[i];
        i++;
    }
    if (sz) out[i] = 0;
}

/* Same file? dev+ino through symlinks — the self-dispatch guard and the
 * PATH-shadow test both need exactly this. */
static int ca_same_file(const char *a, const char *b) {
    struct stat sa, sb;
    return stat(a, &sa) == 0 && stat(b, &sb) == 0 &&
           sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

enum { CA_OK = 0, CA_NOKEY, CA_MISSING };

typedef struct {
    char value[CA_VAL_MAX];    /* the effective store value (argv prefix) */
    char prog[CA_PATH_MAX];    /* its resolved program; "" when unset */
    int  status;               /* CA_OK / CA_NOKEY / CA_MISSING */
} ca_res;

/* Resolve `key` over already-loaded store text. NB "installed" here is
 * EXISTENCE (access F_OK), the same probe the platform's own PATH search
 * uses — a dangling link resolves and then fails at spawn, which is the
 * spawn's error to report, not ours to pre-empt. */
static void ca_resolve(const char *text, const char *key, ca_res *r) {
    r->value[0] = 0;
    r->prog[0] = 0;
    if (!cfg_find(text, key, r->value, sizeof r->value)) {
        r->status = CA_NOKEY;
        return;
    }
    ca_prog(r->value, r->prog, sizeof r->prog);
    r->status = (r->prog[0] && access(r->prog, 0 /* F_OK */) == 0)
        ? CA_OK : CA_MISSING;
}

/* The CANDIDATE set: every line for `key` in layer order, DEDUPED BY VALUE
 * — picking a candidate writes it to the user layer, where it then shadows
 * the same value in a lower one, and offering it twice would be nonsense.
 * Returns the number of distinct candidates. Beyond CA_CAND_MAX the walk
 * stops rather than emit a value it can no longer tell apart. */
#define CA_CAND_MAX 16

struct ca_dedup {
    cfg_line_cb cb;
    void *user;
    int n;
    char seen[CA_CAND_MAX][CA_VAL_MAX];
};

static int ca_dedup_cb(const char *key, const char *value, void *u) {
    struct ca_dedup *d = (struct ca_dedup *)u;
    for (int i = 0; i < d->n; i++)
        if (strcmp(d->seen[i], value) == 0) return 0;
    if (d->n >= CA_CAND_MAX) return 1;
    snprintf(d->seen[d->n++], CA_VAL_MAX, "%s", value);
    return d->cb ? d->cb(key, value, d->user) : 0;
}

static int ca_candidates(const char *text, const char *key,
                         cfg_line_cb cb, void *user) {
    struct ca_dedup d;
    memset(&d, 0, sizeof d);
    d.cb = cb;
    d.user = user;
    cfg_each(text, key, ca_dedup_cb, &d);
    return d.n;
}

/* ------------------------- the PATH-shadow diagnostic --------------------
 *
 * PATH is /usr/local/bin:/bin — user-installed binaries deliberately win
 * over baked ones (todos/0040). A package that plants /usr/local/bin/<name>
 * for a name the base image DISPATCHES therefore wins silently, and the
 * symptom is "switching the default does nothing" (never a broken command:
 * the shadow keeps running the implementation it always ran). gucman no
 * longer plants such a link — but a box that installed the package BEFORE
 * this shipped keeps it forever, because /usr/local -> /var/local is user
 * territory that an image upgrade never writes and `gucman install` has no
 * upgrade path. That population is closed at release and non-growing, so
 * this is DIAGNOSED, never auto-repaired (todos/0338 non-goals).
 *
 * INTERLOCK: the prescribed fix below (remove + reinstall) is only correct
 * once packages CLAIM command names — `commands` in the package definition,
 * appended to /etc/cmdalt by gucman install. Without that step, removing
 * the shadow leaves the key resolving to a baked suggestion the box has not
 * installed, i.e. it converts a stuck default into a `python` that exits
 * 127. Do not print this advice from a tree where gucman does not plant the
 * claim. */

/* Does PATH actually reach the dispatcher for `key`? 0 = yes (or the name
 * is not on PATH at all — nothing to warn about). 1 + `out` = the earlier
 * PATH entry that shadows it. */
static int ca_shadow(const char *key, char *out, size_t sz) {
    char found[CA_PATH_MAX];
    if (sz) out[0] = 0;
    if (!cfg_path_find(key, found, sizeof found)) return 0;
    if (ca_same_file(found, CA_DISPATCH)) return 0;
    snprintf(out, sz, "%s", found);
    return 1;
}

/* The package that planted a shadowing link, read off gucman's own plant
 * shape (/usr/local/bin/<cmd> -> /opt/<name>/...). "" when the shadow is
 * not a package link — then there is no remove/reinstall to advise. */
static void ca_shadow_owner(const char *link, char *out, size_t sz) {
    char tgt[CA_PATH_MAX];
    if (sz) out[0] = 0;
    long n = (long)readlink(link, tgt, sizeof tgt - 1);
    if (n <= 0) return;
    tgt[n] = 0;
    if (strncmp(tgt, "/opt/", 5) != 0) return;
    const char *p = tgt + 5;
    const char *slash = strchr(p, '/');
    size_t len = slash ? (size_t)(slash - p) : strlen(p);
    if (!len || len + 1 > sz) return;
    memcpy(out, p, len);
    out[len] = 0;
}

/* The ONE shadow message, so `cmdalt set`, `cmdalt which`, `cmdalt list`
 * and the Control Panel picker cannot drift. `sep` joins the two halves —
 * a wrapped CLI continuation, or a plain space for a one-line GUI STATIC. */
static void ca_shadow_text(const char *key, const char *shadow,
                           const char *sep, char *out, size_t sz) {
    char pkg[CA_KEY_MAX];
    ca_shadow_owner(shadow, pkg, sizeof pkg);
    if (pkg[0])
        snprintf(out, sz,
                 "%s shadows this setting and will keep winning;%s"
                 "clear it with: gucman remove %s && gucman install %s",
                 shadow, sep, pkg, pkg);
    else
        snprintf(out, sz,
                 "%s shadows this setting and will keep winning;%s"
                 "remove it (it is earlier on PATH than /usr/bin/%s)",
                 shadow, sep, key);
}

#define CA_SEP_CLI "\n         "

#endif /* CMDALT_H */
