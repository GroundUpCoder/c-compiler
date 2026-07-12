/*
 * code — a minimal, line-oriented agentic coding assistant (todos/0174).
 *
 * Speaks the Anthropic Messages API (streaming SSE + tool use) over libcurl.
 * No fullscreen ANSI — just SGR colors — so it behaves the same on VT1 and
 * over a pty in /bin/term. Every tool result is hard-capped so a large file
 * or a chatty command can't blow up the context.
 *
 * Dual-target by construction: this same source builds native with
 * `clang code.c cJSON.c -lcurl` (the reference oracle) and, once the 0173
 * veneer lands, for gucOS against it unchanged. The ONE platform seam is
 * run_command() (process spawn for the bash tool) — see the PLATFORM block.
 *
 * Config (env, overridable by flags):
 *   ANTHROPIC_BASE_URL   default https://api.anthropic.com
 *   ANTHROPIC_API_KEY    -> x-api-key
 *   ANTHROPIC_AUTH_TOKEN -> Authorization: Bearer (takes precedence)
 *   ANTHROPIC_MODEL      default claude-opus-4-8
 * Flags: -p PROMPT (one-shot), --model, --system-prompt, --max-turns,
 *   --max-tokens, --verbose, --no-color.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
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
        if (!b->p) { fprintf(stderr, "code: out of memory\n"); exit(1); }
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

/* ---- ANSI (SGR only; guarded by cfg->color) --------------------------- */
static int  g_color = 1;
static const char *C(const char *code) { return g_color ? code : ""; }
#define CDIM  C("\033[2m")
#define CCYAN C("\033[36m")
#define CGRN  C("\033[32m")
#define CRED  C("\033[31m")
#define CRST  C("\033[0m")

/* ===================================================================== */
/*  PLATFORM SEAM: run a shell command, merge stdout+stderr, cap+timeout  */
/*  Native impl below (fork/exec/poll). gucOS swaps this for __spawn.      */
/* ===================================================================== */
#include <unistd.h>
#include <sys/wait.h>
#include <poll.h>
#include <time.h>
#include <signal.h>

/* Returns malloc'd captured output (truncation-marked if over cap).
 * *exit_code set to the child's exit status (or -1 killed by timeout). */
static char *run_command(const char *cmd, int *exit_code) {
    int pfd[2];
    if (pipe(pfd) != 0) { *exit_code = -1; return strdup("code: pipe() failed\n"); }
    pid_t pid = fork();
    if (pid < 0) { *exit_code = -1; return strdup("code: fork() failed\n"); }
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
/* ===================== end platform seam ============================== */

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
    char *stop_reason;
    int  api_error; sb errmsg;
} stream_ctx;

static void dispatch_json(stream_ctx *ctx, const char *json) {
    cJSON *e = cJSON_Parse(json);
    if (!e) return;
    cJSON *jt = cJSON_GetObjectItem(e, "type");
    const char *type = cJSON_IsString(jt) ? jt->valuestring : "";

    if (!strcmp(type, "content_block_start")) {
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
                fprintf(stderr, "%s· %s%s\n", CCYAN, b->name ? b->name : "?", CRST);
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
                    fputs(tx->valuestring, stdout); fflush(stdout);
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
/* Returns 0 to stop, 1 to continue (tool_use). On error returns -1. */
static int do_turn(config *cfg, cJSON *messages, cJSON *tools) {
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
    if (!h) { free(payload); fprintf(stderr, "code: curl init failed\n"); return -1; }
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
    if (cfg->verbose) { fprintf(stderr, "%s> POST %s%s\n%s\n", CDIM, url.p, CRST, payload); }

    CURLcode rc = curl_easy_perform(h);
    long code = 0; curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(hdr); curl_easy_cleanup(h);
    sb_free(&url); sb_free(&auth); free(payload);

    int ret = 0;
    if (rc != CURLE_OK) {
        fprintf(stderr, "\n%scode: transport error: %s%s\n", CRED, curl_easy_strerror(rc), CRST);
        ret = -1; goto done;
    }
    if (code != 200) {
        fprintf(stderr, "\n%scode: HTTP %ld%s\n%.*s\n", CRED, code, CRST,
                (int)ctx.raw.len, ctx.raw.p ? ctx.raw.p : "");
        ret = -1; goto done;
    }
    if (ctx.api_error) {
        fprintf(stderr, "\n%scode: API error: %s%s\n", CRED, ctx.errmsg.p ? ctx.errmsg.p : "?", CRST);
        ret = -1; goto done;
    }
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
            /* execute and collect a tool_result */
            char *result = execute_tool(b->name ? b->name : "", input);
            cJSON *tr = cJSON_CreateObject();
            cJSON_AddStringToObject(tr, "type", "tool_result");
            cJSON_AddStringToObject(tr, "tool_use_id", b->id ? b->id : "");
            cJSON_AddStringToObject(tr, "content", result ? result : "");
            cJSON_AddItemToArray(tool_results, tr);
            fprintf(stderr, "%s  → %.200s%s\n", CDIM, result ? result : "", CRST);
            free(result);
        }
    }
    cJSON *amsg = cJSON_CreateObject();
    cJSON_AddStringToObject(amsg, "role", "assistant");
    cJSON_AddItemToObject(amsg, "content", acontent);
    cJSON_AddItemToArray(messages, amsg);

    if (ctx.stop_reason && !strcmp(ctx.stop_reason, "tool_use")) {
        cJSON *umsg = cJSON_CreateObject();
        cJSON_AddStringToObject(umsg, "role", "user");
        cJSON_AddItemToObject(umsg, "content", tool_results);
        cJSON_AddItemToArray(messages, umsg);
        ret = 1;
    } else {
        cJSON_Delete(tool_results);
        if (ctx.stop_reason && !strcmp(ctx.stop_reason, "refusal"))
            fprintf(stderr, "%scode: model refused the request%s\n", CRED, CRST);
        ret = 0;
    }

done:
    for (int i = 0; i < MAX_BLOCKS; i++) {
        free(ctx.blocks[i].id); free(ctx.blocks[i].name);
        sb_free(&ctx.blocks[i].text); sb_free(&ctx.blocks[i].json);
    }
    free(ctx.stop_reason); sb_free(&ctx.accum); sb_free(&ctx.raw); sb_free(&ctx.errmsg);
    return ret;
}

