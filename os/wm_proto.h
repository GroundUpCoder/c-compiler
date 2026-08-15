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

#include <errno.h>
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
    WMP_ACTIVATE = 0x18,               /* { sid }: fire the title-activate
                                          (maximize) gesture (todos/0025) —
                                          the wmctl-max path into the same
                                          policy code the title double-click
                                          hits. R_ERR with no subscribed WM
                                          (maximize IS policy) */
    WMP_CYCLE = 0x19,                  /* { direction }: fire the window-
                                          cycling gesture (todos/0032) — the
                                          wmctl-cycle path into the same
                                          EV_CYCLE the Alt+Tab chord emits.
                                          R_ERR with no subscribed WM */
    WMP_SET_LAYER = 0x1A,              /* { sid, layer }: pin the surface to
                                          a z layer (todos/0038) — -1 below
                                          normal windows (the desktop layer),
                                          0 normal, +1 above (the taskbar);
                                          every z-order op stays within its
                                          layer, so a raise/create can never
                                          cover the bar nor a lower sink
                                          under the desktop */
    WMP_GLASS = 0x1B,                  /* { on }: toggle the Aero glass tier
                                          (todos/0063) — browser-compositor-
                                          only backdrop blur behind window
                                          chrome. The headless composite
                                          never reads it; default off */
    WMP_MENU = 0x1C,                   /* { }: fire the Start-menu gesture
                                          (todos/0078) — the wmctl-menu path
                                          into the same EV_MENU the Ctrl+Esc
                                          chord emits. R_ERR with no
                                          subscribed WM (the menu IS policy) */
    WMP_SNAP = 0x1D,                   /* { direction }: fire the Aero Snap
                                          gesture (todos/0095) — the wmctl-
                                          snap path into the same EV_SNAP_KEY
                                          the Win+arrow chord emits; 0 left,
                                          1 right, 2 up, 3 down. R_ERR with
                                          no subscribed WM (snap IS policy) */
    WMP_GET_IDLE = 0x1E,               /* { }: ms since the last real input
                                          (todos/0096) -> R_IDLE { ms }. The
                                          kernel sees ALL input; /bin/wm's
                                          screensaver policy polls this and
                                          applies its own timeout */
    WMP_SAVER = 0x1F,                  /* { }: fire the screensaver gesture
                                          (todos/0096) — wmctl saver / the
                                          Control Panel Preview path into
                                          EV_SAVER. R_ERR with no subscribed
                                          WM (the saver IS policy) */
    WMP_INJECT_KEY = 0x20, WMP_INJECT_POINTER = 0x21,
    WMP_INJECT_SCREEN = 0x22,          /* { kind, xf32, yf32, a }: SCREEN-
                                          coordinate pointer injection through
                                          the kernel's full hit-test/chrome
                                          path (todos/0095) — headless title
                                          drags, edge snap, border resizes;
                                          kind 0 move (a=buttons) / 1 down /
                                          2 up (a=button) */
    WMP_INJECT_WMKEY = 0x23,           /* { down, scancode, keysym, mod,
                                          repeat }: keyboard injection through
                                          the kernel's raw wmKey entry — grab
                                          table (chords), overview swallow,
                                          focus routing — what a real keyboard
                                          feeds (#423, the INJECT_SCREEN
                                          keyboard analogue). INJECT_KEY
                                          delivers per-window and bypasses
                                          all of that by design */
    /* Virtual gamepads (#607) — the headless twin of the browser Gamepad
       API poller: both feed the same kernel pad entries, so a wmctl pad is
       indistinguishable from a real one below the page layer. Button is an
       SDL_GamepadButton index, axis an SDL_GamepadAxis index, value an i16
       (sticks -32768..32767, triggers 0..32767). No idle-clock stamp
       (agent injection, the INJECT_KEY rule). */
    WMP_PAD_CONNECT = 0x24,            /* { slot } */
    WMP_PAD_DISCONNECT = 0x25,         /* { slot } */
    WMP_PAD_BUTTON = 0x26,             /* { slot, button, down } */
    WMP_PAD_AXIS = 0x27,               /* { slot, axis, value } */
    WMP_SHOT = 0x30, WMP_SHOT_SCREEN = 0x31,
    WMP_THUMB = 0x32,                  /* { sid, maxW, maxH }: downscaled
                                          front-buffer thumbnail (todos/0063,
                                          Aero Peek) -> R_SHOT { sid, w, h,
                                          rgba }, aspect-fit inside
                                          maxW x maxH, never upscaled;
                                          deterministic box filter */
    WMP_SYSMENU = 0x33,                /* { }: fire the window system-menu
                                          gesture (todos/0102) — wmctl sysmenu
                                          into the same EV_SYSMENU the
                                          Alt+Space chord emits (carries the
                                          FOCUSED sid). R_ERR with no
                                          subscribed WM (the menu IS policy) */
    WMP_CURSOR_AT = 0x34,              /* { xf32, yf32 }: the effective cursor
                                          shape at a SCREEN point (todos/0105)
                                          -> R_CURSOR { shape } (SDL_SystemCursor;
                                          -1 hidden). Pure query — chrome
                                          overlay + per-surface client cursor,
                                          side-effect-free */
    WMP_GRAB_SET = 0x35,               /* { n, n x (scancode, km, token) }:
                                          REPLACE the whole kernel key-grab
                                          table (todos/KEYBINDING-OVERRIDE-
                                          SYSTEM.md §3). Idempotent; n = 0 =
                                          empty table (no interception); n
                                          capped at WMP_GRAB_MAX. Subscriber-
                                          only (R_ERR otherwise). km is the
                                          canonical KM_* mask (keys.h), Shift
                                          excluded unless the entry names it.
                                          Until sent, the kernel uses a built-in
                                          default table reproducing the legacy
                                          cycle/menu/snap/sysmenu chords; last-
                                          subscriber-gone resets to it */
    /* Window overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md). NOTE the
     * numbering: the design doc drafted these at 0x35/0x92 as "the next free
     * slots", but the keybind grab-table chunk landed 0x35 (GRAB_SET) and 0x92
     * (EV_HOTKEY) first — so they take the ACTUAL next-free slots (0x36-0x38
     * commands, 0x93-0x94 events), honouring the doc's stated intent. */
    WMP_OVERVIEW_SET = 0x36,           /* { n, n x (sid, x, y, w, h) }: enter the
                                          overview (or relayout if already up)
                                          with these miniature cell rects. Kernel
                                          validates sids (dead dropped), stores,
                                          bumps. Subscriber-only (R_ERR otherwise
                                          — a presentation takeover) */
    WMP_OVERVIEW_END = 0x37,           /* { }: leave the overview. Subscriber-
                                          only. Pure presentation clear — no
                                          focus/z/geometry change */
    WMP_OVERVIEW = 0x38,               /* { }: command-side gesture (the CYCLE/
                                          MENU pattern) — fires EV_OVERVIEW at the
                                          subscriber; R_ERR with no WM. Serves
                                          `wmctl overview`. (The Ctrl+Alt+E chord
                                          rides the grab table's KTOK_OVERVIEW ->
                                          EV_HOTKEY instead — see keys.h) */
    /* replies */
    WMP_R_OK = 0x40, WMP_R_ERR = 0x41, WMP_R_LIST = 0x42, WMP_R_SHOT = 0x43,
    WMP_R_IDLE = 0x44,                 /* { ms }: the GET_IDLE reply (todos/
                                          0096) — its own type so /bin/wm's
                                          fire-and-forget drain can route it
                                          (the R_SHOT precedent) */
    WMP_R_CURSOR = 0x45,               /* { shape }: the CURSOR_AT reply
                                          (todos/0105; the R_IDLE precedent) */
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
    WMP_EV_TITLE_ACTIVATE = 0x8A,      /* { sid }: title-bar double-click or an
                                          ACTIVATE command (todos/0025) — the
                                          maximize gesture; policy toggles
                                          configure-vs-scale on the RESIZABLE
                                          bit and keeps the saved geometry */
    WMP_EV_CYCLE = 0x8B,               /* { direction }: the cycling chord
                                          (Tab with Alt held; Shift reverses)
                                          or a CYCLE command (todos/0032) —
                                          policy walks focus; only emitted
                                          with a subscriber */
    WMP_EV_MENU = 0x8C,                /* { }: the Start chord (Esc with Ctrl
                                          held) or a MENU command (todos/0078)
                                          — policy toggles the Start menu;
                                          only emitted with a subscriber, else
                                          the chord passes through */
    WMP_EV_SNAP_EDGE = 0x8D,           /* { sid, edge }: mid-title-drag the
                                          pointer entered (edge > 0) or left
                                          (edge 0) a screen-edge snap zone
                                          (todos/0095) — policy shows/hides
                                          the translucent preview. Edges:
                                          1 L, 2 R, 3 top, 4 TL, 5 TR, 6 BL,
                                          7 BR; only with a subscriber */
    WMP_EV_SNAP_DROP = 0x8E,           /* { sid, edge, x0, y0 }: a title drag
                                          that MOVED (past the kernel's 4px
                                          slop — a click emits nothing) was
                                          released (todos/0095), after its
                                          EV_MOVED — edge > 0 commits the snap
                                          (x0/y0 = the PRE-drag position, the
                                          floating rect policy saves); edge 0
                                          on a snapped/maximized window is the
                                          drag-off restore */
    WMP_EV_SNAP_KEY = 0x8F,            /* { direction }: the Win+arrow chord
                                          (arrows with GUI held) or a SNAP
                                          command (todos/0095) — 0 L / 1 R /
                                          2 U / 3 D; policy snaps the focused
                                          window (halves, maximize, restore/
                                          minimize); only with a subscriber */
    WMP_EV_SAVER = 0x90,               /* { }: a SAVER command (todos/0096) —
                                          wmctl saver / the Control Panel
                                          Preview; policy raises the
                                          configured screensaver at once;
                                          only with a subscriber */
    WMP_EV_SYSMENU = 0x91,             /* { sid }: the Alt+Space chord or a
                                          SYSMENU command (todos/0102) —
                                          policy raises the window system menu
                                          (Restore/Move/Size/Minimize/Maximize/
                                          Close) on that (the focused) window;
                                          only with a subscriber, else the
                                          chord passes through */
    WMP_EV_HOTKEY = 0x92,              /* { token, flags, sid }: a NON-reserved
                                          key-grab table entry matched (todos/
                                          KEYBINDING-OVERRIDE-SYSTEM.md §3) —
                                          the ONE event for every user-installed
                                          chord. flags bit0 = Shift, bit1 =
                                          repeat; sid = focused. The default
                                          table's RESERVED tokens (high bit)
                                          emit the legacy events instead; only
                                          with a subscriber */
    WMP_EV_OVERVIEW = 0x93,           /* { }: toggle the window overview
                                          (todos/EXPOSE-MISSION-CONTROL.md) — an
                                          OVERVIEW command (wmctl overview). The
                                          Ctrl+Alt+E chord reaches wm.c via
                                          EV_HOTKEY { KTOK_OVERVIEW } instead
                                          (the grab table); this is the command-
                                          side twin, the EV_MENU pattern. Only
                                          with a subscriber */
    WMP_EV_OVERVIEW_PICK = 0x94,      /* { sid }: while the overview is up the
                                          user chose — a pointer-down landed in
                                          cell `sid`, or dismissed (sid = 0:
                                          background click or Esc). Policy exits
                                          and (sid != 0) restores+focuses+raises
                                          that window */
};

