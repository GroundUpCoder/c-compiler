/*
 * gcode — a minimal, line-oriented agentic coding assistant (todos/0174).
 *
 * Speaks the Anthropic Messages API (streaming SSE + tool use) over libcurl.
 * No fullscreen ANSI — just SGR colors — so it behaves the same on VT1 and
 * over a pty in /bin/term. Every tool result is hard-capped so a large file
 * or a chatty command can't blow up the context.
 *
 * Dual-target by construction: this same source builds native with
 * `clang gcode.c cJSON.c -lcurl` (the reference oracle) and for gucOS
 * against the 0173 veneer (os/gcode/bin.json) unchanged. The ONE platform
 * seam is run_command() (process spawn for the bash tool) — see the
 * PLATFORM block: posix_spawn in-OS (no fork by design), fork/exec native.
 *
 * Config (env, overridable by flags):
 *   ANTHROPIC_BASE_URL   default https://api.anthropic.com
 *   ANTHROPIC_API_KEY    -> x-api-key
 *   ANTHROPIC_AUTH_TOKEN -> Authorization: Bearer (takes precedence)
 *   ANTHROPIC_MODEL      default claude-opus-4-8
 * Flags: -p PROMPT (one-shot), --model, --system-prompt, --max-turns,
 *   --max-tokens, --resume, --continue, --no-persist, --verbose, --no-color.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <sys/stat.h>
#include <dirent.h>
#include <signal.h>
#include <curl/curl.h>
#include "cJSON.h"

/* ---- caps (keep contexts bounded) ------------------------------------- */
#define CAP_FILE_BYTES   (48 * 1024)
#define CAP_FILE_LINES   2000
#define CAP_BASH_BYTES   (24 * 1024)
#define CAP_BASH_SECS    120
#define CAP_LIST_ENTRIES 500
#define CAP_WHOLE_FILE   (4 * 1024 * 1024)
#define MAX_BLOCKS       64

/* ---- growable byte buffer --------------------------------------------- */
typedef struct { char *p; size_t len, cap; } sb;
static void sb_ensure(sb *b, size_t extra) {
    if (b->len + extra + 1 > b->cap) {
        size_t nc = b->cap ? b->cap : 256;
        while (nc < b->len + extra + 1) nc *= 2;
        b->p = realloc(b->p, nc);
        if (!b->p) { fprintf(stderr, "gcode: out of memory\n"); exit(1); }
        b->cap = nc;
    }
}
static void sb_add(sb *b, const char *s, size_t n) {
    sb_ensure(b, n); memcpy(b->p + b->len, s, n); b->len += n; b->p[b->len] = 0;
}
static void sb_puts(sb *b, const char *s) { sb_add(b, s, strlen(s)); }
static void sb_free(sb *b) { free(b->p); b->p = NULL; b->len = b->cap = 0; }

/* ---- config ----------------------------------------------------------- */
typedef struct {
    const char *base_url, *api_key, *auth_token, *model, *system_prompt;
    long max_tokens, max_turns;
    int  verbose, color;
} config;

#define GCODE_VERSION "2"
#define LOG_SCHEMA_VERSION 1

typedef struct {
    long long input_tokens, output_tokens;
    long long cache_creation_input_tokens, cache_read_input_tokens;
} usage;

typedef struct {
    int fd, persist;
    char id[33];
    char *path;
    char *last_stop;
    long long seq, turn_index;
    usage total;
} session;

static void usage_add(usage *a, const usage *b) {
    a->input_tokens += b->input_tokens;
    a->output_tokens += b->output_tokens;
    a->cache_creation_input_tokens += b->cache_creation_input_tokens;
    a->cache_read_input_tokens += b->cache_read_input_tokens;
}

static cJSON *usage_json(const usage *u) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "input_tokens", (double)u->input_tokens);
    cJSON_AddNumberToObject(o, "output_tokens", (double)u->output_tokens);
    cJSON_AddNumberToObject(o, "cache_creation_input_tokens", (double)u->cache_creation_input_tokens);
    cJSON_AddNumberToObject(o, "cache_read_input_tokens", (double)u->cache_read_input_tokens);
    return o;
}

static long long json_count(cJSON *o, const char *key) {
    cJSON *v = o ? cJSON_GetObjectItemCaseSensitive(o, key) : NULL;
    return cJSON_IsNumber(v) && v->valuedouble >= 0 ? (long long)v->valuedouble : 0;
}

static usage usage_from_json(cJSON *o) {
    usage u = {0};
    u.input_tokens = json_count(o, "input_tokens");
    u.output_tokens = json_count(o, "output_tokens");
    u.cache_creation_input_tokens = json_count(o, "cache_creation_input_tokens");
    u.cache_read_input_tokens = json_count(o, "cache_read_input_tokens");
    return u;
}

/* ---- ANSI (SGR only; no cursor motion or clears — the stream stays
 * append-only so terminal scrollback is preserved, #301/#302) -----------
 * Colour is gated PER STREAM (#303): assistant content on stdout uses
 * g_color; chrome/prompt/tool lines on stderr use g_color_err. The two
 * differ under redirection — `gcode -p x > f` leaves f byte-clean while a
 * tty stderr still shows colour. Both default from isatty() and honour
 * NO_COLOR; --no-color forces off, --color forces on. */
static int g_color = 1;       /* stdout (assistant content) */
static int g_color_err = 1;   /* stderr (chrome, prompt, tool lines) */
static const char *Co(const char *code) { return g_color ? code : ""; }
static const char *Ce(const char *code) { return g_color_err ? code : ""; }
/* chrome (stderr) — dim faint needs term.c SGR 2 (#304, now landed) */
#define CDIM  Ce("\033[2m")
#define CCYAN Ce("\033[36m")
#define CGRN  Ce("\033[32m")
#define CRED  Ce("\033[31m")
#define CRST  Ce("\033[0m")
/* the 8 bold semantic roles from ~/git/chat's ui.py:15-24 (#302).
 * term.c renders bold as the bright-8 palette, so these read strongly
 * in-OS as well as in a host terminal. */
#define R_USER Ce("\033[1;32m")   /* user prompt      — bold green   */
#define R_INFO Ce("\033[1;33m")   /* info / rules     — bold yellow  */
#define R_ERRB Ce("\033[1;31m")   /* errors           — bold red     */
#define R_TIME Ce("\033[1;35m")   /* timestamps       — bold magenta */
#define R_TOOL Ce("\033[1;35m")   /* tool_use         — bold magenta */
#define R_RES  Ce("\033[1;33m")   /* tool_result      — bold yellow  */
#define R_COST Ce("\033[1;36m")   /* per-turn cost    — bold cyan    */
/* assistant speaker header + body live on stdout (the transcript) */
#define O_ASST Co("\033[1;36m")   /* assistant        — bold cyan    */
#define O_RST  Co("\033[0m")
/* coloured diff renderer palette (diffvis.py:18-25) — printed on stderr */
#define D_ADD  Ce("\033[32m")
#define D_DEL  Ce("\033[31m")
#define D_HDR  Ce("\033[1m")
#define D_META Ce("\033[90m")

/* ---- pricing (#302: per-turn Cost line, ui.py:349/372) ----------------
 * USD per 1M tokens, matched by substring against the model id. Cache
 * writes bill at 1.25x input, cache reads at 0.1x (the API's ephemeral
 * cache economics). Longest/most-specific keys first so "claude-opus-5"
 * wins over "claude-opus-4". Rates: Anthropic first-party, 2026-07. */
static double price_usage(const char *model, const usage *u) {
    static const struct { const char *key; double in, out; } P[] = {
        { "claude-fable-5",  10.0, 50.0 },
        { "claude-mythos-5", 10.0, 50.0 },
        { "claude-opus-5",    5.0, 25.0 },
        { "claude-opus-4",    5.0, 25.0 },  /* 4.8/4.7/4.6/4.5/4.1/4.0 */
        { "claude-sonnet-5",  3.0, 15.0 },
        { "claude-sonnet-4",  3.0, 15.0 },
        { "claude-haiku-4",   1.0,  5.0 },
    };
    if (!model) return -1.0;
    for (size_t i = 0; i < sizeof P / sizeof P[0]; i++) {
        if (strstr(model, P[i].key)) {
            double in = P[i].in, out = P[i].out;
            return ((double)u->input_tokens * in
                  + (double)u->cache_creation_input_tokens * in * 1.25
                  + (double)u->cache_read_input_tokens * in * 0.10
                  + (double)u->output_tokens * out) / 1e6;
        }
    }
    return -1.0;   /* unknown model — caller omits the $ line */
}

/* ---- append-only presentation (#302) ----------------------------------
 * Chat's layout (~/git/chat/src/chat/ui.py) is speaker headers on their
 * own line + a 2-space-indented body, rule separators, labelled tool
 * blocks and a coloured diff — all as a forward-only byte stream (NO
 * cursor motion, NO clears: ui.py's \033[H\033[J redraw erases
 * scrollback, the one thing #301 proved gcode gets right). */

/* Emit `s` to stderr, indenting every line by `depth` two-space units.
 * A trailing newline is preserved; blank lines are not indented. */
