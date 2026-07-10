/* wmctl.c — /bin/wmctl, xdotool-as-a-syscall (todos/0014; WM.md "Agent
 * control channel"). One connection per invocation to the kernel's WM
 * endpoint (wm_proto.h); unsubscribed, so the stream carries only replies.
 *
 *   wmctl list                        windows: SID PID GEOM DST Z FLAGS TITLE
 *   wmctl focus|min|restore|close|raise|lower SID
 *   wmctl move SID X Y
 *   wmctl resize SID W H              asks the client; applies at its ack
 *   wmctl scale SID W H               sets a fixed-size window's on-screen
 *                                     dst rect (todos/0024); app oblivious
 *   wmctl max SID                     toggle maximize/restore (todos/0025) —
 *                                     the title double-click gesture; policy
 *                                     lives in /bin/wm, so this needs one
 *   wmctl cycle [DIR]                 cycle focus (todos/0032) — the Alt+Tab
 *                                     chord's event; DIR -1 reverses (the
 *                                     previous-window toggle); needs a WM
 *   wmctl menu                        toggle the Start menu (todos/0078) —
 *                                     the Ctrl+Esc chord's event; needs a WM
 *   wmctl layer SID L                 pin to a z layer (todos/0038): -1
 *                                     bottom, 0 normal, 1 top; z ops never
 *                                     cross layers (list flags: T/B)
 *   wmctl key SID SCANCODE [KEYSYM [MOD]]      key press (down+up)
 *   wmctl click SID X Y [BUTTON]               click (down+up), local coords
 *   wmctl dblclick SID X Y [BUTTON]            two clicks on one connection
 *                                     (fast enough for client double-click
 *                                     detection — todos/0029 desktop icons)
 *   wmctl hover SID X Y               absolute motion injection (todos/0063
 *                                     — drives hover UI like Aero Peek)
 *   wmctl relmove SID DX DY           relative motion (pointer-lock deltas)
 *   wmctl shot SID|screen [FILE]               PPM (P6) to FILE or stdout
 *   wmctl thumb SID [MAXW MAXH] [FILE]         downscaled window thumbnail
 *                                     (todos/0063 Aero Peek; default 96x72
 *                                     box; aspect-fit, never upscaled), PPM
 *   wmctl glass 0|1                   Aero glass tier toggle (todos/0063) —
 *                                     browser compositor only; the headless
 *                                     composite/goldens never change
 *
 * The win32 agent tree (todos/0058; wm_agent.h — served per-process by
 * user32 on /run/win32/agent.<pid>.sock, discovered by directory scan):
 *
 *   wmctl tree                        dump every win32 app's HWND tree
 *   wmctl click LABEL                 press the widget with that text —
 *                                     resolved BY LABEL, never pixels
 *                                     (BM_CLICK on buttons); "CLASS:n"
 *                                     (e.g. EDIT:0) addresses the nth
 *                                     window of a class in tree order
 *   wmctl gettext LABEL               print the widget's WM_GETTEXT text
 *   wmctl settext LABEL TEXT          set it (WM_SETTEXT)
 *
 * SID 0 targets the focused window (key/click/shot). `click` with ONE
 * argument is always the label form — numeric labels included (calc's
 * digit keys are buttons named "7"); there is no bare `click SID`, so
 * nothing is lost. With SID X Y it is the pixel injection above.
 * Exit: 0 ok, 1 command failed / WM endpoint unreachable, 2 usage.
 */
#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "wm_proto.h"
#include "wm_agent.h"

static int fail(const char *msg) { fprintf(stderr, "wmctl: %s\n", msg); return 1; }

static int usage(void) {
    fprintf(stderr,
        "usage: wmctl list\n"
        "       wmctl focus|min|restore|close|raise|lower SID\n"
        "       wmctl move SID X Y\n"
        "       wmctl resize SID W H\n"
        "       wmctl scale SID W H\n"
        "       wmctl max SID\n"
        "       wmctl cycle [DIR]\n"
        "       wmctl menu\n"
        "       wmctl layer SID -1|0|1\n"
        "       wmctl key SID SCANCODE [KEYSYM [MOD]]\n"
        "       wmctl click SID X Y [BUTTON]\n"
        "       wmctl dblclick SID X Y [BUTTON]\n"
        "       wmctl hover SID X Y\n"
        "       wmctl relmove SID DX DY\n"
        "       wmctl shot SID|screen [FILE]\n"
        "       wmctl thumb SID [MAXW MAXH] [FILE]\n"
        "       wmctl glass 0|1\n"
        "       wmctl tree\n"
        "       wmctl click LABEL\n"
        "       wmctl gettext LABEL\n"
        "       wmctl settext LABEL TEXT\n");
    return 2;
}

