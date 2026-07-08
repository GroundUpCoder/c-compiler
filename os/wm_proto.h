/* wm_proto.h — C client side of the WM protocol (todos/0014).
 *
 * The kernel serves a framed protocol on the AF_UNIX socket /run/wm.sock
 * (a KERNEL-owned endpoint — no listener process). Framing, all little-
 * endian (wasm is LE, so raw structs work): u32 len (bytes that follow,
 * 4 + payload) | u32 type | payload. Types >= 0x80 are events (sent only
 * to SUBSCRIBEd connections); command replies arrive strictly in request
 * order, so a subscriber awaiting a reply queues event frames aside
 * (wmp_next_reply below).
 *
 * MUST MATCH kernel.js (the WMP block) and tests/kernel/test_wm_policy.js.
 */
#ifndef WM_PROTO_H
#define WM_PROTO_H

#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

#define WM_SOCK_PATH "/run/wm.sock"

enum {
    /* commands */
    WMP_SUBSCRIBE = 0x01, WMP_LIST = 0x02,
    WMP_MOVE = 0x10, WMP_FOCUS = 0x11, WMP_MINIMIZE = 0x12,
    WMP_RESTORE = 0x13, WMP_RESTACK = 0x14, WMP_CLOSE_REQ = 0x15,
    WMP_RESIZE = 0x16,                 /* { sid, w, h }: asks the client;
                                          geometry changes at its ack ->
                                          EV_CONFIGURED (todos/0019) */
    WMP_SET_DST = 0x17,                /* { sid, w, h }: viewport scaling
                                          (todos/0024) — set the on-screen
                                          dst rect of a FIXED-SIZE surface;
                                          buffer untouched, app oblivious.
                                          R_ERR on a resizable surface */
    WMP_INJECT_KEY = 0x20, WMP_INJECT_POINTER = 0x21,
    WMP_SHOT = 0x30, WMP_SHOT_SCREEN = 0x31,
    /* replies */
    WMP_R_OK = 0x40, WMP_R_ERR = 0x41, WMP_R_LIST = 0x42, WMP_R_SHOT = 0x43,
    /* events */
    WMP_EV_CREATED = 0x80, WMP_EV_DESTROYED = 0x81, WMP_EV_TITLE = 0x82,
    WMP_EV_FOCUS = 0x83, WMP_EV_MOVED = 0x84, WMP_EV_MINIMIZED = 0x85,
    WMP_EV_CONFIGURED = 0x86,          /* { sid, w, h }: resize ack landed */
    WMP_EV_SCREEN = 0x87,              /* { w, h }: screen resolution changed
                                          (todos/0023); the kernel has already
                                          clamped window positions */
    WMP_EV_SCALED = 0x88,              /* { sid, dstW, dstH }: a SET_DST landed
                                          (todos/0024) */
    WMP_EV_SCALE_REQ = 0x89,           /* { sid, w, h }: frame drag released on
                                          a fixed-size surface at that box —
                                          policy answers with an aspect-
                                          preserving SET_DST (todos/0024) */
};

/* The fixed 80-byte window record (EV_CREATED payload; R_LIST carries
 * u32 count then count of these). No padding: 12 i32 + 32 bytes.
 * dst_w/dst_h: the on-screen viewport (todos/0024) — equals w/h unless
 * the surface is scaled. */
typedef struct {
    int32_t sid, pid, x, y, w, h, z, flags, frame_seq, dst_w, dst_h, reserved;
    char title[32];                    /* NUL-padded, always terminated */
} wmp_rec;
#define WMP_F_FOCUSED    1
#define WMP_F_MINIMIZED  2
#define WMP_F_BORDERLESS 4
#define WMP_F_RELMOUSE   8   /* surface requested relative mouse (todos/0018) */
#define WMP_F_RESIZABLE 16   /* SDL_WINDOW_RESIZABLE: RESIZE allowed (0021) */

/* Frame header as read off the wire (after the length word). */
typedef struct { uint32_t type; uint32_t plen; } wmp_hdr;

static int wmp_write_all(int fd, const void *buf, int len) {
    const char *p = (const char *)buf;
    while (len > 0) {
        int n = (int)write(fd, p, (size_t)len);
        if (n <= 0) return -1;
        p += n; len -= n;
    }
    return 0;
}

static int wmp_read_all(int fd, void *buf, int len) {
    char *p = (char *)buf;
    while (len > 0) {
        int n = (int)read(fd, p, (size_t)len);
        if (n <= 0) return -1;         /* EOF or error: connection gone */
        p += n; len -= n;
    }
    return 0;
}

/* Connect to the WM endpoint. Returns the fd or -1. */
static int wmp_connect(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strcpy(sa.sun_path, WM_SOCK_PATH);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) { close(fd); return -1; }
    return fd;
}

/* Send one command frame with n i32 args. */
static int wmp_send(int fd, uint32_t type, const int32_t *args, int nargs) {
    uint32_t buf[2 + 8];
    if (nargs > 8) return -1;
    buf[0] = 4u + (uint32_t)nargs * 4u;
    buf[1] = type;
    for (int i = 0; i < nargs; i++) buf[2 + i] = (uint32_t)args[i];
    return wmp_write_all(fd, buf, 8 + nargs * 4);
}

/* Read the next frame header; the payload (h->plen bytes) is then read by
 * the caller (wmp_read_all / wmp_skip). Returns 0, or -1 on EOF/error. */
static int wmp_next(int fd, wmp_hdr *h) {
    uint32_t hd[2];
    if (wmp_read_all(fd, hd, 8) != 0) return -1;
    if (hd[0] < 4) return -1;          /* corrupt */
    h->type = hd[1];
    h->plen = hd[0] - 4;
    return 0;
}

static int wmp_skip(int fd, uint32_t n) {
    char sink[256];
    while (n > 0) {
        uint32_t c = n > sizeof sink ? (uint32_t)sizeof sink : n;
        if (wmp_read_all(fd, sink, (int)c) != 0) return -1;
        n -= c;
    }
    return 0;
}

/* Read frames until a REPLY (type < 0x80), discarding events — the wmctl
 * pattern (unsubscribed connections only see replies; a subscriber that
 * wants the events must not use this). Payload is left unread; *h tells
 * the caller what to read. */
static int wmp_next_reply(int fd, wmp_hdr *h) {
    for (;;) {
        if (wmp_next(fd, h) != 0) return -1;
        if (h->type < 0x80) return 0;
        if (wmp_skip(fd, h->plen) != 0) return -1;
    }
}

/* One-shot command -> R_OK/R_ERR. Returns 0 on R_OK, -1 otherwise. */
static int wmp_cmd(int fd, uint32_t type, const int32_t *args, int nargs) {
    wmp_hdr h;
    if (wmp_send(fd, type, args, nargs) != 0) return -1;
    if (wmp_next_reply(fd, &h) != 0) return -1;
    int ok = h.type == WMP_R_OK ? 0 : -1;
    if (wmp_skip(fd, h.plen) != 0) return -1;
    return ok;
}

#endif /* WM_PROTO_H */