static void indent_err(const char *s, int depth) {
    int bol = 1;
    for (const char *p = s; *p; p++) {
        if (bol && *p != '\n') { for (int i = 0; i < depth; i++) fputs("  ", stderr); }
        fputc(*p, stderr);
        bol = (*p == '\n');
    }
}

/* A coloured line-diff of old_string -> new_string (diffvis.py:18-25):
 * a bold summary, removed lines red with '-', added lines green with '+'.
 * edit_file replaces one unique span, so old/new ARE the change — no LCS
 * needed. Printed on stderr; append-only. */
static void render_diff(const char *old_s, const char *new_s) {
    int add = 0, del = 0;
    for (const char *p = old_s; *p; p++) if (*p == '\n') del++;
    if (*old_s && old_s[strlen(old_s) - 1] != '\n') del++;
    for (const char *p = new_s; *p; p++) if (*p == '\n') add++;
    if (*new_s && new_s[strlen(new_s) - 1] != '\n') add++;
    fprintf(stderr, "    %sDiff%s %s+%d -%d%s\n", R_RES, CRST, D_HDR, add, del, CRST);
    /* one coloured line per '\n'-terminated (or trailing) segment */
    for (int pass = 0; pass < 2; pass++) {
        const char *s = pass ? new_s : old_s;
        const char *col = pass ? D_ADD : D_DEL;
        char sign = pass ? '+' : '-';
        const char *line = s;
        while (*line) {
            const char *nl = strchr(line, '\n');
            size_t ll = nl ? (size_t)(nl - line) : strlen(line);
            fprintf(stderr, "      %s%c %.*s%s\n", col, sign, (int)ll, line, CRST);
            if (!nl) break;
            line = nl + 1;
        }
    }
}

/* The primary argument of a tool call, shown indented under the tool line
 * (ui.py:420-432 shows path/command). Multiline/long values are clipped. */
static void render_tool_args(const char *name, cJSON *in) {
    const char *key = NULL;
    if (!strcmp(name, "bash"))            key = "command";
    else                                  key = "path";   /* read/write/edit/list */
    cJSON *v = cJSON_GetObjectItem(in, key);
    if (!cJSON_IsString(v)) return;
    const char *val = v->valuestring;
    size_t n = strlen(val); const char *nl = strchr(val, '\n');
    if (nl) n = (size_t)(nl - val);
    if (n > 72) n = 72;
    fprintf(stderr, "    %s%s:%s %.*s%s\n", CDIM, key, CRST, (int)n, val,
            (n < strlen(val)) ? " ..." : "");
}

/* The tool result: a bold-yellow "Result" label + an indented preview,
 * capped so a chatty command can't flood the transcript (ui.py:216-242). */
static void render_tool_result(const char *result) {
    fprintf(stderr, "    %sResult%s\n", R_RES, CRST);
    if (!result || !*result) { fprintf(stderr, "      %s(empty)%s\n", CDIM, CRST); return; }
    const char *line = result; int shown = 0;
    while (*line && shown < 8) {
        const char *nl = strchr(line, '\n');
        size_t ll = nl ? (size_t)(nl - line) : strlen(line);
        if (ll > 120) ll = 120;
        fprintf(stderr, "      %.*s\n", (int)ll, line);
        shown++;
        if (!nl) break;
        line = nl + 1;
    }
    if (*line) fprintf(stderr, "      %s...%s\n", CDIM, CRST);
}

static volatile sig_atomic_t g_interrupted;
static void on_interrupt(int sig) { (void)sig; g_interrupted = 1; }
static int curl_progress(void *p, curl_off_t a, curl_off_t b, curl_off_t c, curl_off_t d) {
    (void)p; (void)a; (void)b; (void)c; (void)d; return g_interrupted ? 1 : 0;
}

/* ===================================================================== */
/*  PLATFORM SEAM: run a shell command, merge stdout+stderr, cap+timeout  */
/*  gucOS (__MTOTS__): posix_spawn — the owner-brokered model has no       */
/*  fork(). Native: fork/exec/poll. Same contract both sides.             */
/* ===================================================================== */
#include <unistd.h>
#include <sys/wait.h>
#include <time.h>
#include <signal.h>

#ifdef __MTOTS__
/* compiler.js's libc has gmtime but not gmtime_r/getline; gucOS processes
 * are single-threaded, so wrapping the static-buffer gmtime is safe. */
static struct tm *gmtime_r(const time_t *t, struct tm *out) { *out = *gmtime(t); return out; }
static ssize_t getline(char **buf, size_t *cap, FILE *f) {
    if (!*buf) { *cap = 256; *buf = malloc(*cap); if (!*buf) return -1; }
    size_t n = 0; int c = EOF;
    while ((c = fgetc(f)) != EOF) {
        if (n + 2 > *cap) { char *nb = realloc(*buf, *cap * 2); if (!nb) return -1; *buf = nb; *cap *= 2; }
        (*buf)[n++] = (char)c;
        if (c == '\n') break;
    }
    if (!n && c == EOF) return -1;
    (*buf)[n] = 0;
    return (ssize_t)n;
}
#endif

#ifdef __MTOTS__
#include <spawn.h>
#include <sys/time.h>

/* Timeout: setitimer(ITIMER_REAL)+SIGALRM (todos/0044). The parked pipe
 * read EINTRs when the signal lands (kernel krpc-intr); we SIGKILL the
 * child and keep draining to EOF. */
static volatile int g_bash_alarm;
static void bash_on_alarm(int sig) { (void)sig; g_bash_alarm = 1; }

/* Returns malloc'd captured output (truncation-marked if over cap).
 * *exit_code set to the child's exit status (or -1 killed by timeout). */
