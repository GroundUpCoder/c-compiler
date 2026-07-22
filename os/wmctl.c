/* wmctl.c — /bin/wmctl, xdotool-as-a-syscall (todos/0014; WM.md "Agent
 * control channel"). One connection per invocation to the kernel's WM
 * endpoint (wm_proto.h); unsubscribed, so the stream carries only replies.
 *
 *   wmctl list                        windows: SID PID GEOM DST Z FLAGS TITLE
 *   wmctl wait COND ARGS... [MS]      block until an observable WM condition
 *                                     holds (todos/0083) — replaces the
 *                                     `sleep N` guess-waits in the e2e/browser
 *                                     drivers; MS (default 15000) is a FAILURE
 *                                     deadline (exit 1 on timeout), not a sync
 *                                     point. Conditions:
 *                                       win TITLE / nowin TITLE
 *                                       count TITLE N / atleast TITLE N
 *                                       gone SID
 *                                       flag SID CH / noflag SID CH
 *                                       seq SID N   (frame_seq >= N)
 *                                       dim SID WxH (buffer geometry ==)
 *                                       dst SID WxH (on-screen dst rect ==)
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
 *   wmctl snap left|right|up|down     Aero Snap the focused window (todos/
 *                                     0095) — the Win+arrow chord's event
 *                                     (halves / maximize / restore-or-
 *                                     minimize); needs a WM
 *   wmctl idle                        print ms since the last real input
 *                                     (todos/0096 — the kernel's idle clock
 *                                     the screensaver policy polls)
 *   wmctl saver                       raise the configured screensaver now
 *                                     (todos/0096) — the Control Panel
 *                                     Preview's event; needs a WM
 *   wmctl sysmenu                     open the window system menu (todos/
 *                                     0102) on the FOCUSED window — the
 *                                     Alt+Space chord's event; needs a WM
 *   wmctl overview                    toggle the window overview / Exposé
 *                                     (todos/EXPOSE) — the Ctrl+Alt+E chord's
 *                                     event; needs a WM
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
 *   wmctl wheel SID DY                mouse-wheel injection (todos/0210):
 *                                     DY in NOTCHES, + scrolls up; the
 *                                     event's position is the last tracked
 *                                     motion, so hover first
 *   wmctl relmove SID DX DY           relative motion (pointer-lock deltas)
 *   wmctl sdown|smove|sup X Y [BTN]   SCREEN-coordinate injection (todos/
 *                                     0095) through the kernel's full
 *                                     hit-test/chrome path — what a real
 *                                     mouse does: title drags, edge snap,
 *                                     border resizes. No SID: the scene
 *                                     routes the event
 *   wmctl sdrag X1 Y1 X2 Y2           press-move-release at screen coords
 *                                     (down, midpoint + endpoint motion, up)
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
 *   wmctl wait label|nolabel LABEL [MS]   block until a widget with that
 *                                     label exists / is gone in ANY app
 *                                     (todos/0154 — over the agent tree, so
 *                                     it sees in-surface control state the
 *                                     kernel window list can't: a dialog's
 *                                     listbox, an EDIT, a MessageBox button)
 *   wmctl wait text LABEL SUBSTR [MS]     block until that widget's text
 *                                     contains SUBSTR
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
#include <time.h>
#include <unistd.h>
#include "wm_proto.h"
#include "wm_agent.h"

static int fail(const char *msg) { fprintf(stderr, "wmctl: %s\n", msg); return 1; }

/* A refused command: name the kernel's REAL cause (todos/0242 — wmp_cmd /
 * wmp_consume_err put the R_ERR errno in errno). ENODEV keeps the old
 * "needs a WM" hint: policy gestures refuse when no WM is subscribed. */
static int failop(const char *op) {
    int e = errno;
    fprintf(stderr, "wmctl: %s: %s%s\n", op, strerror(e),
            e == ENODEV ? " (no WM subscribed)" : "");
    return 1;
}