/* run the agent loop for one user message already appended to `messages` */
static void agent_loop(config *cfg, cJSON *messages, cJSON *tools) {
    for (long turn = 0; turn < cfg->max_turns; turn++) {
        int r = do_turn(cfg, messages, tools);
        if (r <= 0) return;                 /* stop or error */
    }
    fprintf(stderr, "%scode: hit max-turns (%ld)%s\n", CDIM, cfg->max_turns, CRST);
}

static void append_user_text(cJSON *messages, const char *text) {
    cJSON *m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "role", "user");
    cJSON_AddStringToObject(m, "content", text);
    cJSON_AddItemToArray(messages, m);
}

static const char *getenv_or(const char *k, const char *dflt) {
    const char *v = getenv(k);
    return (v && *v) ? v : dflt;
}

int main(int argc, char **argv) {
    config cfg;
    cfg.base_url      = getenv_or("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    cfg.api_key       = getenv("ANTHROPIC_API_KEY");
    cfg.auth_token    = getenv("ANTHROPIC_AUTH_TOKEN");
    cfg.model         = getenv_or("ANTHROPIC_MODEL", "claude-opus-4-8");
    cfg.system_prompt = "You are `code`, a terminal coding assistant running inside gucOS, "
                        "a small POSIX-like OS. Use the tools to explore, create, and edit "
                        "files and run shell commands. Be concise. Prefer small, verifiable "
                        "steps. The C compiler is `cc`.";
    cfg.max_tokens = 4096;
    cfg.max_turns  = 24;
    cfg.verbose = 0;
    cfg.color = 1;

    const char *prompt = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-p") && i + 1 < argc)                 prompt = argv[++i];
        else if (!strcmp(argv[i], "--model") && i + 1 < argc)       cfg.model = argv[++i];
        else if (!strcmp(argv[i], "--system-prompt") && i + 1 < argc) cfg.system_prompt = argv[++i];
        else if (!strcmp(argv[i], "--max-turns") && i + 1 < argc)   cfg.max_turns = atol(argv[++i]);
        else if (!strcmp(argv[i], "--max-tokens") && i + 1 < argc)  cfg.max_tokens = atol(argv[++i]);
        else if (!strcmp(argv[i], "--verbose"))                     cfg.verbose = 1;
        else if (!strcmp(argv[i], "--no-color"))                    cfg.color = 0;
        else if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            printf("usage: code [-p PROMPT] [--model M] [--system-prompt S]\n"
                   "            [--max-turns N] [--max-tokens N] [--verbose] [--no-color]\n"
                   "env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL\n");
            return 0;
        }
    }
    g_color = cfg.color;
    if (!cfg.api_key && !cfg.auth_token)
        fprintf(stderr, "%scode: warning: no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN set%s\n", CDIM, CRST);

    curl_global_init(CURL_GLOBAL_DEFAULT);
    cJSON *messages = cJSON_CreateArray();
    cJSON *tools = build_tools();

    if (prompt) {
        append_user_text(messages, prompt);
        agent_loop(&cfg, messages, tools);
    } else {
        fprintf(stderr, "%scode — type a request, /quit to exit%s\n", CDIM, CRST);
        char line[8192];
        for (;;) {
            fputs("\n> ", stderr); fflush(stderr);
            if (!fgets(line, sizeof line, stdin)) break;
            size_t n = strlen(line);
            while (n && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = 0;
            if (!n) continue;
            if (!strcmp(line, "/quit") || !strcmp(line, "/exit")) break;
            if (!strcmp(line, "/clear")) {
                cJSON_Delete(messages); messages = cJSON_CreateArray();
                fprintf(stderr, "%s[history cleared]%s\n", CDIM, CRST); continue;
            }
            append_user_text(messages, line);
            agent_loop(&cfg, messages, tools);
        }
    }
    cJSON_Delete(messages); cJSON_Delete(tools);
    curl_global_cleanup();
    return 0;
}