static char *run_command(const char *cmd, int *exit_code) {
    int pfd[2];
    if (pipe(pfd) != 0) { *exit_code = -1; return strdup("gcode: pipe() failed\n"); }
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, pfd[1], 1);
    posix_spawn_file_actions_adddup2(&fa, pfd[1], 2);
    posix_spawn_file_actions_addclose(&fa, pfd[0]);
    posix_spawn_file_actions_addclose(&fa, pfd[1]);
    char *sh_argv[] = { "sh", "-c", (char *)cmd, 0 };
    pid_t pid;
    int e = posix_spawn(&pid, "/bin/sh", &fa, 0, sh_argv, 0 /* inherit env */);
    posix_spawn_file_actions_destroy(&fa);
    if (e != 0) {
        close(pfd[0]); close(pfd[1]);
        *exit_code = -1; return strdup("gcode: posix_spawn(/bin/sh) failed\n");
    }
    close(pfd[1]);
    sb out = {0};
    int truncated = 0, timedout = 0;
    g_bash_alarm = 0;
    signal(SIGALRM, bash_on_alarm);
    struct itimerval itv;
    itv.it_interval.tv_sec = 0; itv.it_interval.tv_usec = 0;
    itv.it_value.tv_sec = CAP_BASH_SECS; itv.it_value.tv_usec = 0;
    setitimer(ITIMER_REAL, &itv, 0);
    for (;;) {
        char buf[4096];
        ssize_t n = read(pfd[0], buf, sizeof buf);
        if (n == 0) break;                   /* EOF: child (tree) is done */
        if (n < 0) {
            if (errno == EINTR) {
                if (g_bash_alarm && !timedout) { kill(pid, SIGKILL); timedout = 1; }
                continue;                    /* drain to EOF after the kill */
            }
            break;
        }
        if (out.len < CAP_BASH_BYTES) {
            size_t room = CAP_BASH_BYTES - out.len;
            size_t take = (size_t)n < room ? (size_t)n : room;
            sb_add(&out, buf, take);
            if (take < (size_t)n) truncated = 1;
        } else {
            truncated = 1;                   /* keep draining so the child can exit */
        }
    }
    itv.it_value.tv_sec = 0;
    setitimer(ITIMER_REAL, &itv, 0);         /* disarm */
    close(pfd[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    if (timedout) {
        *exit_code = -1;
        sb_puts(&out, "\n[command killed: exceeded 120s timeout]");
    } else {
        *exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        if (truncated) {
            char m[64];
            snprintf(m, sizeof m, "\n[output truncated at %d bytes]", CAP_BASH_BYTES);
            sb_puts(&out, m);
        }
    }
    if (!out.p) out.p = strdup("");
    return out.p;
}

#else /* native */
#include <poll.h>

/* Returns malloc'd captured output (truncation-marked if over cap).
 * *exit_code set to the child's exit status (or -1 killed by timeout). */
static char *run_command(const char *cmd, int *exit_code) {
    int pfd[2];
    if (pipe(pfd) != 0) { *exit_code = -1; return strdup("gcode: pipe() failed\n"); }
    pid_t pid = fork();
    if (pid < 0) { *exit_code = -1; return strdup("gcode: fork() failed\n"); }
    if (pid == 0) {
        dup2(pfd[1], 1); dup2(pfd[1], 2);
        close(pfd[0]); close(pfd[1]);
        execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
        _exit(127);
    }
    close(pfd[1]);
    sb out = {0};
    int truncated = 0;
    time_t deadline = time(NULL) + CAP_BASH_SECS;
    for (;;) {
        struct pollfd pf = { pfd[0], POLLIN, 0 };
        int remain = (int)(deadline - time(NULL));
        if (remain < 0) remain = 0;
        int r = poll(&pf, 1, remain * 1000 + 100);
        if (r == 0 && time(NULL) >= deadline) {  /* timeout: kill the group */
            kill(pid, SIGKILL);
            *exit_code = -1;
            break;
        }
        if (r > 0 && (pf.revents & (POLLIN | POLLHUP))) {
            char buf[4096];
            ssize_t n = read(pfd[0], buf, sizeof buf);
            if (n <= 0) break;               /* EOF */
            if (out.len < CAP_BASH_BYTES) {
                size_t room = CAP_BASH_BYTES - out.len;
                size_t take = (size_t)n < room ? (size_t)n : room;
                sb_add(&out, buf, take);
                if (take < (size_t)n) truncated = 1;
            } else {
                truncated = 1;              /* keep draining so the child can exit */
            }
        }
    }
    close(pfd[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    if (*exit_code != -1)
        *exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    if (*exit_code == -1)
        sb_puts(&out, "\n[command killed: exceeded 120s timeout]");
    else if (truncated) {
        char m[64];
        snprintf(m, sizeof m, "\n[output truncated at %d bytes]", CAP_BASH_BYTES);
        sb_puts(&out, m);
    }
    if (!out.p) out.p = strdup("");
    return out.p;
}
#endif /* platform */
/* ===================== end platform seam ============================== */

/* ---- interactive line input (readline) --------------------------------
 * In gucOS, reuse busybox's command-line editor — arrow-key history and
 * line editing, the SAME src/libbb/lineedit.c hush runs — linked via
 * os/gcode/bin.json's dep on vendor/busybox/lineedit.json (the lib.json <-
 * bin.json convention gcode already uses for curl). No third editor is
 * written. We declare only the tiny surface we call; libbb.h itself must
 * NOT be included (it redefines FAST_FUNC and the whole libbb macro
 * world). Native keeps fgets: it is the reference oracle, driven
 * non-interactively, where lineedit would fall back to fgets anyway. */
#ifdef __MTOTS__
typedef struct line_input_t line_input_t;   /* opaque here; full def in libbb.h */
line_input_t *new_line_input_t(int flags);
int read_line_input(line_input_t *st, const char *prompt, char *command, int maxsize);
#define LI_DO_HISTORY 1                      /* == libbb enum DO_HISTORY */
static line_input_t *g_editor;
#endif

/* Read one input line. Returns 1 = got a line (trailing newline kept, as
 * fgets), 0 = interrupted at the prompt (^C — caller re-prompts, #305),
 * -1 = EOF/error (caller ends the session). The visible speaker header is
 * printed by the caller; `prompt` is the editor's caret string. */
static int read_input_line(const char *prompt, char *buf, int cap) {
#ifdef __MTOTS__
    if (!g_editor) g_editor = new_line_input_t(LI_DO_HISTORY);
    int r = read_line_input(g_editor, prompt, buf, cap);
    if (r > 0) return 1;
    if (r == 0) return 0;            /* ^C in raw mode: command discarded */
    /* r < 0 is EOF/Ctrl-D — unless a ^C EINTR'd the non-tty fallback fgets
     * inside lineedit, which sets g_interrupted (the #305 distinction). */
    return g_interrupted ? 0 : -1;
#else
    fputs(prompt, stderr); fflush(stderr);
    if (fgets(buf, cap, stdin)) return 1;
    if (g_interrupted) { clearerr(stdin); return 0; }
    return -1;
#endif
}

/* ---- file tools ------------------------------------------------------- */
static char *tool_read_file(cJSON *in) {
    cJSON *jp = cJSON_GetObjectItem(in, "path");
    if (!cJSON_IsString(jp)) return strdup("error: read_file needs a string 'path'");
    long off = 0, lim = CAP_FILE_LINES;
    cJSON *jo = cJSON_GetObjectItem(in, "offset"), *jl = cJSON_GetObjectItem(in, "limit");
    if (cJSON_IsNumber(jo)) off = (long)jo->valuedouble;
    if (cJSON_IsNumber(jl)) lim = (long)jl->valuedouble;
    if (lim > CAP_FILE_LINES) lim = CAP_FILE_LINES;
    FILE *f = fopen(jp->valuestring, "rb");
    if (!f) { sb e = {0}; sb_puts(&e, "error: cannot open "); sb_puts(&e, jp->valuestring);
              sb_puts(&e, ": "); sb_puts(&e, strerror(errno)); return e.p; }
    sb out = {0}; char line[8192]; long n = 0; int bytes = 0, cut = 0;
    while (fgets(line, sizeof line, f)) {
        if (n++ < off) continue;
        if (n - off > lim) { cut = 1; break; }
        size_t ll = strlen(line);
        if (bytes + (int)ll > CAP_FILE_BYTES) { cut = 1; break; }
        sb_add(&out, line, ll); bytes += (int)ll;
    }
    fclose(f);
    if (cut) sb_puts(&out, "\n[truncated: use offset/limit to page]");
    if (!out.p) out.p = strdup("[empty]");
    return out.p;
}
static char *tool_write_file(cJSON *in) {
    cJSON *jp = cJSON_GetObjectItem(in, "path");
    cJSON *jc = cJSON_GetObjectItem(in, "content");
    if (!cJSON_IsString(jp) || !cJSON_IsString(jc))
        return strdup("error: write_file needs string 'path' and 'content'");
    FILE *f = fopen(jp->valuestring, "wb");
    if (!f) { sb e = {0}; sb_puts(&e, "error: cannot write "); sb_puts(&e, jp->valuestring);
              sb_puts(&e, ": "); sb_puts(&e, strerror(errno)); return e.p; }
    size_t n = strlen(jc->valuestring);
    fwrite(jc->valuestring, 1, n, f); fclose(f);
    sb out = {0}; char m[128];
    snprintf(m, sizeof m, "wrote %zu bytes to %s", n, jp->valuestring);
    sb_puts(&out, m); return out.p;
}
static char *tool_edit_file(cJSON *in) {
    cJSON *jp = cJSON_GetObjectItem(in, "path");
    cJSON *jo = cJSON_GetObjectItem(in, "old_string");
    cJSON *jn = cJSON_GetObjectItem(in, "new_string");
    if (!cJSON_IsString(jp) || !cJSON_IsString(jo) || !cJSON_IsString(jn))
        return strdup("error: edit_file needs string 'path', 'old_string', 'new_string'");
    FILE *f = fopen(jp->valuestring, "rb");
    if (!f) return strdup("error: cannot open file for edit");
    sb src = {0}; char buf[8192]; size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) {
        if (src.len + n > CAP_WHOLE_FILE) { fclose(f); sb_free(&src);
            return strdup("error: file too large to edit"); }
        sb_add(&src, buf, n);
    }
    fclose(f);
    const char *old = jo->valuestring, *rep = jn->valuestring;
    size_t ol = strlen(old);
    if (ol == 0) { sb_free(&src); return strdup("error: old_string is empty"); }
    /* require exactly one occurrence */
    char *first = strstr(src.p, old);
    if (!first) { sb_free(&src); return strdup("error: old_string not found"); }
    if (strstr(first + 1, old)) { sb_free(&src);
        return strdup("error: old_string is not unique (matches more than once)"); }
    sb out = {0};
    sb_add(&out, src.p, (size_t)(first - src.p));
    sb_puts(&out, rep);
    sb_puts(&out, first + ol);
    FILE *w = fopen(jp->valuestring, "wb");
    if (!w) { sb_free(&src); sb_free(&out); return strdup("error: cannot rewrite file"); }
    fwrite(out.p, 1, out.len, w); fclose(w);
    sb_free(&src); sb_free(&out);
    sb r = {0}; sb_puts(&r, "edited "); sb_puts(&r, jp->valuestring); return r.p;
}
static char *tool_list_dir(cJSON *in) {
    cJSON *jp = cJSON_GetObjectItem(in, "path");
    const char *path = cJSON_IsString(jp) ? jp->valuestring : ".";
    sb cmd = {0};
    sb_puts(&cmd, "ls -la ");
    /* naive shell-escape: wrap in single quotes, escaping embedded quotes */
    sb_puts(&cmd, "'");
    for (const char *c = path; *c; c++) {
        if (*c == '\'') sb_puts(&cmd, "'\\''"); else sb_add(&cmd, c, 1);
    }
    sb_puts(&cmd, "'");
    int ec = 0; char *out = run_command(cmd.p, &ec); sb_free(&cmd);
    return out;
}
static char *tool_bash(cJSON *in) {
    cJSON *jc = cJSON_GetObjectItem(in, "command");
    if (!cJSON_IsString(jc)) return strdup("error: bash needs a string 'command'");
    int ec = 0; char *out = run_command(jc->valuestring, &ec);
    sb r = {0}; char hdr[64];
    snprintf(hdr, sizeof hdr, "[exit %d]\n", ec);
    sb_puts(&r, hdr); sb_puts(&r, out); free(out);
    return r.p;
}

/* dispatch a tool call by name; returns malloc'd result string */
static char *execute_tool(const char *name, cJSON *input) {
    if (!strcmp(name, "bash"))       return tool_bash(input);
    if (!strcmp(name, "read_file"))  return tool_read_file(input);
    if (!strcmp(name, "write_file")) return tool_write_file(input);
    if (!strcmp(name, "edit_file"))  return tool_edit_file(input);
    if (!strcmp(name, "list_dir"))   return tool_list_dir(input);
    sb r = {0}; sb_puts(&r, "error: unknown tool "); sb_puts(&r, name); return r.p;
}

/* ---- tool schemas (sent on every request) ----------------------------- */
static cJSON *str_prop(const char *desc) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "type", "string");
    cJSON_AddStringToObject(o, "description", desc);
    return o;
}
static cJSON *int_prop(const char *desc) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "type", "integer");
    cJSON_AddStringToObject(o, "description", desc);
    return o;
}
static cJSON *make_tool(const char *name, const char *desc, cJSON *props, const char **req, int nreq) {
    cJSON *t = cJSON_CreateObject();
    cJSON_AddStringToObject(t, "name", name);
    cJSON_AddStringToObject(t, "description", desc);
    cJSON *schema = cJSON_CreateObject();
    cJSON_AddStringToObject(schema, "type", "object");
    cJSON_AddItemToObject(schema, "properties", props);
    cJSON *r = cJSON_CreateArray();
    for (int i = 0; i < nreq; i++) cJSON_AddItemToArray(r, cJSON_CreateString(req[i]));
    cJSON_AddItemToObject(schema, "required", r);
    cJSON_AddItemToObject(t, "input_schema", schema);
    return t;
}
static cJSON *build_tools(void) {
    cJSON *tools = cJSON_CreateArray();
    cJSON *p;

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "command", str_prop("Shell command to run via /bin/sh -c. Output (stdout+stderr) is capped and the command is time-limited."));
    { const char *r[] = {"command"}; cJSON_AddItemToArray(tools, make_tool("bash", "Run a shell command and return its combined output and exit code.", p, r, 1)); }

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "path", str_prop("File path to read."));
    cJSON_AddItemToObject(p, "offset", int_prop("0-based line to start at (optional)."));
    cJSON_AddItemToObject(p, "limit", int_prop("Max lines to return (optional; capped)."));
    { const char *r[] = {"path"}; cJSON_AddItemToArray(tools, make_tool("read_file", "Read a text file, optionally a line range. Output is byte- and line-capped.", p, r, 1)); }

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "path", str_prop("File path to write."));
    cJSON_AddItemToObject(p, "content", str_prop("Full new file contents."));
    { const char *r[] = {"path", "content"}; cJSON_AddItemToArray(tools, make_tool("write_file", "Create or overwrite a file with the given contents.", p, r, 2)); }

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "path", str_prop("File to edit."));
    cJSON_AddItemToObject(p, "old_string", str_prop("Exact text to replace; must occur exactly once."));
    cJSON_AddItemToObject(p, "new_string", str_prop("Replacement text."));
    { const char *r[] = {"path", "old_string", "new_string"}; cJSON_AddItemToArray(tools, make_tool("edit_file", "Replace a unique occurrence of old_string with new_string in a file.", p, r, 3)); }

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "path", str_prop("Directory to list (default '.')."));
    { const char *r[] = {}; cJSON_AddItemToArray(tools, make_tool("list_dir", "List a directory (ls -la).", p, r, 0)); }

    return tools;
}