#define WMP_GRAB_MAX 64                /* GRAB_SET n cap (kernel WM_GRAB_MAX) */
#define WMP_TOK_RESERVED 0x80000000    /* grab token high bit = legacy emit */

/* The fixed 80-byte window record (EV_CREATED payload; R_LIST carries
 * u32 count then count of these). No padding: 12 i32 + 32 bytes.
 * dst_w/dst_h: the on-screen viewport (todos/0024) — equals w/h unless
 * the surface is scaled. layer: the z layer (todos/0038; was reserved) —
 * -1 bottom / 0 normal / +1 top. */
typedef struct {
    int32_t sid, pid, x, y, w, h, z, flags, frame_seq, dst_w, dst_h, layer;
    char title[32];                    /* NUL-padded, always terminated */
} wmp_rec;
#define WMP_F_FOCUSED    1
#define WMP_F_MINIMIZED  2
#define WMP_F_BORDERLESS 4
#define WMP_F_RELMOUSE   8   /* surface requested relative mouse (todos/0018) */
#define WMP_F_RESIZABLE 16   /* SDL_WINDOW_RESIZABLE: RESIZE allowed (0021) */
#define WMP_F_ALPHA     32   /* SDL_WINDOW_TRANSPARENT: per-pixel alpha,
                                composited src-over (todos/0063) */
