/* egress.h — gucOS -> host file egress (todos/0398), the C surface of the
 * ONE transfer seam: Download, Save As, and any future app export are the
 * same mechanism with different disposition words.
 *
 * Header-only by design (the fileops.h precedent): wm.c (icon-menu
 * Download) and os/win32/fileman.c share these static functions by textual
 * inclusion. eg_send builds the path list — one absolute path per
 * '\n'-terminated line, the FO_CLIP_FMT=2 shape, fo_clip_set's builder
 * discipline — and hands it to __egress (host.js createEgress), which
 * prepends the disposition word and ships it to the kernel's EGRESS RPC.
 * The kernel (the fs owner) materializes the bytes exactly once: a lone
 * file crosses as itself, a lone symlink follows to its target, a
 * directory or multi-selection becomes ONE store-only zip with symlinks
 * preserved as symlink entries.
 *
 * Returns 0 (the artifact reached the embedder) or -1 with errno: EINVAL
 * (bad disposition / relative path), ENOENT (path or dangling lone
 * symlink), EACCES, EFBIG (over the kernel's size cap, decided before any
 * byte is read), E2BIG (list over EG_MAX), ENOSYS (no kernel, or an
 * embedder without a host side — there is deliberately no local fallback).
 */
#ifndef EGRESS_H
#define EGRESS_H

#include <errno.h>
#include <stdio.h>

#define EG_DOWNLOAD 1                /* anchor download on the browser side */
#define EG_SAVEAS   2                /* showSaveFilePicker (degrades to
                                        download where the API is absent) */
#define EG_MAX      8192             /* whole path-list byte cap — MUST stay
                                        within kernel.js EG_REQ_MAX */

__import int __egress(int dispo, const void *paths, int len);

/* Egress `n` absolute paths under one disposition. One RPC, one artifact. */
static int eg_send(int dispo, const char *const *paths, int n) {
    char buf[EG_MAX];
    int len = 0;
    if (n <= 0) { errno = EINVAL; return -1; }
    for (int i = 0; i < n; i++) {
        int w = snprintf(buf + len, sizeof buf - (size_t)len, "%s\n", paths[i]);
        if (w < 0 || len + w >= (int)sizeof buf) { errno = ENOMEM; return -1; }
        len += w;
    }
    return __egress(dispo, buf, len) == 0 ? 0 : -1;
}

#endif