/* ---- durable JSONL sessions ------------------------------------------ */
static void utc_time(char out[32], int basic) {
    time_t now = time(NULL); struct tm tm;
    gmtime_r(&now, &tm);
    strftime(out, 32, basic ? "%Y%m%dT%H%M%SZ" : "%Y-%m-%dT%H:%M:%SZ", &tm);
}

static char *system_hash(const char *s) {
    uint64_t h = UINT64_C(1469598103934665603);
    for (; s && *s; s++) { h ^= (unsigned char)*s; h *= UINT64_C(1099511628211); }
    char *out = malloc(17); snprintf(out, 17, "%016llx", (unsigned long long)h); return out;
}

static int mkdirs(const char *path) {
    char *p = strdup(path); if (!p) return -1;
    for (char *q = p + 1; *q; q++) if (*q == '/') {
        *q = 0; if (mkdir(p, 0700) && errno != EEXIST) { free(p); return -1; } *q = '/';
    }
    int r = mkdir(p, 0700); if (r && errno == EEXIST) r = 0;
    free(p); return r;
}

static char *sessions_dir(void) {
    const char *override = getenv("GCODE_STATE_DIR");
    if (override && *override) { sb b = {0}; sb_puts(&b, override); sb_puts(&b, "/sessions"); return b.p; }
    const char *xdg = getenv("XDG_STATE_HOME");
    if (xdg && *xdg) { sb b = {0}; sb_puts(&b, xdg); sb_puts(&b, "/gcode/sessions"); return b.p; }
    const char *home = getenv("HOME");
#ifdef __MTOTS__
    if (!home || !*home) home = "/root";
#endif
    if (!home || !*home) return NULL;
    sb b = {0}; sb_puts(&b, home); sb_puts(&b, "/.local/state/gcode/sessions"); return b.p;
}

static void make_session_id(char out[33]) {
    unsigned char bytes[16]; int fd = open("/dev/urandom", O_RDONLY); ssize_t got = -1;
    if (fd >= 0) { got = read(fd, bytes, sizeof bytes); close(fd); }
    if (got != (ssize_t)sizeof bytes) {
        uint64_t x = (uint64_t)time(NULL) ^ ((uint64_t)getpid() << 32) ^ (uintptr_t)out;
        for (int i = 0; i < 16; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; bytes[i] = (unsigned char)x; }
    }
    for (int i = 0; i < 16; i++) snprintf(out + i * 2, 3, "%02x", bytes[i]);
}

static cJSON *record_new(session *s, const char *type) {
    char ts[32]; utc_time(ts, 0);
    cJSON *r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "schema_version", LOG_SCHEMA_VERSION);
    cJSON_AddStringToObject(r, "type", type);
    cJSON_AddStringToObject(r, "session_id", s->id);
    cJSON_AddNumberToObject(r, "seq", (double)++s->seq);
    cJSON_AddStringToObject(r, "timestamp", ts);
    return r;
}

static int record_write(session *s, cJSON *r) {
    if (!s->persist) { cJSON_Delete(r); return 0; }
    char *line = cJSON_PrintUnformatted(r); cJSON_Delete(r);
    if (!line) return -1;
    size_t n = strlen(line), off = 0; int ok = 0;
    while (off < n) { ssize_t w = write(s->fd, line + off, n - off); if (w < 0) { if (errno == EINTR) continue; ok = -1; break; } off += (size_t)w; }
    if (!ok && write(s->fd, "\n", 1) != 1) ok = -1;
    if (!ok && fsync(s->fd)) ok = -1;
    if (ok) fprintf(stderr, "gcode: session log write failed: %s\n", strerror(errno));
    free(line); return ok;
}

static int session_meta(session *s, config *cfg) {
    cJSON *r = record_new(s, "session_meta");
    char cwd[4096]; if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "");
    char *hash = system_hash(cfg->system_prompt);
    cJSON_AddStringToObject(r, "program", "gcode"); cJSON_AddStringToObject(r, "version", GCODE_VERSION);
#ifdef __MTOTS__
    cJSON_AddStringToObject(r, "target", "gucos");
#else
    cJSON_AddStringToObject(r, "target", "native");
#endif
    cJSON_AddStringToObject(r, "model", cfg->model); cJSON_AddStringToObject(r, "base_url", cfg->base_url);
    cJSON_AddStringToObject(r, "system_prompt_hash", hash); cJSON_AddStringToObject(r, "cwd", cwd);
    cJSON_AddNumberToObject(r, "max_tokens", cfg->max_tokens); cJSON_AddNumberToObject(r, "max_turns", cfg->max_turns);
    free(hash); return record_write(s, r);
}

static int session_create(session *s, config *cfg) {
    memset(s, 0, sizeof *s); s->fd = -1; s->persist = 1; make_session_id(s->id);
    char *dir = sessions_dir(); if (!dir || mkdirs(dir)) { fprintf(stderr, "gcode: cannot create state directory: %s\n", strerror(errno)); free(dir); return -1; }
    char stamp[32]; utc_time(stamp, 1); sb p = {0}; sb_puts(&p, dir); sb_puts(&p, "/"); sb_puts(&p, stamp); sb_puts(&p, "_"); sb_puts(&p, s->id); sb_puts(&p, ".jsonl"); free(dir);
    s->fd = open(p.p, O_WRONLY | O_CREAT | O_APPEND, 0600); s->path = p.p;
    if (s->fd < 0) { fprintf(stderr, "gcode: cannot open session log %s: %s\n", s->path, strerror(errno)); return -1; }
    if (session_meta(s, cfg)) return -1;
    fprintf(stderr, "%ssession %s: %s%s\n", CDIM, s->id, s->path, CRST); return 0;
}

