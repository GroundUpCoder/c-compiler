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
 *   wmctl key SID SCANCODE [KEYSYM [MOD]]      key press (down+up)
 *   wmctl click SID X Y [BUTTON]               click (down+up), local coords
 *   wmctl relmove SID DX DY           relative motion (pointer-lock deltas)
 *   wmctl shot SID|screen [FILE]               PPM (P6) to FILE or stdout
 *
 * SID 0 targets the focused window (key/click/shot).
 * Exit: 0 ok, 1 command failed / WM endpoint unreachable, 2 usage.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "wm_proto.h"

static int fail(const char *msg) { fprintf(stderr, "wmctl: %s\n", msg); return 1; }

static int usage(void) {
    fprintf(stderr,
        "usage: wmctl list\n"
        "       wmctl focus|min|restore|close|raise|lower SID\n"
        "       wmctl move SID X Y\n"
        "       wmctl resize SID W H\n"
        "       wmctl scale SID W H\n"
        "       wmctl key SID SCANCODE [KEYSYM [MOD]]\n"
        "       wmctl click SID X Y [BUTTON]\n"
        "       wmctl relmove SID DX DY\n"
        "       wmctl shot SID|screen [FILE]\n");
    return 2;
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
        char flags[6] = "-----";
        if (r.flags & WMP_F_FOCUSED)    flags[0] = 'f';
        if (r.flags & WMP_F_MINIMIZED)  flags[1] = 'm';
        if (r.flags & WMP_F_BORDERLESS) flags[2] = 'b';
        if (r.flags & WMP_F_RELMOUSE)   flags[3] = 'r';
        if (r.flags & WMP_F_RESIZABLE)  flags[4] = 'R';
        r.title[31] = 0;
        char dst[32] = "-";            /* scaled viewport (todos/0024), or - */
        if (r.dst_w != r.w || r.dst_h != r.h)
            snprintf(dst, sizeof dst, "%dx%d", r.dst_w, r.dst_h);
        printf("%d\t%d\t%dx%d+%d+%d\t%s\t%d\t%s\t%s\n",
               r.sid, r.pid, r.w, r.h, r.x, r.y, dst, r.z, flags, r.title);
    }
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
    int32_t head[3];                   /* sid, w, h; then w*h*4 rgba */
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

int main(int argc, char **argv) {
    if (argc < 2) return usage();
    int fd = wmp_connect();
    if (fd < 0) return fail("cannot reach /run/wm.sock (no kernel WM endpoint?)");

    const char *cmd = argv[1];
    if (!strcmp(cmd, "list")) return do_list(fd);
    if (!strcmp(cmd, "shot")) {
        if (argc < 3) return usage();
        return do_shot(fd, argv[2], argc > 3 ? argv[3] : NULL);
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
    if (!strcmp(cmd, "relmove")) {      /* relative motion (todos/0018) */
        if (argc < 5) return usage();
        int32_t dx = f32bits((float)atoi(argv[3])), dy = f32bits((float)atoi(argv[4]));
        int32_t a[6] = { sid, 4 /* rel */, dx, dy, 0, 0 };
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? fail("no such window") : 0;
    }
    if (!strcmp(cmd, "click")) {
        if (argc < 5) return usage();
        int32_t x = f32bits((float)atoi(argv[3])), y = f32bits((float)atoi(argv[4]));
        int32_t btn = argc > 5 ? atoi(argv[5]) : 1;
        int32_t a[6] = { sid, 1 /* down */, x, y, btn, 0 };
        if (wmp_cmd(fd, WMP_INJECT_POINTER, a, 6)) return fail("no such window");
        a[1] = 2;                       /* up */
        return wmp_cmd(fd, WMP_INJECT_POINTER, a, 6) ? fail("no such window") : 0;
    }
    return usage();
}