/* ---- the win32 agent tree (todos/0058; wm_agent.h) ----
 * Scan /run/win32 for agent sockets; one request per connection. Actions
 * take the FIRST app that accepts the label; tree dumps them all. */

static int agent_connect(const char *sockName) {
    char path[128];
    snprintf(path, sizeof path, "%s/%s", WM_AGENT_DIR, sockName);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strncpy(sa.sun_path, path, sizeof sa.sun_path - 1);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) { close(fd); return -1; }
    return fd;
}

static int agent_is_sock(const char *name) {
    return strncmp(name, "agent.", 6) == 0 &&
           strlen(name) > 11 && strcmp(name + strlen(name) - 5, ".sock") == 0;
}

/* Visit every agent socket; fn returns 1 to stop (handled). Returns the
 * number of sockets visited, or -1 if the dir is missing. */
typedef int (*AgentFn)(int fd, const char *name, void *ctx);

static int agent_scan(AgentFn fn, void *ctx) {
    DIR *d = opendir(WM_AGENT_DIR);
    if (!d) return -1;
    struct dirent *de;
    int visited = 0, stop = 0;
    while (!stop && (de = readdir(d)) != NULL) {
        if (!agent_is_sock(de->d_name)) continue;
        int fd = agent_connect(de->d_name);
        if (fd < 0) continue;                    /* stale socket: app gone */
        visited++;
        stop = fn(fd, de->d_name, ctx);
        close(fd);
    }
    closedir(d);
    return visited;
}

static int tree_one(int fd, const char *name, void *ctx) {
    (void)ctx;
    if (aq_send(fd, AQ_TREE, NULL, 0) != 0) return 0;
    uint32_t type, plen;
    if (aq_next(fd, &type, &plen) != 0 || type != AQ_R_TEXT) return 0;
    int pid = atoi(name + 6);
    printf("== pid %d\n", pid);
    char buf[512];
    while (plen > 0) {
        uint32_t c = plen > sizeof buf ? (uint32_t)sizeof buf : plen;
        if (aq_read_all(fd, buf, (int)c) != 0) return 0;
        fwrite(buf, 1, c, stdout);
        plen -= c;
    }
    return 0;                                    /* keep going: dump all apps */
}

typedef struct { const char *label; const char *text; int done; char *out; } AgentReq;

static int click_one(int fd, const char *name, void *ctx) {
    (void)name;
    AgentReq *rq = (AgentReq *)ctx;
    if (aq_send(fd, AQ_CLICK, rq->label, (uint32_t)strlen(rq->label)) != 0) return 0;
    uint32_t type, plen;
    if (aq_next(fd, &type, &plen) != 0) return 0;
    while (plen > 0) { char sink[256]; uint32_t c = plen > 256 ? 256 : plen; if (aq_read_all(fd, sink, (int)c) != 0) return 0; plen -= c; }
    if (type != AQ_R_OK) return 0;
    rq->done = 1;
    return 1;
}

static int gettext_one(int fd, const char *name, void *ctx) {
    (void)name;
    AgentReq *rq = (AgentReq *)ctx;
    if (aq_send(fd, AQ_GETTEXT, rq->label, (uint32_t)strlen(rq->label)) != 0) return 0;
    uint32_t type, plen;
    if (aq_next(fd, &type, &plen) != 0) return 0;
    if (type != AQ_R_TEXT) { wmp_skip(fd, plen); return 0; }
    rq->out = (char *)malloc(plen + 1);
    if (!rq->out || aq_read_all(fd, rq->out, (int)plen) != 0) return 0;
    rq->out[plen] = 0;
    rq->done = 1;
    return 1;
}