#define WMP_F_ANCHORED  64   /* anchored child surface (todos/0256): pinned
                                to a same-process parent, moved/hidden/
                                raised/destroyed/scaled with it, never
                                focused; always borderless. WM geometry/
                                stacking/minimize ops refuse it (EPERM) —
                                policy never manages popups. */
#define WMP_F_TRANSIENT 128  /* transient/owned window (todos/0281): a framed,
                                focusable modal (MessageBox, dialogs) that Win95
                                never lists in the taskbar. Unlike ANCHORED it
                                keeps chrome + focus; /bin/wm just gives it no
                                taskbar button and skips it when cycling (kept
                                out of wins[], but still placed so it maps). The
                                same flag could later suppress its min/max title
                                boxes — not implemented here (0281 scope note). */

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
        if (n <= 0) {                  /* EOF or error: connection gone */
            if (n == 0) errno = ECONNRESET;   /* EOF leaves errno stale —
                                                 name the real condition so
                                                 callers' strerror() reports
                                                 are truthful (todos/0234) */
            return -1;
        }
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

/* Send one command frame with n i32 args, n NOT capped at wmp_send's small
 * fast-path limit — GRAB_SET's replace-whole-table payload is 1 + 3*n triples
 * (up to 1 + 3*WMP_GRAB_MAX), and OVERVIEW_SET's is 1 + 5*n cell tuples (up to
 * 1 + 5*WMP_GRAB_MAX; MAX_WIN <= WMP_GRAB_MAX). Same wire format as wmp_send (a
 * single write, so the frame is atomic on the stream). Returns 0, or -1. */