static int persist_message(session *s, cJSON *m, const char *source) {
    cJSON *r = record_new(s, "message"); cJSON *role = cJSON_GetObjectItem(m, "role"), *content = cJSON_GetObjectItem(m, "content");
    cJSON_AddStringToObject(r, "role", cJSON_IsString(role) ? role->valuestring : "user"); cJSON_AddStringToObject(r, "source", source);
    cJSON_AddItemToObject(r, "content", cJSON_Duplicate(content, 1)); return record_write(s, r);
}

static void session_end(session *s, const char *reason) {
    if (!s->persist || s->fd < 0) return;
    cJSON *r = record_new(s, "session_end"); cJSON_AddStringToObject(r, "reason", reason); cJSON_AddItemToObject(r, "totals", usage_json(&s->total));
    record_write(s, r); close(s->fd); s->fd = -1;
}

/* ---- SSE stream state ------------------------------------------------- */
typedef struct {
    int active; char type;          /* 't'ext or 'u'se */
    char *id, *name; sb text; sb json;
} cblock;
typedef struct {
    sb accum;                       /* unparsed SSE bytes */
    sb raw;                         /* everything, for non-200 error reporting */
    cblock blocks[MAX_BLOCKS];
    int  nblocks, color;
    char *stop_reason, *message_id, *response_model;
    usage round_usage;
    cJSON *raw_usage;
    int  api_error; sb errmsg;
    int  hdr_shown, at_bol;         /* #302 append-only speaker/indent state */
} stream_ctx;

/* Print the assistant speaker header once per message (ui.py:357 — the
 * "Assistant" line). On stdout so it stays part of the transcript with the
 * streamed body; subsequent body lines indent 2 spaces (at_bol tracks it). */
static void assistant_header(stream_ctx *ctx) {
    if (ctx->hdr_shown) return;
    ctx->hdr_shown = 1;
    fprintf(stdout, "\n%sgcode:%s\n", O_ASST, O_RST);
    fflush(stdout);
    ctx->at_bol = 1;
}

/* Stream a text delta to stdout, indenting each line 2 spaces (ui.py's
 * indent_text at depth 1). Append-only; flushes so tokens appear live. */
static void emit_body(stream_ctx *ctx, const char *s) {
    for (const char *p = s; *p; p++) {
        if (ctx->at_bol && *p != '\n') fputs("  ", stdout);
        ctx->at_bol = 0;
        fputc(*p, stdout);
        if (*p == '\n') ctx->at_bol = 1;
    }
    fflush(stdout);
}

static void merge_usage(stream_ctx *ctx, cJSON *src) {
    if (!cJSON_IsObject(src)) return;
    if (!ctx->raw_usage) ctx->raw_usage = cJSON_CreateObject();
    for (cJSON *v = src->child; v; v = v->next) {
        cJSON_DeleteItemFromObjectCaseSensitive(ctx->raw_usage, v->string);
        cJSON_AddItemToObject(ctx->raw_usage, v->string, cJSON_Duplicate(v, 1));
    }
    ctx->round_usage = usage_from_json(ctx->raw_usage);
}

static void dispatch_json(stream_ctx *ctx, const char *json) {
    cJSON *e = cJSON_Parse(json);
    if (!e) return;
    cJSON *jt = cJSON_GetObjectItem(e, "type");
    const char *type = cJSON_IsString(jt) ? jt->valuestring : "";

    if (!strcmp(type, "message_start")) {
        cJSON *m = cJSON_GetObjectItem(e, "message");
        if (cJSON_IsObject(m)) {
            cJSON *id = cJSON_GetObjectItem(m, "id"), *model = cJSON_GetObjectItem(m, "model");
            if (cJSON_IsString(id)) { free(ctx->message_id); ctx->message_id = strdup(id->valuestring); }
            if (cJSON_IsString(model)) { free(ctx->response_model); ctx->response_model = strdup(model->valuestring); }
            merge_usage(ctx, cJSON_GetObjectItem(m, "usage"));
        }
    } else if (!strcmp(type, "content_block_start")) {
        int idx = (int)cJSON_GetObjectItem(e, "index")->valuedouble;
        cJSON *cb = cJSON_GetObjectItem(e, "content_block");
        if (idx >= 0 && idx < MAX_BLOCKS && cb) {
            cblock *b = &ctx->blocks[idx];
            b->active = 1;
            cJSON *cbt = cJSON_GetObjectItem(cb, "type");
            if (cJSON_IsString(cbt) && !strcmp(cbt->valuestring, "tool_use")) {
                b->type = 'u';
                cJSON *id = cJSON_GetObjectItem(cb, "id");
                cJSON *nm = cJSON_GetObjectItem(cb, "name");
                if (cJSON_IsString(id)) b->id = strdup(id->valuestring);
                if (cJSON_IsString(nm)) b->name = strdup(nm->valuestring);
                /* #302: label the tool as a block. Ensure the assistant
                 * text block above it ended its line (the "Let me run it.·
                 * bash" run-on #301 screenshot 2 called out). */
                assistant_header(ctx);
                if (!ctx->at_bol) { fputc('\n', stdout); fflush(stdout); ctx->at_bol = 1; }
                fprintf(stderr, "  %s\xe2\x97\x8f %s%s\n", R_TOOL, b->name ? b->name : "?", CRST);
            } else {
                b->type = 't';
            }
            if (idx + 1 > ctx->nblocks) ctx->nblocks = idx + 1;
        }
    } else if (!strcmp(type, "content_block_delta")) {
        int idx = (int)cJSON_GetObjectItem(e, "index")->valuedouble;
        cJSON *d = cJSON_GetObjectItem(e, "delta");
        if (idx >= 0 && idx < MAX_BLOCKS && d) {
            cblock *b = &ctx->blocks[idx];
            cJSON *dt = cJSON_GetObjectItem(d, "type");
            const char *dtype = cJSON_IsString(dt) ? dt->valuestring : "";
            if (!strcmp(dtype, "text_delta")) {
                cJSON *tx = cJSON_GetObjectItem(d, "text");
                if (cJSON_IsString(tx)) {
                    assistant_header(ctx);
                    emit_body(ctx, tx->valuestring);
                    sb_puts(&b->text, tx->valuestring);
                }
            } else if (!strcmp(dtype, "input_json_delta")) {
                cJSON *pj = cJSON_GetObjectItem(d, "partial_json");
                if (cJSON_IsString(pj)) sb_puts(&b->json, pj->valuestring);
            }
        }
    } else if (!strcmp(type, "message_delta")) {
        cJSON *d = cJSON_GetObjectItem(e, "delta");
        if (d) {
            cJSON *sr = cJSON_GetObjectItem(d, "stop_reason");
            if (cJSON_IsString(sr)) { free(ctx->stop_reason); ctx->stop_reason = strdup(sr->valuestring); }
        }
        merge_usage(ctx, cJSON_GetObjectItem(e, "usage"));
    } else if (!strcmp(type, "error")) {
        ctx->api_error = 1;
        cJSON *er = cJSON_GetObjectItem(e, "error");
        cJSON *m = er ? cJSON_GetObjectItem(er, "message") : NULL;
        sb_puts(&ctx->errmsg, cJSON_IsString(m) ? m->valuestring : "unknown API error");
    }
    cJSON_Delete(e);
}

/* extract "data:" payload(s) from one SSE event block, then dispatch */
static void handle_event(stream_ctx *ctx, const char *block, size_t len) {
    sb data = {0};
    const char *line = block, *end = block + len;
    while (line < end) {
        const char *nl = memchr(line, '\n', (size_t)(end - line));
        size_t ll = nl ? (size_t)(nl - line) : (size_t)(end - line);
        if (ll && line[ll - 1] == '\r') ll--;
        if (ll >= 5 && !memcmp(line, "data:", 5)) {
            const char *d = line + 5; size_t dl = ll - 5;
            if (dl && *d == ' ') { d++; dl--; }
            sb_add(&data, d, dl);
        }
        if (!nl) break;
        line = nl + 1;
    }
    if (data.len) dispatch_json(ctx, data.p);
    sb_free(&data);
}

/* libcurl write callback: buffer bytes, split complete SSE events on \n\n */
static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *ud) {
    size_t n = size * nmemb;
    stream_ctx *ctx = ud;
    sb_add(&ctx->raw, ptr, n);
    sb_add(&ctx->accum, ptr, n);
    for (;;) {
        char *sep = NULL;
        for (size_t i = 0; i + 1 < ctx->accum.len; i++)
            if (ctx->accum.p[i] == '\n' && ctx->accum.p[i + 1] == '\n') { sep = ctx->accum.p + i; break; }
        if (!sep) break;
        size_t blocklen = (size_t)(sep - ctx->accum.p);
        handle_event(ctx, ctx->accum.p, blocklen);
        size_t consumed = blocklen + 2;
        memmove(ctx->accum.p, ctx->accum.p + consumed, ctx->accum.len - consumed);
        ctx->accum.len -= consumed;
        ctx->accum.p[ctx->accum.len] = 0;
    }
    return n;
}

/* ---- one API round-trip ----------------------------------------------- */
/* Returns 0 to stop, 1 to continue (tool_use). Errors: -1 recoverable
   (transport, HTTP != 200, API error event), -2 interrupted (^C via the
   xferinfo abort, #306), -3 auth (HTTP 401/403 — retrying cannot succeed,
   #305). */