static int settext_one(int fd, const char *name, void *ctx) {
    (void)name;
    AgentReq *rq = (AgentReq *)ctx;
    size_t ll = strlen(rq->label), tl = strlen(rq->text);
    char *payload = (char *)malloc(ll + 1 + tl);
    if (!payload) return 0;
    memcpy(payload, rq->label, ll);
    payload[ll] = 0;
    memcpy(payload + ll + 1, rq->text, tl);
    int rc = aq_send(fd, AQ_SETTEXT, payload, (uint32_t)(ll + 1 + tl));
    free(payload);
    if (rc != 0) return 0;
    uint32_t type, plen;
    if (aq_next(fd, &type, &plen) != 0) return 0;
    wmp_skip(fd, plen);
    if (type != AQ_R_OK) return 0;
    rq->done = 1;
    return 1;
}

static int do_agent(const char *cmd, const char *label, const char *text) {
    AgentReq rq = { label, text, 0, NULL };
    int visited;
    if (!strcmp(cmd, "tree")) {
        visited = agent_scan(tree_one, &rq);
        if (visited <= 0) return fail("no win32 apps (nothing under /run/win32)");
        return 0;
    }
    if (!strcmp(cmd, "click")) visited = agent_scan(click_one, &rq);
    else if (!strcmp(cmd, "gettext")) visited = agent_scan(gettext_one, &rq);
    else visited = agent_scan(settext_one, &rq);
    if (visited <= 0) return fail("no win32 apps (nothing under /run/win32)");
    if (!rq.done) return fail("no widget with that label");
    if (rq.out) {
        printf("%s\n", rq.out);
        free(rq.out);
    }
    return 0;
}

static int32_t f32bits(float v) { int32_t b; memcpy(&b, &v, 4); return b; }

static int do_list(int fd) {
    wmp_hdr h;
    if (wmp_send(fd, WMP_LIST, NULL, 0) != 0 || wmp_next_reply(fd, &h) != 0)
        return fail("protocol error");
    if (h.type != WMP_R_LIST) { wmp_skip(fd, h.plen); return fail("LIST refused"); }
    int32_t count;
    if (wmp_read_all(fd, &count, 4) != 0) return fail("short reply");
    printf("SID\tPID\tGEOMETRY\tDST\tZ\tFLAGS\tTITLE\n");
    for (int32_t i = 0; i < count; i++) {
        wmp_rec r;
        if (wmp_read_all(fd, &r, (int)sizeof r) != 0) return fail("short record");
        char flags[8] = "------";      /* [6] only for pinned layers (0038) */
        if (r.flags & WMP_F_FOCUSED)    flags[0] = 'f';
        if (r.flags & WMP_F_MINIMIZED)  flags[1] = 'm';
        if (r.flags & WMP_F_BORDERLESS) flags[2] = 'b';
        if (r.flags & WMP_F_RELMOUSE)   flags[3] = 'r';
        if (r.flags & WMP_F_RESIZABLE)  flags[4] = 'R';
        if (r.flags & WMP_F_ALPHA)      flags[5] = 'A';   /* todos/0063 */
        if (r.layer > 0) flags[6] = 'T';
        else if (r.layer < 0) flags[6] = 'B';
        r.title[31] = 0;
        char dst[32] = "-";            /* scaled viewport (todos/0024), or - */
        if (r.dst_w != r.w || r.dst_h != r.h)
            snprintf(dst, sizeof dst, "%dx%d", r.dst_w, r.dst_h);
        printf("%d\t%d\t%dx%d+%d+%d\t%s\t%d\t%s\t%s\n",
               r.sid, r.pid, r.w, r.h, r.x, r.y, dst, r.z, flags, r.title);
    }
    return 0;
}

/* Read an R_SHOT payload (sid, w, h; then w*h*4 rgba) and write it as PPM
 * (P6, alpha dropped) — shared by shot and thumb (todos/0063). */
static int shot_to_ppm(int fd, const char *file) {
    int32_t head[3];
    if (wmp_read_all(fd, head, 12) != 0) return fail("short reply");
    int w = head[1], hh = head[2];
    uint8_t *rgba = (uint8_t *)malloc((size_t)w * hh * 4);
    if (!rgba || wmp_read_all(fd, rgba, w * hh * 4) != 0) return fail("short pixels");
    FILE *out = file ? fopen(file, "wb") : stdout;
    if (!out) return fail("cannot open output file");
    fprintf(out, "P6\n%d %d\n255\n", w, hh);
    for (int i = 0; i < w * hh; i++) fwrite(rgba + i * 4, 1, 3, out);   /* drop alpha */
    if (file) fclose(out);
    free(rgba);
    return 0;
}