static int usage(void) {
    fprintf(stderr,
        "usage: wmctl list\n"
        "       wmctl wait win|nowin TITLE [MS]\n"
        "       wmctl wait count|atleast TITLE N [MS]\n"
        "       wmctl wait gone SID [MS]\n"
        "       wmctl wait flag|noflag SID CHAR [MS]\n"
        "       wmctl wait seq SID N [MS]\n"
        "       wmctl wait dim|dst SID WxH [MS]\n"
        "       wmctl wait label|nolabel LABEL [MS]\n"
        "       wmctl wait text LABEL SUBSTR [MS]\n"
        "       wmctl focus|min|restore|close|raise|lower SID\n"
        "       wmctl move SID X Y\n"
        "       wmctl resize SID W H\n"
        "       wmctl scale SID W H\n"
        "       wmctl max SID\n"
        "       wmctl cycle [DIR]\n"
        "       wmctl menu\n"
        "       wmctl snap left|right|up|down\n"
        "       wmctl idle\n"
        "       wmctl cursor X Y\n"
        "       wmctl saver\n"
        "       wmctl sysmenu\n"
        "       wmctl overview\n"
        "       wmctl layer SID -1|0|1\n"
        "       wmctl key SID SCANCODE [KEYSYM [MOD]]\n"
        "       wmctl keydown|keyup SID SCANCODE [KEYSYM [MOD]]\n"
        "       wmctl click SID X Y [BUTTON]\n"
        "       wmctl dblclick SID X Y [BUTTON]\n"
        "       wmctl down|up SID X Y [BUTTON]\n"
        "       wmctl drag SID X1 Y1 X2 Y2 [BUTTON]\n"
        "       wmctl hover SID X Y\n"
        "       wmctl wheel SID DY\n"
        "       wmctl relmove SID DX DY\n"
        "       wmctl sdown|smove|sup X Y [BUTTON]\n"
        "       wmctl sdrag X1 Y1 X2 Y2 [BUTTON]\n"
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

/* ---- agent-tree waits (todos/0154) ----
 * A single AQ_GETTEXT probe against one app: does LABEL resolve here, and
 * (optionally) does its text contain SUBSTR? Reuses the label resolver that
 * `wmctl click LABEL`/`gettext` already share, so a wait keys on the SAME
 * string a later action will. `found` is set the moment a match lands. */
typedef struct { const char *label; const char *substr; int found; char *text; } AgentProbe;

static int probe_one(int fd, const char *name, void *ctx) {
    (void)name;
    AgentProbe *p = (AgentProbe *)ctx;
    if (aq_send(fd, AQ_GETTEXT, p->label, (uint32_t)strlen(p->label)) != 0) return 0;
    uint32_t type, plen;
    if (aq_next(fd, &type, &plen) != 0) return 0;
    if (type != AQ_R_TEXT) { wmp_skip(fd, plen); return 0; }   /* not in this app */
    char *buf = (char *)malloc(plen + 1);
    if (!buf || aq_read_all(fd, buf, (int)plen) != 0) { free(buf); return 0; }
    buf[plen] = 0;
    if (p->substr && !strstr(buf, p->substr)) { free(buf); return 0; }  /* text not there yet — keep scanning */
    p->found = 1;
    free(p->text);
    p->text = buf;
    return 1;                                    /* matched: stop the scan */
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

/* The 8-char FLAGS column (shared by `list` and `wait`): f m b r R A, a T/B
 * slot for pinned z-layers (todos/0038), then U for a transient/owned modal
 * (todos/0281 — no taskbar button, skipped by cycling). Kept in one place so
 * the two readers never drift. */
static void rec_flags(const wmp_rec *r, char flags[9]) {
    memcpy(flags, "--------", 8);
    if (r->flags & WMP_F_FOCUSED)    flags[0] = 'f';
    if (r->flags & WMP_F_MINIMIZED)  flags[1] = 'm';
    if (r->flags & WMP_F_BORDERLESS) flags[2] = 'b';
    if (r->flags & WMP_F_RELMOUSE)   flags[3] = 'r';
    if (r->flags & WMP_F_RESIZABLE)  flags[4] = 'R';
    if (r->flags & WMP_F_ALPHA)      flags[5] = 'A';
    if (r->layer > 0) flags[6] = 'T';
    else if (r->layer < 0) flags[6] = 'B';
    if (r->flags & WMP_F_TRANSIENT)  flags[7] = 'U';
    flags[8] = 0;
}

/* ---- event-based waits (todos/0083) ----
 * Poll WMP_LIST on the open connection until a condition holds, replacing
 * the `sleep N` guess-waits that littered the e2e/browser drivers. The
 * timeout is a FAILURE deadline (exit 1), not a sync point. */

static long wm_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Fetch the current window list into recs[] (capped at max); returns the
 * count, or -1 on protocol error. Reuses the caller's open fd. */
static int wm_fetch(int fd, wmp_rec *recs, int max) {
    if (wmp_send(fd, WMP_LIST, NULL, 0) != 0) return -1;
    wmp_hdr h;
    if (wmp_next_reply(fd, &h) != 0) return -1;
    if (h.type != WMP_R_LIST) { wmp_skip(fd, h.plen); return -1; }
    int32_t count;
    if (wmp_read_all(fd, &count, 4) != 0) return -1;
    int n = 0;
    for (int32_t i = 0; i < count; i++) {
        wmp_rec r;
        if (wmp_read_all(fd, &r, (int)sizeof r) != 0) return -1;
        r.title[31] = 0;
        if (n < max) recs[n++] = r;
    }
    return n;
}

static int wm_count_title(const wmp_rec *recs, int n, const char *title) {
    int c = 0;
    for (int i = 0; i < n; i++) if (!strcmp(recs[i].title, title)) c++;
    return c;
}

static const wmp_rec *wm_by_sid(const wmp_rec *recs, int n, int32_t sid) {
    for (int i = 0; i < n; i++) if (recs[i].sid == sid) return &recs[i];
    return NULL;
}

/* Evaluate one wait condition against a fetched list. Returns 1 (satisfied),
 * 0 (keep waiting). Conditions:
 *   win TITLE      a window titled TITLE exists
 *   nowin TITLE    no window titled TITLE
 *   count TITLE N  exactly N windows titled TITLE
 *   atleast T N    at least N windows titled T
 *   gone SID       SID no longer listed
 *   flag SID CH    SID present AND its FLAGS column contains CH
 *   noflag SID CH  SID present AND its FLAGS column lacks CH
 *   seq SID N      SID present AND frame_seq >= N
 *   dim SID WxH    SID present AND buffer w==W && h==H (a RESIZE ack landed —
 *                  position-agnostic, so a WM-placed window needn't be pinned)
 *   dst SID WxH    SID present AND on-screen dst_w==W && dst_h==H (a SET_DST /
 *                  scale-to-fit ack landed) */
static int wm_cond_met(const char *cond, char **a, const wmp_rec *recs, int n) {
    if (!strcmp(cond, "win"))   return wm_count_title(recs, n, a[0]) > 0;
    if (!strcmp(cond, "nowin")) return wm_count_title(recs, n, a[0]) == 0;
    if (!strcmp(cond, "count")) return wm_count_title(recs, n, a[0]) == atoi(a[1]);
    if (!strcmp(cond, "atleast")) return wm_count_title(recs, n, a[0]) >= atoi(a[1]);
    if (!strcmp(cond, "gone"))  return wm_by_sid(recs, n, (int32_t)atoi(a[0])) == NULL;
    if (!strcmp(cond, "flag") || !strcmp(cond, "noflag")) {
        const wmp_rec *r = wm_by_sid(recs, n, (int32_t)atoi(a[0]));
        if (!r) return 0;
        char flags[9]; rec_flags(r, flags);
        int has = strchr(flags, a[1][0]) != NULL;
        return cond[0] == 'n' ? !has : has;
    }
    if (!strcmp(cond, "seq")) {
        const wmp_rec *r = wm_by_sid(recs, n, (int32_t)atoi(a[0]));
        return r && r->frame_seq >= atoi(a[1]);
    }
    if (!strcmp(cond, "dim") || !strcmp(cond, "dst")) {
        const wmp_rec *r = wm_by_sid(recs, n, (int32_t)atoi(a[0]));
        if (!r) return 0;
        int w = 0, h = 0;
        if (sscanf(a[1], "%dx%d", &w, &h) != 2) return 0;
        return cond[1] == 'i' ? (r->w == w && r->h == h)
                              : (r->dst_w == w && r->dst_h == h);
    }
    return -1;   /* unknown condition */
}

/* wmctl wait COND ARGS... [MS]  — the trailing MS is optional (default
 * 15000). Base arg count per condition: win/nowin/gone take 1, everything
 * else takes 2. */
static int do_wait(int fd, int argc, char **argv) {
    if (argc < 4) return usage();
    const char *cond = argv[2];
    int base = (!strcmp(cond, "win") || !strcmp(cond, "nowin") ||
                !strcmp(cond, "gone")) ? 1 : 2;
    if (argc < 3 + base) return usage();
    char *a[2] = { argv[3], base > 1 ? argv[4] : NULL };
    long timeout = argc > 3 + base ? atol(argv[3 + base]) : 15000;

    /* Validate the condition name once (a bad name must not spin). */
    {
        wmp_rec probe[1];
        int rc = wm_cond_met(cond, a, probe, 0);
        if (rc < 0) { fprintf(stderr, "wmctl: unknown wait condition '%s'\n", cond); return 2; }
    }

    long deadline = wm_now_ms() + timeout;
    for (;;) {
        wmp_rec recs[256];
        int n = wm_fetch(fd, recs, 256);
        if (n < 0) return fail("protocol error");
        if (wm_cond_met(cond, a, recs, n) > 0) return 0;
        if (wm_now_ms() >= deadline) {
            fprintf(stderr, "wmctl: wait %s timed out after %ldms\n", cond, timeout);
            return 1;
        }
        usleep(30000);   /* 30ms poll */
    }
}

/* wmctl wait label|nolabel LABEL [MS] / wait text LABEL SUBSTR [MS] (todos/
 * 0154) — poll the win32 agent tree (NOT the kernel window list) until a
 * widget with LABEL exists / is gone / contains SUBSTR. In-surface control
 * state (a dialog's listbox, an EDIT's text, a MessageBox's buttons) that the
 * WM window list can't see. Same failure-deadline semantics as do_wait. */
static int do_agent_wait(int argc, char **argv) {
    const char *cond = argv[2];
    int isText = !strcmp(cond, "text");
    int base = isText ? 2 : 1;                    /* text takes LABEL SUBSTR */
    if (argc < 3 + base) return usage();
    const char *label = argv[3];
    const char *substr = isText ? argv[4] : NULL;
    long timeout = argc > 3 + base ? atol(argv[3 + base]) : 15000;
    int wantAbsent = !strcmp(cond, "nolabel");

    long deadline = wm_now_ms() + timeout;
    for (;;) {
        AgentProbe p = { label, substr, 0, NULL };
        agent_scan(probe_one, &p);               /* missing dir -> found stays 0 */
        int met = wantAbsent ? !p.found : p.found;
        free(p.text);
        if (met) return 0;
        if (wm_now_ms() >= deadline) {
            fprintf(stderr, "wmctl: wait %s timed out after %ldms\n", cond, timeout);
            return 1;
        }
        usleep(30000);   /* 30ms poll */
    }
}

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
        char flags[9];
        rec_flags(&r, flags);          /* [6] layer (0038), [7] transient (0281) */
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
    if (h.type != WMP_R_SHOT) {
        if (wmp_consume_err(fd, &h) == 0) errno = EIO;   /* unexpected type */
        return failop("shot");
    }
    return shot_to_ppm(fd, file);
}

/* Aero Peek thumbnail (todos/0063): a downscaled window as PPM. */
static int do_thumb(int fd, int32_t sid, int32_t mw, int32_t mh, const char *file) {
    int32_t a[3] = { sid, mw, mh };
    wmp_hdr h;
    if (wmp_send(fd, WMP_THUMB, a, 3) != 0 || wmp_next_reply(fd, &h) != 0)
        return fail("protocol error");
    if (h.type != WMP_R_SHOT) {
        if (wmp_consume_err(fd, &h) == 0) errno = EIO;   /* unexpected type */
        return failop("thumb");
    }
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
    /* Agent-tree waits (todos/0154) also talk to apps, not the kernel. */
    if (!strcmp(cmd, "wait") && argc >= 3 &&
        (!strcmp(argv[2], "label") || !strcmp(argv[2], "nolabel") ||
         !strcmp(argv[2], "text")))
        return do_agent_wait(argc, argv);
    if (!strcmp(cmd, "click") && argc == 3)
        return do_agent(cmd, argv[2], NULL);     /* click by LABEL, no pixels —
                                                    numeric labels too (0048:
                                                    calc's "7"); a pixel click
                                                    always carries X Y */

    int fd = wmp_connect();
    if (fd < 0) return fail("cannot reach /run/wm.sock (no kernel WM endpoint?)");

    if (!strcmp(cmd, "list")) return do_list(fd);
    if (!strcmp(cmd, "wait")) return do_wait(fd, argc, argv);   /* todos/0083 */
    if (!strcmp(cmd, "shot")) {
        if (argc < 3) return usage();
        return do_shot(fd, argv[2], argc > 3 ? argv[3] : NULL);
    }
    if (!strcmp(cmd, "cycle")) {        /* window cycling (todos/0032) */
        int32_t a[1] = { argc > 2 ? atoi(argv[2]) : 1 };
        return wmp_cmd(fd, WMP_CYCLE, a, 1) ? failop("cycle") : 0;
    }
    if (!strcmp(cmd, "menu")) {         /* Start menu toggle (todos/0078) */
        return wmp_cmd(fd, WMP_MENU, NULL, 0) ? failop("menu") : 0;
    }
    if (!strcmp(cmd, "snap")) {         /* Aero Snap (todos/0095) — the
                                           Win+arrow chord's event on the
                                           focused window */
        if (argc < 3) return usage();
        static const char *dirs[4] = { "left", "right", "up", "down" };
        int32_t d = -1;
        for (int i = 0; i < 4; i++) if (!strcmp(argv[2], dirs[i])) d = i;
        if (d < 0) return usage();
        int32_t a[1] = { d };
        return wmp_cmd(fd, WMP_SNAP, a, 1) ? failop("snap") : 0;
    }
    if (!strcmp(cmd, "idle")) {         /* the kernel idle clock (0096) */
        wmp_hdr h;
        if (wmp_send(fd, WMP_GET_IDLE, NULL, 0) != 0 ||
            wmp_next_reply(fd, &h) != 0)
            return fail("protocol error");
        if (h.type != WMP_R_IDLE || h.plen < 4) {
            wmp_skip(fd, h.plen);
            return fail("idle refused");
        }
        int32_t ms;
        if (wmp_read_all(fd, &ms, 4) != 0) return fail("short reply");
        wmp_skip(fd, h.plen - 4);
        printf("%d\n", ms);
        return 0;
    }
    if (!strcmp(cmd, "cursor")) {       /* the effective cursor at a screen
                                           point (todos/0105) — chrome overlay
                                           + per-surface client cursor */
        if (argc < 4) return usage();
        wmp_hdr h;
        int32_t a[2] = { f32bits((float)atoi(argv[2])), f32bits((float)atoi(argv[3])) };
        if (wmp_send(fd, WMP_CURSOR_AT, a, 2) != 0 ||
            wmp_next_reply(fd, &h) != 0)
            return fail("protocol error");
        if (h.type != WMP_R_CURSOR || h.plen < 4) {
            wmp_skip(fd, h.plen);
            return fail("cursor refused");
        }
        int32_t shape;
        if (wmp_read_all(fd, &shape, 4) != 0) return fail("short reply");
        wmp_skip(fd, h.plen - 4);
        printf("%d\n", shape);
        return 0;
    }
    if (!strcmp(cmd, "saver")) {        /* screensaver preview (0096) */
        return wmp_cmd(fd, WMP_SAVER, NULL, 0) ? failop("saver") : 0;
    }
    if (!strcmp(cmd, "overview")) {     /* window overview / Exposé (EXPOSE) —
                                           toggle; policy owns layout + pick */
        return wmp_cmd(fd, WMP_OVERVIEW, NULL, 0) ? failop("overview") : 0;
    }
    if (!strcmp(cmd, "sysmenu")) {      /* window system menu (0102) — the
                                           Alt+Space path; opens on the
                                           FOCUSED window */
        return wmp_cmd(fd, WMP_SYSMENU, NULL, 0) ? failop("sysmenu") : 0;
    }
    /* Screen-coordinate injection (todos/0095): the kernel's raw pointer
     * path — hit test, chrome, title drags, snap zones — so headless tests
     * drive what a real mouse does. No SID argument by design. */
    if (!strcmp(cmd, "sdown") || !strcmp(cmd, "smove") || !strcmp(cmd, "sup")) {
        if (argc < 4) return usage();
        int32_t kind = cmd[1] == 'm' ? 0 : cmd[1] == 'd' ? 1 : 2;
        int32_t a[4] = { kind, f32bits((float)atoi(argv[2])),
                         f32bits((float)atoi(argv[3])),
                         argc > 4 ? atoi(argv[4]) : 1 };
        return wmp_cmd(fd, WMP_INJECT_SCREEN, a, 4) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "sdrag")) {        /* screen press-move-release (0095) */
        if (argc < 6) return usage();
        int32_t x1 = atoi(argv[2]), y1 = atoi(argv[3]);
        int32_t x2 = atoi(argv[4]), y2 = atoi(argv[5]);
        int32_t btn = argc > 6 ? atoi(argv[6]) : 1;
        int32_t mask = 1 << (btn - 1);
        int32_t a[4] = { 1, f32bits((float)x1), f32bits((float)y1), btn };
        if (wmp_cmd(fd, WMP_INJECT_SCREEN, a, 4)) return failop(cmd);
        int32_t m[4] = { 0, f32bits((x1 + x2) / 2.0f), f32bits((y1 + y2) / 2.0f), mask };
        if (wmp_cmd(fd, WMP_INJECT_SCREEN, m, 4)) return failop(cmd);
        m[1] = f32bits((float)x2); m[2] = f32bits((float)y2);
        if (wmp_cmd(fd, WMP_INJECT_SCREEN, m, 4)) return failop(cmd);
        a[0] = 2; a[1] = m[1]; a[2] = m[2];
        return wmp_cmd(fd, WMP_INJECT_SCREEN, a, 4) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "glass")) {        /* Aero glass tier (todos/0063) */
        if (argc < 3) return usage();
        int32_t a[1] = { atoi(argv[2]) };
        return wmp_cmd(fd, WMP_GLASS, a, 1) ? failop("glass") : 0;
    }

    /* Everything else leads with a SID. */
    if (argc < 3) return usage();
    int32_t sid = (int32_t)atoi(argv[2]);

    if (!strcmp(cmd, "focus") || !strcmp(cmd, "restore")) {
        int32_t a[1] = { sid };
        return wmp_cmd(fd, !strcmp(cmd, "focus") ? WMP_FOCUS : WMP_RESTORE, a, 1)
            ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "min")) {
        int32_t a[1] = { sid };
        return wmp_cmd(fd, WMP_MINIMIZE, a, 1) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "close")) {
        int32_t a[1] = { sid };
        return wmp_cmd(fd, WMP_CLOSE_REQ, a, 1) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "raise") || !strcmp(cmd, "lower")) {
        int32_t a[2] = { sid, !strcmp(cmd, "lower") };
        return wmp_cmd(fd, WMP_RESTACK, a, 2) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "move")) {
        if (argc < 5) return usage();
        int32_t a[3] = { sid, atoi(argv[3]), atoi(argv[4]) };
        return wmp_cmd(fd, WMP_MOVE, a, 3) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "resize")) {
        if (argc < 5) return usage();
        int32_t a[3] = { sid, atoi(argv[3]), atoi(argv[4]) };
        return wmp_cmd(fd, WMP_RESIZE, a, 3) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "scale")) {        /* viewport scaling (todos/0024) */
        if (argc < 5) return usage();
        int32_t a[3] = { sid, atoi(argv[3]), atoi(argv[4]) };
        return wmp_cmd(fd, WMP_SET_DST, a, 3) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "max")) {          /* maximize toggle (todos/0025) */
        int32_t a[1] = { sid };
        return wmp_cmd(fd, WMP_ACTIVATE, a, 1) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "layer")) {        /* z-layer pin (todos/0038) */
        if (argc < 4) return usage();
        int32_t a[2] = { sid, atoi(argv[3]) };
        return wmp_cmd(fd, WMP_SET_LAYER, a, 2) ? failop(cmd) : 0;
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
    if (!strcmp(cmd, "key") || !strcmp(cmd, "keydown") || !strcmp(cmd, "keyup")) {
        if (argc < 4) return usage();
        int32_t sc = atoi(argv[3]);
        int32_t sym = argc > 4 ? atoi(argv[4]) : 0;
        int32_t mod = argc > 5 ? atoi(argv[5]) : 0;
        int32_t a[5] = { sid, cmd[3] != 'u', sc, sym, mod };
        /* keydown/keyup (todos/0077): one edge only — a HELD modifier for
         * a following click/drag needs the down without the up. */
        if (wmp_cmd(fd, WMP_INJECT_KEY, a, 5)) return failop(cmd);
        if (cmd[3]) return 0;                    /* keydown / keyup: done */
        a[1] = 0;
        return wmp_cmd(fd, WMP_INJECT_KEY, a, 5) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "hover")) {        /* absolute motion (todos/0063) */
        if (argc < 5) return usage();
        int32_t x = f32bits((float)atoi(argv[3])), y = f32bits((float)atoi(argv[4]));
        int32_t a[6] = { sid, 0 /* move */, x, y, 0, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "wheel")) {        /* wheel notches (todos/0210): +up.
                                           The wheel event's position is the
                                           LAST tracked motion — hover first. */
        if (argc < 4) return usage();
        int32_t dy = f32bits((float)atof(argv[3]));
        int32_t a[6] = { sid, 3 /* wheel */, f32bits(0.0f), dy, 0, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "relmove")) {      /* relative motion (todos/0018) */
        if (argc < 5) return usage();
        int32_t dx = f32bits((float)atoi(argv[3])), dy = f32bits((float)atoi(argv[4]));
        int32_t a[6] = { sid, 4 /* rel */, dx, dy, 0, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "click") || !strcmp(cmd, "dblclick")) {
        if (argc < 5) return usage();
        int32_t x = f32bits((float)atoi(argv[3])), y = f32bits((float)atoi(argv[4]));
        int32_t btn = argc > 5 ? atoi(argv[5]) : 1;
        int reps = cmd[0] == 'd' ? 2 : 1;   /* dblclick: both clicks ride one
                                               connection, ms apart (0029) */
        for (int i = 0; i < reps; i++) {
            int32_t a[6] = { sid, 1 /* down */, x, y, btn, 0 };
            if (wmp_cmd(fd, WMP_INJECT_POINTER, a, 6)) return failop(cmd);
            a[1] = 2;                   /* up */
            if (wmp_cmd(fd, WMP_INJECT_POINTER, a, 6)) return failop(cmd);
        }
        return 0;
    }
    if (!strcmp(cmd, "down") || !strcmp(cmd, "up")) {   /* one edge (0077) */
        if (argc < 5) return usage();
        int32_t x = f32bits((float)atoi(argv[3])), y = f32bits((float)atoi(argv[4]));
        int32_t btn = argc > 5 ? atoi(argv[5]) : 1;
        int32_t a[6] = { sid, cmd[0] == 'd' ? 1 : 2, x, y, btn, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? failop(cmd) : 0;
    }
    if (!strcmp(cmd, "drag")) {         /* press-move-release (todos/0077):
                                           down at (X1,Y1), button-held motion
                                           through the midpoint to (X2,Y2), up
                                           there — the desktop marquee / icon-
                                           move gesture on one connection. */
        if (argc < 7) return usage();
        int32_t x1 = atoi(argv[3]), y1 = atoi(argv[4]);
        int32_t x2 = atoi(argv[5]), y2 = atoi(argv[6]);
        int32_t btn = argc > 7 ? atoi(argv[7]) : 1;
        int32_t mask = 1 << (btn - 1);
        int32_t a[6] = { sid, 1, f32bits((float)x1), f32bits((float)y1), btn, 0 };
        if (wmp_cmd(fd, WMP_INJECT_POINTER, a, 6)) return failop(cmd);
        int32_t m[6] = { sid, 0, f32bits((x1 + x2) / 2.0f), f32bits((y1 + y2) / 2.0f), mask, 0 };
        if (wmp_cmd(fd, WMP_INJECT_POINTER, m, 6)) return failop(cmd);
        m[2] = f32bits((float)x2); m[3] = f32bits((float)y2);
        if (wmp_cmd(fd, WMP_INJECT_POINTER, m, 6)) return failop(cmd);
        a[1] = 2; a[2] = m[2]; a[3] = m[3];
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? failop(cmd) : 0;
    }
    return usage();
}
