/* listdir.h — the shared directory-listing walk (code-debt CD34) for
 * comdlg32.c's file dialog, fileman.c's pane, and wm.c's menu/desktop
 * loader — ALL three of the class's drifted copies since the 0291 fold
 * (the wm.c copy was deferred to the menu redesign, 0250/0259; that
 * shipped, and the fold followed).
 *
 * Header-only by design (the openwith.h / cfgstore.h / fileops.h
 * precedent): the image manifest's `c` entries are single-source
 * compiles, so the walk is a static function shared by textual
 * inclusion.
 *
 * list_dir() is the one "opendir → readdir → stat per entry → fill"
 * loop that was hand-written (and drifting: dotfile policy, link
 * handling, caps) in comdlg32.c's file dialog, fileman.c's pane and
 * wm.c's menu/desktop loader. It fills a CALLER-PROVIDED ld_ent buffer
 * — every field comes off ONE lstat per entry (plus one stat when a
 * link is followed), so is_dir / is_link / size / mtime are all free —
 * and returns the count. SORTING IS CALLER POLICY: each caller qsorts
 * with its own comparator (dirs-first, size/date view keys, the
 * Recycle-Bin tail pin), so the helper bakes in no order.
 *
 * `.` and `..` are always skipped; an entry whose lstat fails
 * (vanished mid-walk) is skipped too. Flags:
 *   LIST_HIDE_DOTFILES  skip every name starting '.'
 *   LIST_FOLLOW_LINKS   a symlink reports its TARGET's
 *                       is_dir/size/mtime (dangling target → zeros);
 *                       is_link stays 1 either way — wm.c's "a link to
 *                       a directory cascades" menu rule needs both
 *                       facts at once.
 * Without LIST_FOLLOW_LINKS a link reports its own lstat facts
 * (is_dir 0, size = target-path length).
 *
 * Callers: comdlg32.c fd_refill (LIST_FOLLOW_LINKS — no dotfile
 * hiding), fileman.c refill (LIST_FOLLOW_LINKS, plus
 * LIST_HIDE_DOTFILES gated on the View toggle), wm.c load_entries
 * (LIST_FOLLOW_LINKS | LIST_HIDE_DOTFILES — the "a link to a directory
 * cascades" menu rule is why is_link and the followed is_dir are
 * separate facts).
 */
#ifndef LISTDIR_H
#define LISTDIR_H

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#define LIST_HIDE_DOTFILES 1u
#define LIST_FOLLOW_LINKS  2u

#define LD_NAME 256   /* a full filesystem name (BlockFS caps names at 255) */

typedef struct {
    char name[LD_NAME];
    int is_dir;
    int is_link;
    long size;
    long mtime;
} ld_ent;

/* Fill `out` (capacity `max`) with `path`'s entries, unsorted. Returns
 * the TOTAL entry count — which may exceed `max`: only the first `max`
 * entries are filled, and the walk keeps counting past the cap so a
 * caller seeing count > max KNOWS the listing was clipped and can say
 * so (a silently-short list reads as "that's everything" — the R4/0255
 * fail-loud rule). Returns -1 when the directory can't be opened
 * (callers tell an unreadable dir from an empty one). */
static int list_dir(const char *path, ld_ent *out, int max, unsigned flags) {
    DIR *d = opendir(path);
    if (!d) return -1;
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d))) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        if ((flags & LIST_HIDE_DOTFILES) && de->d_name[0] == '.') continue;
        char full[1024];
        snprintf(full, sizeof full, "%s/%s", path, de->d_name);
        struct stat st;
        if (lstat(full, &st) != 0) continue;
        if (n >= max) { n++; continue; }   /* count past the cap, don't fill */
        ld_ent *e = &out[n++];
        memset(e, 0, sizeof *e);
        snprintf(e->name, sizeof e->name, "%s", de->d_name);
        e->is_link = S_ISLNK(st.st_mode) ? 1 : 0;
        int have = 1;
        if (e->is_link && (flags & LIST_FOLLOW_LINKS)) {
            struct stat st2;
            if (stat(full, &st2) == 0) st = st2;   /* the target's facts */
            else have = 0;                          /* dangling: zeros */
        }
        if (have) {
            e->is_dir = S_ISDIR(st.st_mode) ? 1 : 0;
            e->size = (long)st.st_size;
            e->mtime = (long)st.st_mtime;
        }
    }
    closedir(d);
    return n;
}

#endif /* LISTDIR_H */