static int do_shot(int fd, const char *what, const char *file) {
    int screen = strcmp(what, "screen") == 0;
    int32_t a[1] = { screen ? 0 : (int32_t)atoi(what) };
    wmp_hdr h;
    if (wmp_send(fd, screen ? WMP_SHOT_SCREEN : WMP_SHOT, a, screen ? 0 : 1) != 0 ||
        wmp_next_reply(fd, &h) != 0)
        return fail("protocol error");
    if (h.type != WMP_R_SHOT) { wmp_skip(fd, h.plen); return fail("no such surface"); }
    return shot_to_ppm(fd, file);
}

/* Aero Peek thumbnail (todos/0063): a downscaled window as PPM. */
static int do_thumb(int fd, int32_t sid, int32_t mw, int32_t mh, const char *file) {
    int32_t a[3] = { sid, mw, mh };
    wmp_hdr h;
    if (wmp_send(fd, WMP_THUMB, a, 3) != 0 || wmp_next_reply(fd, &h) != 0)
        return fail("protocol error");
    if (h.type != WMP_R_SHOT) { wmp_skip(fd, h.plen); return fail("no such surface"); }
    return shot_to_ppm(fd, file);
}

int main(int argc, char **argv) {
    if (argc < 2) return usage();
    const char *cmd = argv[1];

    /* Agent-tree ops (todos/0058) talk to apps, not the kernel endpoint. */
    if (!strcmp(cmd, "tree")) return do_agent(cmd, NULL, NULL);
    if (!strcmp(cmd, "gettext")) {
        if (argc < 3) return usage();
        return do_agent(cmd, argv[2], NULL);
    }
    if (!strcmp(cmd, "settext")) {
        if (argc < 4) return usage();
        return do_agent(cmd, argv[2], argv[3]);
    }
    if (!strcmp(cmd, "click") && argc == 3)
        return do_agent(cmd, argv[2], NULL);     /* click by LABEL, no pixels —
                                                    numeric labels too (0048:
                                                    calc's "7"); a pixel click
                                                    always carries X Y */

    int fd = wmp_connect();
    if (fd < 0) return fail("cannot reach /run/wm.sock (no kernel WM endpoint?)");

    if (!strcmp(cmd, "list")) return do_list(fd);
    if (!strcmp(cmd, "shot")) {
        if (argc < 3) return usage();
        return do_shot(fd, argv[2], argc > 3 ? argv[3] : NULL);
    }
    if (!strcmp(cmd, "cycle")) {        /* window cycling (todos/0032) */
        int32_t a[1] = { argc > 2 ? atoi(argv[2]) : 1 };
        return wmp_cmd(fd, WMP_CYCLE, a, 1) ? fail("cycle refused (no WM?)") : 0;
    }
    if (!strcmp(cmd, "menu")) {         /* Start menu toggle (todos/0078) */
        return wmp_cmd(fd, WMP_MENU, NULL, 0) ? fail("menu refused (no WM?)") : 0;
    }
    if (!strcmp(cmd, "glass")) {        /* Aero glass tier (todos/0063) */
        if (argc < 3) return usage();
        int32_t a[1] = { atoi(argv[2]) };
        return wmp_cmd(fd, WMP_GLASS, a, 1) ? fail("glass refused") : 0;
    }

    /* Everything else leads with a SID. */
    if (argc < 3) return usage();
    int32_t sid = (int32_t)atoi(argv[2]);

    if (!strcmp(cmd, "focus") || !strcmp(cmd, "restore")) {
        int32_t a[1] = { sid };
        return wmp_cmd(fd, !strcmp(cmd, "focus") ? WMP_FOCUS : WMP_RESTORE, a, 1)
            ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "min")) {
        int32_t a[1] = { sid };
        return wmp_cmd(fd, WMP_MINIMIZE, a, 1) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "close")) {
        int32_t a[1] = { sid };
        return wmp_cmd(fd, WMP_CLOSE_REQ, a, 1) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "raise") || !strcmp(cmd, "lower")) {
        int32_t a[2] = { sid, !strcmp(cmd, "lower") };
        return wmp_cmd(fd, WMP_RESTACK, a, 2) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "move")) {
        if (argc < 5) return usage();
        int32_t a[3] = { sid, atoi(argv[3]), atoi(argv[4]) };
        return wmp_cmd(fd, WMP_MOVE, a, 3) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "resize")) {
        if (argc < 5) return usage();
        int32_t a[3] = { sid, atoi(argv[3]), atoi(argv[4]) };
        return wmp_cmd(fd, WMP_RESIZE, a, 3) ? fail("resize refused") : 0;
    }
    if (!strcmp(cmd, "scale")) {        /* viewport scaling (todos/0024) */
        if (argc < 5) return usage();
        int32_t a[3] = { sid, atoi(argv[3]), atoi(argv[4]) };
        return wmp_cmd(fd, WMP_SET_DST, a, 3) ? fail("scale refused") : 0;
    }
    if (!strcmp(cmd, "max")) {          /* maximize toggle (todos/0025) */
        int32_t a[1] = { sid };
        return wmp_cmd(fd, WMP_ACTIVATE, a, 1) ? fail("max refused (no WM?)") : 0;
    }
    if (!strcmp(cmd, "layer")) {        /* z-layer pin (todos/0038) */
        if (argc < 4) return usage();
        int32_t a[2] = { sid, atoi(argv[3]) };
        return wmp_cmd(fd, WMP_SET_LAYER, a, 2) ? fail("layer refused") : 0;
    }
    if (!strcmp(cmd, "thumb")) {        /* Aero Peek thumbnail (todos/0063):
                                           thumb SID [MAXW MAXH] [FILE] —
                                           argc 4 means FILE, argc >= 5 means
                                           the dims lead (0 = kernel default) */
        int32_t mw = 0, mh = 0;
        const char *file = NULL;
        if (argc >= 5) { mw = atoi(argv[3]); mh = atoi(argv[4]); file = argc > 5 ? argv[5] : NULL; }
        else if (argc == 4) file = argv[3];
        return do_thumb(fd, sid, mw, mh, file);
    }
    if (!strcmp(cmd, "key")) {
        if (argc < 4) return usage();
        int32_t sc = atoi(argv[3]);
        int32_t sym = argc > 4 ? atoi(argv[4]) : 0;
        int32_t mod = argc > 5 ? atoi(argv[5]) : 0;
        int32_t a[5] = { sid, 1, sc, sym, mod };
        if (wmp_cmd(fd, WMP_INJECT_KEY, a, 5)) return fail("no such window");
        a[1] = 0;
        return wmp_cmd(fd, WMP_INJECT_KEY, a, 5) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "hover")) {        /* absolute motion (todos/0063) */
        if (argc < 5) return usage();
        int32_t x = f32bits((float)atoi(argv[3])), y = f32bits((float)atoi(argv[4]));
        int32_t a[6] = { sid, 0 /* move */, x, y, 0, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "relmove")) {      /* relative motion (todos/0018) */
        if (argc < 5) return usage();
        int32_t dx = f32bits((float)atoi(argv[3])), dy = f32bits((float)atoi(argv[4]));
        int32_t a[6] = { sid, 4 /* rel */, dx, dy, 0, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "click") || !strcmp(cmd, "dblclick")) {
        if (argc < 5) return usage();
        int32_t x = f32bits((float)atoi(argv[3])), y = f32bits((float)atoi(argv[4]));
        int32_t btn = argc > 5 ? atoi(argv[5]) : 1;
        int reps = cmd[0] == 'd' ? 2 : 1;   /* dblclick: both clicks ride one
                                               connection, ms apart (0029) */
        for (int i = 0; i < reps; i++) {
            int32_t a[6] = { sid, 1 /* down */, x, y, btn, 0 };
            if (wmp_cmd(fd, WMP_INJECT_POINTER, a, 6)) return fail("no such window");
            a[1] = 2;                   /* up */
            if (wmp_cmd(fd, WMP_INJECT_POINTER, a, 6)) return fail("no such window");
        }
        return 0;
    }
    return usage();
}
