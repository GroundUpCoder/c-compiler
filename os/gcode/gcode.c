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
 *   GCODE_BASH_SECS      bash-tool wall-time cap (default CAP_BASH_SECS)
 *   GCODE_VISION         1/0 forces the read_image tool on/off (#670;
 *                        default: derived from the model's vision capability)
 *   GCODE_CACHE          0 disables the #747 prompt-cache breakpoints and
 *                        sends `system` as a bare string again (the escape
 *                        hatch for an Anthropic-compatible endpoint that
 *                        rejects the block-array form)
 * Flags: -p PROMPT (one-shot), --model, --system-prompt, --max-turns (opt-in
 *   turn cap; default unlimited, #353), --max-tokens, --context-tokens
 *   (#467: the model's context window override; env GCODE_CONTEXT_TOKENS,
 *   with GCODE_WARN_PCT/GCODE_COMPACT_PCT as the threshold knobs),
 *   --resume, --continue, --no-persist, --no-context, --verbose, --no-color.
 *
 * Context files (#530): layered GCODE.md — /usr/share/gcode + /etc/gcode +
 *   ~/.config/gcode + a project-tree walk-up from cwd — appended to the
 *   system prompt, general first, specific last. See context_load.
 *   GCODE_CONTEXT_ROOT is the system-layer test seam; --no-context is off.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <time.h>
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
#define CAP_SEARCH_RESULTS 200
#define CAP_SEARCH_VISITS  20000
#define CAP_SEARCH_DEPTH   64
#define CAP_WHOLE_FILE   (4 * 1024 * 1024)
#define CAP_IMAGE_BYTES  (3840 * 1024)   /* #670: 3.75 MB raw -> 5 MB base64, the API's per-image cap */
#define CAP_IMAGE_PX     8000            /* #670: the API's max image dimension */
#define MAX_BLOCKS       64

/* #503: the bash cap, env-overridable (GCODE_BASH_SECS, positive seconds)
 * so the timeout path is testable in seconds instead of minutes — the SAME
 * code path as the default, only the constant moves. */
static int bash_cap_secs(void) {
    static int v;
    if (!v) {
        const char *s = getenv("GCODE_BASH_SECS");
        long n = s ? atol(s) : 0;
        v = (n > 0 && n <= 86400) ? (int)n : CAP_BASH_SECS;
    }
    return v;
}

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

/* ---- UTF-8 validation + scrub (#386/#387) ------------------------------
 * The Messages API body must be valid UTF-8; cJSON escapes only controls
 * (< 32 on an unsigned pointer), so a raw high byte in any string rides
 * through to the POST verbatim and the server rejects the whole body. */

/* Length (1..4) of the valid UTF-8 sequence at p (n bytes available), else
 * 0. RFC 3629 / Unicode Table 3-7: rejects overlong forms, surrogates
 * (U+D800..DFFF) and anything above U+10FFFF. */
static int utf8_seq(const unsigned char *p, size_t n) {
    if (n >= 1 && p[0] <= 0x7F) return 1;
    if (n >= 2 && p[0] >= 0xC2 && p[0] <= 0xDF && (p[1] & 0xC0) == 0x80) return 2;
    if (n >= 3 && (p[2] & 0xC0) == 0x80 &&
        ((p[0] == 0xE0 && p[1] >= 0xA0 && p[1] <= 0xBF) ||
         (p[0] >= 0xE1 && p[0] <= 0xEC && (p[1] & 0xC0) == 0x80) ||
         (p[0] == 0xED && p[1] >= 0x80 && p[1] <= 0x9F) ||
         (p[0] >= 0xEE && p[0] <= 0xEF && (p[1] & 0xC0) == 0x80))) return 3;
    if (n >= 4 && (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80 &&
        ((p[0] == 0xF0 && p[1] >= 0x90 && p[1] <= 0xBF) ||
         (p[0] >= 0xF1 && p[0] <= 0xF3 && (p[1] & 0xC0) == 0x80) ||
         (p[0] == 0xF4 && p[1] >= 0x80 && p[1] <= 0x8F))) return 4;
    return 0;
}

/* First byte offset where s stops being valid UTF-8; -1 when clean. */
static long utf8_invalid_at(const char *s, size_t n) {
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;
    while (i < n) {
        int l = utf8_seq(p + i, n - i);
        if (!l) return (long)i;
        i += (size_t)l;
    }
    return -1;
}

/* malloc'd copy of s with every byte that is not part of a valid sequence
 * replaced by U+FFFD (EF BF BD) — one replacement per bad byte, so bytes
 * are marked, never silently dropped. *replaced counts them. */
static char *utf8_scrub(const char *s, size_t n, size_t *replaced) {
    const unsigned char *p = (const unsigned char *)s;
    sb out = {0}; size_t i = 0, rep = 0;
    while (i < n) {
        int l = utf8_seq(p + i, n - i);
        if (l) { sb_add(&out, s + i, (size_t)l); i += (size_t)l; }
        else   { sb_puts(&out, "\xEF\xBF\xBD"); i++; rep++; }
    }
    if (!out.p) sb_puts(&out, "");   /* empty input still returns a string */
    if (replaced) *replaced = rep;
    return out.p;
}

/* ---- config ----------------------------------------------------------- */
typedef struct {
    const char *base_url, *api_key, *auth_token, *model, *system_prompt;
    long max_tokens, max_turns;
    int  verbose, color;
    /* #530: layered GCODE.md context (fields LAST — self_test's positional
     * initializer zero-fills them). system_sent is the string actually
     * POSTed as `system` (base prompt + context blocks; NULL = no context
     * loaded, fall back to system_prompt). context_files lists what was
     * loaded, for session_meta. */
    char  *system_sent;
    cJSON *context_files;
    /* #467: context-window override (--context-tokens / GCODE_CONTEXT_TOKENS;
     * 0 = derive from the model). Field LAST, same zero-fill rule as above. */
    long   context_tokens;
} config;

#define GCODE_VERSION "2"
#define LOG_SCHEMA_VERSION 1

/* ---- #462: the output cap ---------------------------------------------
 * The old default was 4096 — far too small for an agent that writes whole
 * source files, so hitting the cap mid-`tool_use` (and bricking the
 * session, see do_turn) was an ordinary Monday rather than an edge case.
 * The values below were MEASURED against the providers actually in use on
 * 2026-08-03, not assumed — a cap the provider rejects would turn a rare
 * brick into a 400 on every request:
 *   api.anthropic.com   claude-opus-4-8 (the default model)  32768 -> 200
 *                                                           128000 -> 200
 *                                                           128001 -> 400 "> 128000"
 *                       claude-haiku-4-5 (lowest live cap)   64000 -> 200
 *                                                           128000 -> 400 "> 64000"
 *                       claude-3-haiku-20240307             404 (retired)
 *   api.deepseek.com/anthropic  deepseek-v4-flash / -pro     32768 -> 200
 *                       (accepts 1000000 too — it does not validate at all)
 * So 32768 sits at half the SMALLEST cap any live Anthropic model accepts,
 * and the ceiling is the largest one any of them accepts. The floor keeps
 * an atol() of a typo (or a negative) from posting a nonsense cap. Values
 * outside the range are CLAMPED with a printed note, never passed through. */
#define MAX_TOKENS_DEFAULT 32768
#define MAX_TOKENS_FLOOR     256
#define MAX_TOKENS_CEILING 128000

/* #462: consecutive truncation-continuations before the turn gives up.
 * Deliberately INDEPENDENT of cfg.max_turns (which defaults to unlimited,
 * #353): a model that keeps re-sending an oversized write would otherwise
 * spend the whole turn budget silently. Hitting it PRINTS why. */
#define TRUNC_MAX_CONTINUATIONS 3

/* ---- #467: the context-window budget -----------------------------------
 * gcode has no client-side tokenizer, so the live accounting is the
 * provider's own usage numbers: the assembled prompt of round N is
 * input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
 * On a cached conversation input_tokens ALONE is tiny while cache_read
 * carries the real size (the #462 incident logged 900,480 cache-read
 * tokens) — thresholding on the wrong field undercounts by orders of
 * magnitude and the compactor looks implemented while being dead.
 *
 * The window table below is substring-matched like the pricing table, but
 * its unknown-model fallback is a LIVE conservative default, never "omit
 * the feature": pricing can honestly omit a $ line for a model it cannot
 * price, while a compactor keyed only on known ids would silently never
 * fire against exactly the providers gcode is live-tested on. A default
 * smaller than the real window compacts early (safe, mildly lossy); the
 * provider's own context-length 400 nets a default that is too large. */
#define CTX_WINDOW_DEFAULT   128000
#define CTX_WARN_PCT_DEFAULT     75
#define CTX_COMPACT_PCT_DEFAULT  85
#define CTX_TARGET_PCT           50
#define CAP_COMPACT_SUMMARY (16 * 1024)
#define COMPACT_MARKER "[gcode: compacted history]"

typedef struct {
    long long input_tokens, output_tokens;
    long long cache_creation_input_tokens, cache_read_input_tokens;
} usage;

/* ---- #348: per-model usage buckets ------------------------------------
 * A provider can map the requested alias to different models across the
 * rounds of one turn (or one session), and the flat usage totals destroy
 * that attribution before pricing runs. Buckets are ADDITIVE alongside the
 * scalar totals (resume and its golden depend on the scalars): one entry
 * per distinct actual model, accumulating that model's usage + round count,
 * in first-seen order. Helpers live after the usage/json ones they use. */
typedef struct { char *model; usage u; int rounds; } mbucket;
typedef struct { mbucket *v; int n, cap; } mlist;

typedef struct {
    int fd, persist;
    char id[33];
    char *path;
    char *last_stop;
    char *response_model;   /* #348: last provider-returned model (owned) */
    long long seq, turn_index;
    long long round_index;  /* #348: API round within the current turn (1-based) */
    int trunc_streak;       /* #462: consecutive rounds cut at the output cap */
    long long last_prompt_tokens;  /* #467: input+cache_create+cache_read of the last round */
    int ctx_warned;         /* #467: soft-threshold warning latched until usage drops below */
    usage total;
    mlist models;           /* #348: per-actual-model usage across the session */
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

static void mlist_add(mlist *l, const char *model, const usage *u) {
    for (int i = 0; i < l->n; i++)
        if (!strcmp(l->v[i].model, model)) { usage_add(&l->v[i].u, u); l->v[i].rounds++; return; }
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 4;
        l->v = realloc(l->v, (size_t)l->cap * sizeof *l->v);
        if (!l->v) { fprintf(stderr, "gcode: out of memory\n"); exit(1); }
    }
    l->v[l->n].model = strdup(model); l->v[l->n].u = *u; l->v[l->n].rounds = 1; l->n++;
}
static void mlist_free(mlist *l) {
    for (int i = 0; i < l->n; i++) free(l->v[i].model);
    free(l->v); l->v = NULL; l->n = l->cap = 0;
}
/* the ordered set of actual models, for the turn_end/session_end summaries */
static cJSON *mlist_json(const mlist *l) {
    cJSON *a = cJSON_CreateArray();
    for (int i = 0; i < l->n; i++) cJSON_AddItemToArray(a, cJSON_CreateString(l->v[i].model));
    return a;
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
 * wins over "claude-opus-4". Rates: Anthropic first-party, 2026-08.
 * A row may carry a dated introductory rate (#313): `until` is the LAST
 * UTC day (YYYY-MM-DD) on which the in/out columns apply; from the next
 * day the sticker columns in2/out2 take over. `today` is passed as a
 * YYYY-MM-DD string so the rollover is testable with fixed dates. */
static double price_usage_at(const char *model, const usage *u, const char *today) {
    static const struct { const char *key; double in, out;
                          const char *until; double in2, out2; } P[] = {
        { "claude-fable-5",  10.0, 50.0, NULL, 0, 0 },
        { "claude-mythos-5", 10.0, 50.0, NULL, 0, 0 },
        { "claude-opus-5",    5.0, 25.0, NULL, 0, 0 },
        { "claude-opus-4",    5.0, 25.0, NULL, 0, 0 },  /* 4.8/4.7/4.6/4.5/4.1/4.0 */
        { "claude-sonnet-5",  2.0, 10.0, "2026-08-31", 3.0, 15.0 },  /* intro, then sticker */
        { "claude-sonnet-4",  3.0, 15.0, NULL, 0, 0 },
        { "claude-haiku-4",   1.0,  5.0, NULL, 0, 0 },
    };
    if (!model) return -1.0;
    for (size_t i = 0; i < sizeof P / sizeof P[0]; i++) {
        if (strstr(model, P[i].key)) {
            double in = P[i].in, out = P[i].out;
            if (P[i].until && today && strcmp(today, P[i].until) > 0) {
                in = P[i].in2; out = P[i].out2;
            }
            return ((double)u->input_tokens * in
                  + (double)u->cache_creation_input_tokens * in * 1.25
                  + (double)u->cache_read_input_tokens * in * 0.10
                  + (double)u->output_tokens * out) / 1e6;
        }
    }
    return -1.0;   /* unknown model — caller omits the $ line */
}

static double price_usage(const char *model, const usage *u) {
    /* single-threaded (the gucOS libc has gmtime but not gmtime_r) */
    char today[11]; time_t now = time(NULL); struct tm *tm = gmtime(&now);
    if (!tm || !strftime(today, sizeof today, "%Y-%m-%d", tm)) today[0] = 0;
    return price_usage_at(model, u, today);
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
static void render_tool_result(const char *result, long secs) {
    /* #507: a slow call names its duration — unconditional (not tty-gated),
     * a one-shot line that is honest in captured logs too */
    if (secs >= 2)
        fprintf(stderr, "    %sResult%s %s(%lds)%s\n", R_RES, CRST, CDIM, secs, CRST);
    else
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
#ifndef __MTOTS__
/* #511: the native self-pipe. A SIGINT landing in the instructions between
 * run_command's loop-top g_interrupted check and poll(2) entering used to be
 * handled BEFORE poll blocked — no EINTR, so against a SILENT child the ^C
 * stayed latent until the next slice timeout (up to 1s, the #507 clamp). The
 * handler writes one byte here and the read end joins run_command's pollfd
 * set, so a signal at ANY point wakes the poll: landing before the syscall
 * leaves the byte already readable, landing during it is EINTR/POLLIN either
 * way. The FLAG stays authoritative — the pipe is only a wake mechanism, so
 * draining a stale byte can never lose an interrupt. gucOS does not need
 * this: cooperative signals run handlers only at import returns, and there
 * is no import between the loop-top check and the read (the wm.c
 * flag-then-park rule). */
static int g_intr_pipe[2] = { -1, -1 };
#endif
static void on_interrupt(int sig) {
    (void)sig; g_interrupted = 1;
#ifndef __MTOTS__
    if (g_intr_pipe[1] >= 0) {          /* async-signal-safe; preserve errno */
        int e = errno;
        ssize_t w = write(g_intr_pipe[1], "x", 1); (void)w;
        errno = e;
    }
#endif
}

/* ---- #507: progress signal during long operations ----------------------
 * A working agent must be distinguishable from a wedged one: gcode used to
 * print the tool header, then NOTHING until the result (the last output of
 * a 15-minute session). The heartbeat is on by default on a tty;
 * GCODE_PROGRESS=1/0 forces it on/off (the GCODE_BASH_SECS test seam
 * precedent). On a real tty it renders in place with \r; forced on down a
 * pipe it prints plain newline-terminated lines; a pipe without the env
 * override gets nothing — the harness-safe degradation. */
static int progress_enabled(void) {
    static int v;                       /* 0 unknown, 1 on, 2 off */
    if (!v) {
        const char *s = getenv("GCODE_PROGRESS");
        if (s && *s) v = atoi(s) ? 1 : 2;
        else v = isatty(2) ? 1 : 2;
    }
    return v == 1;
}
static int g_progress_live;             /* an in-place \r line is showing */
static void progress_show(const char *what, long secs) {
    if (!progress_enabled()) return;
    if (isatty(2)) {
        fprintf(stderr, "\r    %s\xe2\x80\xa6 %s %lds%s\033[K", CDIM, what, secs, CRST);
        g_progress_live = 1;
    } else {
        fprintf(stderr, "    %s\xe2\x80\xa6 %s %lds%s\n", CDIM, what, secs, CRST);
    }
    fflush(stderr);
}
static void progress_clear(void) {
    if (!g_progress_live) return;
    fprintf(stderr, "\r\033[K");
    fflush(stderr);
    g_progress_live = 0;
}

/* #507: while a request is in flight and no response byte has arrived,
 * libcurl's periodic callback (already wired for the ^C abort; the in-OS
 * veneer calls it at every wait boundary) doubles as the API-half
 * heartbeat. dlnow > 0 means the stream is rendering its own progress. */
static time_t g_api_start;
static int curl_progress(void *p, curl_off_t dltotal, curl_off_t dlnow,
                         curl_off_t ultotal, curl_off_t ulnow) {
    (void)p; (void)dltotal; (void)ultotal; (void)ulnow;
    if (g_api_start && dlnow == 0) {
        long secs = (long)(time(NULL) - g_api_start);
        static long last_shown;
        if (secs >= 2 && secs != last_shown) {
            progress_show("waiting for model", secs);
            last_shown = secs;
        }
    }
    return g_interrupted ? 1 : 0;
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
#include <sys/select.h>   /* #504: the post-exit nonblocking pipe drain */

/* Timeout: setitimer(ITIMER_REAL)+SIGALRM (todos/0044). The parked pipe
 * read EINTRs when the signal lands (kernel krpc-intr); we SIGKILL the
 * child and STOP READING (#503 — draining to EOF after the kill made the
 * cap unbounded, see the loop-top check). */
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
    int truncated = 0, timedout = 0, intkilled = 0;
    /* #504: the direct sh exiting means the FOREGROUND work is done (a shell
     * waits its foreground children before exiting) — only processes the
     * command itself backgrounded can still hold the pipe write end. Blocking
     * on to their EOF was the #504 wedge: `cd X && app &` leaves a NOMMU
     * re-exec'd hush subshell wrapper holding fds 1/2 for the app's whole
     * lifetime (there is no real exec to collapse it into the redirected
     * app), so every compound background launch burned the full cap. */
    int shdone = 0, survivors = 0, shstatus = 0;
    time_t start = time(NULL);
    long shown = 0;
    g_bash_alarm = 0;
    signal(SIGALRM, bash_on_alarm);
    /* #507: the alarm is a 1-second TICK, re-armed one-shot each time it
     * fires (only the proven one-shot itimer path is relied on); the CAP is
     * judged at the loop top against the wall clock — the same loud kill on
     * the same code path, so the #503 discipline is unchanged. Each tick
     * EINTRs a parked read: that is both the heartbeat's chance to render
     * and the cap's chance to fire on a silent child. */
    struct itimerval itv;
    itv.it_interval.tv_sec = 0; itv.it_interval.tv_usec = 0;
    itv.it_value.tv_sec = 1; itv.it_value.tv_usec = 0;
    setitimer(ITIMER_REAL, &itv, 0);
    for (;;) {
        char buf[4096];
        /* #503: the cap check lives at the TOP of the loop, not only in
         * the EINTR branch. Two failure modes of the old shape, both
         * measured (#488 Pass B): (a) kill-then-keep-draining hostaged
         * the cap to any pipe-holding descendant — `sleep 200` ran 203s,
         * `sleep 300 &` never returned (the alarm is one-shot, nothing
         * fired again); (b) a chatty child whose reads keep succeeding
         * never EINTRs, so an EINTR-only check never ran at all. Kill AND
         * STOP READING, exactly the #412(c) rule below. Gap-free by the
         * cooperative-signal rule (the wm.c flag-then-park precedent):
         * handlers run only at import returns, and there is no import
         * between this check and the read. */
        /* #510: the ^C check lives at the loop top too — the interrupt twin
         * of the alarm's #503 move above. It used to sit only in the EINTR
         * branch, but a chatty child's reads keep returning data and never
         * park, so nothing EINTRs and the kill branch never ran: the ^C did
         * NOTHING until the wall-time cap (measured — a 60s-capped chatty
         * round stalled the full 60s). #412(c) semantics unchanged: the
         * fg-pgroup SIGINT normally kills the child too (EOF follows at
         * once); this closes the survivor edge — a child that traps/ignores
         * SIGINT, or a kill -INT aimed at gcode alone. Kill AND STOP
         * READING: draining to EOF would hostage the interrupt to any
         * pipe-holding descendant. Everything the tool printed before the
         * ^C was already drained by earlier reads, and waitpid on the
         * SIGKILLed sh cannot block. Checked BEFORE the alarm: if both
         * landed in one safe-point batch, the user's ^C is the truer cause. */
        if (g_interrupted && !intkilled) { kill(pid, SIGKILL); intkilled = 1; break; }
        long elapsed = (long)(time(NULL) - start);
        if (elapsed >= bash_cap_secs() && !timedout) { kill(pid, SIGKILL); timedout = 1; break; }
        if (g_bash_alarm) {                  /* #507: 1s tick — render + re-arm */
            g_bash_alarm = 0;
            /* #504: reap-check the direct sh at the tick. Gone means the
             * foreground work finished — return now (after a nonblocking
             * drain below) instead of parking on an EOF only a background
             * survivor can deliver. Tick-gated, so a launch costs at most
             * ~1s; the EOF path still serves every survivor-free command. */
            if (waitpid(pid, &shstatus, WNOHANG) == pid) { shdone = 1; break; }
            if (elapsed >= 1 && elapsed != shown) { progress_show("running", elapsed); shown = elapsed; }
            itv.it_value.tv_sec = 1; itv.it_value.tv_usec = 0;
            setitimer(ITIMER_REAL, &itv, 0);
        }
        ssize_t n = read(pfd[0], buf, sizeof buf);
        if (n == 0) break;                   /* EOF: child (tree) is done */
        if (n < 0) {
            if (errno == EINTR) {
                /* Alarm or ^C EINTR: both handled by the loop-top checks
                 * (no import between them and the read, so no signal can
                 * slip through the gap — the wm.c flag-then-park rule). */
                continue;
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
    progress_clear();
    /* #504: sh exited — collect what is already buffered, without ever
     * blocking (a background survivor may hold the write end open forever).
     * EOF during the drain means nothing holds the pipe: survivor-free. */
    if (shdone) {
        for (;;) {
            fd_set rf; struct timeval tv = { 0, 0 };
            FD_ZERO(&rf); FD_SET(pfd[0], &rf);
            int r = select(pfd[0] + 1, &rf, 0, 0, &tv);
            if (r < 0 && errno == EINTR) continue;
            if (r <= 0) { survivors = 1; break; }    /* open but dry */
            char dbuf[4096];
            ssize_t n = read(pfd[0], dbuf, sizeof dbuf);
            if (n == 0) break;                       /* EOF: survivor-free */
            if (n < 0) { if (errno == EINTR) continue; survivors = 1; break; }
            if (out.len < CAP_BASH_BYTES) {
                size_t room = CAP_BASH_BYTES - out.len;
                size_t take = (size_t)n < room ? (size_t)n : room;
                sb_add(&out, dbuf, take);
                if (take < (size_t)n) truncated = 1;
            } else {                                 /* firehose survivor: stop —
                we are leaving, not draining to EOF (#503's rule) */
                truncated = 1; survivors = 1; break;
            }
        }
    }
    close(pfd[0]);
    int status = 0;
    if (shdone) status = shstatus;
    else waitpid(pid, &status, 0);
    if (timedout) {
        *exit_code = -1;
        /* #503: say what actually happened — the shell got SIGKILL, but a
         * process it spawned may survive (hush runs commands as its own
         * children; they inherit nothing from our kill). Never claim the
         * whole command was killed: a model told an rm -rf died will
         * re-run it concurrently with the survivor. */
        char m[128];
        snprintf(m, sizeof m, "\n[command timed out after %ds: shell killed;"
                 " processes it spawned may still be running]", bash_cap_secs());
        sb_puts(&out, m);
    } else {
        *exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        /* #509: same honesty as the timeout path above. Our SIGKILL reached
         * only the direct sh — in the ordinary ^C the fg-pgroup SIGINT also
         * reached the job, but in the #412(c) survivor edge (a child that
         * traps/ignores SIGINT, or kill -INT at gcode alone) it did not.
         * Say the shell died and that processes it spawned may survive;
         * never claim the whole command was killed. */
        if (intkilled) sb_puts(&out, "\n[command interrupted by user (^C): shell killed;"
                                     " processes it spawned may still be running]");
        /* #504: an honest early return — the pipe is still open, so
         * something the command backgrounded is alive; its future output
         * has nowhere captured to go. */
        if (shdone && survivors)
            sb_puts(&out, "\n[background processes spawned by this command are"
                          " still running; their further output is not captured]");
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

/* #511: create the interrupt self-pipe (once, from main). Nonblocking both
 * ends — the handler's write must never block on a full pipe, and the drain
 * loop ends at EAGAIN — and CLOEXEC so the sh child never inherits the fds.
 * On failure the fds stay -1: poll ignores a negative fd, so every failure
 * mode degrades to the pre-#511 behavior, never to a broken loop. */
static void intr_pipe_init(void) {
    if (pipe(g_intr_pipe)) { g_intr_pipe[0] = g_intr_pipe[1] = -1; return; }
    for (int i = 0; i < 2; i++) {
        fcntl(g_intr_pipe[i], F_SETFL, O_NONBLOCK);
        fcntl(g_intr_pipe[i], F_SETFD, FD_CLOEXEC);
    }
}

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
    int truncated = 0, intkilled = 0;
    /* #504: same contract as the gucOS flavor — the direct sh exiting means
     * the foreground work is done; only backgrounded survivors can still
     * hold the pipe, and parking on their EOF wedges every `app &` whose
     * output lands in our pipe (an unredirected orphan holds fds 1/2). */
    int shdone = 0, survivors = 0, shstatus = 0;
    *exit_code = 0;   /* the timeout path overwrites with -1; every other
                         path used to read this uninitialized in the
                         `!= -1` guard below */
    time_t start = time(NULL);
    time_t deadline = start + bash_cap_secs();
    long shown = 0;
    /* #511: shed bytes a ^C consumed elsewhere (the REPL prompt) left in the
     * pipe — the flag is authoritative, so eating a stale byte loses nothing
     * and a fresh signal after this drain leaves its own byte for poll. */
    if (g_intr_pipe[0] >= 0) {
        char junk[64];
        while (read(g_intr_pipe[0], junk, sizeof junk) > 0) {}
    }
    for (;;) {
        /* #510: check BEFORE the poll, not only in its EINTR branch — a
         * chatty child keeps the pipe readable, so poll keeps returning
         * POLLIN and a SIGINT landing outside the poll syscall never
         * produces EINTR: the kill branch never ran and the ^C did nothing
         * until the cap (measured — the smoke.mjs #510 red control).
         * #412(c) semantics unchanged: a ^C whose SIGINT reached gcode but
         * not the child (kill -INT at gcode alone, or a SIGINT-trapping
         * child) must not drain the child's remaining runtime — kill and
         * stop reading, like the timeout path below. */
        if (g_interrupted && !intkilled) { kill(pid, SIGKILL); intkilled = 1; break; }
        /* #504: reap-check the direct sh (the poll below wakes at least
         * once a second, so a backgrounded launch returns within ~1s). */
        if (waitpid(pid, &shstatus, WNOHANG) == pid) { shdone = 1; break; }
        long elapsed = (long)(time(NULL) - start);        /* #507: heartbeat */
        if (elapsed >= 1 && elapsed != shown) { progress_show("running", elapsed); shown = elapsed; }
        /* #511 test seam (GCODE_TEST_INTR_BEFORE_POLL=1): raise SIGINT once,
         * exactly in the raced window — after the loop-top check, before poll
         * enters. The only deterministic way to place a signal there; the
         * product path is untouched (the hook is a raise(), not a branch). */
        static int selfraise = -1;
        if (selfraise < 0) {
            const char *s = getenv("GCODE_TEST_INTR_BEFORE_POLL");
            selfraise = (s && atoi(s)) ? 1 : 0;
        }
        if (selfraise == 1) { selfraise = 2; raise(SIGINT); }
        struct pollfd pf[2] = { { pfd[0], POLLIN, 0 }, { g_intr_pipe[0], POLLIN, 0 } };
        int remain = (int)(deadline - time(NULL));
        if (remain < 0) remain = 0;
        int slice = remain * 1000 + 100;
        if (slice > 1000) slice = 1000;   /* #507: wake ~1/s so a silent child still ticks */
        int r = poll(pf, 2, slice);
        if (r < 0 && errno == EINTR)
            continue;                        /* ^C re-checked at loop top */
        if (r > 0 && (pf[1].revents & POLLIN)) {   /* #511: interrupt wake */
            char junk[64];
            while (read(g_intr_pipe[0], junk, sizeof junk) > 0) {}
            continue;                        /* loop top re-checks the flag */
        }
        if (r == 0 && time(NULL) >= deadline) {  /* timeout: kill the direct
            sh and stop reading — its descendants may survive (#503) */
            kill(pid, SIGKILL);
            *exit_code = -1;
            break;
        }
        if (r > 0 && (pf[0].revents & (POLLIN | POLLHUP))) {
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
    progress_clear();
    /* #504: sh exited — nonblocking drain of what is already buffered; EOF
     * here means nothing holds the pipe (survivor-free). Mirrors the gucOS
     * flavor's select drain. */
    if (shdone) {
        for (;;) {
            struct pollfd pf = { pfd[0], POLLIN, 0 };
            int r = poll(&pf, 1, 0);
            if (r < 0 && errno == EINTR) continue;
            if (r <= 0 || !(pf.revents & (POLLIN | POLLHUP))) { survivors = 1; break; }
            char dbuf[4096];
            ssize_t n = read(pfd[0], dbuf, sizeof dbuf);
            if (n == 0) break;                       /* EOF: survivor-free */
            if (n < 0) { if (errno == EINTR) continue; survivors = 1; break; }
            if (out.len < CAP_BASH_BYTES) {
                size_t room = CAP_BASH_BYTES - out.len;
                size_t take = (size_t)n < room ? (size_t)n : room;
                sb_add(&out, dbuf, take);
                if (take < (size_t)n) truncated = 1;
            } else {
                truncated = 1; survivors = 1; break;
            }
        }
    }
    close(pfd[0]);
    int status = 0;
    if (shdone) status = shstatus;
    else waitpid(pid, &status, 0);
    if (*exit_code != -1)
        *exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    if (*exit_code == -1) {
        /* #503: same honesty as the gucOS path — the sh got SIGKILL,
         * descendants may survive; never claim the command was killed. */
        char m[128];
        snprintf(m, sizeof m, "\n[command timed out after %ds: shell killed;"
                 " processes it spawned may still be running]", bash_cap_secs());
        sb_puts(&out, m);
    } else {
        /* #509: same honesty as the gucOS path — the SIGKILL reached only
         * the direct sh; its descendants may survive the survivor-edge ^C. */
        if (intkilled) sb_puts(&out, "\n[command interrupted by user (^C): shell killed;"
                                     " processes it spawned may still be running]");
        /* #504: same honest early-return note as the gucOS flavor. */
        if (shdone && survivors)
            sb_puts(&out, "\n[background processes spawned by this command are"
                          " still running; their further output is not captured]");
        if (truncated) {
            char m[64];
            snprintf(m, sizeof m, "\n[output truncated at %d bytes]", CAP_BASH_BYTES);
            sb_puts(&out, m);
        }
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

/* ---- #670: read_image — put real pixels in front of the model ----------
 * A game is a VISUAL artifact, and the statistics an agent can compute over
 * a screenshot (pixel counts, centroids, bounding boxes) are mirror- and
 * orientation-invariant: a complete Asteroids shipped with every glyph
 * mirrored, "verified" by exactly those statistics (#508 Pass B r2). The
 * fix is not a better statistic — it is eyes. read_image returns the
 * file's bytes as a real image content block in the tool_result, so the
 * model's own vision looks at the same PNG a human reviewer would.
 *
 * The tool renders NO verdict and applies NO transform: the bytes pass
 * through exactly (base64 is a positional transport encoding — there is no
 * pixel convention here to get wrong), so the verifying instrument shares
 * zero code with the renderer under test or with any comparator the agent
 * writes. A transport bug corrupts the image loudly (the provider rejects
 * undecodable data); it cannot plausibly pass a wrong picture.
 *
 * Whether the model CAN see is a provider property, so the tool is gated
 * by a capability table (substring-matched like pricing) with GCODE_VISION
 * =1/0 as the override seam (the GCODE_BASH_SECS pattern). The gate must
 * be CLIENT-side and conservative: MEASURED 2026-08-24 against
 * api.deepseek.com/anthropic (deepseek-v4-flash AND -v4-pro, image blocks
 * both in a plain user message and in a real tool_use/tool_result
 * round-trip), the provider returns HTTP 200 and silently replaces the
 * image with a literal "[Unsupported Image]" placeholder — no error ever
 * comes back, so nothing downstream can catch a wrongly-open gate there.
 * A known-off or unknown model gets a LOUD startup note, never a silently
 * absent tool: an agent that half-believes it might see re-creates the
 * exact false-verification this ticket is about. */
static int g_vision;   /* 0 off, 1 on; resolved once by vision_resolve() */
static int vision_enabled(void) { return g_vision == 1; }

/* 1 = vision, 0 = no vision, -1 = not in the table */
static int model_vision_table(const char *model) {
    static const struct { const char *key; int vision; } V[] = {
        { "claude",   1 },   /* every live Claude model (3 and later) has vision */
        { "deepseek", 0 },   /* measured above: images silently swallowed, HTTP 200 */
    };
    if (model)
        for (size_t i = 0; i < sizeof V / sizeof V[0]; i++)
            if (strstr(model, V[i].key)) return V[i].vision;
    return -1;
}

static void vision_resolve(const char *model) {
    const char *s = getenv("GCODE_VISION");
    if (s && *s) {
        g_vision = atoi(s) ? 1 : 0;
        if (!g_vision)
            fprintf(stderr, "%sgcode: read_image disabled by GCODE_VISION=0%s\n", CDIM, CRST);
        return;
    }
    int t = model_vision_table(model);
    g_vision = t == 1;
    if (t == 0)
        fprintf(stderr, "%sgcode: %s does not support image input — the read_image tool is"
                " disabled, so screenshots cannot be visually verified on this model%s\n",
                CDIM, model, CRST);
    else if (t < 0)
        fprintf(stderr, "%sgcode: %s is not known to support image input — the read_image tool"
                " is disabled (GCODE_VISION=1 enables it if the provider really has vision)%s\n",
                CDIM, model, CRST);
}

static char *b64_encode(const unsigned char *p, size_t n) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char *out = malloc((n + 2) / 3 * 4 + 1);
    if (!out) { fprintf(stderr, "gcode: out of memory\n"); exit(1); }
    char *o = out;
    size_t i = 0;
    for (; i + 3 <= n; i += 3) {
        unsigned v = (unsigned)p[i] << 16 | (unsigned)p[i + 1] << 8 | p[i + 2];
        *o++ = T[v >> 18]; *o++ = T[(v >> 12) & 63]; *o++ = T[(v >> 6) & 63]; *o++ = T[v & 63];
    }
    if (n - i == 1) {
        unsigned v = (unsigned)p[i] << 16;
        *o++ = T[v >> 18]; *o++ = T[(v >> 12) & 63]; *o++ = '='; *o++ = '=';
    } else if (n - i == 2) {
        unsigned v = (unsigned)p[i] << 16 | (unsigned)p[i + 1] << 8;
        *o++ = T[v >> 18]; *o++ = T[(v >> 12) & 63]; *o++ = T[(v >> 6) & 63]; *o++ = '=';
    }
    *o = 0;
    return out;
}

static unsigned rd_be32(const unsigned char *p) { return (unsigned)p[0] << 24 | (unsigned)p[1] << 16 | (unsigned)p[2] << 8 | p[3]; }
static unsigned rd_be16(const unsigned char *p) { return (unsigned)p[0] << 8 | p[1]; }
static unsigned rd_le16(const unsigned char *p) { return (unsigned)p[1] << 8 | p[0]; }
static unsigned rd_le24(const unsigned char *p) { return (unsigned)p[2] << 16 | (unsigned)p[1] << 8 | p[0]; }

/* Identify an image by its MAGIC BYTES — never the file name; the bytes are
 * what the provider will decode — and pull the pixel dimensions out of the
 * header. Returns the media type (PNG/JPEG/GIF/WebP) or NULL for anything
 * else; *w and *h are 0 when the header did not yield dimensions (accepted,
 * undimensioned — the provider enforces its own pixel limit either way). */
static const char *img_sniff(const unsigned char *p, size_t n, long *w, long *h) {
    *w = *h = 0;
    if (n >= 24 && !memcmp(p, "\x89PNG\r\n\x1a\n", 8)) {
        if (!memcmp(p + 12, "IHDR", 4)) { *w = (long)rd_be32(p + 16); *h = (long)rd_be32(p + 20); }
        return "image/png";
    }
    if (n >= 3 && p[0] == 0xFF && p[1] == 0xD8 && p[2] == 0xFF) {
        /* walk the marker segments to the first SOFn frame header */
        size_t i = 2;
        while (i + 9 < n) {
            if (p[i] != 0xFF) break;
            unsigned m = p[i + 1];
            if (m == 0xFF) { i++; continue; }                              /* fill byte */
            if (m == 0xD8 || (m >= 0xD0 && m <= 0xD7) || m == 0x01) { i += 2; continue; }
            if (m == 0xD9 || m == 0xDA) break;                             /* EOI / entropy data */
            unsigned len = rd_be16(p + i + 2);
            if (len < 2) break;
            if (m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC) {
                *h = (long)rd_be16(p + i + 5); *w = (long)rd_be16(p + i + 7);
                break;
            }
            i += 2 + len;
        }
        return "image/jpeg";
    }
    if (n >= 10 && (!memcmp(p, "GIF87a", 6) || !memcmp(p, "GIF89a", 6))) {
        *w = (long)rd_le16(p + 6); *h = (long)rd_le16(p + 8);
        return "image/gif";
    }
    if (n >= 30 && !memcmp(p, "RIFF", 4) && !memcmp(p + 8, "WEBP", 4)) {
        if (!memcmp(p + 12, "VP8X", 4)) {
            *w = (long)rd_le24(p + 24) + 1; *h = (long)rd_le24(p + 27) + 1;
        } else if (!memcmp(p + 12, "VP8 ", 4) && p[23] == 0x9D && p[24] == 0x01 && p[25] == 0x2A) {
            *w = (long)(rd_le16(p + 26) & 0x3FFF); *h = (long)(rd_le16(p + 28) & 0x3FFF);
        } else if (!memcmp(p + 12, "VP8L", 4) && p[20] == 0x2F) {
            unsigned b0 = p[21], b1 = p[22], b2 = p[23], b3 = p[24];
            *w = (long)((b0 | ((b1 & 0x3F) << 8)) + 1);
            *h = (long)(((b1 >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10)) + 1);
        }
        return "image/webp";
    }
    return NULL;
}

/* On success sets *blocks_out to a content ARRAY — the image block first,
 * then a one-line text caption (path, media type, dimensions, byte count)
 * so the transcript and a later compaction summary can say what was shown
 * — and returns the caption for display. On failure *blocks_out stays NULL
 * and the return is the error string, like every other tool. */
static char *tool_read_image(cJSON *in, cJSON **blocks_out) {
    cJSON *jp = cJSON_GetObjectItem(in, "path");
    if (!cJSON_IsString(jp)) return strdup("error: read_image needs a string 'path'");
    const char *path = jp->valuestring;
    FILE *f = fopen(path, "rb");
    if (!f) { sb e = {0}; sb_puts(&e, "error: cannot open "); sb_puts(&e, path);
              sb_puts(&e, ": "); sb_puts(&e, strerror(errno)); return e.p; }
    sb raw = {0}; char buf[8192]; size_t rn; int over = 0;
    while ((rn = fread(buf, 1, sizeof buf, f)) > 0) {
        if (raw.len + rn > CAP_IMAGE_BYTES) { over = 1; break; }
        sb_add(&raw, buf, rn);
    }
    fclose(f);
    if (over) {
        sb_free(&raw); sb e = {0}; char m[192];
        snprintf(m, sizeof m, "error: image is larger than the %d-byte cap the API accepts — "
                 "capture a smaller region instead (wmctl shot takes one: "
                 "wmctl shot SID FILE X Y W H)", CAP_IMAGE_BYTES);
        sb_puts(&e, m); return e.p;
    }
    long w = 0, h = 0;
    const char *media = img_sniff((const unsigned char *)raw.p, raw.len, &w, &h);
    if (!media) {
        sb_free(&raw);
        return strdup("error: not a recognized image — read_image accepts PNG, JPEG, GIF and "
                      "WebP, identified by content, not file name. For text files use read_file.");
    }
    if (w > CAP_IMAGE_PX || h > CAP_IMAGE_PX) {
        sb_free(&raw); sb e = {0}; char m[160];
        snprintf(m, sizeof m, "error: image is %ldx%ld — the API rejects images over %d px on a "
                 "side; capture a smaller region", w, h, CAP_IMAGE_PX);
        sb_puts(&e, m); return e.p;
    }
    char *b64 = b64_encode((const unsigned char *)raw.p, raw.len);
    size_t nbytes = raw.len;
    sb_free(&raw);
    char cap_line[512];
    if (w && h)
        snprintf(cap_line, sizeof cap_line, "image %s: %s %ldx%ld, %zu bytes", path, media, w, h, nbytes);
    else
        snprintf(cap_line, sizeof cap_line, "image %s: %s, %zu bytes", path, media, nbytes);
    cJSON *arr = cJSON_CreateArray();
    cJSON *ib = cJSON_CreateObject(), *src = cJSON_CreateObject();
    cJSON_AddStringToObject(ib, "type", "image");
    cJSON_AddStringToObject(src, "type", "base64");
    cJSON_AddStringToObject(src, "media_type", media);
    cJSON_AddStringToObject(src, "data", b64);
    cJSON_AddItemToObject(ib, "source", src);
    cJSON_AddItemToArray(arr, ib);
    cJSON *tb = cJSON_CreateObject();
    cJSON_AddStringToObject(tb, "type", "text");
    cJSON_AddStringToObject(tb, "text", cap_line);
    cJSON_AddItemToArray(arr, tb);
    free(b64);
    *blocks_out = arr;
    return strdup(cap_line);
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
    /* #670: an image is not text — a line-capped scrub of a PNG reads as
     * U+FFFD garbage while LOOKING like a successful read. Redirect by
     * CONTENT (magic bytes, never the file name) to the tool that can
     * actually show it, or say honestly that this model cannot see. */
    {
        unsigned char magic[32]; long iw, ih;
        size_t mn = fread(magic, 1, sizeof magic, f);
        const char *media = img_sniff(magic, mn, &iw, &ih);
        if (media) {
            fclose(f);
            sb e = {0};
            sb_puts(&e, "error: "); sb_puts(&e, jp->valuestring);
            sb_puts(&e, " is a binary image ("); sb_puts(&e, media); sb_puts(&e, "), not text. ");
            if (vision_enabled())
                sb_puts(&e, "Use the read_image tool to look at it.");
            else
                sb_puts(&e, "This model does not support image input, so gcode cannot show it "
                            "to you. If a task needs the image visually verified, say you "
                            "cannot see it — pixel statistics are not a substitute (they "
                            "cannot catch mirrored, flipped or garbled rendering).");
            return e.p;
        }
        rewind(f);
    }
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
/* ---- search tools (#506) ----------------------------------------------
 * Bounded, structured search so the model stops composing `find /` and
 * `grep -r /` bash calls (the #488 Pass B session-wedging class). Two
 * tools, one job each: `grep` matches file CONTENTS (fixed string, not a
 * regex — the honest description matches the implementation), `glob`
 * matches file NAMES (* and ? wildcards on the basename). Shared
 * discipline: a REQUIRED root that must be a directory and must not be /
 * (refused loudly — the agent has no reason to walk /usr/opt's vendored
 * trees), a hard result cap, a visit cap so any walk terminates, and
 * symlinks never followed (loop-proof: /usr/local -> /var/local). */

/* basename wildcard match: * (any run) and ? (any one char) */
static int name_match(const char *pat, const char *s) {
    const char *star = NULL, *ss = NULL;
    while (*s) {
        if (*pat == '*') { star = pat++; ss = s; }
        else if (*pat == '?' || *pat == *s) { pat++; s++; }
        else if (star) { pat = star + 1; s = ++ss; }
        else return 0;
    }
    while (*pat == '*') pat++;
    return *pat == 0;
}

typedef struct {
    const char *pattern;
    int is_grep;
    sb out;
    int results, visits, truncated, visits_capped;
} search_ctx;

/* Append one result line, enforcing the result and byte caps. */
static int search_emit(search_ctx *sc, const char *line, size_t n) {
    if (sc->results >= CAP_SEARCH_RESULTS || sc->out.len > CAP_FILE_BYTES) {
        sc->truncated = 1; return 0;
    }
    sb_add(&sc->out, line, n);
    sb_puts(&sc->out, "\n");
    sc->results++;
    return 1;
}

static void grep_file(search_ctx *sc, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return;
    unsigned char probe[512];
    size_t pn = fread(probe, 1, sizeof probe, f);
    if (pn && memchr(probe, 0, pn)) { fclose(f); return; }   /* binary: skip */
    rewind(f);
    char line[4096]; long lineno = 0; int at_bol = 1;
    while (fgets(line, sizeof line, f)) {
        size_t ll = strlen(line);
        int ends_line = ll > 0 && line[ll - 1] == '\n';
        if (at_bol) lineno++;
        /* a >4K line is matched only in its first chunk — a search tool's
         * honest simplification, not a file-content contract */
        if (at_bol && strstr(line, sc->pattern)) {
            if (ends_line) line[--ll] = 0;
            if (ll > 160) { line[160] = 0; ll = 160; }   /* clip long lines */
            sb hit = {0}; char hdr[32];
            sb_puts(&hit, path);
            snprintf(hdr, sizeof hdr, ":%ld: ", lineno);
            sb_puts(&hit, hdr); sb_add(&hit, line, ll);
            int ok = search_emit(sc, hit.p, hit.len);
            sb_free(&hit);
            if (!ok) break;
        }
        at_bol = ends_line;
    }
    fclose(f);
}

static void search_walk(search_ctx *sc, const char *dir, int depth) {
    if (depth > CAP_SEARCH_DEPTH) return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d))) {
        const char *nm = de->d_name;
        if (!strcmp(nm, ".") || !strcmp(nm, "..")) continue;
        if (sc->visits++ >= CAP_SEARCH_VISITS) { sc->visits_capped = 1; break; }
        if (sc->truncated) break;
        sb p = {0};
        sb_puts(&p, dir);
        if (p.len && p.p[p.len - 1] != '/') sb_puts(&p, "/");
        sb_puts(&p, nm);
        struct stat st;
        /* lstat, and only S_ISDIR/S_ISREG recursed/searched: symlinks are
         * never followed, so a link cycle cannot hang the walk */
        if (lstat(p.p, &st) == 0) {
            if (S_ISDIR(st.st_mode)) {
                search_walk(sc, p.p, depth + 1);
            } else if (S_ISREG(st.st_mode)) {
                if (sc->is_grep) grep_file(sc, p.p);
                else if (name_match(sc->pattern, nm)) search_emit(sc, p.p, p.len);
            }
        }
        sb_free(&p);
        if (sc->visits_capped) break;
    }
    closedir(d);
}

static char *tool_search(cJSON *in, int is_grep) {
    const char *tname = is_grep ? "grep" : "glob";
    cJSON *jp = cJSON_GetObjectItem(in, "pattern");
    cJSON *jr = cJSON_GetObjectItem(in, "root");
    sb e = {0};
    if (!cJSON_IsString(jp) || !*jp->valuestring) {
        sb_puts(&e, "error: "); sb_puts(&e, tname);
        sb_puts(&e, " needs a non-empty string 'pattern'"); return e.p;
    }
    if (!cJSON_IsString(jr) || !*jr->valuestring) {
        sb_puts(&e, "error: "); sb_puts(&e, tname);
        sb_puts(&e, " needs a string 'root' directory"); return e.p;
    }
    /* normalize the root lexically: trim trailing "/" and "/." so "//" and
     * "/." can't dodge the refusal. This guards the accidental whole-tree
     * search, not a determined escape ("/x/.." is the model working at it,
     * and the visit cap still bounds that walk). */
    sb root = {0}; sb_puts(&root, jr->valuestring);
    for (;;) {
        if (root.len > 1 && root.p[root.len - 1] == '/') root.p[--root.len] = 0;
        else if (root.len > 1 && root.p[root.len - 1] == '.' && root.p[root.len - 2] == '/')
            { root.len -= 2; root.p[root.len] = 0; if (!root.len) { sb_puts(&root, "/"); } }
        else break;
    }
    if (!strcmp(root.p, "/")) {
        sb_free(&root);
        sb_puts(&e, "error: refusing to search from / (the whole filesystem, "
                    "including /usr's vendored trees) — pass a narrower root, "
                    "e.g. the project directory");
        return e.p;
    }
    struct stat st;
    if (stat(root.p, &st) != 0 || !S_ISDIR(st.st_mode)) {
        sb_puts(&e, "error: "); sb_puts(&e, tname); sb_puts(&e, " root ");
        sb_puts(&e, root.p); sb_puts(&e, " is not a directory");
        sb_free(&root); return e.p;
    }
    search_ctx sc; memset(&sc, 0, sizeof sc);
    sc.pattern = jp->valuestring; sc.is_grep = is_grep;
    search_walk(&sc, root.p, 0);
    if (sc.truncated) {
        char m[96];
        snprintf(m, sizeof m, "[results truncated at %d — narrow the pattern or root]",
                 CAP_SEARCH_RESULTS);
        sb_puts(&sc.out, m);
    }
    if (sc.visits_capped) {
        char m[96];
        snprintf(m, sizeof m, "\n[search stopped after visiting %d entries — narrow the root]",
                 CAP_SEARCH_VISITS);
        sb_puts(&sc.out, m);
    }
    if (!sc.out.p) {
        sb_puts(&sc.out, "no matches for \""); sb_puts(&sc.out, sc.pattern);
        sb_puts(&sc.out, "\" under "); sb_puts(&sc.out, root.p);
    }
    sb_free(&root);
    return sc.out.p;
}
static char *tool_grep(cJSON *in) { return tool_search(in, 1); }
static char *tool_glob(cJSON *in) { return tool_search(in, 0); }

static char *tool_bash(cJSON *in) {
    cJSON *jc = cJSON_GetObjectItem(in, "command");
    if (!cJSON_IsString(jc)) return strdup("error: bash needs a string 'command'");
    int ec = 0; char *out = run_command(jc->valuestring, &ec);
    sb r = {0}; char hdr[64];
    snprintf(hdr, sizeof hdr, "[exit %d]\n", ec);
    sb_puts(&r, hdr); sb_puts(&r, out); free(out);
    return r.p;
}

/* dispatch a tool call by name; returns malloc'd result string.
 * #386: EVERY tool's result is scrubbed to valid UTF-8 here — this is the
 * one seam both consumers share (the live `messages` payload and the
 * persisted session record), so a raw high byte from any tool can never
 * poison the request body or re-poison a --resume. Bad bytes become U+FFFD
 * plus a visible trailer naming the count. NB an embedded NUL in tool
 * output still truncates at this char* boundary — known, separate defect
 * (needs a length-carrying return type; see ticket #386's adjacent
 * finding).
 * #670: read_image returns STRUCTURED content through *blocks_out (an
 * image block + a caption text block); the char* return is then just the
 * caption for display. Every other tool leaves *blocks_out NULL. The
 * blocks bypass the scrub below by construction: base64 and the caption
 * are ASCII. */
static char *execute_tool(const char *name, cJSON *input, cJSON **blocks_out) {
    char *raw;
    if (blocks_out) *blocks_out = NULL;
    if      (!strcmp(name, "bash"))       raw = tool_bash(input);
    else if (!strcmp(name, "read_file"))  raw = tool_read_file(input);
    else if (!strcmp(name, "write_file")) raw = tool_write_file(input);
    else if (!strcmp(name, "edit_file"))  raw = tool_edit_file(input);
    else if (!strcmp(name, "list_dir"))   raw = tool_list_dir(input);
    else if (!strcmp(name, "grep"))       raw = tool_grep(input);
    else if (!strcmp(name, "glob"))       raw = tool_glob(input);
    else if (!strcmp(name, "read_image")) {
        /* #670: refuse when vision is off — the tool is not offered then,
         * but a resumed session or a model ignoring the tools array can
         * still name it, and executing it would put a block in the history
         * that the provider swallows silently (measured: DeepSeek) or
         * rejects. */
        if (!vision_enabled() || !blocks_out)
            raw = strdup("error: read_image is disabled — this model is not known to support "
                         "image input, so gcode cannot show it images");
        else
            raw = tool_read_image(input, blocks_out);
    }
    else { sb r = {0}; sb_puts(&r, "error: unknown tool "); sb_puts(&r, name); raw = r.p; }
    if (!raw) return NULL;
    size_t n = strlen(raw);
    if (utf8_invalid_at(raw, n) < 0) return raw;   /* common case: no copy */
    size_t rep = 0;
    char *clean = utf8_scrub(raw, n, &rep);
    free(raw);
    sb out = {0}; char note[96];
    sb_puts(&out, clean); free(clean);
    snprintf(note, sizeof note, "\n[gcode: replaced %lu invalid UTF-8 byte%s with U+FFFD]",
             (unsigned long)rep, rep == 1 ? "" : "s");
    sb_puts(&out, note);
    return out.p;
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

    /* #670: only when the model can actually see (vision_resolve) —
     * offering a tool that must always refuse teaches the model nothing
     * but a wasted round, and on a provider that silently swallows images
     * (measured: DeepSeek) it would manufacture false "I looked at it"
     * rounds, the exact failure this tool exists to end. */
    if (vision_enabled()) {
        p = cJSON_CreateObject();
        cJSON_AddItemToObject(p, "path", str_prop("Image file to view (PNG, JPEG, GIF or WebP — identified by content, not name)."));
        { const char *r[] = {"path"}; cJSON_AddItemToArray(tools, make_tool("read_image",
          "View an image file: it is returned as a real image you can SEE, not text. Use it on every "
          "screenshot you take (wmctl shot SID FILE) to visually verify what a program rendered — "
          "pixel statistics cannot catch mirrored, flipped, rotated or garbled drawing; only looking can.",
          p, r, 1)); }
    }

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "pattern", str_prop("Exact text to find (a fixed string, not a regex). Case-sensitive."));
    cJSON_AddItemToObject(p, "root", str_prop("Directory to search under, recursively. Searching from / is refused — pass a project or system subdirectory."));
    { const char *r[] = {"pattern", "root"}; cJSON_AddItemToArray(tools, make_tool("grep",
      "Search file CONTENTS under a directory for a fixed string. Returns path:line: matches (capped); skips binary files; never follows symlinks. Prefer this over a bash grep -r.", p, r, 2)); }

    p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "pattern", str_prop("File name pattern with * and ? wildcards, matched against each file's basename (e.g. '*.c')."));
    cJSON_AddItemToObject(p, "root", str_prop("Directory to search under, recursively. Searching from / is refused — pass a project or system subdirectory."));
    { const char *r[] = {"pattern", "root"}; cJSON_AddItemToArray(tools, make_tool("glob",
      "Find files by NAME under a directory. Returns matching paths (capped); never follows symlinks. Prefer this over a bash find.", p, r, 2)); }

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

/* ---- #530: layered GCODE.md context files ------------------------------
 * The system prompt proper stays the small hardcoded literal (or the
 * --system-prompt override) — portable, no platform content baked into the
 * binary (jku's #551 architecture ruling). Orientation comes from GCODE.md
 * context files, layered stable-and-general first, specific-and-volatile
 * last:
 *
 *   1. /usr/share/gcode/GCODE.md     the platform's shipped default
 *   2. /etc/gcode/GCODE.md           local admin additions
 *   3. $HOME/.config/gcode/GCODE.md  per-user additions
 *   4. GCODE.md in each directory from the walk-up root down to cwd
 *      (collected walking up, emitted parent-most first so the most
 *      specific directory has the last word)
 *
 * The cfgstore precedent (~/.config > /etc > /usr/share, todos/NETWORK.md)
 * fixes the layer set; unlike cfgstore's per-key override, prose context
 * CONCATENATES — an /etc file adds to the shipped orientation instead of
 * silently discarding it (the Claude Code CLAUDE.md layering model, which
 * this ticket was asked to follow). Absent files are a silent no-op ("IF
 * present"); with no file anywhere the POSTed system prompt is
 * byte-identical to the bare literal.
 *
 * Bounds: the walk up stops at $HOME (when cwd is under it), at a mount
 * boundary (st_dev change), at /, or at CAP_CONTEXT_DEPTH directories.
 * CAP_CONTEXT_BYTES bounds the TOTAL, consumed in emission order; the file
 * that crosses the cap is truncated with an in-band marker and a stderr
 * warning, later files are dropped with a stderr warning — never a silent
 * trim.
 *
 * DELIBERATE (#530 design point ii): context files are EXCLUDED from
 * system_prompt_hash. The hash keeps meaning "the base prompt or
 * --system-prompt changed", so editing a project GCODE.md never trains
 * users to ignore the resume warning; what was loaded is recorded in
 * session_meta's `context_files` list instead.
 *
 * GCODE_CONTEXT_ROOT (test seam, the GCODE_STATE_DIR precedent) prefixes
 * the two absolute system-layer paths so the native oracle can exercise
 * them hermetically; --no-context disables file context entirely. */
#define CAP_CONTEXT_BYTES (48 * 1024)
#define CAP_CONTEXT_DEPTH 32

static long context_append(sb *out, cJSON *files, const char *path, long budget) {
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode) || st.st_size == 0) return 0;
    if (budget <= 0) {
        fprintf(stderr, "%sgcode: warning: %s dropped (the %d-byte context cap is spent)%s\n",
                CDIM, path, CAP_CONTEXT_BYTES, CRST);
        return 0;
    }
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    sb_puts(out, "\n\n[GCODE.md context: "); sb_puts(out, path); sb_puts(out, "]\n");
    char buf[4096]; size_t n; long took = 0; int truncated = 0;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) {
        size_t room = (size_t)(budget - took);
        size_t take = n < room ? n : room;
        sb_add(out, buf, take); took += (long)take;
        if (take < n) { truncated = 1; break; }
    }
    fclose(f);
    if (truncated) {
        char m[96];
        snprintf(m, sizeof m, "\n[gcode: context truncated at the %d-byte total cap]", CAP_CONTEXT_BYTES);
        sb_puts(out, m);
        fprintf(stderr, "%sgcode: warning: %s truncated at the %d-byte context cap%s\n",
                CDIM, path, CAP_CONTEXT_BYTES, CRST);
    }
    cJSON_AddItemToArray(files, cJSON_CreateString(path));
    return took;
}

static void context_load(config *cfg) {
    const char *root = getenv("GCODE_CONTEXT_ROOT"); if (!root) root = "";
    const char *home = getenv("HOME");
    sb ctx = {0}; cJSON *files = cJSON_CreateArray();
    long budget = CAP_CONTEXT_BYTES;
    char p[4200];

    snprintf(p, sizeof p, "%s/usr/share/gcode/GCODE.md", root);
    budget -= context_append(&ctx, files, p, budget);
    snprintf(p, sizeof p, "%s/etc/gcode/GCODE.md", root);
    budget -= context_append(&ctx, files, p, budget);
    if (home && *home) {
        snprintf(p, sizeof p, "%s/.config/gcode/GCODE.md", home);
        budget -= context_append(&ctx, files, p, budget);
    }

    static char dirs[CAP_CONTEXT_DEPTH][4096];   /* static: 128K is stack-hostile */
    int ndirs = 0;
    char cur[4096];
    if (getcwd(cur, sizeof cur)) {
        /* $HOME is matched by INODE, not by string: getcwd returns the real
         * path while $HOME may spell the same directory through a symlink
         * (macOS /var -> /private/var is the live case), and a string
         * compare would sail past $HOME. */
        struct stat st, hst; int home_ok = 0;
        if (home && *home && !stat(home, &hst)) home_ok = 1;
        if (stat(cur, &st)) st.st_dev = 0, st.st_ino = 0;
        while (ndirs < CAP_CONTEXT_DEPTH) {
            snprintf(dirs[ndirs], sizeof dirs[ndirs], "%s", cur); ndirs++;
            if (home_ok && st.st_dev == hst.st_dev && st.st_ino == hst.st_ino)
                break;                                         /* never above $HOME */
            if (!strcmp(cur, "/")) break;
            char *slash = strrchr(cur, '/');
            if (!slash) break;                                 /* relative — bail */
            if (slash == cur) cur[1] = 0; else *slash = 0;
            struct stat pst;
            if (stat(cur, &pst) || pst.st_dev != st.st_dev) break;  /* mount boundary */
            st = pst;
        }
    }
    for (int i = ndirs - 1; i >= 0; i--) {
        snprintf(p, sizeof p, "%s/GCODE.md", dirs[i]);
        budget -= context_append(&ctx, files, p, budget);
    }

    if (ctx.len) {
        sb full = {0};
        if (cfg->system_prompt) sb_puts(&full, cfg->system_prompt);
        sb_add(&full, ctx.p, ctx.len);
        cfg->system_sent = full.p;
        cfg->context_files = files;
    } else {
        cfg->system_sent = NULL;
        cfg->context_files = NULL;
        cJSON_Delete(files);
    }
    sb_free(&ctx);
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
    /* #530: record WHICH context files were loaded (they are deliberately
     * outside system_prompt_hash — see context_load) */
    if (cfg->context_files) cJSON_AddItemToObject(r, "context_files", cJSON_Duplicate(cfg->context_files, 1));
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
    cJSON_AddItemToObject(r, "models", mlist_json(&s->models));
    record_write(s, r); close(s->fd); s->fd = -1;
}

/* ---- SSE stream state ------------------------------------------------- */
/* #738: the parser recognises every content-block type the Messages API can
 * put on the wire, because the REPLAY is only as faithful as the parse. The
 * old two-way split ('t'ext / 'u'se) collapsed `thinking` into text, and a
 * thinking block accumulates no text (its deltas are thinking_delta, which
 * was never read) — so gcode replayed it as {"type":"text","text":""} and
 * the API rejected the whole request with
 *   400 "messages: text content blocks must be non-empty".
 *
 * Preserve rather than discard: the Messages API contract is that thinking
 * blocks are replayed UNCHANGED — signature included — when the conversation
 * continues on the same model, and that the API rejects blocks whose content
 * was modified. Blocks whose `thinking` text is EMPTY still count: `display`
 * defaults to "omitted" on every current thinking model, so an empty-text
 * block carrying a real signature is the normal case, not a degenerate one.
 *
 * `type` is the block kind:
 *   't'  text                — `text` holds the body
 *   'u'  tool_use            — `id`/`name` + `json` holds partial input JSON
 *   'k'  thinking            — `text` holds the thinking, `sig` the signature
 *   'r'  redacted_thinking   — `text` holds the opaque `data` payload
 *   '?'  anything else       — `raw` holds the content_block VERBATIM
 *
 * The '?' arm is what keeps the next block type from becoming this bug again:
 * an unrecognised block is replayed byte-for-byte from its content_block_start
 * object, and is DROPPED (loudly) only if a delta arrived that we could not
 * apply to it — because a partially-captured block replayed as whole is worse
 * than an absent one. */
typedef struct {
    int active; char type;          /* 't'ext 'u'se thin'k'ing 'r'edacted '?'unknown */
    char *id, *name; sb text; sb json;
    sb   sig;                       /* 'k': signature_delta accumulation */
    cJSON *raw;                     /* '?': the verbatim content_block */
    int  lost;                      /* '?': an uninterpretable delta arrived */
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
    int  k_open;                    /* #738: a streamed thinking line is open */
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
            const char *btype = cJSON_IsString(cbt) ? cbt->valuestring : "";
            if (!strcmp(btype, "tool_use")) {
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
            } else if (!strcmp(btype, "text")) {
                b->type = 't';
            } else if (!strcmp(btype, "thinking")) {
                /* #738: its own kind, never text. A provider that answers in
                 * one shot can also put `thinking`/`signature` on the START
                 * object rather than streaming deltas, so read both here. */
                b->type = 'k';
                cJSON *th = cJSON_GetObjectItem(cb, "thinking");
                cJSON *sg = cJSON_GetObjectItem(cb, "signature");
                if (cJSON_IsString(th) && *th->valuestring) sb_puts(&b->text, th->valuestring);
                if (cJSON_IsString(sg) && *sg->valuestring) sb_puts(&b->sig, sg->valuestring);
                fprintf(stderr, "  %s\xe2\x9c\xbb thinking%s\n", CDIM, CRST);
            } else if (!strcmp(btype, "redacted_thinking")) {
                /* Opaque and deltaless: the entire payload rides the start
                 * object and goes back verbatim or not at all. */
                b->type = 'r';
                cJSON *da = cJSON_GetObjectItem(cb, "data");
                if (cJSON_IsString(da)) sb_puts(&b->text, da->valuestring);
            } else {
                /* Not a kind this build knows. Keep the object VERBATIM so it
                 * can be replayed exactly as received; `lost` (set by an
                 * uninterpretable delta) decides whether that copy is still
                 * whole when the round closes. This is the arm that stops the
                 * NEXT block type from being this same bug. */
                b->type = '?';
                b->raw = cJSON_Duplicate(cb, 1);
                /* A block carrying no usable `type` can never be replayed
                 * validly whatever we do with it, so mark it lost up front
                 * and let the one drop path report it, rather than sending a
                 * typeless object and letting the provider decide. */
                if (!b->raw || !cJSON_IsString(cbt)) b->lost = 1;
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
            if (b->type == '?') {
                /* 🔴 THIS TEST MUST COME FIRST, ahead of every delta name.
                 * The question is not "do we know this delta's name" but "can
                 * this build APPLY it to THIS block" — and for a block kind we
                 * do not model, the answer is no for EVERY delta, however
                 * familiar the name. `server_tool_use` is the live example: a
                 * real block type that streams `input_json_delta` exactly like
                 * `tool_use`. Matched on name it would accumulate into `json`,
                 * a field the '?' replay never reads, leave `lost` clear, and
                 * send the start object back with an EMPTY input — a partial
                 * block presented as whole, which is the single failure this
                 * arm exists to prevent. So: any delta at all on an
                 * unrecognised block proves the verbatim copy incomplete. */
                b->lost = 1;
            } else if (!strcmp(dtype, "text_delta")) {
                cJSON *tx = cJSON_GetObjectItem(d, "text");
                if (cJSON_IsString(tx)) {
                    assistant_header(ctx);
                    emit_body(ctx, tx->valuestring);
                    sb_puts(&b->text, tx->valuestring);
                }
            } else if (!strcmp(dtype, "input_json_delta")) {
                cJSON *pj = cJSON_GetObjectItem(d, "partial_json");
                if (cJSON_IsString(pj)) sb_puts(&b->json, pj->valuestring);
            } else if (!strcmp(dtype, "thinking_delta")) {
                /* #738: the delta gcode never read. Without it a thinking
                 * block accumulates NOTHING and — under the old
                 * everything-else-is-text rule — replayed as an empty text
                 * block, which is the exact body the API 400s on. The body
                 * goes to stderr (beside the tool markers), never to the
                 * stdout transcript: gcode does not request
                 * thinking.display "summarized", so on every current model
                 * the documented default leaves this empty and there is
                 * nothing to render. Printing it where it DOES arrive is
                 * what keeps a summary from being silently swallowed. */
                cJSON *th = cJSON_GetObjectItem(d, "thinking");
                if (cJSON_IsString(th) && *th->valuestring) {
                    sb_puts(&b->text, th->valuestring);
                    fprintf(stderr, "%s%s%s", CDIM, th->valuestring, CRST);
                    fflush(stderr);
                    ctx->k_open = 1;      /* the line is mid-thinking */
                }
            } else if (!strcmp(dtype, "signature_delta")) {
                /* The signature is the part the API validates on replay. It
                 * is accumulated, never displayed and never synthesised: a
                 * manufactured signature is a rejected request. */
                cJSON *sg = cJSON_GetObjectItem(d, "signature");
                if (cJSON_IsString(sg)) sb_puts(&b->sig, sg->valuestring);
            }
        }
    } else if (!strcmp(type, "content_block_stop")) {
        /* #738: end the dim thinking line, so a streamed summary cannot run
         * into the tool marker or the next thinking marker on the same row. */
        if (ctx->k_open) { fputc('\n', stderr); fflush(stderr); ctx->k_open = 0; }
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
    progress_clear();     /* #507: first response bytes end the wait line */
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

/* ---- #747: prompt-cache breakpoints -----------------------------------
 *
 * gcode sent NO cache_control anywhere, and the Messages API caches only what
 * is explicitly marked — so every round re-sent the entire accumulated
 * conversation as fresh, fully-priced input. Measured on the Anthropic route
 * in #678 Pass B round 3: cacheRead 0 across all 7 rounds of a turn. gcode is
 * agentic, so one turn is many rounds (5/8/13/17/24 measured), and round N
 * re-pays for rounds 1..N-1: the cost of a session grows with the SQUARE of
 * its round count rather than linearly. It survived because the standing live
 * route is DeepSeek, which auto-caches server-side without being asked, so the
 * defect is invisible on the only route the estate exercises.
 *
 * Placement. Render order is tools -> system -> messages, and caching is a
 * PREFIX match, so:
 *   1. a breakpoint on the last `system` block caches tools + system together
 *      — the part that is fixed for the whole session, and the one that helps
 *      every single round. That requires `system` to be an array of text
 *      blocks rather than a bare string: a JSON string cannot carry
 *      cache_control.
 *   2. a breakpoint on the last content block of the last message caches the
 *      settled history, so a growing conversation reads instead of re-paying.
 *
 * The second one MOVES each round, which is the documented multi-turn shape.
 * It is therefore added at serialize time and removed immediately after — the
 * #348 record contract is explicit that `messages` is attached to the body BY
 * REFERENCE, so a key left on a message object would be persisted into the
 * session log and would accumulate one stale breakpoint per round until the
 * request blew the 4-breakpoint ceiling.
 *
 * Known limits, recorded rather than hidden:
 *   - a breakpoint walks back at most 20 content blocks to find a prior entry,
 *     so a single round that adds more than ~20 blocks (many parallel tool
 *     calls) silently misses. gcode's tool use is near-serial, so this is a
 *     ceiling on batch size, not a live fault.
 *   - the minimum cacheable prefix is model-dependent (512 tokens on Opus 5,
 *     but 4096 on Opus 4.6 and Haiku 4.5). Below it the breakpoint silently
 *     does nothing — no error, no benefit.
 *   - a cache WRITE costs ~1.25x. A one-round turn therefore pays a small
 *     premium for nothing; every multi-round turn wins, and agentic turns are
 *     the shape gcode has.
 *
 * GCODE_CACHE=0 turns the whole thing off. It exists because array-form
 * `system` is canonical Messages API but is UNTESTED against the third-party
 * Anthropic-compatible endpoints gcode also targets, and the standing live
 * route is one of them; an operator who hits a compat wall needs a switch,
 * not a rebuild. */
static int cache_enabled(void) {
    static int v;                       /* 0 unresolved, 1 on, -1 off */
    /* An EMPTY value means UNSET, matching GCODE_VISION's `s && *s` rule —
     * an exported-but-blank variable should not silently disable a feature. */
    if (!v) { const char *s = getenv("GCODE_CACHE"); v = (s && *s && !atoi(s)) ? -1 : 1; }
    return v == 1;
}

static cJSON *cache_control_new(void) {
    cJSON *cc = cJSON_CreateObject();
    cJSON_AddStringToObject(cc, "type", "ephemeral");
    return cc;
}

/* The system prompt as a cacheable one-element block array. Returns NULL when
 * there is no system prompt at all, in which case the caller marks the tool
 * list instead — the goal is a breakpoint at the end of the STABLE prefix,
 * wherever that prefix happens to end. */
static cJSON *cache_system_blocks(const char *sysp) {
    if (!sysp) return NULL;
    cJSON *arr = cJSON_CreateArray();
    cJSON *tb = cJSON_CreateObject();
    cJSON_AddStringToObject(tb, "type", "text");
    cJSON_AddStringToObject(tb, "text", sysp);
    cJSON_AddItemToObject(tb, "cache_control", cache_control_new());
    cJSON_AddItemToArray(arr, tb);
    return arr;
}

/* Mark the last content block of the last message, so the settled history is
 * read from cache next round. Returns the block that was marked (NULL if none
 * was) so the caller can UNMARK it the moment the payload is serialized.
 *
 * Skipped while there is a single message: with one user turn there is no
 * settled history yet, and a second breakpoint covering almost the same prefix
 * as the system one just pays a second write for nothing. */
static cJSON *cache_mark_history(cJSON *messages) {
    if (cJSON_GetArraySize(messages) < 2) return NULL;
    cJSON *last = cJSON_GetArrayItem(messages, cJSON_GetArraySize(messages) - 1);
    cJSON *content = last ? cJSON_GetObjectItem(last, "content") : NULL;
    if (!cJSON_IsArray(content) || !cJSON_GetArraySize(content)) return NULL;
    cJSON *blk = cJSON_GetArrayItem(content, cJSON_GetArraySize(content) - 1);
    if (!cJSON_IsObject(blk) || cJSON_GetObjectItem(blk, "cache_control")) return NULL;
    cJSON_AddItemToObject(blk, "cache_control", cache_control_new());
    return blk;
}

static void cache_unmark(cJSON *blk) {
    if (blk) cJSON_DeleteItemFromObjectCaseSensitive(blk, "cache_control");
}


/* #738: map ONE accumulated content block to the JSON that goes back into the
 * history, for every kind that does not require running a tool. Returns NULL
 * when the block must be omitted, and says so on stderr when the omission is
 * lossy. Factored out of do_turn so the self-test asserts the SAME mapping the
 * turn ships — an assertion written against a re-implementation of the rule is
 * an assertion about the test. `tool_use` stays inline in do_turn: its replay
 * is entangled with executing the call. */
static cJSON *block_replay_json(cblock *b) {
    if (b->type == 't') {
        /* #738 acceptance 1: NEVER emit an empty text block. The
         * Messages API rejects the whole request with
         *   400 "messages: text content blocks must be non-empty"
         * and gcode reports that as permanent, so the turn dies. A text
         * block that accumulated nothing carries no information, so
         * dropping it is lossless — unlike dropping a thinking block,
         * which the API validates. The empty-`content` array this can
         * leave behind is closed by do_turn, at the point the assistant
         * message is built. */
        if (!b->text.len) return NULL;
        cJSON *tb = cJSON_CreateObject();
        cJSON_AddStringToObject(tb, "type", "text");
        cJSON_AddStringToObject(tb, "text", b->text.p);
        return tb;
    } else if (b->type == 'k') {
        /* #738: replay UNCHANGED, signature included. The contract is
         * that a continuing conversation on the same model gets its
         * thinking blocks back exactly as issued — the API rejects a
         * modified block, and a DROPPED one can trip the ordering and
         * signature checks on a tool-use turn. An EMPTY `thinking`
         * string is the normal case, not a degenerate one:
         * thinking.display defaults to "omitted", so the text is empty
         * by contract while the signature is real. That is precisely
         * why the emptiness test above must not be applied here.
         *
         * `signature` is emitted only when one was received. gcode never
         * synthesises one: an invented signature is a rejected request,
         * and a provider that issues thinking without a signature is
         * replayed as faithfully as it spoke. */
        cJSON *kb = cJSON_CreateObject();
        cJSON_AddStringToObject(kb, "type", "thinking");
        cJSON_AddStringToObject(kb, "thinking", b->text.p ? b->text.p : "");
        if (b->sig.len) cJSON_AddStringToObject(kb, "signature", b->sig.p);
        return kb;
    } else if (b->type == 'r') {
        /* Opaque payload, verbatim both ways. */
        cJSON *rb = cJSON_CreateObject();
        cJSON_AddStringToObject(rb, "type", "redacted_thinking");
        cJSON_AddStringToObject(rb, "data", b->text.p ? b->text.p : "");
        return rb;
    } else if (b->type == '?') {
        /* A block kind this build does not know. If nothing arrived that
         * we could not apply, the captured start object IS the whole
         * block and goes back byte-for-byte. Otherwise our copy is
         * provably partial, and replaying a partial block as whole is
         * worse than omitting it — so drop it, LOUDLY, naming the type
         * so the next reader knows what to add rather than finding an
         * unexplained gap in the history. */
        if (b->raw && !b->lost) {
            cJSON *raw = b->raw;
            b->raw = NULL;                       /* the caller owns it now */
            return raw;
        } else {
            cJSON *bt = b->raw ? cJSON_GetObjectItem(b->raw, "type") : NULL;
            fprintf(stderr, "%sgcode: dropped an incomplete `%s` content block from the "
                            "replayed history — this build does not know how to accumulate "
                            "it, so the copy it holds is partial%s\n",
                    R_ERRB, (bt && cJSON_IsString(bt)) ? bt->valuestring : "unknown", CRST);
        }
    }
    return NULL;
}

/* ---- #348 record contract ---------------------------------------------
 * The metadata lives on the RECORD, never on the message object: `messages`
 * is attached to the API request body BY REFERENCE (do_turn), so any key
 * added to a message ships to the provider on the next round. These two
 * writers take the stream_ctx and attach round metadata JSONL-side only.
 * Records link by turn identity — turn_id ("<session_id>-<turn_index>",
 * matching turn_start/turn_end) plus the 1-based round within the turn —
 * so no adjacency inference is needed. Fields are additive; schema stays
 * at LOG_SCHEMA_VERSION 1 (the resume reader ignores unknown fields and
 * tolerates absent ones, so old and new logs stay mutually readable). */
static void turn_id_str(const session *s, char out[80]) {
    snprintf(out, 80, "%s-%lld", s->id, s->turn_index);
}

static int persist_api_round(session *s, const stream_ctx *ctx, const char *request_model) {
    cJSON *r = record_new(s, "api_round");
    char tid[80]; turn_id_str(s, tid);
    cJSON_AddStringToObject(r, "turn_id", tid);
    cJSON_AddNumberToObject(r, "round", (double)s->round_index);
    cJSON_AddStringToObject(r, "request_model", request_model);
    cJSON_AddStringToObject(r, "response_model", ctx->response_model ? ctx->response_model : "");
    cJSON_AddStringToObject(r, "provider_message_id", ctx->message_id ? ctx->message_id : "");
    cJSON_AddStringToObject(r, "stop_reason", ctx->stop_reason ? ctx->stop_reason : "");
    cJSON_AddItemToObject(r, "usage", usage_json(&ctx->round_usage));
    cJSON_AddItemToObject(r, "raw_usage", ctx->raw_usage ? cJSON_Duplicate(ctx->raw_usage, 1) : cJSON_CreateObject());
    return record_write(s, r);
}

/* The persisted assistant message is self-contained: content plus the
 * provider-returned model, request model, provider_message_id, stop_reason,
 * normalized usage and raw_usage, and turn identity — intelligible on its
 * own without joining the adjacent api_round line. */
static int persist_assistant_message(session *s, cJSON *m, const stream_ctx *ctx, const char *request_model) {
    cJSON *r = record_new(s, "message");
    cJSON *role = cJSON_GetObjectItem(m, "role"), *content = cJSON_GetObjectItem(m, "content");
    cJSON_AddStringToObject(r, "role", cJSON_IsString(role) ? role->valuestring : "assistant");
    cJSON_AddStringToObject(r, "source", "model");
    char tid[80]; turn_id_str(s, tid);
    cJSON_AddStringToObject(r, "turn_id", tid);
    cJSON_AddNumberToObject(r, "round", (double)s->round_index);
    cJSON_AddStringToObject(r, "model", ctx->response_model ? ctx->response_model : "");
    cJSON_AddStringToObject(r, "request_model", request_model);
    cJSON_AddStringToObject(r, "provider_message_id", ctx->message_id ? ctx->message_id : "");
    cJSON_AddStringToObject(r, "stop_reason", ctx->stop_reason ? ctx->stop_reason : "");
    cJSON_AddItemToObject(r, "usage", usage_json(&ctx->round_usage));
    cJSON_AddItemToObject(r, "raw_usage", ctx->raw_usage ? cJSON_Duplicate(ctx->raw_usage, 1) : cJSON_CreateObject());
    cJSON_AddItemToObject(r, "content", cJSON_Duplicate(content, 1));
    return record_write(s, r);
}

/* #387: name the first tool_result in the history whose content is not
 * valid UTF-8 — the diagnostic for a malformed request body (a poisoned
 * pre-#386 log replayed by --resume is the surviving way to get one). */
static const char *find_invalid_tool_result(cJSON *messages) {
    cJSON *m;
    cJSON_ArrayForEach(m, messages) {
        cJSON *content = cJSON_GetObjectItem(m, "content");
        if (!cJSON_IsArray(content)) continue;
        cJSON *blk;
        cJSON_ArrayForEach(blk, content) {
            cJSON *t = cJSON_GetObjectItem(blk, "type");
            if (!cJSON_IsString(t) || strcmp(t->valuestring, "tool_result")) continue;
            cJSON *c = cJSON_GetObjectItem(blk, "content");
            if (cJSON_IsString(c) && utf8_invalid_at(c->valuestring, strlen(c->valuestring)) >= 0) {
                cJSON *id = cJSON_GetObjectItem(blk, "tool_use_id");
                return cJSON_IsString(id) ? id->valuestring : "?";
            }
            /* #670: structured (image) results — check their text blocks.
             * The base64 data is ASCII by construction, but a hand-edited
             * log could poison a caption like any other string. */
            if (cJSON_IsArray(c)) {
                cJSON *cb;
                cJSON_ArrayForEach(cb, c) {
                    cJSON *tt = cJSON_GetObjectItem(cb, "text");
                    if (cJSON_IsString(tt) &&
                        utf8_invalid_at(tt->valuestring, strlen(tt->valuestring)) >= 0) {
                        cJSON *id = cJSON_GetObjectItem(blk, "tool_use_id");
                        return cJSON_IsString(id) ? id->valuestring : "?";
                    }
                }
            }
        }
    }
    return NULL;
}

/* ---- #463: validate-and-repair the history at the send seam ------------
 *
 * The Messages API contract is STRUCTURAL, and it has two halves:
 *   (a) every `tool_use` block in an assistant message must be answered by a
 *       `tool_result` carrying the same id in the IMMEDIATELY FOLLOWING
 *       message;
 *   (b) a `tool_result` may only answer a `tool_use` in the immediately
 *       PRECEDING message.
 * A history that breaks either half is rejected with an HTTP 400 on every
 * subsequent request, which gcode classifies as permanent and exits the REPL
 * on — a destroyed session. The incident behind #462 lost one carrying
 * 900,480 cache-read tokens.
 *
 * #462 stops gcode CREATING such a history. This pass lets it RECOVER from
 * one it already has, which is the half a forward fix cannot reach:
 *   - a log poisoned by the shipped bug and replayed by --resume (jku's
 *     900k-token session is one of them);
 *   - a crash-torn round — the assistant message and its results are two
 *     independent appended records (see the comment at the second
 *     persist_message call), so a stop between them corrupts a normal round.
 *
 * 🔴 REPAIR, never refuse. Refusing only announces the session's death
 * politely: the user's exits would still be /clear or a fresh session, both
 * of which lose everything.
 *
 * 🔴 Repairing half (a) alone would trade one 400 for another — a stranded
 * `tool_result` is just as fatal — so half (b) is repaired in the same pass.
 *
 * IDEMPOTENT by construction: the pass establishes exactly the invariant it
 * checks, so a second run over its own output finds nothing and mutates
 * nothing. That is also why the repair is deliberately NOT persisted. The
 * JSONL is append-only, so a dropped orphan could never be un-written; the
 * log would then disagree with memory in a way strictly worse than not
 * recording it at all. Being deterministic, the pass re-derives the identical
 * repair on every load, so the EFFECTIVE history after a --resume is the same
 * whether or not it was recorded.
 */

/* The ticket's marker text, verbatim. It is visible on purpose: the model is
 * told the result is missing rather than being handed a plausible fake. */
#define REPAIR_MARKER "[gcode: no result recorded for this tool call \xe2\x80\x94 session repaired]"
#define REPAIR_ID_LIST_MAX 8      /* ids named in the log line before "+N more" */
#define REPAIR_ID_MIN_LEN  4      /* below this an id is too short to match on */
#define REPAIR_NAMED_MAX   64     /* server-named ids canonicalized in one pass */

typedef struct {
    int inserted;       /* marker tool_results added for unanswered tool_use ids */
    int dropped;        /* orphan tool_result blocks removed */
    int moved;          /* results relocated to their canonical slot (#463 named pass) */
    int msgs_added;     /* synthesized answer messages */
    int msgs_removed;   /* messages left with no blocks by the drops */
    int ins_listed, drop_listed, moved_listed;
    sb  ins_ids, drop_ids, moved_ids;
} repair_report;

/* A repair is a MUTATION iff it changed a block. msgs_added is always
 * accompanied by an insert and msgs_removed by a drop, so those never need
 * to be counted separately — but they are reported, because "3 changes" with
 * no mention of a deleted message would be a half-told story. */
static int repair_total(const repair_report *r) { return r->inserted + r->dropped + r->moved; }
static void repair_report_free(repair_report *r) {
    sb_free(&r->ins_ids); sb_free(&r->drop_ids); sb_free(&r->moved_ids);
}

static void repair_note_id(sb *list, int *listed, const char *id) {
    if (*listed < REPAIR_ID_LIST_MAX) {
        if (*listed) sb_puts(list, ", ");
        sb_puts(list, (id && *id) ? id : "(no id)");
    }
    (*listed)++;
}

static int blk_is(cJSON *blk, const char *type) {
    cJSON *t = cJSON_GetObjectItem(blk, "type");
    return cJSON_IsString(t) && !strcmp(t->valuestring, type);
}
static const char *blk_str(cJSON *o, const char *key) {
    cJSON *v = cJSON_GetObjectItem(o, key);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}
static const char *tool_use_id_of(cJSON *blk) {
    const char *id = blk_str(blk, "id"); return id ? id : "";
}
static const char *tool_result_id_of(cJSON *blk) {
    const char *id = blk_str(blk, "tool_use_id"); return id ? id : "";
}

static cJSON *make_marker_result(const char *id) {
    cJSON *tr = cJSON_CreateObject();
    cJSON_AddStringToObject(tr, "type", "tool_result");
    cJSON_AddStringToObject(tr, "tool_use_id", id ? id : "");
    cJSON_AddStringToObject(tr, "content", REPAIR_MARKER);
    return tr;
}

static int msg_has_tool_use(cJSON *m) {
    cJSON *content = cJSON_GetObjectItem(m, "content"), *blk;
    const char *role = blk_str(m, "role");
    if (!role || strcmp(role, "assistant") || !cJSON_IsArray(content)) return 0;
    cJSON_ArrayForEach(blk, content) if (blk_is(blk, "tool_use")) return 1;
    return 0;
}

/* Is `m` usable as the answer message for the assistant message before it?
 * Only a user message whose content is an ARRAY can carry a tool_result; a
 * bare-string content or an assistant message cannot, so those are treated
 * as "no answer message" and one is synthesized beside them. */
static int msg_can_answer(cJSON *m) {
    const char *role = m ? blk_str(m, "role") : NULL;
    return role && !strcmp(role, "user") && cJSON_IsArray(cJSON_GetObjectItem(m, "content"));
}

/* Half (b): drop every tool_result that answers no tool_use in the message
 * immediately before it. Runs FIRST, because a drop can empty a message, and
 * removing that message is exactly what turns its predecessor into an
 * unanswered tool_use for half (a) to fix. */
static void repair_drop_orphans(cJSON *messages, repair_report *rep) {
    for (int i = 0; i < cJSON_GetArraySize(messages); ) {
        cJSON *m = cJSON_GetArrayItem(messages, i);
        cJSON *content = cJSON_GetObjectItem(m, "content");
        if (!cJSON_IsArray(content)) { i++; continue; }
        cJSON *prev = i > 0 ? cJSON_GetArrayItem(messages, i - 1) : NULL;
        cJSON *pcontent = (prev && msg_has_tool_use(prev)) ? cJSON_GetObjectItem(prev, "content") : NULL;
        int had = cJSON_GetArraySize(content);
        for (int k = 0; k < cJSON_GetArraySize(content); ) {
            cJSON *b = cJSON_GetArrayItem(content, k);
            if (!blk_is(b, "tool_result")) { k++; continue; }
            const char *rid = tool_result_id_of(b);
            int matched = 0;
            if (pcontent) {
                cJSON *pb;
                cJSON_ArrayForEach(pb, pcontent)
                    if (blk_is(pb, "tool_use") && !strcmp(tool_use_id_of(pb), rid)) { matched = 1; break; }
            }
            if (matched) { k++; continue; }
            /* Record BEFORE the delete: rid points INTO the block, and
             * cJSON_DeleteItemFromArray frees it (ASan caught this). */
            rep->dropped++; repair_note_id(&rep->drop_ids, &rep->drop_listed, rid);
            cJSON_DeleteItemFromArray(content, k);
        }
        /* Only remove a message THIS pass emptied. A content array that
         * arrived empty is a different defect and not this ticket's to
         * rewrite — "no gratuitous rewriting" cuts both ways. */
        if (had && cJSON_GetArraySize(content) == 0) {
            cJSON_DeleteItemFromArray(messages, i);
            rep->msgs_removed++;
            continue;   /* do not advance: the message now at i has a new predecessor */
        }
        i++;
    }
}

/* Half (a): give every unanswered tool_use a marker tool_result in the very
 * next message, synthesizing that message when there is none to use. */
static void repair_fill_missing(cJSON *messages, repair_report *rep) {
    for (int i = 0; i < cJSON_GetArraySize(messages); i++) {
        cJSON *m = cJSON_GetArrayItem(messages, i);
        if (!msg_has_tool_use(m)) continue;
        cJSON *content = cJSON_GetObjectItem(m, "content"), *blk;
        cJSON *next = i + 1 < cJSON_GetArraySize(messages) ? cJSON_GetArrayItem(messages, i + 1) : NULL;
        if (!msg_can_answer(next)) {
            cJSON *umsg = cJSON_CreateObject(), *arr = cJSON_CreateArray();
            cJSON_AddStringToObject(umsg, "role", "user");
            cJSON_AddItemToObject(umsg, "content", arr);
            cJSON_ArrayForEach(blk, content) {
                if (!blk_is(blk, "tool_use")) continue;
                const char *id = tool_use_id_of(blk);
                cJSON_AddItemToArray(arr, make_marker_result(id));
                rep->inserted++; repair_note_id(&rep->ins_ids, &rep->ins_listed, id);
            }
            cJSON_InsertItemInArray(messages, i + 1, umsg);
            rep->msgs_added++;
            i++;            /* the message just synthesized needs no visit */
            continue;
        }
        cJSON *ncontent = cJSON_GetObjectItem(next, "content");
        cJSON_ArrayForEach(blk, content) {
            if (!blk_is(blk, "tool_use")) continue;
            const char *id = tool_use_id_of(blk);
            int found = 0, last_result = -1, k = 0;
            cJSON *nb;
            cJSON_ArrayForEach(nb, ncontent) {
                if (blk_is(nb, "tool_result")) {
                    last_result = k;
                    if (!strcmp(tool_result_id_of(nb), id)) { found = 1; break; }
                }
                k++;
            }
            if (found) continue;
            /* After the last existing tool_result, or at the front when there
             * is none — the API wants the tool_result run to LEAD the user
             * message's content, and this keeps that true either way. */
            cJSON_InsertItemInArray(ncontent, last_result + 1, make_marker_result(id));
            rep->inserted++; repair_note_id(&rep->ins_ids, &rep->ins_listed, id);
        }
    }
}

/* The structural pass. Returns the number of BLOCK-level mutations IT made
 * (a delta, so it composes with the named pass over a shared report); 0
 * means the history was already valid and was left byte-identical. */
static int history_repair(cJSON *messages, repair_report *rep) {
    int before = repair_total(rep);
    repair_drop_orphans(messages, rep);
    repair_fill_missing(messages, rep);
    return repair_total(rep) - before;
}

/* ---- #463: the server-directed pass -----------------------------------
 * The structural pass runs before EVERY POST, so by the time a 400 comes
 * back it has already had its say — running it again would be a guaranteed
 * no-op, and a retry gated on a guaranteed no-op is dead code. What is new
 * at that moment is the SERVER'S opinion: a rejection of this class names
 * the offending tool_use ids in its body ("`tool_use` ids were found without
 * `tool_result` blocks immediately after: call_00_vKx8..."). That is a
 * second, authoritative reading of the same history, and gcode's own reading
 * can legitimately differ from a given provider's — e.g. this pass enforces
 * that the tool_result run LEADS the answer message, which the Anthropic API
 * requires and the structural pass deliberately does not rewrite for.
 *
 * The ids are matched by looking for each id ALREADY IN OUR HISTORY inside
 * the error body, never by parsing the sentence: no grammar to track across
 * providers, and it cannot invent an id we do not hold. Ids shorter than
 * REPAIR_ID_MIN_LEN are skipped so a degenerate id cannot match by accident.
 */
static int err_names_id(const char *errbody, const char *id) {
    return errbody && id && strlen(id) >= REPAIR_ID_MIN_LEN && strstr(errbody, id) != NULL;
}

/* Detach the first tool_result answering `id` from anywhere in the history,
 * deleting any further duplicates. Returns the detached block (caller owns
 * it) or NULL when the history held none. */
static cJSON *repair_take_result(cJSON *messages, const char *id, repair_report *rep) {
    cJSON *taken = NULL;
    for (int i = 0; i < cJSON_GetArraySize(messages); ) {
        cJSON *m = cJSON_GetArrayItem(messages, i);
        cJSON *content = cJSON_GetObjectItem(m, "content");
        if (!cJSON_IsArray(content)) { i++; continue; }
        int had = cJSON_GetArraySize(content);
        for (int k = 0; k < cJSON_GetArraySize(content); ) {
            cJSON *b = cJSON_GetArrayItem(content, k);
            if (!blk_is(b, "tool_result") || strcmp(tool_result_id_of(b), id)) { k++; continue; }
            if (!taken) taken = cJSON_DetachItemFromArray(content, k);
            else        cJSON_DeleteItemFromArray(content, k);
        }
        if (had && cJSON_GetArraySize(content) == 0) {
            cJSON_DeleteItemFromArray(messages, i); rep->msgs_removed++; continue;
        }
        i++;
    }
    return taken;
}

/* Is `id` already answered in canonical position — a tool_result in the very
 * next message, with nothing but tool_results ahead of it? */
static int repair_is_canonical(cJSON *messages, int assistant_idx, const char *id) {
    cJSON *next = assistant_idx + 1 < cJSON_GetArraySize(messages)
                ? cJSON_GetArrayItem(messages, assistant_idx + 1) : NULL;
    if (!msg_can_answer(next)) return 0;
    cJSON *ncontent = cJSON_GetObjectItem(next, "content"), *nb;
    cJSON_ArrayForEach(nb, ncontent) {
        if (!blk_is(nb, "tool_result")) return 0;      /* a non-result got ahead of it */
        if (!strcmp(tool_result_id_of(nb), id)) return 1;
    }
    return 0;
}

/* Find the assistant message holding tool_use `id`; -1 when it is gone. */
static int repair_find_tool_use(cJSON *messages, const char *id) {
    for (int i = 0; i < cJSON_GetArraySize(messages); i++) {
        cJSON *m = cJSON_GetArrayItem(messages, i), *blk;
        if (!msg_has_tool_use(m)) continue;
        cJSON_ArrayForEach(blk, cJSON_GetObjectItem(m, "content"))
            if (blk_is(blk, "tool_use") && !strcmp(tool_use_id_of(blk), id)) return i;
    }
    return -1;
}

static int history_repair_named(cJSON *messages, const char *errbody, repair_report *rep) {
    int before = repair_total(rep);
    if (!errbody || !*errbody) return 0;
    /* ONE id per sweep, restarting after each mutation. repair_take_result
     * can delete a message it emptied, which invalidates every index and
     * every block pointer held across the walk; a restart costs a second
     * scan of a small array and removes that aliasing hazard entirely. The
     * set is small by construction — a rejection names the offending ids,
     * not the whole history — and REPAIR_NAMED_MAX bounds it regardless.
     * Termination is structural, not just budgeted: a processed id ends up
     * at index 0 of its answer message, which makes repair_is_canonical
     * true for it, so it is never selected twice. */
    for (int guard = 0; guard < REPAIR_NAMED_MAX; guard++) {
        char *id = NULL;
        for (int i = 0; i < cJSON_GetArraySize(messages) && !id; i++) {
            cJSON *m = cJSON_GetArrayItem(messages, i), *blk;
            if (!msg_has_tool_use(m)) continue;
            cJSON_ArrayForEach(blk, cJSON_GetObjectItem(m, "content")) {
                if (!blk_is(blk, "tool_use")) continue;
                const char *cand = tool_use_id_of(blk);
                if (!err_names_id(errbody, cand)) continue;
                if (repair_is_canonical(messages, i, cand)) continue;
                id = strdup(cand);   /* cand points INTO the history we mutate */
                break;
            }
        }
        if (!id) break;
        /* Keep the REAL output when the history holds one — relocating a
         * genuine tool result beats replacing it with a marker. */
        cJSON *got = repair_take_result(messages, id, rep);
        int a = repair_find_tool_use(messages, id);
        if (a < 0) { cJSON_Delete(got); free(id); break; }   /* cannot happen */
        cJSON *next = a + 1 < cJSON_GetArraySize(messages) ? cJSON_GetArrayItem(messages, a + 1) : NULL;
        cJSON *ncontent;
        if (!msg_can_answer(next)) {
            cJSON *umsg = cJSON_CreateObject(); ncontent = cJSON_CreateArray();
            cJSON_AddStringToObject(umsg, "role", "user");
            cJSON_AddItemToObject(umsg, "content", ncontent);
            cJSON_InsertItemInArray(messages, a + 1, umsg);
            rep->msgs_added++;
        } else ncontent = cJSON_GetObjectItem(next, "content");
        cJSON_InsertItemInArray(ncontent, 0, got ? got : make_marker_result(id));
        if (got) { rep->moved++;    repair_note_id(&rep->moved_ids, &rep->moved_listed, id); }
        else     { rep->inserted++; repair_note_id(&rep->ins_ids,   &rep->ins_listed,   id); }
        free(id);
    }
    return repair_total(rep) - before;
}

/* One line per repair KIND, each naming its ids — a silent repair is a bug
 * that hides itself, and this whole ticket exists because a symptom was
 * mistaken for its cause. The id list is bounded and says so when it is
 * clipped; a repair of 200 ids must not scroll the reason off the screen. */
static void repair_log_ids(const char *what, int count, const sb *ids, int listed) {
    char more[32] = "";
    if (listed > REPAIR_ID_LIST_MAX) snprintf(more, sizeof more, " (+%d more)", listed - REPAIR_ID_LIST_MAX);
    fprintf(stderr, "%sgcode:   %d %s: %.400s%s%s\n",
            R_ERRB, count, what, ids->p ? ids->p : "", more, CRST);
}

static void repair_log(const repair_report *rep, const char *where) {
    int total = repair_total(rep);
    if (!total) return;
    fprintf(stderr, "\n%sgcode: repaired the message history %s \xe2\x80\x94 %d change(s)%s\n",
            R_ERRB, where, total, CRST);
    if (rep->inserted) repair_log_ids("unanswered tool_use id(s) given a marker tool_result",
                                      rep->inserted, &rep->ins_ids, rep->ins_listed);
    if (rep->dropped)  repair_log_ids("orphan tool_result(s) dropped (no matching tool_use before them)",
                                      rep->dropped, &rep->drop_ids, rep->drop_listed);
    if (rep->moved)    repair_log_ids("tool_result(s) moved to the slot the server expects them in",
                                      rep->moved, &rep->moved_ids, rep->moved_listed);
    if (rep->msgs_added || rep->msgs_removed)
        fprintf(stderr, "%sgcode:   %d message(s) synthesized, %d removed (left with no content)%s\n",
                R_ERRB, rep->msgs_added, rep->msgs_removed, CRST);
    fprintf(stderr, "%sgcode: the session continues \xe2\x80\x94 a repaired round shows the marker text "
                    "in place of the result that was never recorded%s\n", CDIM, CRST);
}

/* ---- #467: compact at the context ceiling ------------------------------
 *
 * Ruled (night decider, 2026-08-03): gcode COMPACTS — summarize-and-drop the
 * oldest rounds, in-process, and keeps going. It does not warn-and-refuse.
 * The warning half survives: compaction is LOUD, announced before (the soft
 * threshold) and when it fires. A silent compaction would be worse than the
 * brick it prevents, because the user could not tell half the session was
 * forgotten.
 *
 * The fold is mechanical, synthesized in-process from the folded messages
 * (user asks, assistant text, tool calls and result heads) rather than by a
 * summarize API call: it works against every provider, cannot itself fail or
 * 400, is deterministic (testable byte-for-byte), and is available at the
 * exact moment the provider is rejecting our requests. The most recent
 * exchanges and the ORIGINAL first user message are always kept verbatim.
 *
 * Invariants (the #462/#463 family):
 *   - the cut lands only where the preceding message carries no tool_use, so
 *     a tool_use/tool_result pair is never split across the fold boundary;
 *   - a prior summary folds INTO the new one body-first (its marker header
 *     dropped), so summaries never nest and the marker appears exactly once;
 *   - the compacted history is PERSISTED (a "compact" record carrying the
 *     splice), so --resume loads what the live session ended with instead of
 *     re-blowing the ceiling. This deliberately differs from #463's
 *     unpersisted repair: a repair re-derives deterministically from the log,
 *     a compaction depends on usage numbers a re-reader may not reproduce. */

/* #748: the window a model really has, so the compactor folds at the right
 * point rather than a guessed one.
 *
 * The table used to be two substrings, and `claude` matched EVERY Claude model
 * at 200000. That is right for exactly one current model (Haiku 4.5) and wrong
 * for the rest: Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6, Fable 5 and Mythos 5
 * all carry 1M. gcode warns at 75% and compacts at 85%, so on its own
 * documented default model (claude-opus-4-8, 1M) it was folding history away at
 * ~170k with 830k of real headroom unused — roughly 5.9x too early. In a long
 * build that is the difference between the agent remembering the API it looked
 * up in round 12 and re-deriving it in round 90.
 *
 * The fix is NOT to flip the blanket the other way. A blanket `claude` ->
 * 1000000 is the same class of error, and the WORSE direction: over-stating a
 * window means never compacting until the provider hard-400s the request,
 * where under-stating only folds early. So: exact rows for the models whose
 * window is known, a conservative `claude` family row for a Claude model this
 * build has not heard of, and CTX_WINDOW_DEFAULT for everything else.
 *
 * MATCHING IS FIRST-MATCH SUBSTRING, so specific keys MUST precede general
 * ones — the bare `claude` row is last, and a `claude-haiku` id must not be
 * captured by it. That ordering hazard is what the self-test pins; substring
 * rather than prefix so a provider-prefixed id (`anthropic.claude-opus-5` on
 * Bedrock) and a dated full id both resolve. */
static long context_window_for(const char *model) {
    static const struct { const char *key; long window; } W[] = {
        /* 1M-context models, most specific first */
        { "claude-opus-5",     1000000 },
        { "claude-opus-4-8",   1000000 },
        { "claude-opus-4-7",   1000000 },
        { "claude-opus-4-6",   1000000 },
        { "claude-sonnet-5",   1000000 },
        { "claude-sonnet-4-6", 1000000 },
        { "claude-fable-5",    1000000 },
        { "claude-mythos-5",   1000000 },
        /* 200k models. These rows are behaviourally INERT today — the family
         * row below carries the same number, so deleting them changes no
         * answer, and a mutation that deletes one is correctly not caught by
         * a test asserting behaviour. They are kept because they are the
         * difference between "we know this model is 200k" and "we have never
         * heard of it": if the family row's value ever moves, these stay
         * right. Explicit over inherited. */
        { "claude-haiku",       200000 },
        { "claude-opus-4-5",    200000 },
        { "claude-opus-4-1",    200000 },
        { "claude-sonnet-4-5",  200000 },
        /* Family fallback: a Claude model this build does not know. 200000
         * is a true lower bound rather than a guess — no shipped Claude model
         * has ever had a window smaller than 200k — so an unrecognised one
         * folds early rather than 400ing. `--context-tokens` /
         * GCODE_CONTEXT_TOKENS is the operator override. MUST stay last. */
        { "claude",             200000 },
        { "deepseek",           128000 },
    };
    if (model)
        for (size_t i = 0; i < sizeof W / sizeof W[0]; i++)
            if (strstr(model, W[i].key)) return W[i].window;
    return CTX_WINDOW_DEFAULT;   /* unknown model: a LIVE ceiling, never "off" */
}

/* env-tunable thresholds (the GCODE_BASH_SECS pattern); invalid values fall
 * back to the defaults rather than disabling the guard. */
static int ctx_pct_env(const char *name, int dflt) {
    const char *s = getenv(name);
    long n = s ? atol(s) : 0;
    return (n >= 1 && n <= 99) ? (int)n : dflt;
}
static int ctx_warn_pct(void) {
    static int v; if (!v) v = ctx_pct_env("GCODE_WARN_PCT", CTX_WARN_PCT_DEFAULT); return v;
}
static int ctx_compact_pct(void) {
    static int v; if (!v) v = ctx_pct_env("GCODE_COMPACT_PCT", CTX_COMPACT_PCT_DEFAULT); return v;
}

/* The usable budget: the window minus the output reservation (a request whose
 * prompt leaves no room for max_tokens of output is rejected too). Floored at
 * half the window so a huge output cap cannot zero the budget. */
static long long ctx_ceiling(const config *cfg, const session *sess) {
    long win = cfg->context_tokens > 0 ? cfg->context_tokens
             : context_window_for((sess->response_model && *sess->response_model)
                                  ? sess->response_model : cfg->model);
    long long c = (long long)win - cfg->max_tokens;
    if (c < win / 2) c = win / 2;
    return c;
}

/* ASCII case-insensitive strstr — the gucOS libc has strcasecmp but no
 * strcasestr, and the error bodies matched below are ASCII. */
static const char *stristr(const char *h, const char *n) {
    size_t nl = strlen(n);
    if (!nl) return h;
    for (; *h; h++) {
        size_t i = 0;
        while (i < nl) {
            char a = h[i], b = n[i];
            if (a >= 'A' && a <= 'Z') a += 32;
            if (b >= 'A' && b <= 'Z') b += 32;
            if (a != b) break;
            i++;
        }
        if (i == nl) return h;
    }
    return NULL;
}

/* Does this rejection describe a context-length overflow? Matched against the
 * live provider phrasings, NOT by narrowing the permanent classifier: a 400
 * for an unknown model / bad parameter must keep failing fast, so only a
 * body that talks about length is even considered, and the caller still
 * gates the retry on the compaction having actually shrunk the history.
 * (A validation error that merely ECHOES one of these phrases from user
 * content would cost one bounded compact-and-retry, then go permanent —
 * the same once-only budget as the #463 repair retry.) */
static int err_is_context_length(const char *body) {
    static const char *P[] = {
        "prompt is too long",              /* Anthropic: "...: X tokens > Y maximum" */
        "exceed context limit",            /* Anthropic: "input length and `max_tokens` exceed context limit" */
        "context_length",                  /* OpenAI-compat error code */
        "context length",                  /* "...maximum context length is N tokens" */
        "too many tokens",
        "maximum context",
    };
    if (!body) return 0;
    for (size_t i = 0; i < sizeof P / sizeof P[0]; i++)
        if (stristr(body, P[i])) return 1;
    return 0;
}

/* ---- #670: recover from a provider that rejects image input ------------
 * The vision gate should keep an image block from ever reaching a provider
 * that cannot decode one — but the gate is a table plus an env override,
 * and a wrongly-open gate (or a forced GCODE_VISION=1) on a provider that
 * REJECTS images would otherwise brick the session: the image stays in the
 * history, so every later round 400s permanently (the #462 class). Same
 * recovery contract as the #463 repair and the #467 compaction: mutate the
 * history so the next attempt is structurally different, then retry ONCE
 * on the shared per-turn budget. The strip is double-gated — the error
 * body must mention images AND the history must actually carry one — so a
 * stray "image" in an unrelated validation echo costs at most one bounded
 * strip-and-retry, then goes permanent as before. Like the #463 repair the
 * strip is not persisted: on a --resume the images reload, the provider
 * rejects once, and the same recovery re-derives operationally.
 * NB this is the BELT only. The measured DeepSeek behavior (HTTP 200, the
 * image silently replaced by an "[Unsupported Image]" placeholder) never
 * produces the 400 this path watches for — the capability gate is the one
 * true defense there. */
#define IMAGE_STRIP_MARKER "[gcode: an image was shown here, but the provider rejected image input" \
                           " \xe2\x80\x94 this model cannot see images]"

static int err_mentions_image(const char *body) {
    return body && stristr(body, "image") != NULL;
}

/* Replace every image content block under `arr` (including inside
 * tool_result nested content) with a text marker; returns blocks replaced. */
static int strip_images_in(cJSON *arr) {
    int stripped = 0, i = 0;
    for (cJSON *blk = arr->child; blk; ) {
        cJSON *next = blk->next;
        if (blk_is(blk, "image")) {
            cJSON *tb = cJSON_CreateObject();
            cJSON_AddStringToObject(tb, "type", "text");
            cJSON_AddStringToObject(tb, "text", IMAGE_STRIP_MARKER);
            cJSON_ReplaceItemInArray(arr, i, tb);
            stripped++;
        } else if (blk_is(blk, "tool_result")) {
            cJSON *c = cJSON_GetObjectItem(blk, "content");
            if (cJSON_IsArray(c)) stripped += strip_images_in(c);
        }
        blk = next; i++;
    }
    return stripped;
}

static int history_strip_images(cJSON *messages) {
    int stripped = 0;
    cJSON *m;
    cJSON_ArrayForEach(m, messages) {
        cJSON *content = cJSON_GetObjectItem(m, "content");
        if (cJSON_IsArray(content)) stripped += strip_images_in(content);
    }
    return stripped;
}

/* Largest prefix of s[0..cap) that ends on a UTF-8 boundary — a clip that
 * splits a sequence would poison the summary and trip the #387 pre-POST
 * guard on the very request the compaction was meant to save. */
static size_t utf8_clip_at(const char *s, size_t n, size_t cap) {
    if (n <= cap) return n;
    size_t i = cap;
    while (i > 0 && ((unsigned char)s[i] & 0xC0) == 0x80) i--;
    return i;
}

/* One clipped single-line summary entry: newlines flattened, UTF-8-safe cut,
 * an ellipsis when clipped. */
static void sum_add_clip(sb *out, const char *prefix, const char *s, size_t cap) {
    sb_puts(out, prefix);
    size_t n = strlen(s), take = utf8_clip_at(s, n, cap), start = out->len;
    sb_add(out, s, take);
    for (size_t i = start; i < out->len; i++)
        if (out->p[i] == '\n' || out->p[i] == '\r') out->p[i] = ' ';
    if (take < n) sb_puts(out, "\xE2\x80\xA6");
    sb_puts(out, "\n");
}

static int msg_is_summary(cJSON *m) {
    const char *role = m ? blk_str(m, "role") : NULL;
    if (!role || strcmp(role, "user")) return 0;
    cJSON *content = cJSON_GetObjectItem(m, "content");
    if (!cJSON_IsArray(content) || cJSON_GetArraySize(content) != 1) return 0;
    cJSON *b = cJSON_GetArrayItem(content, 0);
    if (!blk_is(b, "text")) return 0;
    const char *t = blk_str(b, "text");
    return t && !strncmp(t, COMPACT_MARKER, strlen(COMPACT_MARKER));
}

/* The synthesized summary for messages[from..to): one entry per message,
 * bounded by CAP_COMPACT_SUMMARY with the NEWEST entries kept when the cap
 * forces a choice (they are closest to the live conversation). A prior
 * summary contributes its BODY (the marker header line dropped), so the
 * marker never nests and repeated compaction stays flat. */
static char *compact_summary_text(cJSON *messages, int from, int to, int *rounds_out) {
    int count = to - from, rounds = 0;
    sb *entries = calloc((size_t)count, sizeof *entries);
    if (!entries) return NULL;
    for (int i = from; i < to; i++) {
        cJSON *m = cJSON_GetArrayItem(messages, i);
        sb *e = &entries[i - from];
        const char *role = blk_str(m, "role");
        int assistant = role && !strcmp(role, "assistant");
        if (assistant) rounds++;
        cJSON *content = cJSON_GetObjectItem(m, "content");
        if (cJSON_IsString(content)) {
            if (*content->valuestring)
                sum_add_clip(e, assistant ? "gcode: " : "You: ", content->valuestring, 300);
            continue;
        }
        if (!cJSON_IsArray(content)) continue;
        if (msg_is_summary(m)) {
            const char *t = blk_str(cJSON_GetArrayItem(content, 0), "text");
            const char *nl = t ? strchr(t, '\n') : NULL;
            if (nl && nl[1]) sb_puts(e, nl + 1);   /* body only — header dropped */
            continue;
        }
        cJSON *blk;
        cJSON_ArrayForEach(blk, content) {
            if (blk_is(blk, "text")) {
                const char *t = blk_str(blk, "text");
                if (t && *t) sum_add_clip(e, assistant ? "gcode: " : "You: ", t, 300);
            } else if (blk_is(blk, "tool_use")) {
                const char *nm = blk_str(blk, "name");
                cJSON *in = cJSON_GetObjectItem(blk, "input");
                const char *arg = in ? blk_str(in, (nm && !strcmp(nm, "bash")) ? "command" : "path") : NULL;
                sb line = {0};
                sb_puts(&line, nm ? nm : "?");
                if (arg && *arg) { sb_puts(&line, " "); sb_puts(&line, arg); }
                sum_add_clip(e, "  tool: ", line.p ? line.p : "", 160);
                sb_free(&line);
            } else if (blk_is(blk, "tool_result")) {
                cJSON *c = cJSON_GetObjectItem(blk, "content");
                if (cJSON_IsString(c) && *c->valuestring)
                    sum_add_clip(e, "  result: ", c->valuestring, 160);
                else if (cJSON_IsArray(c)) {
                    /* #670: an image result folds to its caption (the text
                     * block read_image pairs with every image); a bare
                     * image with no caption still leaves a visible trace. */
                    cJSON *cb; int texted = 0;
                    cJSON_ArrayForEach(cb, c) {
                        if (blk_is(cb, "text")) {
                            const char *t = blk_str(cb, "text");
                            if (t && *t) { sum_add_clip(e, "  result: ", t, 160); texted = 1; }
                        }
                    }
                    if (!texted) {
                        cJSON_ArrayForEach(cb, c)
                            if (blk_is(cb, "image")) { sum_add_clip(e, "  result: ", "[image]", 160); break; }
                    }
                }
            }
        }
    }
    size_t total = 0;
    for (int i = 0; i < count; i++) total += entries[i].len;
    int start = 0;
    while (start < count && total > CAP_COMPACT_SUMMARY) total -= entries[start++].len;
    sb out = {0};
    char hdr[320];
    snprintf(hdr, sizeof hdr, COMPACT_MARKER " %d message(s) — %d assistant round(s) — were"
             " folded into this summary to keep the conversation inside the model's context"
             " window. The original first user message precedes this summary; the most recent"
             " exchanges follow it verbatim.\n", count, rounds);
    sb_puts(&out, hdr);
    if (start > 0) {
        char m[96];
        snprintf(m, sizeof m, "[%d oldest folded message(s) not itemized — summary size cap]\n", start);
        sb_puts(&out, m);
    }
    for (int i = start; i < count; i++)
        if (entries[i].len) sb_add(&out, entries[i].p, entries[i].len);
    for (int i = 0; i < count; i++) sb_free(&entries[i]);
    free(entries);
    if (rounds_out) *rounds_out = rounds;
    return out.p;
}

/* Fold modes. AUTO no-ops when the estimate already fits the target (that is
 * what makes threshold-driven compaction idempotent at the fold level);
 * REJECTED skips that early-out because the provider just proved the
 * estimate wrong; MANUAL (/compact) takes the largest pair-safe fold. */
#define COMPACT_AUTO     0
#define COMPACT_REJECTED 1
#define COMPACT_MANUAL   2

/* Fold messages[1..k) into one summary message spliced at index 1. The cut k
 * is pair-safe (messages[k-1] carries no tool_use — its answer would be
 * messages[k], and dropping one half manufactures exactly the dangling-id
 * 400 that #462/#463 exist to prevent), keeps at least the last two
 * messages verbatim, and must include at least one non-summary message
 * (re-folding only the previous summary is churn, not progress). Token
 * estimates are serialized-bytes × tok_per_byte — self-calibrated from the
 * provider's own numbers by the caller. Returns messages REMOVED (0 = no
 * fold possible or needed). */
static int compact_fold(cJSON *messages, long long target_tokens, double tok_per_byte,
                        int mode, long long *est_after, int *rounds_out) {
    int n = cJSON_GetArraySize(messages);
    if (n < 4) return 0;
    size_t *lens = malloc((size_t)n * sizeof *lens);
    if (!lens) return 0;
    size_t total = 0;
    for (int i = 0; i < n; i++) {
        char *s = cJSON_PrintUnformatted(cJSON_GetArrayItem(messages, i));
        lens[i] = s ? strlen(s) : 0; free(s); total += lens[i];
    }
    if (mode == COMPACT_AUTO &&
        (long long)(tok_per_byte * (double)total) <= target_tokens) {
        free(lens); return 0;   /* already fits: compaction is a no-op */
    }
    int prior_summary = msg_is_summary(cJSON_GetArrayItem(messages, 1));
    int k = 0;
    for (int c = 2; c <= n - 2; c++) {
        if (msg_has_tool_use(cJSON_GetArrayItem(messages, c - 1))) continue;
        if (prior_summary && c == 2) continue;
        k = c;
        if (mode != COMPACT_MANUAL) {
            size_t suffix = 0, folded_bytes = 0;
            for (int i = c; i < n; i++) suffix += lens[i];
            for (int i = 1; i < c; i++) folded_bytes += lens[i];
            size_t sum_est = folded_bytes / 8;
            if (sum_est < 512) sum_est = 512;
            if (sum_est > CAP_COMPACT_SUMMARY) sum_est = CAP_COMPACT_SUMMARY;
            long long est = (long long)(tok_per_byte * (double)(lens[0] + sum_est + suffix));
            if (est <= target_tokens) break;   /* smallest sufficient fold */
        }
        /* MANUAL keeps walking to the largest pair-safe cut */
    }
    free(lens);
    if (k < 2) return 0;
    int rounds = 0;
    char *text = compact_summary_text(messages, 1, k, &rounds);
    cJSON *umsg = cJSON_CreateObject(), *arr = cJSON_CreateArray(), *tb = cJSON_CreateObject();
    cJSON_AddStringToObject(umsg, "role", "user");
    cJSON_AddStringToObject(tb, "type", "text");
    cJSON_AddStringToObject(tb, "text", text ? text : COMPACT_MARKER);
    cJSON_AddItemToArray(arr, tb);
    cJSON_AddItemToObject(umsg, "content", arr);
    free(text);
    for (int i = 1; i < k; i++) cJSON_DeleteItemFromArray(messages, 1);
    cJSON_InsertItemInArray(messages, 1, umsg);
    if (est_after) {
        char *s = cJSON_PrintUnformatted(messages);
        *est_after = (long long)(tok_per_byte * (double)(s ? strlen(s) : 0));
        free(s);
    }
    if (rounds_out) *rounds_out = rounds;
    return k - 1;
}

/* The one entry point: fold, announce, persist, refresh the accounting.
 * reason is "auto" | "manual" | "rejected". Returns messages removed. */
static int compact_apply(config *cfg, session *sess, cJSON *messages, const char *reason) {
    long long ceiling = ctx_ceiling(cfg, sess);
    long long target = ceiling * CTX_TARGET_PCT / 100;
    double tpb = 0.25;   /* no usage signal yet: ~4 bytes/token */
    long long before = sess->last_prompt_tokens;
    {
        char *s = cJSON_PrintUnformatted(messages);
        size_t bytes = s ? strlen(s) : 0; free(s);
        if (before > 0 && bytes > 0) tpb = (double)before / (double)bytes;
        else if (bytes > 0) before = (long long)(tpb * (double)bytes);
    }
    int mode = !strcmp(reason, "manual")   ? COMPACT_MANUAL
             : !strcmp(reason, "rejected") ? COMPACT_REJECTED : COMPACT_AUTO;
    long long est_after = 0; int rounds = 0;
    int folded = compact_fold(messages, target, tpb, mode, &est_after, &rounds);
    if (!folded) return 0;
    fprintf(stderr, "\n%sgcode: compacted the history (%s) — folded %d message(s), %d assistant"
                    " round(s), into one summary: ~%lld -> ~%lld tokens of the ~%lld-token budget%s\n",
            R_INFO, reason, folded, rounds, before, est_after, ceiling, CRST);
    sess->last_prompt_tokens = est_after;
    sess->ctx_warned = 0;
    /* Persist the splice so --resume loads the compacted history. On a write
     * failure record_write already printed; the live session continues. */
    cJSON *r = record_new(sess, "compact");
    cJSON_AddStringToObject(r, "reason", reason);
    cJSON_AddNumberToObject(r, "folded", (double)folded);
    cJSON_AddNumberToObject(r, "rounds", (double)rounds);
    cJSON_AddNumberToObject(r, "est_tokens_before", (double)before);
    cJSON_AddNumberToObject(r, "est_tokens_after", (double)est_after);
    cJSON_AddItemToObject(r, "summary", cJSON_Duplicate(cJSON_GetArrayItem(messages, 1), 1));
    record_write(sess, r);
    return folded;
}

/* The decision point, at the top of every round. The usage signal LAGS by
 * one round by construction (round N's usage prices round N+1's send), so
 * the firm threshold sits below 100% to absorb ordinary growth; a single
 * overgrown round that jumps the ceiling inside one round is netted by the
 * context-length-400 recovery in do_turn's rejection path. */
static void context_guard(config *cfg, session *sess, cJSON *messages) {
    if (sess->last_prompt_tokens <= 0) return;   /* no signal yet */
    long long ceiling = ctx_ceiling(cfg, sess);
    if (ceiling <= 0) return;
    long long pct = sess->last_prompt_tokens * 100 / ceiling;
    if (pct >= ctx_compact_pct()) {
        fprintf(stderr, "\n%sgcode: context is at %lld%% of the ~%lld-token budget"
                        " (%lld tokens) — compacting%s\n",
                R_INFO, pct, ceiling, sess->last_prompt_tokens, CRST);
        if (!compact_apply(cfg, sess, messages, "auto"))
            fprintf(stderr, "%sgcode: the history is too short to fold — sending as is"
                            " (the provider may reject it)%s\n", CDIM, CRST);
    } else if (pct >= ctx_warn_pct()) {
        if (!sess->ctx_warned) {
            sess->ctx_warned = 1;
            fprintf(stderr, "\n%sgcode: context is at %lld%% of the ~%lld-token budget"
                            " (%lld tokens, model %s) — gcode will compact automatically at %d%%;"
                            " /compact folds the oldest rounds now, /clear starts fresh%s\n",
                    R_INFO, pct, ceiling, sess->last_prompt_tokens,
                    (sess->response_model && *sess->response_model) ? sess->response_model : cfg->model,
                    ctx_compact_pct(), CRST);
        }
    } else {
        sess->ctx_warned = 0;   /* dropped below: re-arm the warning */
    }
}

/* ---- one API round-trip ----------------------------------------------- */
/* Returns 0 to stop, 1 to continue (tool_use). Errors: -1 recoverable
   (transport, HTTP 5xx/408/429, API error event), -2 interrupted (^C via
   the xferinfo abort, #306), -3 permanent — retrying the same conversation
   cannot succeed (auth 401/403 #305; other 4xx and a malformed request
   body caught before the POST, #387), -4 the history was REPAIRED in
   response to the rejection and this exact round is worth ONE retry (#463;
   agent_loop owns the retry budget). */
static int do_turn(config *cfg, session *sess, cJSON *messages, cJSON *tools, usage *turn_usage, mlist *turn_models) {
    /* #412(b): a ^C that landed after the previous round's tool loop had
     * already run its last block must stop the turn HERE, before another
     * POST is built and sent — interruption is a property of the agent
     * loop, not of the HTTP transfer. */
    if (g_interrupted) { fprintf(stderr, "\n%sgcode: interrupted%s\n", CDIM, CRST); return -2; }
    /* #463: validate-and-repair BEFORE the body is built, beside the #387
     * UTF-8 guard below and in the same spirit — never POST a body the
     * server is guaranteed to reject. This is the seam a poisoned --resume
     * log and a crash-torn round both arrive through, so it runs on every
     * round rather than once at load: the invariant is about what we SEND. */
    {
        repair_report rep; memset(&rep, 0, sizeof rep);
        if (history_repair(messages, &rep)) repair_log(&rep, "before sending");
        repair_report_free(&rep);
    }
    /* #467: warn/compact BEFORE the body is built, on the last round's usage
     * (after the repair above, so the fold walks a structurally valid
     * history). */
    context_guard(cfg, sess, messages);
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "model", cfg->model);
    cJSON_AddNumberToObject(body, "max_tokens", (double)cfg->max_tokens);
    cJSON_AddBoolToObject(body, "stream", 1);
    /* #530: system_sent = base prompt + GCODE.md context (NULL = no context
     * files found; the bare prompt goes out byte-identical). */
    {
        const char *sysp = cfg->system_sent ? cfg->system_sent : cfg->system_prompt;
        /* #747: as a cacheable block array when caching is on, so the
         * breakpoint at its end covers tools + system — the prefix that is
         * fixed for the whole session. Byte-identical bare string otherwise. */
        cJSON *sysblocks = cache_enabled() ? cache_system_blocks(sysp) : NULL;
        if (sysblocks)   cJSON_AddItemToObject(body, "system", sysblocks);
        else if (sysp)   cJSON_AddStringToObject(body, "system", sysp);
    }
    cJSON_AddItemReferenceToObject(body, "messages", messages);
    cJSON_AddItemReferenceToObject(body, "tools", tools);
    /* #747: with no system prompt the stable prefix ends at the tool list, so
     * that is where the breakpoint belongs — marking nothing would mean
     * caching nothing at all, and a silent zero is the failure mode this
     * ticket is about. gcode's own CLI always supplies a system prompt, so
     * this arm is for an embedder or a future config rather than today's
     * command line; it is kept because the placement rule is "mark the end of
     * the stable prefix", not "mark the system block". Idempotent: `tools` is
     * long-lived across rounds and the marker is added at most once. */
    if (cache_enabled() && !cJSON_GetObjectItem(body, "system")) {
        int nt = cJSON_GetArraySize(tools);
        cJSON *lt = nt ? cJSON_GetArrayItem(tools, nt - 1) : NULL;
        if (lt && !cJSON_GetObjectItem(lt, "cache_control"))
            cJSON_AddItemToObject(lt, "cache_control", cache_control_new());
    }
    /* #747: the moving history breakpoint. Added here and removed the instant
     * the payload exists — `messages` is the live, persisted history and the
     * #348 contract is that anything left on it is both SENT and written to
     * the session log, so a breakpoint per round would accumulate past the
     * 4-breakpoint ceiling and start 400ing. */
    cJSON *histbp = cache_enabled() ? cache_mark_history(messages) : NULL;
    char *payload = cJSON_PrintUnformatted(body);
    cache_unmark(histbp);
    cJSON_Delete(body);
    if (!payload) { fprintf(stderr, "%sgcode: could not serialize request body%s\n", R_ERRB, CRST); return -1; }
    size_t payload_len = strlen(payload);

    /* #387: never POST a body the server is guaranteed to reject — the bad
     * bytes would be re-sent identically every round (the bricked-session
     * class #386 fixed at the tool seam; this guard covers every other way
     * the history can go bad, e.g. a poisoned pre-#386 log via --resume). */
    {
        long bad = utf8_invalid_at(payload, payload_len);
        if (bad >= 0) {
            const char *culprit = find_invalid_tool_result(messages);
            fprintf(stderr, "\n%sgcode: request body is not valid UTF-8 at byte %ld (0x%02X) — not sent%s\n",
                    R_ERRB, bad, (unsigned char)payload[bad], CRST);
            if (culprit)
                fprintf(stderr, "%sgcode: the poisoned block is tool_result tool_use_id=%s%s\n",
                        R_ERRB, culprit, CRST);
            fprintf(stderr, "%sgcode: the message history carries these bytes, so retrying cannot succeed — start a fresh session (or /clear)%s\n",
                    R_ERRB, CRST);
            free(payload);
            return -3;
        }
    }

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

    static char curl_errbuf[CURL_ERROR_SIZE];   /* #392: the transport's own words */
    curl_errbuf[0] = 0;
    curl_easy_setopt(h, CURLOPT_ERRORBUFFER, curl_errbuf);
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

    g_api_start = time(NULL);            /* #507: arm the waiting heartbeat */
    CURLcode rc = curl_easy_perform(h);
    g_api_start = 0;
    progress_clear();
    long code = 0; curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(hdr); curl_easy_cleanup(h);
    sb_free(&url); sb_free(&auth); free(payload);

    int ret = 0;
    if (rc != CURLE_OK) {
        if (g_interrupted && rc == CURLE_ABORTED_BY_CALLBACK) { fprintf(stderr, "\n%sgcode: interrupted%s\n", CDIM, CRST); ret = -2; }
        /* #392: prefer the errorbuffer — the veneer writes the transport's
           real diagnostic there; strerror(rc) is the blanket category. */
        else { fprintf(stderr, "\n%sgcode: transport error: %s%s\n", R_ERRB,
                       curl_errbuf[0] ? curl_errbuf : curl_easy_strerror(rc), CRST); ret = -1; }
        goto done;
    }
    if (code != 200) {
        /* #387: say what WE sent, not just what came back — and classify.
         * A request-shaped 4xx (400 body parse, 404 bad route, 413 too
         * large, 422 validation, ...) fails identically on every retry, the
         * 401/403 precedent; 408 (timeout) and 429 (rate limit) stay
         * retryable, as does every 5xx. */
        int permanent = code >= 400 && code < 500 && code != 408 && code != 429;
        fprintf(stderr, "\n%sgcode: HTTP %ld (model %s, %s, payload %lu bytes)%s\n%.*s\n",
                R_ERRB, code, cfg->model, cfg->base_url, (unsigned long)payload_len, CRST,
                (int)ctx.raw.len, ctx.raw.p ? ctx.raw.p : "");
        /* #463: a rejection is the SERVER's reading of the history we just
         * sent, and it is worth acting on — but only when acting on it
         * actually changes something.
         *
         * 🔴 DO NOT blanket-narrow this classifier. A 400 for an unknown
         * model, a malformed body or a bad parameter is GENUINELY permanent,
         * and making those retry converts a clean fast failure into a masked
         * one (or a loop). The gate is therefore not "which status code" but
         * "did the repair MUTATE the history": mutated ⇒ exactly one retry,
         * then the normal classification applies; no-op ⇒ the pre-#463
         * permanent verdict, unchanged, with the same message. That way a
         * retry can only ever fire when there is a concrete, structural
         * reason to believe the next attempt differs from this one.
         *
         * 401/403 are terminal UNCONDITIONALLY — no credential was ever
         * fixed by rewriting the conversation, so the repair is not even
         * attempted there. */
        if (permanent && code != 401 && code != 403) {
            repair_report rep; memset(&rep, 0, sizeof rep);
            const char *errbody = ctx.raw.p ? ctx.raw.p : "";
            history_repair_named(messages, errbody, &rep);
            history_repair(messages, &rep);     /* re-establish both halves globally */
            int changed = repair_total(&rep);
            if (changed) {
                repair_log(&rep, "after the server rejected it");
                fprintf(stderr, "%sgcode: the rejected history was repaired \xe2\x80\x94 retrying this round once%s\n",
                        R_ERRB, CRST);
            }
            repair_report_free(&rep);
            if (changed) { ret = -4; goto done; }
            /* #670: a provider that rejects image input rejects the whole
             * request — strip the images to loud text markers and retry
             * once (the mutation IS the gate, exactly as above; see the
             * history_strip_images block for why this is only the belt and
             * the capability gate is the braces). */
            if (err_mentions_image(errbody)) {
                int stripped = history_strip_images(messages);
                if (stripped) {
                    fprintf(stderr, "%sgcode: the provider rejected image input — removed %d "
                            "image(s) from the history, retrying this round once; this model "
                            "cannot see images (the read_image tool should not be enabled for "
                            "it: check GCODE_VISION)%s\n", R_ERRB, stripped, CRST);
                    ret = -4; goto done;
                }
            }
            /* #467: a context-length rejection is REPAIRABLE by compaction —
             * but only that phrasing class, and only when the fold actually
             * shrinks the history (a no-op fold followed by a retry is an
             * infinite loop; a fold that happened is a concrete structural
             * reason the next attempt differs). Every other 4xx keeps the
             * pre-#467 permanent verdict below, and the retry shares
             * agent_loop's once-per-turn budget with the #463 repair. */
            if (err_is_context_length(errbody)) {
                if (compact_apply(cfg, sess, messages, "rejected")) {
                    fprintf(stderr, "%sgcode: the provider rejected the conversation as too long"
                                    " — compacted, retrying this round once%s\n", R_ERRB, CRST);
                    ret = -4; goto done;
                }
            }
            fprintf(stderr, "%sgcode: the server rejected the request itself — retrying cannot succeed%s\n",
                    R_ERRB, CRST);
        }
        ret = permanent ? -3 : -1; goto done;
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
    /* #462: a round that ended at the output cap was cut mid-stream, and
     * because blocks stream IN ORDER the cut can only be in the LAST active
     * block. Every earlier block is complete and runs normally. */
    int stop_max_tokens = ctx.stop_reason && !strcmp(ctx.stop_reason, "max_tokens");
    int last_block = -1, truncated_calls = 0;
    for (int i = ctx.nblocks - 1; i >= 0; i--)
        if (ctx.blocks[i].active) { last_block = i; break; }
    for (int i = 0; i < ctx.nblocks; i++) {
        cblock *b = &ctx.blocks[i];
        if (!b->active) continue;
        if (b->type != 'u') {
            cJSON *rb = block_replay_json(b);
            if (rb) cJSON_AddItemToArray(acontent, rb);
        } else {
            cJSON *input = b->json.len ? cJSON_Parse(b->json.p) : cJSON_CreateObject();
            /* #462: a partial input_json_delta does not parse. The old code
             * silently substituted {} and RAN THE TOOL ANYWAY — which is a
             * confusing "needs 'path' and 'content'" for write_file and a
             * live hazard for bash (a half-emitted command executing). */
            int bad_json = !input;
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
            /* #412(a): a ^C during an earlier block of this round means
             * the remaining tool calls must NOT run. Substitute a marker
             * tool_result — never drop the block: every tool_use needs a
             * tool_result or the history goes API-invalid and the session
             * stops being resumable. */
            /* #462: the same rule for a call the model never finished
             * emitting. Two independent tells that this block is
             * incomplete: its accumulated JSON does not parse, or the round
             * stopped at the cap and this is the last block (belt and
             * braces — a cut can leave JSON that happens to parse, and
             * running a half-specified `bash` command is the hazard). The
             * substituted result NAMES the cause and the cap so the model
             * can retry smaller instead of re-emitting the same call. */
            /* Attribute the cause, don't guess it. Only a cut at the cap is
             * a TRUNCATION; unparseable arguments on any other stop reason
             * are a MALFORMED stream, and saying "truncated at the
             * max_tokens cap" there would send the next debugger into the
             * cap code for a problem that has nothing to do with it. Both
             * causes are refused identically (never execute a tool whose
             * arguments we could not read) and both count toward the same
             * streak — the runaway guard is about a provider repeating an
             * unusable round, which either cause can do. */
            int cap_cut = stop_max_tokens && i == last_block;
            int refused = cap_cut || bad_json;
            char *result;
            if (refused) {
                truncated_calls++;
                char msg[512];
                if (cap_cut)
                    snprintf(msg, sizeof msg,
                             "[gcode: this tool call was TRUNCATED at the max_tokens output cap (%ld) "
                             "and was NOT executed — %s. Nothing was run and nothing changed on disk. "
                             "Retry with a smaller payload (for a large file, write it in several "
                             "smaller chunks).]",
                             cfg->max_tokens,
                             bad_json ? "its arguments were cut mid-JSON, so they are incomplete"
                                      : "the response ended inside this block, so it may be incomplete");
                else
                    snprintf(msg, sizeof msg,
                             "[gcode: this tool call's arguments were not valid JSON (the stream ended "
                             "\"%s\", so this is a MALFORMED response, not the max_tokens cap) and it "
                             "was NOT executed. Nothing was run and nothing changed on disk. Re-send "
                             "the call with well-formed arguments.]",
                             ctx.stop_reason ? ctx.stop_reason : "(no stop_reason)");
                result = strdup(msg);
                if (cap_cut)
                    fprintf(stderr, "    %struncated at the max_tokens cap (%ld) — not executed%s\n",
                            R_ERRB, cfg->max_tokens, CRST);
                else
                    fprintf(stderr, "    %smalformed tool arguments (stop_reason %s) — not executed%s\n",
                            R_ERRB, ctx.stop_reason ? ctx.stop_reason : "(none)", CRST);
            }
            long tool_secs = 0;                  /* #507: shown on Result */
            cJSON *rblocks = NULL;               /* #670: structured (image) result content */
            if (!refused) {
                if (g_interrupted) {
                    result = strdup("[interrupted by user (^C) — tool not executed]");
                } else {
                    time_t t0 = time(NULL);
                    result = execute_tool(b->name ? b->name : "", input, &rblocks);
                    tool_secs = (long)(time(NULL) - t0);
                }
            }
            cJSON *tr = cJSON_CreateObject();
            cJSON_AddStringToObject(tr, "type", "tool_result");
            cJSON_AddStringToObject(tr, "tool_use_id", b->id ? b->id : "");
            /* #670: an image result's content is the block ARRAY; the char*
             * result is then only the caption, for display and logs. */
            if (rblocks) cJSON_AddItemToObject(tr, "content", rblocks);
            else cJSON_AddStringToObject(tr, "content", result ? result : "");
            cJSON_AddItemToArray(tool_results, tr);
            render_tool_result(result, tool_secs);
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
    /* #738: skipping empty text blocks above can leave `content` EMPTY, and
     * an assistant message with no content blocks is refused by the same API
     * that refuses the empty text block — so this trades one 400 for another
     * unless it is closed here. The message is appended unconditionally a few
     * lines below (it must be: a tool_use needs its assistant turn), so the
     * fix belongs here rather than in the caller. The substitute NAMES what
     * happened instead of inventing plausible assistant prose. */
    if (!cJSON_GetArraySize(acontent)) {
        cJSON *tb = cJSON_CreateObject();
        cJSON_AddStringToObject(tb, "type", "text");
        cJSON_AddStringToObject(tb, "text",
            "[gcode: this round produced no replayable content blocks]");
        cJSON_AddItemToArray(acontent, tb);
    }
    cJSON *amsg = cJSON_CreateObject();
    cJSON_AddStringToObject(amsg, "role", "assistant");
    cJSON_AddItemToObject(amsg, "content", acontent);
    cJSON_AddItemToArray(messages, amsg);

    sess->round_index++;
    if (persist_api_round(sess, &ctx, cfg->model)) { ret = -1; goto done; }
    usage_add(turn_usage, &ctx.round_usage); usage_add(&sess->total, &ctx.round_usage);
    /* #467: the assembled-prompt size of THIS round — all three input
     * counters. On a cached conversation input_tokens alone is tiny while
     * cache_read carries the real size; summing fewer than the three is the
     * bug that makes the compactor look implemented while being dead. */
    sess->last_prompt_tokens = ctx.round_usage.input_tokens
        + ctx.round_usage.cache_creation_input_tokens
        + ctx.round_usage.cache_read_input_tokens;
    /* #348: bucket this round's usage under its ACTUAL model (the display
     * fallback applies: a model-less stream books under the requested name) */
    {
        const char *mkey = (ctx.response_model && *ctx.response_model) ? ctx.response_model : cfg->model;
        mlist_add(turn_models, mkey, &ctx.round_usage);
        mlist_add(&sess->models, mkey, &ctx.round_usage);
    }
    /* #348: carry the returned model out to agent_loop's turn summary —
     * ctx dies with this call. Only overwrite on a round that named one,
     * so a later message_start-less error round keeps the last known. */
    if (ctx.response_model) { free(sess->response_model); sess->response_model = strdup(ctx.response_model); }
    if (persist_assistant_message(sess, amsg, &ctx, cfg->model)) { ret = -1; goto done; }

    /* #462: PAIR ON SHAPE, NEVER ON stop_reason. The API contract is
     * structural — any assistant message carrying a tool_use block MUST be
     * followed by a user message carrying the matching tool_result blocks —
     * and the assistant message above was appended unconditionally. Gating
     * the results on `stop_reason == "tool_use"` therefore left a DANGLING
     * tool_use on every other terminal reason (max_tokens, stop_sequence,
     * refusal, an unknown reason, or a compat-shim provider that returns
     * end_turn alongside tool calls), and the tools had ALREADY RUN — their
     * results were built and then deleted. Every later request was then
     * permanently API-invalid (HTTP 400 "tool_use ids were found without
     * tool_result blocks"), which gcode classifies as permanent and exits
     * the REPL on: a destroyed session. The #412 comment in the block loop
     * above already states this invariant; the code here used to violate
     * it. Delete the array only when it is genuinely EMPTY. */
    int have_tool_use = cJSON_GetArraySize(tool_results) > 0;
    if (have_tool_use) {
        cJSON *umsg = cJSON_CreateObject();
        cJSON_AddStringToObject(umsg, "role", "user");
        cJSON_AddItemToObject(umsg, "content", tool_results);
        cJSON_AddItemToArray(messages, umsg);
        /* 🔴 NOT ATOMIC, and do not read it as such. This is the SECOND of
         * two independent appended+fsync'd records: persist_assistant_message
         * above wrote the tool_use, this writes the matching tool_result.
         * Nothing makes the pair land or fail together. If the process or
         * machine stops between them — or this write fails ENOSPC or lands
         * short — the log holds a complete assistant record and no answer,
         * session_resume() skips the trailing fragment, and --resume loads
         * exactly the dangling tool_use this ticket exists to eliminate.
         * That window is PRE-EXISTING (eb626a41 persisted these as two
         * writes too) and is deliberately left open here: closing it needs a
         * combined record, an append-then-rename, or a resume-side repair
         * that drops a trailing unanswered tool_use — see the ticket filed
         * off #462's review. What this ticket fixes is the far larger hole
         * beside it: the tool_result used to be skipped ENTIRELY, with no
         * crash required, on every stop reason but "tool_use". */
        if (persist_message(sess, umsg, "tool")) { ret = -1; goto done; }
    } else {
        cJSON_Delete(tool_results);
    }

    /* #462: whether to CONTINUE is a separate decision from whether to
     * pair — the pairing above is unconditional so the history stays valid
     * on every path below. */
    sess->trunc_streak = truncated_calls ? sess->trunc_streak + 1 : 0;
    if (have_tool_use && g_interrupted) {
        /* #412: a ^C anywhere in the tool loop ends the TURN, not just the
         * one child. The results (real + substituted) are already appended
         * and persisted above, so the next send resumes a valid history. */
        fprintf(stderr, "\n%sgcode: interrupted%s\n", CDIM, CRST); ret = -2;
    } else if (ctx.stop_reason && !strcmp(ctx.stop_reason, "refusal")) {
        fprintf(stderr, "%sgcode: model refused the request%s\n", R_ERRB, CRST);
        ret = 0;
    } else if (sess->trunc_streak > TRUNC_MAX_CONTINUATIONS) {
        /* Loud, never silent: a truncation storm that quietly ate the turn
         * budget would be a worse failure than the brick this ticket fixes. */
        fprintf(stderr, "%sgcode: %d consecutive rounds ended in an unusable tool call (cut at the "
                        "max_tokens cap, or malformed arguments — the per-call results above say "
                        "which) — giving up on this turn instead of retrying forever. If it was the "
                        "cap (%ld), raise it with --max-tokens N or ANTHROPIC_MAX_TOKENS.%s\n",
                R_ERRB, sess->trunc_streak, cfg->max_tokens, CRST);
        sess->trunc_streak = 0;   /* the next turn starts fresh */
        ret = 0;
    } else if (have_tool_use) {
        /* The model has results it has not seen — including the explanatory
         * ones from a truncated call, which let it SELF-HEAL by retrying
         * with a smaller payload instead of the turn ending on a cut. Note
         * this is keyed on shape too: a compat-shim provider that returns
         * end_turn alongside tool calls now gets its round completed rather
         * than its tool output silently discarded. */
        ret = 1;
    } else {
        ret = 0;
    }

done:
    for (int i = 0; i < MAX_BLOCKS; i++) {
        free(ctx.blocks[i].id); free(ctx.blocks[i].name);
        sb_free(&ctx.blocks[i].text); sb_free(&ctx.blocks[i].json);
        /* #738: `raw` is NULLed when the replay array adopted it, so this
         * frees only the copies that were dropped or never used. */
        sb_free(&ctx.blocks[i].sig); cJSON_Delete(ctx.blocks[i].raw);
    }
    free(ctx.stop_reason); free(ctx.message_id); free(ctx.response_model); cJSON_Delete(ctx.raw_usage);
    sb_free(&ctx.accum); sb_free(&ctx.raw); sb_free(&ctx.errmsg);
    return ret;
}

/* #348 display slice: the turn summary names the PROVIDER-RETURNED model,
 * with the requested alias labelled only when it differs. A stream that
 * never carried message_start leaves response_model unset — fall back to
 * the requested name so the line stays well-formed. */
static void format_model_line(char *buf, size_t cap, const char *response_model, const char *requested) {
    const char *shown = (response_model && *response_model) ? response_model : requested;
    if (strcmp(shown, requested)) snprintf(buf, cap, "%s (requested %s)", shown, requested);
    else                          snprintf(buf, cap, "%s", shown);
}

/* #348: price each bucket with its OWN model and sum. Returns 1 with a
 * formatted cost line in buf; 0 when nothing priced (caller omits the line
 * — the pre-existing unknown-model behavior). A part-known set appends an
 * explicit partial marker naming the unpriced models: a bare $ total that
 * silently excluded rounds would read authoritative while understating,
 * exactly the failure mode #313 exists to fix. */
static int format_cost_line(char *buf, size_t cap, const mlist *l) {
    double total = 0.0; int priced = 0, unpriced_rounds = 0;
    char names[160]; size_t noff = 0; names[0] = 0;
    for (int i = 0; i < l->n; i++) {
        double c = price_usage(l->v[i].model, &l->v[i].u);
        if (c >= 0.0) { total += c; priced++; }
        else {
            unpriced_rounds += l->v[i].rounds;
            if (noff < sizeof names)
                noff += (size_t)snprintf(names + noff, sizeof names - noff, "%s%s",
                                         noff ? ", " : "", l->v[i].model);
        }
    }
    if (!priced) return 0;
    size_t off = (size_t)snprintf(buf, cap, "$%.6f", total);
    if (unpriced_rounds && off < cap)
        snprintf(buf + off, cap - off, "  (%d round%s unpriced: %s)",
                 unpriced_rounds, unpriced_rounds == 1 ? "" : "s", names);
    return 1;
}

/* run the agent loop for one user message already appended to `messages` */
static void report_usage(const char *label, const usage *u, const mlist *models) {
    fprintf(stderr, "%s%s usage: input=%lld output=%lld cache-create=%lld cache-read=%lld%s\n", CDIM, label,
            u->input_tokens, u->output_tokens, u->cache_creation_input_tokens, u->cache_read_input_tokens, CRST);
    char cost[256];
    if (format_cost_line(cost, sizeof cost, models))
        fprintf(stderr, "%s%s cost: %s%s\n", R_COST, label, cost, CRST);
}

static int agent_loop(config *cfg, session *sess, cJSON *messages, cJSON *tools) {
    usage turn = {0}; mlist turn_models = {0}; int rounds = 0, last = 0; const char *status = "done";
    int repair_retried = 0;
    g_interrupted = 0;
    char turn_id[80]; snprintf(turn_id, sizeof turn_id, "%s-%lld", sess->id, sess->turn_index);
    for (long round = 0; cfg->max_turns <= 0 || round < cfg->max_turns; round++) {
        last = do_turn(cfg, sess, messages, tools, &turn, &turn_models); if (last >= 0) rounds++;
        if (last == -4) {
            /* #463/#467: the rejected history was repaired (or compacted
             * after a context-length rejection — the two share this budget
             * deliberately: one free retry per turn, of any kind). Re-send
             * it ONCE. The
             * rejected request never became a round, so it consumes neither
             * the round count nor the --max-turns budget. A second -4 in one
             * turn degrades to the pre-#463 permanent verdict rather than
             * looping: the mutation gate already makes progress a
             * precondition, and this is the belt to that brace. */
            if (repair_retried) { last = -3; break; }
            repair_retried = 1; round--; continue;
        }
        if (last <= 0) break;
    }
    if (last == -2) status = "interrupted";
    else if (last < 0) status = "error";
    else if (last > 0) { status = "max_turns"; fprintf(stderr, "%sgcode: hit max-turns (%ld)%s\n", CDIM, cfg->max_turns, CRST); }
    else { cJSON *lastmsg = cJSON_GetArrayItem(messages, cJSON_GetArraySize(messages) - 1); (void)lastmsg; }
    cJSON *end = record_new(sess, "turn_end"); cJSON_AddStringToObject(end, "turn_id", turn_id); cJSON_AddStringToObject(end, "status", status);
    cJSON_AddStringToObject(end, "stop_reason", last > 0 ? "max_turns" : (sess->last_stop ? sess->last_stop : "")); cJSON_AddNumberToObject(end, "api_rounds", rounds);
    cJSON_AddItemToObject(end, "models", mlist_json(&turn_models));
    cJSON_AddItemToObject(end, "usage", usage_json(&turn)); cJSON_AddItemToObject(end, "session_usage", usage_json(&sess->total));
    if (record_write(sess, end)) { mlist_free(&turn_models); return -1; }
    /* #348 display contract: returned model (alias secondary when it
     * differs), round count when > 1, stop reason when abnormal */
    char mline[256]; format_model_line(mline, sizeof mline, sess->response_model, cfg->model);
    fprintf(stderr, "%sturn model: %s", CDIM, mline);
    if (rounds > 1) fprintf(stderr, ", rounds: %d", rounds);
    if (sess->last_stop && *sess->last_stop &&
        strcmp(sess->last_stop, "end_turn") && strcmp(sess->last_stop, "tool_use"))
        fprintf(stderr, ", stop: %s", sess->last_stop);
    fprintf(stderr, "%s\n", CRST);
    report_usage("turn", &turn, &turn_models); report_usage("session", &sess->total, &sess->models);
    mlist_free(&turn_models);
    /* 0 = done or interrupted (^C lands back at the prompt), -1 =
       recoverable turn error, -3 = permanent (fatal — auth #305,
       non-retryable 4xx / malformed body #387) */
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
    /* #462: the truncation streak is per-TURN. A turn that ended ON the cap
     * must not make the next one give up before its first round. */
    s->turn_index++; s->round_index = 0; s->trunc_streak = 0;
    char turn_id[80]; snprintf(turn_id, sizeof turn_id, "%s-%lld", s->id, s->turn_index);
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
    char meta_model[128] = "";
    while ((n = getline(&line, &cap, f)) >= 0) {
        if (!n || line[n - 1] != '\n') { had_fragment = 1; break; } /* ignore crash fragment */
        cJSON *r = cJSON_ParseWithLength(line, (size_t)n); if (!r) continue;
        long long seq = json_count(r, "seq"); if (seq > s->seq) s->seq = seq;
        const char *type = jstr(r, "type");
        if (!strcmp(type, "session_meta")) {
            saw_meta = 1; snprintf(s->id, sizeof s->id, "%s", jstr(r, "session_id"));
            snprintf(meta_model, sizeof meta_model, "%s", jstr(r, "model"));
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
            /* #467: rebuild the context accounting — the LAST round's
             * assembled-prompt size (all three input counters), so a resumed
             * near-ceiling session compacts BEFORE its first POST instead of
             * discovering the ceiling with a 400. */
            s->last_prompt_tokens = u.input_tokens
                + u.cache_creation_input_tokens + u.cache_read_input_tokens;
            /* #348: rebuild the per-model buckets so the resumed session's
             * cost line keeps pricing each round with its own model. Old
             * records missing the fields fall back response -> request ->
             * session_meta model -> the current requested name. */
            const char *rm = jstr(r, "response_model");
            if (!*rm) rm = jstr(r, "request_model");
            if (!*rm) rm = meta_model[0] ? meta_model : cfg->model;
            mlist_add(&s->models, rm, &u);
        } else if (!strcmp(type, "turn_start")) {
            long long idx = json_count(r, "turn_index"); if (idx > s->turn_index) s->turn_index = idx;
        } else if (!strcmp(type, "compact")) {
            /* #467: replay the splice. At the time the record was written the
             * loaded array mirrored the live one exactly (every message is
             * persisted), so the identical splice reproduces the compacted
             * history — the resumed session must not re-blow the ceiling. A
             * record that no longer matches (a hand-edited log) is skipped
             * LOUDLY: the un-spliced history is still complete and valid,
             * merely big. */
            long long folded = json_count(r, "folded");
            cJSON *summ = cJSON_GetObjectItem(r, "summary");
            int have = cJSON_GetArraySize(messages);
            if (cJSON_IsObject(summ) && folded > 0 && folded + 1 <= have) {
                for (long long i = 0; i < folded; i++) cJSON_DeleteItemFromArray(messages, 1);
                cJSON *m = cJSON_CreateObject();
                cJSON_AddStringToObject(m, "role", jstr(summ, "role"));
                cJSON_AddItemToObject(m, "content", cJSON_Duplicate(cJSON_GetObjectItem(summ, "content"), 1));
                cJSON_InsertItemInArray(messages, 1, m);
                long long ea = json_count(r, "est_tokens_after");
                if (ea > 0) s->last_prompt_tokens = ea;
            } else {
                fprintf(stderr, "gcode: warning: compact record does not match the replayed log"
                                " (folded %lld, loaded %d) — ignored\n", folded, have);
            }
        }
        cJSON_Delete(r);
    }
    free(line); fclose(f);
    if (!saw_meta || !s->id[0]) { fprintf(stderr, "gcode: invalid session log %s\n", s->path); return -1; }
    s->fd = open(s->path, O_WRONLY | O_CREAT | O_APPEND, 0600); if (s->fd < 0) { fprintf(stderr, "gcode: cannot append %s: %s\n", s->path, strerror(errno)); return -1; }
    if (had_fragment && (write(s->fd, "\n", 1) != 1 || fsync(s->fd))) { fprintf(stderr, "gcode: cannot repair session fragment: %s\n", strerror(errno)); close(s->fd); s->fd = -1; return -1; }
    fprintf(stderr, "%sresumed %s (%d messages): %s%s\n", CDIM, s->id, cJSON_GetArraySize(messages), s->path, CRST); return 0;
}

/* ---- #463 self-test scaffolding ---------------------------------------
 * Run the repair over a history literal and compare the result to an
 * expected literal, byte for byte after a normalizing re-print through
 * cJSON. Every case ALSO asserts idempotence — a second structural pass
 * over the repaired history must report zero changes and must not move a
 * byte — so repair(repair(h)) == repair(h) is checked on every fixture
 * rather than once on a chosen one. `errbody` NULL skips the server-directed
 * pass, which is how the structural pass is tested in isolation. */
static int repair_case(const char *in, const char *errbody, int want_changes, const char *want_json) {
    cJSON *h = cJSON_Parse(in), *w = cJSON_Parse(want_json);
    if (!h || !w) { cJSON_Delete(h); cJSON_Delete(w); return 0; }
    repair_report rep; memset(&rep, 0, sizeof rep);
    int n = 0;
    if (errbody) n += history_repair_named(h, errbody, &rep);
    n += history_repair(h, &rep);
    repair_report_free(&rep);
    char *got = cJSON_PrintUnformatted(h), *want = cJSON_PrintUnformatted(w);
    int ok = got && want && !strcmp(got, want) && n == want_changes;
    repair_report rep2; memset(&rep2, 0, sizeof rep2);
    int n2 = history_repair(h, &rep2);
    repair_report_free(&rep2);
    char *again = cJSON_PrintUnformatted(h);
    ok = ok && n2 == 0 && again && got && !strcmp(again, got);
    if (!ok) fprintf(stderr, "gcode self-test: repair case FAILED\n  in:   %s\n  want: %s\n  got:  %s\n"
                             "  changes want=%d got=%d; second pass changes=%d\n",
                     in, want ? want : "(null)", got ? got : "(null)", want_changes, n, n2);
    free(got); free(want); free(again); cJSON_Delete(h); cJSON_Delete(w);
    return ok;
}

#define TR_MARK(id) "{\"type\":\"tool_result\",\"tool_use_id\":\"" id "\",\"content\":\"" REPAIR_MARKER "\"}"
#define U_TEXT(t)   "{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"" t "\"}]}"
#define A_USE(id)   "{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" id "\",\"name\":\"bash\",\"input\":{}}]}"
#define TR(id, c)   "{\"type\":\"tool_result\",\"tool_use_id\":\"" id "\",\"content\":\"" c "\"}"

/* #463: the invariant the whole ticket is about, asserted directly on a
 * history rather than inferred from a green run — every tool_use id has a
 * matching tool_result in the message immediately after it, and no
 * tool_result answers anything else. Returns 1 when the history is
 * API-valid on both halves. */
static int history_is_valid(cJSON *messages) {
    int n = cJSON_GetArraySize(messages);
    for (int i = 0; i < n; i++) {
        cJSON *m = cJSON_GetArrayItem(messages, i), *blk;
        cJSON *content = cJSON_GetObjectItem(m, "content");
        if (msg_has_tool_use(m)) {
            cJSON *next = i + 1 < n ? cJSON_GetArrayItem(messages, i + 1) : NULL;
            if (!msg_can_answer(next)) return 0;
            cJSON_ArrayForEach(blk, content) {
                if (!blk_is(blk, "tool_use")) continue;
                int found = 0; cJSON *nb;
                cJSON_ArrayForEach(nb, cJSON_GetObjectItem(next, "content"))
                    if (blk_is(nb, "tool_result") && !strcmp(tool_result_id_of(nb), tool_use_id_of(blk))) { found = 1; break; }
                if (!found) return 0;
            }
        }
        if (!cJSON_IsArray(content)) continue;
        cJSON *prev = i > 0 ? cJSON_GetArrayItem(messages, i - 1) : NULL;
        cJSON *pcontent = (prev && msg_has_tool_use(prev)) ? cJSON_GetObjectItem(prev, "content") : NULL;
        cJSON_ArrayForEach(blk, content) {
            if (!blk_is(blk, "tool_result")) continue;
            int matched = 0; cJSON *pb;
            cJSON_ArrayForEach(pb, pcontent)
                if (blk_is(pb, "tool_use") && !strcmp(tool_use_id_of(pb), tool_result_id_of(blk))) { matched = 1; break; }
            if (!matched) return 0;
        }
    }
    return 1;
}

static int repair_self_test(void) {
    int ok = 1;

    /* A clean history is left ALONE — no gratuitous rewriting. */
    ok &= repair_case("[" U_TEXT("hi") "," A_USE("toolu_aaaa") ","
                      "{\"role\":\"user\",\"content\":[" TR("toolu_aaaa", "ok") "]}]",
                      NULL, 0,
                      "[" U_TEXT("hi") "," A_USE("toolu_aaaa") ","
                      "{\"role\":\"user\",\"content\":[" TR("toolu_aaaa", "ok") "]}]");

    /* Crash-torn tail: the assistant record landed, its results did not (the
     * two-independent-writes window at the second persist_message call). */
    ok &= repair_case("[" U_TEXT("hi") "," A_USE("toolu_aaaa") "]",
                      NULL, 1,
                      "[" U_TEXT("hi") "," A_USE("toolu_aaaa") ","
                      "{\"role\":\"user\",\"content\":[" TR_MARK("toolu_aaaa") "]}]");

    /* The #462 incident's exact shape: a dangling tool_use, then the user's
     * next question. The follow-up message IS a legal carrier, so the marker
     * joins it AHEAD of the text — which is also the order the API wants. */
    ok &= repair_case("[" A_USE("toolu_aaaa") "," U_TEXT("what now") "]",
                      NULL, 1,
                      "[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":["
                      TR_MARK("toolu_aaaa") ",{\"type\":\"text\",\"text\":\"what now\"}]}]");

    /* No carrier at all (the next message is another assistant turn) — one
     * is synthesized between them. */
    ok &= repair_case("[" A_USE("toolu_aaaa") "," A_USE("toolu_bbbb") ","
                      "{\"role\":\"user\",\"content\":[" TR("toolu_bbbb", "ok") "]}]",
                      NULL, 1,
                      "[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":[" TR_MARK("toolu_aaaa") "]},"
                      A_USE("toolu_bbbb") ",{\"role\":\"user\",\"content\":[" TR("toolu_bbbb", "ok") "]}]");

    /* Partially answered round: the gap is filled in place, after the last
     * real result, so the tool_result run keeps leading the message. */
    ok &= repair_case("[{\"role\":\"assistant\",\"content\":["
                      "{\"type\":\"tool_use\",\"id\":\"toolu_aaaa\",\"name\":\"bash\",\"input\":{}},"
                      "{\"type\":\"tool_use\",\"id\":\"toolu_bbbb\",\"name\":\"bash\",\"input\":{}}]},"
                      "{\"role\":\"user\",\"content\":[" TR("toolu_aaaa", "ok") "]}]",
                      NULL, 1,
                      "[{\"role\":\"assistant\",\"content\":["
                      "{\"type\":\"tool_use\",\"id\":\"toolu_aaaa\",\"name\":\"bash\",\"input\":{}},"
                      "{\"type\":\"tool_use\",\"id\":\"toolu_bbbb\",\"name\":\"bash\",\"input\":{}}]},"
                      "{\"role\":\"user\",\"content\":[" TR("toolu_aaaa", "ok") "," TR_MARK("toolu_bbbb") "]}]");

    /* REVERSE ORPHAN — a tool_result answering nothing. Repairing only the
     * forward half would trade one 400 for another. Here the drop empties
     * the message, so the message goes too. */
    ok &= repair_case("[" U_TEXT("hi") ",{\"role\":\"user\",\"content\":[" TR("toolu_ghost", "x") "]}]",
                      NULL, 1, "[" U_TEXT("hi") "]");

    /* Reverse orphan beside a real result and a text block: only the orphan
     * goes, the message stays. */
    ok &= repair_case("[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":["
                      TR("toolu_aaaa", "ok") "," TR("toolu_ghost", "x") ",{\"type\":\"text\",\"text\":\"more\"}]}]",
                      NULL, 1,
                      "[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":["
                      TR("toolu_aaaa", "ok") ",{\"type\":\"text\",\"text\":\"more\"}]}]");

    /* Both halves compounding: the orphan drop empties the answer message,
     * whose removal exposes the tool_use the drop was hiding. Two changes,
     * and the order of the two passes is what makes it converge in one run. */
    ok &= repair_case("[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":[" TR("toolu_ghost", "x") "]}]",
                      NULL, 2,
                      "[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":[" TR_MARK("toolu_aaaa") "]}]");

    /* ---- the server-directed pass and its gate ------------------------
     * This history satisfies gcode's structural reading — the result IS in
     * the next message — but not Anthropic's, which wants the tool_result
     * run to LEAD. It is the case that makes the post-400 retry live rather
     * than dead code. */
    {
        const char *skewed =
            "[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":["
            "{\"type\":\"text\",\"text\":\"note\"}," TR("toolu_aaaa", "real output") "]}]";
        const char *fixed =
            "[" A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":["
            TR("toolu_aaaa", "real output") ",{\"type\":\"text\",\"text\":\"note\"}]}]";
        const char *names_it =
            "{\"error\":{\"message\":\"messages.1: `tool_use` ids were found without `tool_result` "
            "blocks immediately after: toolu_aaaa. Each `tool_use` block must have a corresponding "
            "`tool_result` block in the next message.\"}}";
        /* structural pass alone: no change — gcode's reading says it is fine */
        ok &= repair_case(skewed, NULL, 0, skewed);
        /* the server names the id: the REAL output is relocated, not replaced */
        ok &= repair_case(skewed, names_it, 1, fixed);
        /* 🔴 THE NEGATIVE CONTROL. A genuinely permanent 400 — unknown model —
         * names no id we hold, so the pass mutates NOTHING and the caller
         * keeps its pre-#463 permanent verdict. This is the leak the ticket
         * warns about, asserted rather than assumed. */
        ok &= repair_case(skewed,
                          "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\","
                          "\"message\":\"model: nonexistent-model-9000\"}}",
                          0, skewed);
        /* An id too short to match on is never acted upon, however the error
         * body reads — a degenerate id must not match by coincidence. */
        ok &= repair_case("[{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"ab\","
                          "\"name\":\"bash\",\"input\":{}}]},{\"role\":\"user\",\"content\":["
                          "{\"type\":\"text\",\"text\":\"note\"}," TR("ab", "real") "]}]",
                          "{\"error\":{\"message\":\"ids without results: ab\"}}", 0,
                          "[{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"ab\","
                          "\"name\":\"bash\",\"input\":{}}]},{\"role\":\"user\",\"content\":["
                          "{\"type\":\"text\",\"text\":\"note\"}," TR("ab", "real") "]}]");
    }

    /* The repaired output is API-VALID on both halves, asserted directly —
     * and the corrupt input is NOT, which is what makes the assertion mean
     * something. */
    {
        const char *bad = "[" A_USE("toolu_aaaa") "," U_TEXT("what now") ","
                          "{\"role\":\"user\",\"content\":[" TR("toolu_ghost", "x") "]}]";
        cJSON *h = cJSON_Parse(bad);
        ok &= h && !history_is_valid(h);
        repair_report rep; memset(&rep, 0, sizeof rep);
        ok &= history_repair(h, &rep) > 0;
        ok &= rep.inserted == 1 && rep.dropped == 1;
        ok &= rep.ins_ids.p && !strcmp(rep.ins_ids.p, "toolu_aaaa");
        ok &= rep.drop_ids.p && !strcmp(rep.drop_ids.p, "toolu_ghost");
        repair_report_free(&rep);
        ok &= h && history_is_valid(h);
        cJSON_Delete(h);
    }
    /* The id list is bounded and SAYS it was clipped — a 200-id repair must
     * not scroll its own reason off the screen. */
    {
        repair_report rep; memset(&rep, 0, sizeof rep);
        for (int i = 0; i < REPAIR_ID_LIST_MAX + 3; i++) repair_note_id(&rep.ins_ids, &rep.ins_listed, "toolu_x");
        ok &= rep.ins_listed == REPAIR_ID_LIST_MAX + 3;
        ok &= rep.ins_ids.p && strlen(rep.ins_ids.p) == (size_t)(REPAIR_ID_LIST_MAX * 7 + (REPAIR_ID_LIST_MAX - 1) * 2);
        repair_report_free(&rep);
    }
    /* An empty history, and one holding only a bare-string content, must not
     * trip the walk. */
    ok &= repair_case("[]", NULL, 0, "[]");
    ok &= repair_case("[{\"role\":\"user\",\"content\":\"plain string\"}]", NULL, 0,
                      "[{\"role\":\"user\",\"content\":\"plain string\"}]");
    return ok;
}

/* ---- #467 self-test: the compaction machinery -------------------------- */
#define A_TEXT(t) "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"" t "\"}]}"

static int count_markers(cJSON *h) {
    char *s = cJSON_PrintUnformatted(h);
    int cnt = 0;
    for (const char *p = s; p && (p = strstr(p, COMPACT_MARKER)); p++) cnt++;
    free(s);
    return cnt;
}

static int compact_self_test(void) {
    int ok = 1;

    /* The window table's unknown-model fallback is a LIVE ceiling — the
     * vacuous-green hazard is a compactor that silently never fires against
     * an off-table provider, which is exactly how gcode is live-tested. */
    ok &= context_window_for("claude-opus-5") == 1000000;
    ok &= context_window_for("claude-opus-4-8") == 1000000;   /* gcode's own default */
    ok &= context_window_for("claude-sonnet-5") == 1000000;
    ok &= context_window_for("claude-fable-5") == 1000000;
    ok &= context_window_for("deepseek-v4-pro") == 128000;
    ok &= context_window_for("totally-unknown-model") == CTX_WINDOW_DEFAULT;
    ok &= context_window_for(NULL) == CTX_WINDOW_DEFAULT;
    ok &= CTX_WINDOW_DEFAULT > 0;
    /* #748: the FIRST-MATCH ordering hazard. The table is scanned in order,
     * so a specific key placed after the broad `claude` row would be
     * unreachable and its model would silently take the family number. These
     * rows fail the moment the bare `claude` entry is moved up. */
    ok &= context_window_for("claude-haiku-4-5") == 200000;
    ok &= context_window_for("claude-opus-4-5") == 200000;
    ok &= context_window_for("claude-sonnet-4-5") == 200000;
    /* A Claude model this build has never heard of falls to the family row —
     * conservative, so it folds early instead of 400ing. Deliberately NOT the
     * optimistic 1M: over-stating a window is the worse direction. */
    ok &= context_window_for("claude-opus-9") == 200000;
    ok &= context_window_for("claude-something-new") == 200000;
    /* Real-world id shapes must resolve, not fall through: a dated full id,
     * and a provider-prefixed id. */
    ok &= context_window_for("claude-opus-4-5-20251101") == 200000;
    ok &= context_window_for("anthropic.claude-opus-5") == 1000000;

    /* The 400-recovery gate must catch the live phrasings and MUST NOT catch
     * a genuinely-permanent 400 — narrowing the permanent classifier is the
     * regression the ticket warns about. */
    ok &= err_is_context_length("{\"error\":{\"message\":\"prompt is too long: 213462 tokens > 204698 maximum\"}}");
    ok &= err_is_context_length("{\"error\":{\"message\":\"input length and `max_tokens` exceed context limit: 195000 + 32768 > 204698\"}}");
    ok &= err_is_context_length("{\"error\":{\"code\":\"context_length_exceeded\"}}");
    ok &= err_is_context_length("This model's maximum context length is 128000 tokens");
    ok &= !err_is_context_length("model: nonexistent-model-9000");
    ok &= !err_is_context_length("There was an error parsing the body");
    ok &= !err_is_context_length(NULL);

    /* The usable budget: window minus the output reservation, floored at
     * half the window; the response model outranks the requested alias. */
    {
        config c; memset(&c, 0, sizeof c);
        session s; memset(&s, 0, sizeof s);
        c.context_tokens = 10000; c.max_tokens = 1000; c.model = "x";
        ok &= ctx_ceiling(&c, &s) == 9000;
        c.max_tokens = 32768;
        ok &= ctx_ceiling(&c, &s) == 5000;
        c.context_tokens = 0; c.max_tokens = 1000; c.model = "totally-unknown";
        ok &= ctx_ceiling(&c, &s) == CTX_WINDOW_DEFAULT - 1000;
        s.response_model = (char *)"deepseek-v4-flash";
        ok &= ctx_ceiling(&c, &s) == 128000 - 1000;
    }

    /* A clip landing inside a multi-byte sequence must back off to the
     * boundary — a split sequence would trip the #387 pre-POST guard on the
     * very request the compaction was meant to save. */
    {
        sb b = {0};
        sum_add_clip(&b, "", "ab\xC3\xA9\xC3\xA9", 3);   /* cap splits the first é */
        ok &= b.p && utf8_invalid_at(b.p, b.len) == -1;
        sb_free(&b);
    }

    /* The fold itself: pair-safe cut, first user message kept verbatim, the
     * summary spliced at index 1, and the result API-valid. */
    {
        const char *hist =
            "[" U_TEXT("first ask") ","
            A_USE("toolu_aaaa") ",{\"role\":\"user\",\"content\":[" TR("toolu_aaaa", "out a") "]},"
            A_TEXT("done a") ","
            U_TEXT("second ask") ","
            A_USE("toolu_bbbb") ",{\"role\":\"user\",\"content\":[" TR("toolu_bbbb", "out b") "]},"
            A_TEXT("done b") "]";
        cJSON *h = cJSON_Parse(hist);
        long long ea = 0; int rounds = 0;
        /* target 1 token: nothing suffices, so the largest pair-safe fold —
         * k=5 (k=2 and k=6 are blocked by the tool_use before the cut). */
        int folded = compact_fold(h, 1, 0.25, COMPACT_AUTO, &ea, &rounds);
        ok &= folded == 4 && rounds == 2 && cJSON_GetArraySize(h) == 5;
        ok &= history_is_valid(h);
        cJSON *m0 = cJSON_GetArrayItem(h, 0);
        const char *t0 = blk_str(cJSON_GetArrayItem(cJSON_GetObjectItem(m0, "content"), 0), "text");
        ok &= t0 && !strcmp(t0, "first ask");
        ok &= msg_is_summary(cJSON_GetArrayItem(h, 1));
        ok &= !msg_is_summary(cJSON_GetArrayItem(h, 0));
        ok &= count_markers(h) == 1;
        /* the kept tail is verbatim: the toolu_bbbb pair survived intact */
        ok &= msg_has_tool_use(cJSON_GetArrayItem(h, 2));

        /* Idempotent at a satisfied target: an AUTO fold over a history that
         * already fits is a no-op — the property that stops threshold-driven
         * compaction firing forever on its own output. */
        long long ea2 = 0; int r2 = 0;
        ok &= compact_fold(h, 1000000000, 0.25, COMPACT_AUTO, &ea2, &r2) == 0;
        ok &= cJSON_GetArraySize(h) == 5;

        /* Summaries never nest: a second fold that swallows the first
         * summary merges its BODY, so the marker still appears exactly once
         * and the message count strictly falls. */
        cJSON_AddItemToArray(h, cJSON_Parse(U_TEXT("third ask")));
        cJSON_AddItemToArray(h, cJSON_Parse(A_TEXT("done c")));
        long long ea3 = 0; int r3 = 0;
        int folded3 = compact_fold(h, 1, 0.25, COMPACT_MANUAL, &ea3, &r3);
        ok &= folded3 == 4 && cJSON_GetArraySize(h) == 4;
        ok &= history_is_valid(h) && count_markers(h) == 1;

        /* A fold that could only swallow the previous summary is refused —
         * churn, not progress ([U0, SUM, U2, At2] has no other cut). */
        long long ea4 = 0; int r4 = 0;
        ok &= compact_fold(h, 1, 0.25, COMPACT_MANUAL, &ea4, &r4) == 0;
        cJSON_Delete(h);
    }

    /* Too short to fold: never invent a cut that would drop the live tail. */
    {
        cJSON *h = cJSON_Parse("[" U_TEXT("a") "," A_TEXT("b") "," U_TEXT("c") "]");
        long long ea = 0; int r = 0;
        ok &= compact_fold(h, 1, 0.25, COMPACT_MANUAL, &ea, &r) == 0;
        cJSON_Delete(h);
    }

    if (!ok) fprintf(stderr, "gcode self-test: compact case FAILED\n");
    return ok;
}

/* ---- #670 self-test: base64, image sniff, image strip ------------------ */
static int vision_self_test(void) {
    int ok = 1;
    /* base64: the RFC 4648 test vectors + a binary (non-text) triple */
    {
        static const struct { const char *in, *out; } B[] = {
            { "", "" }, { "f", "Zg==" }, { "fo", "Zm8=" }, { "foo", "Zm9v" },
            { "foob", "Zm9vYg==" }, { "fooba", "Zm9vYmE=" }, { "foobar", "Zm9vYmFy" },
        };
        for (size_t i = 0; i < sizeof B / sizeof B[0]; i++) {
            char *e = b64_encode((const unsigned char *)B[i].in, strlen(B[i].in));
            if (strcmp(e, B[i].out)) {
                ok = 0;
                fprintf(stderr, "gcode self-test: b64(%s) = %s, want %s\n", B[i].in, e, B[i].out);
            }
            free(e);
        }
        unsigned char bin[3] = { 0x00, 0xFF, 0x10 };
        char *e = b64_encode(bin, 3);
        if (strcmp(e, "AP8Q")) { ok = 0; fprintf(stderr, "gcode self-test: b64 binary FAILED (%s)\n", e); }
        free(e);
    }
    /* sniff: media by content, dimensions out of the real header layouts */
    {
        unsigned char png[24] = { 0x89,'P','N','G','\r','\n',0x1A,'\n', 0,0,0,13,
                                  'I','H','D','R', 0,0,0x03,0x20, 0,0,0x01,0xF4 };
        long w, h; const char *m = img_sniff(png, sizeof png, &w, &h);
        if (!(m && !strcmp(m, "image/png") && w == 800 && h == 500))
            { ok = 0; fprintf(stderr, "gcode self-test: png sniff FAILED\n"); }
    }
    {
        unsigned char gif[10] = { 'G','I','F','8','9','a', 0x20,0x03, 0xF4,0x01 };
        long w, h; const char *m = img_sniff(gif, sizeof gif, &w, &h);
        if (!(m && !strcmp(m, "image/gif") && w == 800 && h == 500))
            { ok = 0; fprintf(stderr, "gcode self-test: gif sniff FAILED\n"); }
    }
    {
        /* SOI, APP0 (len 4), SOF0 (len 11): 8-bit 500x800 — height leads in a SOF */
        unsigned char jpg[21] = { 0xFF,0xD8, 0xFF,0xE0, 0x00,0x04, 0,0,
                                  0xFF,0xC0, 0x00,0x0B, 8, 0x01,0xF4, 0x03,0x20, 1, 0,0,0 };
        long w, h; const char *m = img_sniff(jpg, sizeof jpg, &w, &h);
        if (!(m && !strcmp(m, "image/jpeg") && w == 800 && h == 500))
            { ok = 0; fprintf(stderr, "gcode self-test: jpeg sniff FAILED (%ldx%ld)\n", w, h); }
    }
    {
        /* WebP VP8L: sig 0x2F, then 14+14 packed bits for (w-1, h-1) */
        unsigned char webp[30] = { 'R','I','F','F', 22,0,0,0, 'W','E','B','P',
                                   'V','P','8','L', 10,0,0,0, 0x2F, 0x1F,0xC3,0x7C,0x00,
                                   0,0,0,0,0 };
        long w, h; const char *m = img_sniff(webp, sizeof webp, &w, &h);
        if (!(m && !strcmp(m, "image/webp") && w == 800 && h == 500))
            { ok = 0; fprintf(stderr, "gcode self-test: webp sniff FAILED (%ldx%ld)\n", w, h); }
    }
    {
        unsigned char junk[16] = "just some text\n";
        long w, h;
        if (img_sniff(junk, sizeof junk, &w, &h) != NULL)
            { ok = 0; fprintf(stderr, "gcode self-test: junk sniffed as an image\n"); }
    }
    /* strip: every image block (nested tool_result content included) becomes
     * the loud marker; idempotent; the count is the mutation gate. */
    {
        cJSON *hst = cJSON_Parse(
            "[{\"role\":\"user\",\"content\":["
              "{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":["
                "{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"AAAA\"}},"
                "{\"type\":\"text\",\"text\":\"image x.png\"}]},"
              "{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"BBBB\"}}]},"
             "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}]");
        int n1 = history_strip_images(hst);
        int n2 = history_strip_images(hst);
        char *s = cJSON_PrintUnformatted(hst);
        if (!(n1 == 2 && n2 == 0 && s && !strstr(s, "\"image\"") &&
              strstr(s, "rejected image input")))
            { ok = 0; fprintf(stderr, "gcode self-test: image strip FAILED (%d/%d)\n  %s\n", n1, n2, s ? s : "?"); }
        free(s); cJSON_Delete(hst);
    }
    if (!ok) fprintf(stderr, "gcode self-test: vision case FAILED\n");
    return ok;
}


/* ---- #738: content-block parse + replay -------------------------------
 * The defect this pins: gcode collapsed EVERY non-tool_use block to text,
 * never read thinking_delta, and replayed the result as
 * {"type":"text","text":""} — which the Messages API refuses with
 *   400 "messages: text content blocks must be non-empty"
 * killing the turn. Reproduced 3/3 live on api.anthropic.com in #678 Pass B
 * round 3. The legs below drive the REAL SSE reader (write_cb) and the REAL
 * replay mapping (block_replay_json), so a regression cannot hide behind a
 * re-implementation in the test. */
static int blocks_self_test(void) {
    int ok = 1;

    /* Leg 1 — the exact shape that 400'd: a thinking block (thinking_delta +
     * signature_delta, no text_delta at all) followed by a tool_use, with no
     * assistant preamble text anywhere. */
    {
        const char *fx =
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5\"}}\n\n"
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n"
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"weigh\"}}\n\n"
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" it\"}}\n\n"
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"SIGabc\"}}\n\n"
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"bash\"}}\n\n"
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n";
        stream_ctx c; memset(&c, 0, sizeof c);
        write_cb((char *)fx, 1, strlen(fx), &c);
        /* Parsed as its own kind, not as text — the root cause. */
        ok &= c.nblocks == 2 && c.blocks[0].type == 'k' && c.blocks[1].type == 'u';
        /* thinking_delta actually accumulated (it was dropped on the floor). */
        ok &= c.blocks[0].text.p && !strcmp(c.blocks[0].text.p, "weigh it");
        ok &= c.blocks[0].sig.p && !strcmp(c.blocks[0].sig.p, "SIGabc");
        /* And the replay is a thinking block carrying its signature, NOT the
         * empty text block the API rejects. */
        cJSON *rb = block_replay_json(&c.blocks[0]);
        char *js = rb ? cJSON_PrintUnformatted(rb) : NULL;
        ok &= js && !strcmp(js, "{\"type\":\"thinking\",\"thinking\":\"weigh it\",\"signature\":\"SIGabc\"}");
        free(js); cJSON_Delete(rb);
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&c.blocks[i].text); sb_free(&c.blocks[i].json); sb_free(&c.blocks[i].sig);
            cJSON_Delete(c.blocks[i].raw); free(c.blocks[i].id); free(c.blocks[i].name);
        }
        free(c.stop_reason); free(c.message_id); free(c.response_model);
        cJSON_Delete(c.raw_usage); sb_free(&c.accum); sb_free(&c.raw); sb_free(&c.errmsg);
    }

    /* Leg 2 — an EMPTY thinking block still replays, signature and all. This
     * is the normal case on every current thinking model: thinking.display
     * defaults to "omitted", so the text is empty by contract while the
     * signature is real, and dropping the block is what breaks the turn. The
     * empty-text rule must NOT be generalised to thinking. */
    {
        cblock b; memset(&b, 0, sizeof b);
        b.type = 'k'; b.active = 1; sb_puts(&b.sig, "SIGempty");
        cJSON *rb = block_replay_json(&b);
        char *js = rb ? cJSON_PrintUnformatted(rb) : NULL;
        ok &= js && !strcmp(js, "{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"SIGempty\"}");
        free(js); cJSON_Delete(rb); sb_free(&b.sig); sb_free(&b.text); sb_free(&b.json);
    }

    /* Leg 3 — an empty TEXT block is omitted (never emitted empty), and a
     * non-empty one is unchanged. */
    {
        cblock b; memset(&b, 0, sizeof b); b.type = 't'; b.active = 1;
        ok &= block_replay_json(&b) == NULL;
        sb_puts(&b.text, "hi");
        cJSON *rb = block_replay_json(&b);
        char *js = rb ? cJSON_PrintUnformatted(rb) : NULL;
        ok &= js && !strcmp(js, "{\"type\":\"text\",\"text\":\"hi\"}");
        free(js); cJSON_Delete(rb); sb_free(&b.text); sb_free(&b.json); sb_free(&b.sig);
    }

    /* Leg 4 — redacted_thinking: the whole payload rides the start object and
     * goes back verbatim. */
    {
        const char *fx =
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"OPAQUE==\"}}\n\n";
        stream_ctx c; memset(&c, 0, sizeof c);
        write_cb((char *)fx, 1, strlen(fx), &c);
        ok &= c.blocks[0].type == 'r';
        cJSON *rb = block_replay_json(&c.blocks[0]);
        char *js = rb ? cJSON_PrintUnformatted(rb) : NULL;
        ok &= js && !strcmp(js, "{\"type\":\"redacted_thinking\",\"data\":\"OPAQUE==\"}");
        free(js); cJSON_Delete(rb);
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&c.blocks[i].text); sb_free(&c.blocks[i].json); sb_free(&c.blocks[i].sig);
            cJSON_Delete(c.blocks[i].raw); free(c.blocks[i].id); free(c.blocks[i].name);
        }
        free(c.stop_reason); free(c.message_id); free(c.response_model);
        cJSON_Delete(c.raw_usage); sb_free(&c.accum); sb_free(&c.raw); sb_free(&c.errmsg);
    }

    /* Leg 5 — the FUTURE block type, both ways. A kind this build has never
     * heard of replays byte-for-byte when nothing was streamed into it, and
     * is dropped when an uninterpretable delta proves our copy partial. This
     * is the leg that stops the next block type being this same bug: without
     * it, "handle thinking" is a fix for one name rather than for the class. */
    {
        const char *whole =
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"future_thing\",\"payload\":\"whole\",\"n\":7}}\n\n";
        stream_ctx c; memset(&c, 0, sizeof c);
        write_cb((char *)whole, 1, strlen(whole), &c);
        ok &= c.blocks[0].type == '?' && !c.blocks[0].lost;
        cJSON *rb = block_replay_json(&c.blocks[0]);
        char *js = rb ? cJSON_PrintUnformatted(rb) : NULL;
        ok &= js && !strcmp(js, "{\"type\":\"future_thing\",\"payload\":\"whole\",\"n\":7}");
        ok &= c.blocks[0].raw == NULL;      /* ownership moved to the caller */
        free(js); cJSON_Delete(rb);
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&c.blocks[i].text); sb_free(&c.blocks[i].json); sb_free(&c.blocks[i].sig);
            cJSON_Delete(c.blocks[i].raw); free(c.blocks[i].id); free(c.blocks[i].name);
        }
        free(c.stop_reason); free(c.message_id); free(c.response_model);
        cJSON_Delete(c.raw_usage); sb_free(&c.accum); sb_free(&c.raw); sb_free(&c.errmsg);

        const char *partial =
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"future_thing\",\"payload\":\"\"}}\n\n"
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"future_delta\",\"payload\":\"more\"}}\n\n";
        stream_ctx d; memset(&d, 0, sizeof d);
        write_cb((char *)partial, 1, strlen(partial), &d);
        ok &= d.blocks[0].type == '?' && d.blocks[0].lost;
        ok &= block_replay_json(&d.blocks[0]) == NULL;   /* dropped, loudly */
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&d.blocks[i].text); sb_free(&d.blocks[i].json); sb_free(&d.blocks[i].sig);
            cJSON_Delete(d.blocks[i].raw); free(d.blocks[i].id); free(d.blocks[i].name);
        }
        free(d.stop_reason); free(d.message_id); free(d.response_model);
        cJSON_Delete(d.raw_usage); sb_free(&d.accum); sb_free(&d.raw); sb_free(&d.errmsg);
    }

    /* Leg 5b — 🔴 THE COUNTER-PASS MUST-FIX. A valid but UNRECOGNISED block
     * type that streams a delta whose NAME we happen to know. `server_tool_use`
     * is the live example: a real Messages API block kind this build does not
     * model, which streams `input_json_delta` exactly like `tool_use` does.
     *
     * The rule has to be "can this build APPLY the delta to THIS block", not
     * "is the delta name in our table". A known name says nothing about a
     * block kind whose semantics we do not know — the payload lands in a
     * field the '?' replay never reads, so the block would go back as its
     * start object with an EMPTY input: a partial block presented as whole,
     * which is the one thing the '?' arm exists to prevent. */
    {
        const char *fx =
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"server_tool_use\",\"id\":\"srvtoolu_1\",\"name\":\"web_search\",\"input\":{}}}\n\n"
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"x\\\"}\"}}\n\n";
        stream_ctx c; memset(&c, 0, sizeof c);
        write_cb((char *)fx, 1, strlen(fx), &c);
        ok &= c.blocks[0].type == '?';
        ok &= c.blocks[0].lost;                          /* the delta was not applicable */
        ok &= block_replay_json(&c.blocks[0]) == NULL;   /* so it is dropped, loudly */
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&c.blocks[i].text); sb_free(&c.blocks[i].json); sb_free(&c.blocks[i].sig);
            cJSON_Delete(c.blocks[i].raw); free(c.blocks[i].id); free(c.blocks[i].name);
        }
        free(c.stop_reason); free(c.message_id); free(c.response_model);
        cJSON_Delete(c.raw_usage); sb_free(&c.accum); sb_free(&c.raw); sb_free(&c.errmsg);
    }

    /* Leg 6 — a block carrying NO usable `type`. It can never be replayed
     * validly whatever we do, so it is marked lost at the start rather than
     * sent as a typeless object for the provider to reject. */
    {
        const char *fx =
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"payload\":\"no type field\"}}\n\n";
        stream_ctx c; memset(&c, 0, sizeof c);
        write_cb((char *)fx, 1, strlen(fx), &c);
        ok &= c.blocks[0].type == '?' && c.blocks[0].lost;
        ok &= block_replay_json(&c.blocks[0]) == NULL;
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&c.blocks[i].text); sb_free(&c.blocks[i].json); sb_free(&c.blocks[i].sig);
            cJSON_Delete(c.blocks[i].raw); free(c.blocks[i].id); free(c.blocks[i].name);
        }
        free(c.stop_reason); free(c.message_id); free(c.response_model);
        cJSON_Delete(c.raw_usage); sb_free(&c.accum); sb_free(&c.raw); sb_free(&c.errmsg);
    }

    /* Leg 7 — the streamed-thinking line is CLOSED at content_block_stop, so a
     * summary cannot run into the tool marker that follows it on the same row.
     * Display-only, but a run-on line is how the #301/#302 rendering bugs
     * looked, and this is the same shape. */
    {
        const char *fx =
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n"
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"mulling\"}}\n\n";
        stream_ctx c; memset(&c, 0, sizeof c);
        write_cb((char *)fx, 1, strlen(fx), &c);
        ok &= c.k_open == 1;                      /* the line is open mid-stream */
        const char *stop = "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n";
        write_cb((char *)stop, 1, strlen(stop), &c);
        ok &= c.k_open == 0;                      /* and closed when it ends */
        for (int i = 0; i < MAX_BLOCKS; i++) {
            sb_free(&c.blocks[i].text); sb_free(&c.blocks[i].json); sb_free(&c.blocks[i].sig);
            cJSON_Delete(c.blocks[i].raw); free(c.blocks[i].id); free(c.blocks[i].name);
        }
        free(c.stop_reason); free(c.message_id); free(c.response_model);
        cJSON_Delete(c.raw_usage); sb_free(&c.accum); sb_free(&c.raw); sb_free(&c.errmsg);
    }

    if (!ok) fprintf(stderr, "gcode self-test: content-block case FAILED\n");
    return ok;
}


/* ---- #747: prompt-cache breakpoint placement -------------------------- */
static int cache_self_test(void) {
    int ok = 1;

    /* The system prompt must go out as a cacheable BLOCK ARRAY. A bare JSON
     * string cannot carry cache_control, which is why the shape had to
     * change at all — the defect was not a missing key, it was a container
     * that could not hold one. */
    {
        cJSON *a = cache_system_blocks("SYS");
        char *js = a ? cJSON_PrintUnformatted(a) : NULL;
        ok &= js && !strcmp(js,
            "[{\"type\":\"text\",\"text\":\"SYS\",\"cache_control\":{\"type\":\"ephemeral\"}}]");
        free(js); cJSON_Delete(a);
        ok &= cache_system_blocks(NULL) == NULL;   /* nothing to mark */
    }

    /* The history breakpoint lands on the LAST content block of the LAST
     * message, and is a no-op on a single-message history: with one user turn
     * there is no settled history yet, and a second breakpoint covering
     * almost the same prefix as the system one buys a second cache WRITE for
     * no read. */
    {
        cJSON *m = cJSON_Parse("[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}]}]");
        ok &= cache_mark_history(m) == NULL;
        char *js = cJSON_PrintUnformatted(m);
        ok &= js && !strstr(js, "cache_control");
        free(js); cJSON_Delete(m);
    }
    {
        cJSON *m = cJSON_Parse(
            "[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}]},"
            " {\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"b\"},"
            "                                     {\"type\":\"text\",\"text\":\"c\"}]}]");
        cJSON *bp = cache_mark_history(m);
        ok &= bp != NULL;
        char *js = cJSON_PrintUnformatted(m);
        /* on "c", the last block of the last message — not "a", not "b" */
        ok &= js && strstr(js, "\"text\":\"c\",\"cache_control\"")
                 && !strstr(js, "\"text\":\"a\",\"cache_control\"")
                 && !strstr(js, "\"text\":\"b\",\"cache_control\"");
        free(js);
        /* And it must come straight back off. `messages` is the live history
         * that gets PERSISTED (#348: anything left on a message object is both
         * sent and logged), so a marker left behind would accumulate one stale
         * breakpoint per round until the request blew the 4-breakpoint ceiling
         * — a bug that would only show up several rounds into a long session,
         * which is exactly where it would cost the most. */
        cache_unmark(bp);
        js = cJSON_PrintUnformatted(m);
        ok &= js && !strstr(js, "cache_control");
        free(js); cJSON_Delete(m);
    }

    /* Marking twice never doubles up (a second call finds the key already
     * there and declines), so a retry path cannot silently spend a
     * breakpoint slot. */
    {
        cJSON *m = cJSON_Parse(
            "[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}]},"
            " {\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"b\"}]}]");
        cJSON *bp = cache_mark_history(m);
        ok &= bp != NULL && cache_mark_history(m) == NULL;
        cache_unmark(bp);
        char *js = cJSON_PrintUnformatted(m);
        ok &= js && !strstr(js, "cache_control");
        free(js); cJSON_Delete(m);
    }

    /* A message whose content is a bare string (the API accepts that shape)
     * has no block to mark; declining is correct and must not crash. */
    {
        cJSON *m = cJSON_Parse("[{\"role\":\"user\",\"content\":\"a\"},{\"role\":\"user\",\"content\":\"b\"}]");
        ok &= cache_mark_history(m) == NULL;
        cJSON_Delete(m);
    }

    if (!ok) fprintf(stderr, "gcode self-test: prompt-cache case FAILED\n");
    return ok;
}

static int self_test(void) {
    /* #313: the dated Sonnet 5 intro rate ($2/$10 through 2026-08-31,
     * $3/$15 sticker after) — fixed dates so the check outlives the
     * rollover. 1M in + 1M out makes the expected sums exact doubles. */
    usage pu = { 1000000, 1000000, 0, 0 };
    int ok = price_usage_at("claude-sonnet-5", &pu, "2026-08-31") == 12.0 &&
             price_usage_at("claude-sonnet-5", &pu, "2026-09-01") == 18.0 &&
             price_usage_at("claude-opus-5", &pu, "2026-09-01") == 30.0 &&
             price_usage_at("some-unknown-model", &pu, "2026-08-02") == -1.0;
    const char *fixture =
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_fixture\",\"model\":\"fixture-model\",\"usage\":{\"input_tokens\":12,\"output_tokens\":1,\"cache_creation_input_tokens\":3,\"cache_read_input_tokens\":4,\"future_counter\":9}}}\n\n"
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n"
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"fixture\"}}\n\n"
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n";
    stream_ctx ctx; memset(&ctx, 0, sizeof ctx); write_cb((char *)fixture, 1, strlen(fixture), &ctx);
    ok &= ctx.round_usage.input_tokens == 12 && ctx.round_usage.output_tokens == 7 &&
        ctx.round_usage.cache_creation_input_tokens == 3 && ctx.round_usage.cache_read_input_tokens == 4 &&
        json_count(ctx.raw_usage, "future_counter") == 9;
    /* #348: the fixture's returned model must reach ctx, and — with the
     * self-test cfg.model deliberately a DIFFERENT string — the turn line
     * labels the requested alias as secondary. Equal / unset / empty
     * response models print one well-formed name, never "(null)". */
    ok &= ctx.response_model && !strcmp(ctx.response_model, "fixture-model");
    char ml[128];
    format_model_line(ml, sizeof ml, ctx.response_model, "requested-alias");
    ok &= !strcmp(ml, "fixture-model (requested requested-alias)");
    format_model_line(ml, sizeof ml, "same-model", "same-model");
    ok &= !strcmp(ml, "same-model");
    format_model_line(ml, sizeof ml, NULL, "requested-alias");
    ok &= !strcmp(ml, "requested-alias");
    format_model_line(ml, sizeof ml, "", "requested-alias");
    ok &= !strcmp(ml, "requested-alias");
    /* #348: per-model buckets — a mixed turn prices each round with its own
     * model and MARKS the unpriced rounds; all-unknown keeps omitting the
     * line. claude-opus-5 is an undated row, so the sums are date-stable. */
    {
        mlist tl = {0}; char cl[256];
        mlist_add(&tl, "claude-opus-5", &pu);
        ok &= format_cost_line(cl, sizeof cl, &tl) == 1 && !strcmp(cl, "$30.000000");
        mlist_add(&tl, "mystery-model", &pu);
        mlist_add(&tl, "mystery-model", &pu);
        ok &= format_cost_line(cl, sizeof cl, &tl) == 1 &&
              !strcmp(cl, "$30.000000  (2 rounds unpriced: mystery-model)");
        mlist_free(&tl);
        mlist unk = {0}; mlist_add(&unk, "mystery-model", &pu);
        ok &= format_cost_line(cl, sizeof cl, &unk) == 0;
        mlist_free(&unk);
    }
    /* #386/#387: the UTF-8 validator/scrubber shared by the tool-result
     * seam and the pre-POST guard. Rejections per RFC 3629. */
    {
        ok &= utf8_invalid_at("plain ascii", 11) == -1;
        ok &= utf8_invalid_at("caf\xC3\xA9", 5) == -1;           /* 2-byte */
        ok &= utf8_invalid_at("\xE2\x82\xAC", 3) == -1;          /* 3-byte */
        ok &= utf8_invalid_at("\xF0\x9F\x98\x80", 4) == -1;      /* 4-byte */
        ok &= utf8_invalid_at("ok\x80", 3) == 2;                 /* lone continuation */
        ok &= utf8_invalid_at("\xC0\xAF", 2) == 0;               /* overlong 2-byte */
        ok &= utf8_invalid_at("\xE0\x80\x80", 3) == 0;           /* overlong 3-byte */
        ok &= utf8_invalid_at("\xED\xA0\x80", 3) == 0;           /* surrogate */
        ok &= utf8_invalid_at("\xF4\x90\x80\x80", 4) == 0;       /* > U+10FFFF */
        ok &= utf8_invalid_at("\xE2\x82", 2) == 0;               /* truncated tail */
        size_t rep = 0;
        char *sc = utf8_scrub("title: \x80\xC0!", 10, &rep);
        ok &= rep == 2 && !strcmp(sc, "title: \xEF\xBF\xBD\xEF\xBF\xBD!"); free(sc);
        sc = utf8_scrub("caf\xC3\xA9 \xE2\x82", 8, &rep);        /* valid kept, truncated marked */
        ok &= rep == 2 && !strcmp(sc, "caf\xC3\xA9 \xEF\xBF\xBD\xEF\xBF\xBD"); free(sc);
        sc = utf8_scrub("", 0, &rep);
        ok &= rep == 0 && !strcmp(sc, ""); free(sc);
    }
    /* #463: the validate-and-repair pass — both halves of the structural
     * invariant, the server-directed pass and its no-mutation gate, and
     * idempotence on every fixture. */
    ok &= repair_self_test();
    ok &= vision_self_test();   /* #670: base64, image sniff, image strip */
    /* #467: window table, rejection matcher, ceiling arithmetic, and the
     * fold's pair-safety/idempotence/no-nesting invariants. */
    ok &= compact_self_test();
    ok &= blocks_self_test();   /* #738: content-block parse + replay mapping */
    ok &= cache_self_test();    /* #747: prompt-cache breakpoint placement */
    char tmp[] = "/tmp/gcode-step2-test-XXXXXX"; if (!mkdtemp(tmp)) return 1; setenv("GCODE_STATE_DIR", tmp, 1);
    config cfg = { "https://example.invalid", NULL, NULL, "requested-alias", "fixture-system", 123, 4, 0, 0, NULL, NULL };
    session s; cJSON *messages = cJSON_CreateArray();
    if (session_create(&s, &cfg)) return 1;
    struct stat logst; ok &= !stat(s.path, &logst) && (logst.st_mode & 0777) == 0600;
    ok &= append_user_text(&s, messages, "hello") == 0;
    /* #348: write the round + assistant records through the REAL writers,
     * fed by the parsed fixture ctx — the round-trip below then proves the
     * persisted assistant message is self-contained. */
    s.round_index++;
    ok &= persist_api_round(&s, &ctx, cfg.model) == 0;
    cJSON *assistant = cJSON_CreateObject(), *content = cJSON_CreateArray(), *text = cJSON_CreateObject(); cJSON_AddStringToObject(assistant, "role", "assistant");
    cJSON_AddStringToObject(text, "type", "text"); cJSON_AddStringToObject(text, "text", "fixture"); cJSON_AddItemToArray(content, text); cJSON_AddItemToObject(assistant, "content", content); cJSON_AddItemToArray(messages, assistant);
    ok &= persist_assistant_message(&s, assistant, &ctx, cfg.model) == 0; char *path = strdup(s.path); close(s.fd); s.fd = -1; cJSON_Delete(messages);
    int partial = open(path, O_WRONLY | O_APPEND); if (partial >= 0) { ok &= write(partial, "{crash", 6) == 6; close(partial); } else ok = 0;
    cJSON *loaded = cJSON_CreateArray(); session resumed; ok &= session_resume(&resumed, &cfg, loaded, path) == 0;
    ok &= cJSON_GetArraySize(loaded) == 2 && resumed.total.input_tokens == 12 && resumed.total.output_tokens == 7 && resumed.seq == 5 && resumed.turn_index == 1;
    /* #348: resume rebuilt the per-model buckets from the api_round records */
    ok &= resumed.models.n == 1 && !strcmp(resumed.models.v[0].model, "fixture-model") &&
          resumed.models.v[0].u.input_tokens == 12 && resumed.models.v[0].rounds == 1;
    FILE *f = fopen(path, "r"); const char *want[] = {"session_meta", "turn_start", "message", "api_round", "message"}; char *line = NULL; size_t cap = 0;
    char exp_tid[80]; snprintf(exp_tid, sizeof exp_tid, "%s-1", s.id);
    for (int i = 0; i < 5; i++) {
        if (!f || getline(&line, &cap, f) < 0) { ok = 0; break; }
        cJSON *r = cJSON_Parse(line);
        ok &= r && !strcmp(jstr(r, "type"), want[i]) && json_count(r, "seq") == i + 1;
        if (r && i == 3) {   /* api_round: linked by turn identity, raw_usage round-trips */
            ok &= !strcmp(jstr(r, "turn_id"), exp_tid) && json_count(r, "round") == 1;
            ok &= !strcmp(jstr(r, "response_model"), "fixture-model");
            ok &= json_count(cJSON_GetObjectItem(r, "raw_usage"), "future_counter") == 9;
        }
        if (r && i == 4) {   /* assistant message: self-contained, no adjacency join */
            ok &= !strcmp(jstr(r, "model"), "fixture-model") && !strcmp(jstr(r, "request_model"), "requested-alias");
            ok &= !strcmp(jstr(r, "provider_message_id"), "msg_fixture") && !strcmp(jstr(r, "stop_reason"), "end_turn");
            ok &= !strcmp(jstr(r, "turn_id"), exp_tid) && json_count(r, "round") == 1;
            ok &= json_count(cJSON_GetObjectItem(r, "usage"), "input_tokens") == 12;
            ok &= json_count(cJSON_GetObjectItem(r, "raw_usage"), "future_counter") == 9;
        }
        cJSON_Delete(r);
    }
    if (f) fclose(f); free(line); close(resumed.fd); free(resumed.path); free(resumed.last_stop); free(resumed.response_model); mlist_free(&resumed.models); cJSON_Delete(loaded); free(path);
    for (int i = 0; i < MAX_BLOCKS; i++) { sb_free(&ctx.blocks[i].text); sb_free(&ctx.blocks[i].json);
        sb_free(&ctx.blocks[i].sig); cJSON_Delete(ctx.blocks[i].raw);
        free(ctx.blocks[i].id); free(ctx.blocks[i].name); }
    free(ctx.stop_reason); free(ctx.message_id); free(ctx.response_model); cJSON_Delete(ctx.raw_usage); sb_free(&ctx.accum); sb_free(&ctx.raw); sb_free(&ctx.errmsg);
    fprintf(stderr, "gcode self-test: %s\n", ok ? "PASS" : "FAIL"); return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    config cfg;
    cfg.base_url      = getenv_or("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    cfg.api_key       = getenv("ANTHROPIC_API_KEY");
    cfg.auth_token    = getenv("ANTHROPIC_AUTH_TOKEN");
    cfg.model         = getenv_or("ANTHROPIC_MODEL", "claude-opus-4-8");
    /* #530: the literal carries NO platform content — gcode is dual-target
     * and env-pointable at non-Anthropic providers, so a binary running
     * anywhere else must not inherit a gucOS steer (jku's #551 ruling).
     * Platform orientation (the gucOS identity, `cc`, the SDL rule #551
     * inlined here temporarily) now ships as the PLATFORM's baked
     * /usr/share/gcode/GCODE.md and loads via context_load below. */
    cfg.system_prompt = "You are `gcode`, a terminal coding assistant. Use the tools to "
                        "explore, create, and edit files and run shell commands. Be "
                        "concise. Prefer small, verifiable steps.";
    cfg.system_sent   = NULL;
    cfg.context_files = NULL;
    /* #462: raised from 4096 (see the MAX_TOKENS_* block for the measured
     * provider caps). --max-tokens wins over ANTHROPIC_MAX_TOKENS, which
     * wins over the default; the result is clamped below, once colour is
     * resolved, so the note prints in the right style. */
    cfg.max_tokens = atol(getenv_or("ANTHROPIC_MAX_TOKENS", "0"));
    if (cfg.max_tokens <= 0) cfg.max_tokens = MAX_TOKENS_DEFAULT;
    cfg.max_turns  = 0;    /* #353: 0 = unlimited; --max-turns N is the opt-in cap */
    /* #467: 0 = derive the window from the model; a positive override wins.
     * Negative/garbage atol results collapse to auto rather than to a dead
     * guard. */
    cfg.context_tokens = atol(getenv_or("GCODE_CONTEXT_TOKENS", "0"));
    if (cfg.context_tokens < 0) cfg.context_tokens = 0;
    cfg.verbose = 0;
    cfg.color = -1;   /* #303: -1 auto (isatty), 0 forced off, 1 forced on */

    const char *prompt = NULL, *resume = NULL; int persist = 1, do_continue = 0, do_self_test = 0, no_context = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-p") && i + 1 < argc)                 prompt = argv[++i];
        else if (!strcmp(argv[i], "--model") && i + 1 < argc)       cfg.model = argv[++i];
        else if (!strcmp(argv[i], "--system-prompt") && i + 1 < argc) cfg.system_prompt = argv[++i];
        else if (!strcmp(argv[i], "--max-turns") && i + 1 < argc)   cfg.max_turns = atol(argv[++i]);
        else if (!strcmp(argv[i], "--max-tokens") && i + 1 < argc)  cfg.max_tokens = atol(argv[++i]);
        else if (!strcmp(argv[i], "--context-tokens") && i + 1 < argc) {
            cfg.context_tokens = atol(argv[++i]);                    /* #467 */
            if (cfg.context_tokens < 0) cfg.context_tokens = 0;
        }
        else if (!strcmp(argv[i], "--verbose"))                     cfg.verbose = 1;
        else if (!strcmp(argv[i], "--no-color"))                    cfg.color = 0;
        else if (!strcmp(argv[i], "--color"))                       cfg.color = 1;
        else if (!strcmp(argv[i], "--no-persist"))                  persist = 0;
        else if (!strcmp(argv[i], "--no-context"))                  no_context = 1;   /* #530 */
        else if (!strcmp(argv[i], "--resume") && i + 1 < argc)      resume = argv[++i];
        else if (!strcmp(argv[i], "-c") || !strcmp(argv[i], "--continue")) do_continue = 1;
        else if (!strcmp(argv[i], "--self-test"))                   do_self_test = 1;
        else if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            printf("usage: gcode [-p PROMPT] [--model M] [--system-prompt S]\n"
                   "            [--max-turns N] [--max-tokens N] [--context-tokens N]\n"
                   "            [--resume ID|PATH] [-c|--continue]\n"
                   "            [--no-persist] [--no-context] [--verbose] [--no-color] [--color]\n"
                   "env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL,\n"
                   "     ANTHROPIC_MAX_TOKENS, GCODE_CONTEXT_TOKENS, GCODE_WARN_PCT, GCODE_COMPACT_PCT,\n"
                   "     GCODE_STATE_DIR, XDG_STATE_HOME, NO_COLOR, GCODE_VISION\n"
                   "\n"
                   "GCODE_VISION=1/0 forces the read_image tool on/off (default: derived from the\n"
                   "model — a model without image input never gets the tool, loudly).\n"
                   "\n"
                   "--max-tokens N (env ANTHROPIC_MAX_TOKENS) is the per-response OUTPUT cap.\n"
                   "Default %d; values are clamped to [%d, %d] with a printed note.\n"
                   "A response cut at the cap never executes the truncated tool call: gcode\n"
                   "says so in the tool result and lets the model retry smaller, up to %d\n"
                   "consecutive times.\n"
                   "\n"
                   "--context-tokens N (env GCODE_CONTEXT_TOKENS) overrides the model's context\n"
                   "window (default: derived from the model id; %d for an unknown model). Long\n"
                   "sessions warn at %d%% of the usable budget and COMPACT at %d%% (the oldest\n"
                   "rounds fold into a summary and the session keeps going); /compact folds on\n"
                   "demand, /clear still starts over.\n",
                   MAX_TOKENS_DEFAULT, MAX_TOKENS_FLOOR, MAX_TOKENS_CEILING,
                   TRUNC_MAX_CONTINUATIONS, CTX_WINDOW_DEFAULT,
                   CTX_WARN_PCT_DEFAULT, CTX_COMPACT_PCT_DEFAULT);
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
    /* #462: clamp, never pass through — an out-of-range cap is a 400 on
     * EVERY request, which is strictly worse than the truncation this
     * ticket fixes. Loud, so a clamped value is never a silent surprise. */
    if (cfg.max_tokens < MAX_TOKENS_FLOOR || cfg.max_tokens > MAX_TOKENS_CEILING) {
        long clamped = cfg.max_tokens < MAX_TOKENS_FLOOR ? MAX_TOKENS_FLOOR : MAX_TOKENS_CEILING;
        fprintf(stderr, "%sgcode: max-tokens %ld is outside [%d, %d] — clamped to %ld%s\n",
                CDIM, cfg.max_tokens, MAX_TOKENS_FLOOR, MAX_TOKENS_CEILING, clamped, CRST);
        cfg.max_tokens = clamped;
    }
    signal(SIGINT, on_interrupt);
#ifndef __MTOTS__
    intr_pipe_init();   /* #511: arm the interrupt self-pipe (native only) */
#endif
    if (do_self_test) return self_test();
    vision_resolve(cfg.model);   /* #670: before build_tools — the gate decides the tools array */
    if (!no_context) context_load(&cfg);   /* #530: after self_test — the self-test stays hermetic */
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
                session_end(&sess, "clear"); free(sess.path); free(sess.last_stop); free(sess.response_model); mlist_free(&sess.models);
                cJSON_Delete(messages); messages = cJSON_CreateArray();
                if (persist && session_create(&sess, &cfg)) { cJSON_Delete(messages); cJSON_Delete(tools); curl_global_cleanup(); return 1; }
                if (!persist) { memset(&sess, 0, sizeof sess); sess.fd = -1; make_session_id(sess.id); }
                fprintf(stderr, "%s[history cleared]%s\n", CDIM, CRST); continue;
            }
            if (!strcmp(line, "/compact")) {
                /* #467: the graduated option beside /clear's nuclear one —
                 * the largest pair-safe fold, announced by compact_apply. */
                if (!compact_apply(&cfg, &sess, messages, "manual"))
                    fprintf(stderr, "%s[nothing to compact — the history is too short to fold]%s\n",
                            CDIM, CRST);
                continue;
            }
            if (append_user_text(&sess, messages, line)) break;
            int turn_rc = agent_loop(&cfg, &sess, messages, tools);
            g_interrupted = 0;   /* consumed: a stale mid-turn ^C must not eat the next EOF */
            if (turn_rc == -3) { session_end(&sess, "error"); break; }   /* permanent (#305 auth, #387 4xx): retrying cannot succeed */
            /* r == -1 (recoverable turn error — transport, 5xx/429, timeout)
               returns to the prompt like r == 0: the error line already
               printed red, and the failed user message STAYS in history —
               in-memory and in the persisted JSONL alike, so a resume
               replays exactly what the live session carries (#305). */
        }
    }
    if (sess.fd >= 0) close(sess.fd); free(sess.path); free(sess.last_stop); free(sess.response_model); mlist_free(&sess.models);
    cJSON_Delete(messages); cJSON_Delete(tools);
    free(cfg.system_sent); cJSON_Delete(cfg.context_files);   /* #530 */
    curl_global_cleanup();
    return 0;
}