static int do_turn(config *cfg, session *sess, cJSON *messages, cJSON *tools, usage *turn_usage) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "model", cfg->model);
    cJSON_AddNumberToObject(body, "max_tokens", (double)cfg->max_tokens);
    cJSON_AddBoolToObject(body, "stream", 1);
    if (cfg->system_prompt) cJSON_AddStringToObject(body, "system", cfg->system_prompt);
    cJSON_AddItemReferenceToObject(body, "messages", messages);
    cJSON_AddItemReferenceToObject(body, "tools", tools);
    char *payload = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);

    stream_ctx ctx; memset(&ctx, 0, sizeof ctx); ctx.color = cfg->color;

    CURL *h = curl_easy_init();
    if (!h) { free(payload); fprintf(stderr, "gcode: curl init failed\n"); return -1; }
    sb url = {0}; sb_puts(&url, cfg->base_url); sb_puts(&url, "/v1/messages");
    struct curl_slist *hdr = NULL;
    hdr = curl_slist_append(hdr, "content-type: application/json");
    hdr = curl_slist_append(hdr, "anthropic-version: 2023-06-01");
    hdr = curl_slist_append(hdr, "anthropic-dangerous-direct-browser-access: true");
    sb auth = {0};
    if (cfg->auth_token) { sb_puts(&auth, "authorization: Bearer "); sb_puts(&auth, cfg->auth_token); }
    else if (cfg->api_key) { sb_puts(&auth, "x-api-key: "); sb_puts(&auth, cfg->api_key); }
    if (auth.len) hdr = curl_slist_append(hdr, auth.p);

    curl_easy_setopt(h, CURLOPT_URL, url.p);
    curl_easy_setopt(h, CURLOPT_POST, 1L);
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdr);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(h, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(h, CURLOPT_XFERINFOFUNCTION, curl_progress);
    if (cfg->verbose) { fprintf(stderr, "%s> POST %s%s\n%s\n", CDIM, url.p, CRST, payload); }

    CURLcode rc = curl_easy_perform(h);
    long code = 0; curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(hdr); curl_easy_cleanup(h);
    sb_free(&url); sb_free(&auth); free(payload);

    int ret = 0;
    if (rc != CURLE_OK) {
        if (g_interrupted && rc == CURLE_ABORTED_BY_CALLBACK) { fprintf(stderr, "\n%sgcode: interrupted%s\n", CDIM, CRST); ret = -2; }
        else { fprintf(stderr, "\n%sgcode: transport error: %s%s\n", R_ERRB, curl_easy_strerror(rc), CRST); ret = -1; }
        goto done;
    }
    if (code != 200) {
        fprintf(stderr, "\n%sgcode: HTTP %ld%s\n%.*s\n", R_ERRB, code, CRST,
                (int)ctx.raw.len, ctx.raw.p ? ctx.raw.p : "");
        ret = (code == 401 || code == 403) ? -3 : -1; goto done;
    }
    if (ctx.api_error) {
        fprintf(stderr, "\n%sgcode: API error: %s%s\n", R_ERRB, ctx.errmsg.p ? ctx.errmsg.p : "?", CRST);
        ret = -1; goto done;
    }
    free(sess->last_stop); sess->last_stop = strdup(ctx.stop_reason ? ctx.stop_reason : "");
    fputc('\n', stdout);

    /* build the assistant message from accumulated blocks */
    cJSON *acontent = cJSON_CreateArray();
    cJSON *tool_results = cJSON_CreateArray();   /* filled if any tool_use */
    for (int i = 0; i < ctx.nblocks; i++) {
        cblock *b = &ctx.blocks[i];
        if (!b->active) continue;
        if (b->type == 't') {
            cJSON *tb = cJSON_CreateObject();
            cJSON_AddStringToObject(tb, "type", "text");
            cJSON_AddStringToObject(tb, "text", b->text.p ? b->text.p : "");
            cJSON_AddItemToArray(acontent, tb);
        } else if (b->type == 'u') {
            cJSON *input = b->json.len ? cJSON_Parse(b->json.p) : cJSON_CreateObject();
            if (!input) input = cJSON_CreateObject();
            cJSON *ub = cJSON_CreateObject();
            cJSON_AddStringToObject(ub, "type", "tool_use");
            cJSON_AddStringToObject(ub, "id", b->id ? b->id : "");
            cJSON_AddStringToObject(ub, "name", b->name ? b->name : "");
            cJSON_AddItemToObject(ub, "input", input);   /* ub owns input now */
            cJSON_AddItemToArray(acontent, ub);
            /* #302: show the primary argument, then a labelled result block;
             * for edit_file, render the coloured old->new diff (diffvis.py). */
            render_tool_args(b->name ? b->name : "", input);
            char *result = execute_tool(b->name ? b->name : "", input);
            cJSON *tr = cJSON_CreateObject();
            cJSON_AddStringToObject(tr, "type", "tool_result");
            cJSON_AddStringToObject(tr, "tool_use_id", b->id ? b->id : "");
            cJSON_AddStringToObject(tr, "content", result ? result : "");
            cJSON_AddItemToArray(tool_results, tr);
            render_tool_result(result);
            if (b->name && !strcmp(b->name, "edit_file") && result &&
                !strncmp(result, "edited ", 7)) {
                cJSON *jo = cJSON_GetObjectItem(input, "old_string");
                cJSON *jn = cJSON_GetObjectItem(input, "new_string");
                if (cJSON_IsString(jo) && cJSON_IsString(jn))
                    render_diff(jo->valuestring, jn->valuestring);
            }
            free(result);
        }
    }
    cJSON *amsg = cJSON_CreateObject();
    cJSON_AddStringToObject(amsg, "role", "assistant");
    cJSON_AddItemToObject(amsg, "content", acontent);
    cJSON_AddItemToArray(messages, amsg);

    cJSON *round = record_new(sess, "api_round");
    cJSON_AddStringToObject(round, "request_model", cfg->model);
    cJSON_AddStringToObject(round, "response_model", ctx.response_model ? ctx.response_model : "");
    cJSON_AddStringToObject(round, "provider_message_id", ctx.message_id ? ctx.message_id : "");
    cJSON_AddStringToObject(round, "stop_reason", ctx.stop_reason ? ctx.stop_reason : "");
    cJSON_AddItemToObject(round, "usage", usage_json(&ctx.round_usage));
    cJSON_AddItemToObject(round, "raw_usage", ctx.raw_usage ? cJSON_Duplicate(ctx.raw_usage, 1) : cJSON_CreateObject());
    if (record_write(sess, round)) { ret = -1; goto done; }
    usage_add(turn_usage, &ctx.round_usage); usage_add(&sess->total, &ctx.round_usage);
    if (persist_message(sess, amsg, "model")) { ret = -1; goto done; }

    if (ctx.stop_reason && !strcmp(ctx.stop_reason, "tool_use")) {
        cJSON *umsg = cJSON_CreateObject();
        cJSON_AddStringToObject(umsg, "role", "user");
        cJSON_AddItemToObject(umsg, "content", tool_results);
        cJSON_AddItemToArray(messages, umsg);
        if (persist_message(sess, umsg, "tool")) { ret = -1; goto done; }
        ret = 1;
    } else {
        cJSON_Delete(tool_results);
        if (ctx.stop_reason && !strcmp(ctx.stop_reason, "refusal"))
            fprintf(stderr, "%sgcode: model refused the request%s\n", R_ERRB, CRST);
        ret = 0;
    }

done:
    for (int i = 0; i < MAX_BLOCKS; i++) {
        free(ctx.blocks[i].id); free(ctx.blocks[i].name);
        sb_free(&ctx.blocks[i].text); sb_free(&ctx.blocks[i].json);
    }
    free(ctx.stop_reason); free(ctx.message_id); free(ctx.response_model); cJSON_Delete(ctx.raw_usage);
    sb_free(&ctx.accum); sb_free(&ctx.raw); sb_free(&ctx.errmsg);
    return ret;
}

/* run the agent loop for one user message already appended to `messages` */
static void report_usage(const char *label, const usage *u, const char *model) {
    fprintf(stderr, "%s%s usage: input=%lld output=%lld cache-create=%lld cache-read=%lld%s\n", CDIM, label,
            u->input_tokens, u->output_tokens, u->cache_creation_input_tokens, u->cache_read_input_tokens, CRST);
    double cost = price_usage(model, u);   /* #302: price the counters gcode already holds */
    if (cost >= 0.0)
        fprintf(stderr, "%s%s cost: $%.6f%s\n", R_COST, label, cost, CRST);
}

