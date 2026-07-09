/* wm_agent.h — the win32 agent-tree protocol (todos/0058; design
 * todos/WIN32.md "Agent-drivability").
 *
 * Every user32 process serves its HWND tree on an AF_UNIX socket at
 * /run/win32/agent.<pid>.sock (bound at the first CreateWindowEx,
 * unlinked at exit). wmctl discovers apps by scanning WM_AGENT_DIR and
 * speaks one request per connection: the app's GetMessage idle loop
 * accepts, serves the request, replies, and closes.
 *
 * Framing mirrors wm_proto.h (little-endian, wasm-native):
 *   u32 len (bytes that follow: 4 + payload) | u32 type | payload
 * Request payloads are UTF-8 text (a target label); replies carry text
 * (the tree dump / window text) or nothing.
 *
 * Targets resolve by WINDOW TEXT, never pixels (OS.md's agent-target
 * pillar): '&' mnemonics are stripped before matching; "CLASS:n" (e.g.
 * "EDIT:0") addresses the nth window of a class in tree order, for
 * controls whose text is their content.
 *
 * MUST MATCH os/win32/user32.c (the serving side) and os/wmctl.c (the
 * driving side).
 */
#ifndef WM_AGENT_H
#define WM_AGENT_H

#include <stdint.h>
#include <unistd.h>

#define WM_AGENT_DIR "/run/win32"
#define WM_AGENT_SOCK_FMT "/run/win32/agent.%d.sock"

enum {
    /* requests */
    AQ_TREE    = 0x01,   /* payload none; reply AQ_R_TEXT: the tree dump */
    AQ_CLICK   = 0x02,   /* payload label; BUTTON -> BM_CLICK, else a
                            synthetic client-center click */
    AQ_GETTEXT = 0x03,   /* payload label; reply AQ_R_TEXT: WM_GETTEXT */
    AQ_SETTEXT = 0x04,   /* payload label \0 text; WM_SETTEXT */
    /* replies */
    AQ_R_OK    = 0x40,   /* action done (payload none) */
    AQ_R_ERR   = 0x41,   /* no such target / bad request (payload none) */
    AQ_R_TEXT  = 0x42,   /* payload: UTF-8 text */
};

static int aq_write_all(int fd, const void *buf, int len) {
    const char *p = (const char *)buf;
    while (len > 0) {
        int n = (int)write(fd, p, (size_t)len);
        if (n <= 0) return -1;
        p += n; len -= n;
    }
    return 0;
}

static int aq_read_all(int fd, void *buf, int len) {
    char *p = (char *)buf;
    while (len > 0) {
        int n = (int)read(fd, p, (size_t)len);
        if (n <= 0) return -1;
        p += n; len -= n;
    }
    return 0;
}

/* Send one frame. */
static int aq_send(int fd, uint32_t type, const void *payload, uint32_t plen) {
    uint32_t hd[2] = { 4u + plen, type };
    if (aq_write_all(fd, hd, 8) != 0) return -1;
    if (plen && aq_write_all(fd, payload, (int)plen) != 0) return -1;
    return 0;
}

/* Read the next frame header; payload (*plen bytes) is the caller's. */
static int aq_next(int fd, uint32_t *type, uint32_t *plen) {
    uint32_t hd[2];
    if (aq_read_all(fd, hd, 8) != 0) return -1;
    if (hd[0] < 4) return -1;
    *type = hd[1];
    *plen = hd[0] - 4;
    return 0;
}

#endif /* WM_AGENT_H */
