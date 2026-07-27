/* openwith.h — file associations, ONE policy in ONE place (todos/0072).
 *
 * Header-only by design: the image manifest's `c` entries are single-source
 * compiles, so the resolver is static functions shared by textual inclusion
 * — wm.c (desktop/menu activate), os/win32/fileman.c (Open + the "Open
 * with" picker) and open.c (the terminal-context CLI) all include this and
 * must stay behaviorally identical through it.
 *
 * The store is a plain text map in three layers, overlaid PER KEY — a
 * key's value comes from the highest-precedence layer that defines it
 * (cfgstore.h, arch CS3; ow_set writes only the changed key to the user
 * layer, so new baked defaults keep reaching customized users):
 *   $HOME/.config/openwith   per-user (what ow_set writes)
 *   /etc/openwith            admin override
 *   /usr/share/openwith      baked default (os/image.json)
 * Lines: KEY<ws>COMMAND. KEY is a lowercase extension (no dot) or
 * `default.gui` / `default.term`; '#' starts a comment. COMMAND is an argv
 * prefix — the file path is appended as one argument. A bare program word
 * resolves through /usr/local/bin:/bin (the canonical PATH); GUI-context
 * commands should be windowed apps (wrap tty programs: `term vi`).
 * With no store at all, the pre-0072 defaults apply: `term vi` (gui),
 * `vi` (term).
 */
#ifndef OPENWITH_H
#define OPENWITH_H

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cfgstore.h"

#define OW_STORE_MAX CFG_STORE_MAX
#define OW_CMD_MAX   256

/* "Runnable" = the kernel can exec it: a wasm binary (`\0asm`) or a `#!`
 * script (shebang exec, todos/0065) — the same peek the kernel spawn path
 * does. fopen follows symlinks, so a link to a binary is runnable too. */
static int ow_is_runnable(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    unsigned char b[4];
    size_t n = fread(b, 1, 4, f);
    fclose(f);
    if (n >= 4 && b[0] == 0 && b[1] == 'a' && b[2] == 's' && b[3] == 'm') return 1;
    if (n >= 2 && b[0] == '#' && b[1] == '!') return 1;
    return 0;
}

/* The association key for a path: its lowercase extension (basename only;
 * a leading dot is a dotfile, not an extension). Returns 1 if there is
 * one. */
static int ow_key_for(const char *path, char *key, size_t sz) {
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    const char *dot = strrchr(base, '.');
    if (!dot || dot == base || !dot[1]) return 0;
    size_t i;
    for (i = 0; dot[1 + i] && i + 1 < sz; i++) key[i] = (char)tolower((unsigned char)dot[1 + i]);
    key[i] = 0;
    return 1;
}

/* Load the effective store (per-key overlay of the existing layers).
 * Returns 1 and the NUL-terminated text, 0 with text[0] == 0, or -1 with
 * errno (cfgstore.h: overflow/read error; text keeps the valid prefix). */
static int ow_load(char *text, size_t sz) {
    char user[300];
    cfg_user_path(user, sizeof user, "openwith");
    return cfg_load3(text, sz, user, "/etc/openwith", "/usr/share/openwith");
}

/* Find `key` in store text; copies its command into cmd. */
static int ow_find(const char *text, const char *key, char *cmd, size_t sz) {
    return cfg_find(text, key, cmd, sz);
}

/* The command that opens `path` in this context (gui: the desktop/fileman
 * double-click; !gui: open(1) on a tty): the extension association if there
 * is one, else the context default, else the pre-0072 hardcoded viewer. */
static void ow_resolve(const char *path, int gui, char *cmd, size_t sz) {
    char text[OW_STORE_MAX], key[32];
    if (ow_load(text, sizeof text)) {
        if (ow_key_for(path, key, sizeof key) && ow_find(text, key, cmd, sz)) return;
        if (ow_find(text, gui ? "default.gui" : "default.term", cmd, sz)) return;
    }
    snprintf(cmd, sz, "%s", gui ? "term vi" : "vi");
}

/* The GUI text-EDITOR command (the context menus' "Edit" row, todos/0202):
 * always the `default.gui` entry — deliberately NOT the extension
 * association, which is the VIEWER (Edit on a .mgp deck must open the text
 * editor, not the presentation). Same no-store fallback as ow_resolve. */
static void ow_editor(char *cmd, size_t sz) {
    char text[OW_STORE_MAX];
    if (ow_load(text, sizeof text) && ow_find(text, "default.gui", cmd, sz)) return;
    snprintf(cmd, sz, "term vi");
}

/* Write an association: set `key` to `cmd` in the USER layer only
 * (cfgstore.h delta-write — the admin/baked layers keep serving every
 * other key through the overlay). Returns 0, or -1. */
static int ow_set(const char *key, const char *cmd) {
    return cfg_set("openwith", key, cmd);
}

/* Build the argv for `cmd path`: split cmd into at most maxargs-2 words
 * (backing storage in buf), append path, NUL-terminate. argv[0] stays the
 * bare word; prog gets the spawnable program path (a bare word resolves
 * through /usr/local/bin:/bin, the canonical PATH). Returns argc, or 0.
 *
 * The splitter itself lives in cfgstore.h since todos/0338 — a store value
 * is an argv prefix in every store, and cmdalt appends N arguments where
 * this appends one path. This is the reserve = 1 wrapper: the loop bound
 * maxargs - reserve - 1 IS the old maxargs - 2, and cfg_resolve_prog is the
 * old three lines. The ONE difference is unobservable: cfg_path_find probes
 * /bin/<word> before falling back to it, where the old code fell back
 * unconditionally — same prog either way, one extra access() when nothing
 * is installed. test_openwith_e2e.js is the behavioral guard. */
static int ow_build(const char *cmd, const char *path, char *argv[],
                    int maxargs, char *buf, size_t bufsz,
                    char *prog, size_t progsz) {
    int n = cfg_split_argv(cmd, argv, maxargs, 1, buf, bufsz);
    if (n == 0) return 0;
    argv[n++] = (char *)path;
    argv[n] = 0;
    cfg_resolve_prog(argv[0], prog, progsz);
    return n;
}

#endif /* OPENWITH_H */