static int agent_loop(config *cfg, session *sess, cJSON *messages, cJSON *tools) {
    usage turn = {0}; int rounds = 0, last = 0; const char *status = "done";
    g_interrupted = 0;
    char turn_id[80]; snprintf(turn_id, sizeof turn_id, "%s-%lld", sess->id, sess->turn_index);
    for (long round = 0; round < cfg->max_turns; round++) {
        last = do_turn(cfg, sess, messages, tools, &turn); if (last >= 0) rounds++;
        if (last <= 0) break;
    }
    if (last == -2) status = "interrupted";
    else if (last < 0) status = "error";
    else if (last > 0) { status = "max_turns"; fprintf(stderr, "%sgcode: hit max-turns (%ld)%s\n", CDIM, cfg->max_turns, CRST); }
    else { cJSON *lastmsg = cJSON_GetArrayItem(messages, cJSON_GetArraySize(messages) - 1); (void)lastmsg; }
    cJSON *end = record_new(sess, "turn_end"); cJSON_AddStringToObject(end, "turn_id", turn_id); cJSON_AddStringToObject(end, "status", status);
    cJSON_AddStringToObject(end, "stop_reason", last > 0 ? "max_turns" : (sess->last_stop ? sess->last_stop : "")); cJSON_AddNumberToObject(end, "api_rounds", rounds);
    cJSON_AddItemToObject(end, "usage", usage_json(&turn)); cJSON_AddItemToObject(end, "session_usage", usage_json(&sess->total));
    if (record_write(sess, end)) return -1;
    report_usage("turn", &turn, cfg->model); report_usage("session", &sess->total, cfg->model);
    /* 0 = done or interrupted (^C lands back at the prompt), -1 =
       recoverable turn error, -3 = auth (fatal — #305) */
    return last == -2 ? 0 : (last == -3 ? -3 : (last < 0 ? -1 : 0));
}

static cJSON *make_user_text(const char *text) {
    cJSON *m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "role", "user");
    cJSON *a = cJSON_CreateArray(), *b = cJSON_CreateObject();
    cJSON_AddStringToObject(b, "type", "text"); cJSON_AddStringToObject(b, "text", text); cJSON_AddItemToArray(a, b); cJSON_AddItemToObject(m, "content", a);
    return m;
}

static int append_user_text(session *s, cJSON *messages, const char *text) {
    s->turn_index++; char turn_id[80]; snprintf(turn_id, sizeof turn_id, "%s-%lld", s->id, s->turn_index);
    cJSON *start = record_new(s, "turn_start"); cJSON_AddStringToObject(start, "turn_id", turn_id); cJSON_AddNumberToObject(start, "turn_index", (double)s->turn_index);
    if (record_write(s, start)) return -1;
    cJSON *m = make_user_text(text); cJSON_AddItemToArray(messages, m); return persist_message(s, m, "human");
}

static const char *getenv_or(const char *k, const char *dflt) {
    const char *v = getenv(k);
    return (v && *v) ? v : dflt;
}

static char *find_resume_path(const char *arg) {
    if (arg && (strchr(arg, '/') || access(arg, F_OK) == 0)) return strdup(arg);
    char *dir = sessions_dir(); if (!dir) return NULL; DIR *d = opendir(dir); if (!d) { free(dir); return NULL; }
    char *best = NULL; time_t best_time = 0; struct dirent *de;
    while ((de = readdir(d))) {
        size_t n = strlen(de->d_name); if (n < 7 || strcmp(de->d_name + n - 6, ".jsonl")) continue;
        if (arg) { sb suffix = {0}; sb_puts(&suffix, "_"); sb_puts(&suffix, arg); sb_puts(&suffix, ".jsonl"); int match = n >= suffix.len && !strcmp(de->d_name + n - suffix.len, suffix.p); sb_free(&suffix); if (!match) continue; }
        sb p = {0}; sb_puts(&p, dir); sb_puts(&p, "/"); sb_puts(&p, de->d_name); struct stat st;
        if (!stat(p.p, &st) && (!best || st.st_mtime > best_time)) { free(best); best = p.p; best_time = st.st_mtime; } else sb_free(&p);
    }
    closedir(d); free(dir); return best;
}

static const char *jstr(cJSON *o, const char *key) { cJSON *v = cJSON_GetObjectItem(o, key); return cJSON_IsString(v) ? v->valuestring : ""; }

static int session_resume(session *s, config *cfg, cJSON *messages, const char *arg) {
    memset(s, 0, sizeof *s); s->fd = -1; s->persist = 1; s->path = find_resume_path(arg);
    if (!s->path) { fprintf(stderr, "gcode: no matching session found\n"); return -1; }
    FILE *f = fopen(s->path, "r"); if (!f) { fprintf(stderr, "gcode: cannot read %s: %s\n", s->path, strerror(errno)); return -1; }
    char *line = NULL; size_t cap = 0; ssize_t n; int saw_meta = 0, had_fragment = 0;
    while ((n = getline(&line, &cap, f)) >= 0) {
        if (!n || line[n - 1] != '\n') { had_fragment = 1; break; } /* ignore crash fragment */
        cJSON *r = cJSON_ParseWithLength(line, (size_t)n); if (!r) continue;
        long long seq = json_count(r, "seq"); if (seq > s->seq) s->seq = seq;
        const char *type = jstr(r, "type");
        if (!strcmp(type, "session_meta")) {
            saw_meta = 1; snprintf(s->id, sizeof s->id, "%s", jstr(r, "session_id"));
            char cwd[4096]; if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, ""); char *hash = system_hash(cfg->system_prompt);
            if (strcmp(jstr(r, "model"), cfg->model)) fprintf(stderr, "gcode: warning: resumed model differs (%s -> %s)\n", jstr(r, "model"), cfg->model);
            if (strcmp(jstr(r, "base_url"), cfg->base_url)) fprintf(stderr, "gcode: warning: resumed base_url differs\n");
            if (strcmp(jstr(r, "system_prompt_hash"), hash)) fprintf(stderr, "gcode: warning: resumed system prompt differs\n");
            if (strcmp(jstr(r, "cwd"), cwd)) fprintf(stderr, "gcode: warning: resumed cwd differs (%s -> %s)\n", jstr(r, "cwd"), cwd); free(hash);
        } else if (!strcmp(type, "message")) {
            cJSON *m = cJSON_CreateObject(); cJSON_AddStringToObject(m, "role", jstr(r, "role"));
            cJSON *content = cJSON_GetObjectItem(r, "content"); cJSON_AddItemToObject(m, "content", cJSON_Duplicate(content, 1)); cJSON_AddItemToArray(messages, m);
        } else if (!strcmp(type, "api_round")) {
            usage u = usage_from_json(cJSON_GetObjectItem(r, "usage")); usage_add(&s->total, &u);
        } else if (!strcmp(type, "turn_start")) {
            long long idx = json_count(r, "turn_index"); if (idx > s->turn_index) s->turn_index = idx;
        }
        cJSON_Delete(r);
    }
    free(line); fclose(f);
    if (!saw_meta || !s->id[0]) { fprintf(stderr, "gcode: invalid session log %s\n", s->path); return -1; }
    s->fd = open(s->path, O_WRONLY | O_CREAT | O_APPEND, 0600); if (s->fd < 0) { fprintf(stderr, "gcode: cannot append %s: %s\n", s->path, strerror(errno)); return -1; }
    if (had_fragment && (write(s->fd, "\n", 1) != 1 || fsync(s->fd))) { fprintf(stderr, "gcode: cannot repair session fragment: %s\n", strerror(errno)); close(s->fd); s->fd = -1; return -1; }
    fprintf(stderr, "%sresumed %s (%d messages): %s%s\n", CDIM, s->id, cJSON_GetArraySize(messages), s->path, CRST); return 0;
}

