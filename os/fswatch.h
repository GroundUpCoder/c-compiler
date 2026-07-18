/* fswatch.h — the FS_WATCH consumer surface (ticket #75).
 *
 * ONE kernel primitive: a PATH-KEYED watch fd. __fs_watch(path, mask,
 * flags) creates a watch on a file or directory and returns an fd; the fd
 * is readable in select()/__wait like any other fd, read() drains packed
 * fsw_event records (EAGAIN when dry — watch fds never block), and
 * close() removes the watch. One watch per fd; several watches = several
 * fds in the wait list.
 *
 * Because the watch key is the PATH (not the inode), an editor's
 * tmp+rename-over save lands FSW_CLOSE_WRITE on the watched path and the
 * watch SURVIVES — the inotify rename-over-save trap does not exist here.
 * A watched path that gets deleted fires FSW_SELF_GONE but the watch
 * stays armed: if the path reappears, events fire again.
 *
 * Consumer contract (WAIT-first): park on the fd (__wait / select), then
 * drain until EAGAIN, then act ONCE. FSW_OVERFLOW means records were
 * dropped — rescan whatever you watch (for the typical re-list/re-load
 * consumer the degraded mode is the normal mode).
 *
 * The constants and the record layout MUST MATCH kernel.js's FSW table.
 * Record stream, little-endian, each record 4-byte aligned:
 *   [u16 len][u8 type][u8 flags][name ... NUL, padded to len]
 * `name` is the watch-relative child name for dir-watch events
 * (FSW_RENAME: "old\0new\0" — one record, both names), empty for self
 * events.
 *
 * Known residuals (documented, not solved): attribution is by the
 * mutator's lexically-canonical path, so a write through a symlink or
 * hardlink ALIAS attributes to the alias's path, not the watched one
 * (the realpath-is-lexical flavor limit, todos/0263 — the kernel's
 * _watchCanon is the one seam to upgrade when a physical resolver
 * lands); and a writer that never closes gets no settle until
 * FSW_MODIFY is opted into.
 */
#ifndef FSWATCH_H
#define FSWATCH_H

#include <errno.h>
#include <unistd.h>

/* Event types (record `type` byte; mask bit = 1 << type). */
#define FSW_CLOSE_WRITE 1  /* content at the path is complete — safe to react
                            * (dirty open-file-description released, or a
                            * rename landed complete content at the path) */
#define FSW_CREATE      2  /* entry appeared (create/mkdir/symlink/link/
                            * move-in of a directory) */
#define FSW_DELETE      3  /* entry disappeared (unlink/rmdir/move-out) */
#define FSW_RENAME      4  /* same-dir rename under a dir watch: one record,
                            * name = "old\0new\0" */
#define FSW_SELF_GONE   5  /* the watched path itself unlinked/renamed away
                            * (the watch stays armed) */
#define FSW_MODIFY      6  /* every write/ftruncate — mid-write chatter,
                            * OPT-IN (not in the default mask) */
#define FSW_OVERFLOW    7  /* queue overflowed: rescan */

#define FSW_BIT(t) (1u << (t))

/* The default mask (mask 0 at __fs_watch): the settled set — everything
 * except FSW_MODIFY. You must ASK for mid-write chatter. */
#define FSW_M_SETTLED (FSW_BIT(FSW_CLOSE_WRITE) | FSW_BIT(FSW_CREATE) | \
                       FSW_BIT(FSW_DELETE) | FSW_BIT(FSW_RENAME) |      \
                       FSW_BIT(FSW_SELF_GONE) | FSW_BIT(FSW_OVERFLOW))
#define FSW_M_ALL     (FSW_M_SETTLED | FSW_BIT(FSW_MODIFY))

/* Record flags. */
#define FSW_F_ISDIR 1      /* the subject is a directory */

struct fsw_event {
    unsigned short len;    /* whole record bytes (header + name + padding) */
    unsigned char  type;   /* FSW_* */
    unsigned char  flags;  /* FSW_F_* */
    char           name[1];/* NUL-terminated; watch-relative; "" for self */
};

/* The kernel primitive: watch fd or -1/errno (ENOENT: path must exist at
 * creation — catches typos loudly; ENOSYS: no brokered kernel in this
 * flavor). mask 0 = FSW_M_SETTLED. flags reserved (must be 0). */
__import int __fs_watch(const char *path, unsigned mask, unsigned flags);

static int fsw_open(const char *path, unsigned mask)
{
    return __fs_watch(path, mask, 0);
}

/* Drain every pending record; returns the OR of FSW_BIT(type) seen (0 if
 * nothing was pending). The convenience form for re-list/re-load
 * consumers, which only need "did anything relevant happen" — consumers
 * that need names iterate the records of a raw read() themselves. */
static unsigned fsw_drain(int fd)
{
    char buf[512];
    unsigned seen = 0;
    for (;;) {
        int n = (int)read(fd, buf, sizeof buf);
        if (n <= 0)
            break;
        int off = 0;
        while (off + 4 <= n) {
            const struct fsw_event *ev =
                (const struct fsw_event *)(buf + off);
            if (ev->len < 4 || off + ev->len > n)
                break;
            seen |= FSW_BIT(ev->type);
            off += ev->len;
        }
    }
    return seen;
}

#endif /* FSWATCH_H */