static int wmp_sendv(int fd, uint32_t type, const int32_t *args, int nargs) {
    uint32_t buf[2 + 1 + 5 * WMP_GRAB_MAX];      /* header + largest such payload */
    if (nargs < 0 || (size_t)nargs > (sizeof buf / sizeof buf[0]) - 2) return -1;
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

/* Consume a reply frame's payload, surfacing the kernel's cause (todos/
 * 0242). An R_ERR reply carries one i32 errno naming the REAL failure —
 * EINVAL bad/unknown sid or args, EPERM the surface's mode forbids the op
 * (resize a non-resizable / scale a resizable / maximize a borderless),
 * ENODEV no WM subscribed, ESRCH the target's process is gone, EAGAIN its
 * event ring is full, ENOSYS unknown op (MUST MATCH kernel.js WMP_ERRNO).
 * That value lands in errno and -1 comes back; any other reply type is just
 * skipped (returns 0). Lets every caller — wmp_cmd and the typed-reply
 * paths (R_SHOT, R_LIST, ...) — report strerror(errno) on refusal. */
static int wmp_consume_err(int fd, const wmp_hdr *h) {
    if (h->type != WMP_R_ERR) return wmp_skip(fd, h->plen);
    int32_t e = 0;
    uint32_t left = h->plen;
    if (left >= 4) {
        if (wmp_read_all(fd, &e, 4) != 0) return -1;
        left -= 4;
    }
    if (wmp_skip(fd, left) != 0) return -1;
    errno = e > 0 ? (int)e : EIO;      /* payload-less R_ERR: unknowable */
    return -1;
}

/* One-shot command -> R_OK/R_ERR. Returns 0 on R_OK, -1 otherwise — the
 * legacy contract, unchanged. Additionally (todos/0242) a failure sets
 * errno to the cause: the R_ERR payload errno (see wmp_consume_err above),
 * EIO on a non-OK/non-ERR reply, or the transport errno from read/write
 * (ECONNRESET on EOF, the 0234 shape). */
static int wmp_cmd(int fd, uint32_t type, const int32_t *args, int nargs) {
    wmp_hdr h;
    if (wmp_send(fd, type, args, nargs) != 0) return -1;
    if (wmp_next_reply(fd, &h) != 0) return -1;
    if (h.type == WMP_R_OK) return wmp_skip(fd, h.plen);
    if (wmp_consume_err(fd, &h) == 0) errno = EIO;   /* unexpected reply type */
    return -1;
}

#endif /* WM_PROTO_H */