static int self_test(void) {
    const char *fixture =
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_fixture\",\"model\":\"fixture-model\",\"usage\":{\"input_tokens\":12,\"output_tokens\":1,\"cache_creation_input_tokens\":3,\"cache_read_input_tokens\":4,\"future_counter\":9}}}\n\n"
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n"
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"fixture\"}}\n\n"
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n";
    stream_ctx ctx; memset(&ctx, 0, sizeof ctx); write_cb((char *)fixture, 1, strlen(fixture), &ctx);
    int ok = ctx.round_usage.input_tokens == 12 && ctx.round_usage.output_tokens == 7 &&
        ctx.round_usage.cache_creation_input_tokens == 3 && ctx.round_usage.cache_read_input_tokens == 4 &&
        json_count(ctx.raw_usage, "future_counter") == 9;
    char tmp[] = "/tmp/gcode-step2-test-XXXXXX"; if (!mkdtemp(tmp)) return 1; setenv("GCODE_STATE_DIR", tmp, 1);
    config cfg = { "https://example.invalid", NULL, NULL, "fixture-model", "fixture-system", 123, 4, 0, 0 };
    session s; cJSON *messages = cJSON_CreateArray();
    if (session_create(&s, &cfg)) return 1;
    struct stat logst; ok &= !stat(s.path, &logst) && (logst.st_mode & 0777) == 0600;
    ok &= append_user_text(&s, messages, "hello") == 0;
    cJSON *round = record_new(&s, "api_round"); cJSON_AddStringToObject(round, "request_model", cfg.model); cJSON_AddStringToObject(round, "response_model", "fixture-model");
    cJSON_AddStringToObject(round, "provider_message_id", "msg_fixture"); cJSON_AddStringToObject(round, "stop_reason", "end_turn");
    cJSON_AddItemToObject(round, "usage", usage_json(&ctx.round_usage)); cJSON_AddItemToObject(round, "raw_usage", cJSON_Duplicate(ctx.raw_usage, 1)); ok &= record_write(&s, round) == 0;
    cJSON *assistant = cJSON_CreateObject(), *content = cJSON_CreateArray(), *text = cJSON_CreateObject(); cJSON_AddStringToObject(assistant, "role", "assistant");
    cJSON_AddStringToObject(text, "type", "text"); cJSON_AddStringToObject(text, "text", "fixture"); cJSON_AddItemToArray(content, text); cJSON_AddItemToObject(assistant, "content", content); cJSON_AddItemToArray(messages, assistant);
    ok &= persist_message(&s, assistant, "model") == 0; char *path = strdup(s.path); close(s.fd); s.fd = -1; cJSON_Delete(messages);
    int partial = open(path, O_WRONLY | O_APPEND); if (partial >= 0) { ok &= write(partial, "{crash", 6) == 6; close(partial); } else ok = 0;
    cJSON *loaded = cJSON_CreateArray(); session resumed; ok &= session_resume(&resumed, &cfg, loaded, path) == 0;
    ok &= cJSON_GetArraySize(loaded) == 2 && resumed.total.input_tokens == 12 && resumed.total.output_tokens == 7 && resumed.seq == 5 && resumed.turn_index == 1;
    FILE *f = fopen(path, "r"); const char *want[] = {"session_meta", "turn_start", "message", "api_round", "message"}; char *line = NULL; size_t cap = 0;
    for (int i = 0; i < 5; i++) { if (!f || getline(&line, &cap, f) < 0) { ok = 0; break; } cJSON *r = cJSON_Parse(line); ok &= r && !strcmp(jstr(r, "type"), want[i]) && json_count(r, "seq") == i + 1; cJSON_Delete(r); }
    if (f) fclose(f); free(line); close(resumed.fd); free(resumed.path); free(resumed.last_stop); cJSON_Delete(loaded); free(path);
    for (int i = 0; i < MAX_BLOCKS; i++) { sb_free(&ctx.blocks[i].text); sb_free(&ctx.blocks[i].json); free(ctx.blocks[i].id); free(ctx.blocks[i].name); }
    free(ctx.stop_reason); free(ctx.message_id); free(ctx.response_model); cJSON_Delete(ctx.raw_usage); sb_free(&ctx.accum); sb_free(&ctx.raw); sb_free(&ctx.errmsg);
    fprintf(stderr, "gcode self-test: %s\n", ok ? "PASS" : "FAIL"); return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    config cfg;
    cfg.base_url      = getenv_or("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    cfg.api_key       = getenv("ANTHROPIC_API_KEY");
    cfg.auth_token    = getenv("ANTHROPIC_AUTH_TOKEN");
    cfg.model         = getenv_or("ANTHROPIC_MODEL", "claude-opus-4-8");
    cfg.system_prompt = "You are `gcode`, a terminal coding assistant running inside gucOS, "
                        "a small POSIX-like OS. Use the tools to explore, create, and edit "
                        "files and run shell commands. Be concise. Prefer small, verifiable "
                        "steps. The C compiler is `cc`.";
    cfg.max_tokens = 4096;
    cfg.max_turns  = 24;
    cfg.verbose = 0;
    cfg.color = -1;   /* #303: -1 auto (isatty), 0 forced off, 1 forced on */

    const char *prompt = NULL, *resume = NULL; int persist = 1, do_continue = 0, do_self_test = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-p") && i + 1 < argc)                 prompt = argv[++i];
        else if (!strcmp(argv[i], "--model") && i + 1 < argc)       cfg.model = argv[++i];
        else if (!strcmp(argv[i], "--system-prompt") && i + 1 < argc) cfg.system_prompt = argv[++i];
        else if (!strcmp(argv[i], "--max-turns") && i + 1 < argc)   cfg.max_turns = atol(argv[++i]);
        else if (!strcmp(argv[i], "--max-tokens") && i + 1 < argc)  cfg.max_tokens = atol(argv[++i]);
        else if (!strcmp(argv[i], "--verbose"))                     cfg.verbose = 1;
        else if (!strcmp(argv[i], "--no-color"))                    cfg.color = 0;
        else if (!strcmp(argv[i], "--color"))                       cfg.color = 1;
        else if (!strcmp(argv[i], "--no-persist"))                  persist = 0;
        else if (!strcmp(argv[i], "--resume") && i + 1 < argc)      resume = argv[++i];
        else if (!strcmp(argv[i], "-c") || !strcmp(argv[i], "--continue")) do_continue = 1;
        else if (!strcmp(argv[i], "--self-test"))                   do_self_test = 1;
        else if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            printf("usage: gcode [-p PROMPT] [--model M] [--system-prompt S]\n"
                   "            [--max-turns N] [--max-tokens N] [--resume ID|PATH] [-c|--continue]\n"
                   "            [--no-persist] [--verbose] [--no-color] [--color]\n"
                   "env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL,\n"
                   "     GCODE_STATE_DIR, XDG_STATE_HOME, NO_COLOR\n");
            return 0;
        }
    }
    /* #303: resolve colour per stream. --color forces on; --no-color or a
     * non-empty NO_COLOR (no-color.org) forces off; otherwise auto from
     * isatty — stdout (content) and stderr (chrome) decided independently,
     * so `gcode -p x > f` leaves f byte-clean while a tty stderr keeps
     * colour. */
    {
        const char *nc = getenv("NO_COLOR");
        if (cfg.color == 1)                       { g_color = g_color_err = 1; }
        else if (cfg.color == 0 || (nc && *nc))   { g_color = g_color_err = 0; }
        else { g_color = isatty(fileno(stdout)); g_color_err = isatty(fileno(stderr)); }
    }
    signal(SIGINT, on_interrupt);
    if (do_self_test) return self_test();
    if (!persist && (resume || do_continue)) { fprintf(stderr, "gcode: --no-persist cannot be used with resume\n"); return 2; }
    if (!cfg.api_key && !cfg.auth_token)
        fprintf(stderr, "%sgcode: warning: no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN set%s\n", CDIM, CRST);

    curl_global_init(CURL_GLOBAL_DEFAULT);
    cJSON *messages = cJSON_CreateArray();
    cJSON *tools = build_tools();
    session sess; memset(&sess, 0, sizeof sess); sess.fd = -1; sess.persist = persist;
    if (persist) {
        if ((resume || do_continue) ? session_resume(&sess, &cfg, messages, resume) : session_create(&sess, &cfg)) {
            cJSON_Delete(messages); cJSON_Delete(tools); curl_global_cleanup(); return 1;
        }
    } else make_session_id(sess.id);

    if (prompt) {
        if (append_user_text(&sess, messages, prompt) || agent_loop(&cfg, &sess, messages, tools)) { session_end(&sess, "eof"); return 1; }
        session_end(&sess, "eof");
    } else {
        /* #302: framed info banner (ui.py's ==== rule separators) */
        const char *rule = "==================================================";
        fprintf(stderr, "%s%s%s\n", R_INFO, rule, CRST);
        fprintf(stderr, "%s gcode%s \xe2\x80\x94 type a request, /quit to exit\n", R_INFO, CRST);
        fprintf(stderr, "%s%s%s\n", R_INFO, rule, CRST);
        char line[8192];
        for (;;) {
            /* #302: named speaker header on its own line, indented input */
            fprintf(stderr, "\n%sYou:%s\n", R_USER, CRST);
            int r = read_input_line("  ", line, sizeof line);
            if (r == 0) { g_interrupted = 0; continue; }   /* ^C: fresh prompt (#305) */
            if (r < 0) { session_end(&sess, "eof"); break; } /* real EOF ends the session */
            size_t n = strlen(line);
            while (n && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = 0;
            if (!n) continue;
            if (!strcmp(line, "/quit") || !strcmp(line, "/exit")) { session_end(&sess, "quit"); break; }
            if (!strcmp(line, "/clear")) {
                session_end(&sess, "clear"); free(sess.path); free(sess.last_stop);
                cJSON_Delete(messages); messages = cJSON_CreateArray();
                if (persist && session_create(&sess, &cfg)) { cJSON_Delete(messages); cJSON_Delete(tools); curl_global_cleanup(); return 1; }
                if (!persist) { memset(&sess, 0, sizeof sess); sess.fd = -1; make_session_id(sess.id); }
                fprintf(stderr, "%s[history cleared]%s\n", CDIM, CRST); continue;
            }
            if (append_user_text(&sess, messages, line)) break;
            int turn_rc = agent_loop(&cfg, &sess, messages, tools);
            g_interrupted = 0;   /* consumed: a stale mid-turn ^C must not eat the next EOF */
            if (turn_rc == -3) { session_end(&sess, "error"); break; }   /* auth: retrying cannot succeed */
            /* r == -1 (recoverable turn error — transport, 5xx/429, timeout)
               returns to the prompt like r == 0: the error line already
               printed red, and the failed user message STAYS in history —
               in-memory and in the persisted JSONL alike, so a resume
               replays exactly what the live session carries (#305). */
        }
    }
    if (sess.fd >= 0) close(sess.fd); free(sess.path); free(sess.last_stop);
    cJSON_Delete(messages); cJSON_Delete(tools);
    curl_global_cleanup();
    return 0;
}
