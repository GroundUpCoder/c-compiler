/*
 * This file is part of NetSurf, http://www.netsurf-browser.org/
 *
 * NetSurf is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; version 2 of the License.
 *
 * NetSurf is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

/**
 * \file
 * gucOS http/https fetcher (ticket #182, todos/0437 — Option B of the
 * networking assessment): NetSurf's per-scheme fetcher contract implemented
 * over the kernel HTTP transport (todos/0172, fd-shaped todos/0417 —
 * __http_open / __http_status / read / close), the same primitive under
 * os/curl/libcurl.c and the Control Panel Network applet.  Upstream's
 * fetchers/curl.c stays excluded (curl_multi/socket/SSL-ctx callbacks are
 * meaningless over fetch — evaluated and rejected, see the ticket).
 *
 * Shape: fetchers/data.c is the ring/poll/locked skeleton, fetchers/curl.c
 * the callback sequencing.  The two contracts are near-isomorphic:
 *   ops.start -> __http_open (transfer opens HERE, not at setup, so
 *     fetch.c's max_fetchers queueing keeps meaning; open failure is
 *     recorded and reported from the next poll — start must not return
 *     false, which would re-queue forever);
 *   ops.poll  -> __http_status until not-EAGAIN, one FETCH_HEADER per
 *     blob line, then read() -> FETCH_DATA until EAGAIN;
 *   0 = clean EOF -> FETCH_FINISHED; ETIMEDOUT -> FETCH_TIMEDOUT (the
 *     kernel headers/idle deadlines); other errno -> FETCH_ERROR.
 *   ops.abort flags, the poll reaps (the data.c discipline);
 *   ops.free  -> close(fd) aborts the kernel-side transfer.
 * NO __wait anywhere: NetSurf's own 10 ms poll scheduler paces the fetch,
 * and the http-fd contract is literally "poll, consume until EAGAIN,
 * never park".
 *
 * Redirects (#359): the transport follows them opaquely (platform fetch,
 * both modes) and surfaces WHERE the response came from as the synthetic
 * x-guc-final-url header line prepended to the blob.  When that differs
 * from the request URL this fetcher emits FETCH_REDIRECT(finalUrl) and
 * discards the body it already holds: llcache then records the redirect
 * and refetches the final URL (typically served from the platform HTTP
 * cache), so relative links and cache entries resolve against the REAL
 * URL.  The synthetic line itself is stripped — llcache never sees a
 * header no server sent.  Intermediate hops are permanently unknowable
 * (fetch-stack fact, not a gap).
 *
 * v1 scope (descoped DELIBERATELY, per the ticket — say it, don't absorb):
 *   - urlenc POST: yes.  multipart POST: NO — loud FETCH_ERROR; it is what
 *     todos/0433's file-upload residual waits on.
 *   - cookies: NO.  Browser direct mode forbids them outright (fetch
 *     forbidden-header rules: Cookie banned, Set-Cookie hidden), so the
 *     urldb jar cannot function there regardless of effort.
 *   - HTTP auth: NO FETCH_AUTH — the gucOS frontend does not build
 *     401login.c, so a 401 renders as ordinary content (its body).
 *   - TLS cert chain / FETCH_CERTS: permanently out; the platform owns
 *     TLS (NETWORK.md: the OS does not grow a TLS stack).
 */

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#include <libwapcaplet/libwapcaplet.h>

#include "utils/corestrings.h"
#include "utils/log.h"
#include "utils/messages.h"
#include "utils/nsurl.h"
#include "utils/ring.h"
#include "utils/useragent.h"

#include "content/fetch.h"
#include "content/fetchers.h"

#include "gucos/fetch.h"

/* The kernel HTTP primitive, surfaced by host.js as env imports (declared
   here like any other consumer — os/curl/libcurl.c precedent). */
__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);

#define HDR_BLOB_CAP  (64 * 1024)   /* matches the kernel's flatten cap */
#define READ_CHUNK    49152         /* under the kernel page payload cap */
#define FINAL_URL_KEY "x-guc-final-url:"

/* Big buffers are static — the wasm stack is the low 64KB.  Safe to share
   across fetches: the poll consumes each synchronously (llcache copies
   callback payloads before returning, the curl.c transient-buffer
   precedent). */
static char gf_hdrblob[HDR_BLOB_CAP + 1];
static char gf_rdbuf[READ_CHUNK];

struct fetch_gucos_http_ctx {
	struct fetch *parent_fetch;
	nsurl *url;

	char *req_headers;          /* "Name: Value\n" blob for __http_open */
	char *post;                 /* copied urlenc body, or NULL */
	size_t postlen;
	bool is_post;
	bool multipart;             /* v1 refusal, reported from the poll */
	bool only_2xx;

	int fd;                     /* -1 until opened */
	bool started;               /* ops.start ran (open attempted) */
	int open_errno;             /* != 0: __http_open failed at start */
	bool have_status;
	int http_code;

	bool aborted;
	bool locked;
	bool finished;

	struct fetch_gucos_http_ctx *r_next, *r_prev;
};

static struct fetch_gucos_http_ctx *gf_ring = NULL;

static bool fetch_gucos_http_initialise(lwc_string *scheme)
{
	NSLOG(netsurf, INFO, "gucos http fetcher initialise %s",
	      lwc_string_data(scheme));
	return true;
}

static void fetch_gucos_http_finalise(lwc_string *scheme)
{
	NSLOG(netsurf, INFO, "gucos http fetcher finalise %s",
	      lwc_string_data(scheme));
}

static bool fetch_gucos_http_can_fetch(const nsurl *url)
{
	(void)url;
	return true;
}

/* The data.c locked-callback discipline: any callback may re-enter the
   poll or abort this very fetch — flag around the call, re-check
   c->aborted after EVERY use. */
static void fetch_gucos_http_send(const fetch_msg *msg,
		struct fetch_gucos_http_ctx *c)
{
	c->locked = true;
	fetch_send_callback(msg, c->parent_fetch);
	c->locked = false;
}

static void fetch_gucos_http_error(struct fetch_gucos_http_ctx *c,
		const char *text)
{
	fetch_msg msg;
	msg.type = FETCH_ERROR;
	msg.data.error = text;
	fetch_gucos_http_send(&msg, c);
	c->finished = true;
}

static void *fetch_gucos_http_setup(struct fetch *parent_fetch, nsurl *url,
		bool only_2xx, bool downgrade_tls, const char *post_urlenc,
		const struct fetch_multipart_data *post_multipart,
		const char **headers)
{
	struct fetch_gucos_http_ctx *ctx = calloc(1, sizeof(*ctx));
	size_t hlen = 0, i;
	bool have_ua = false, have_ct = false;
	char *w;

	(void)downgrade_tls;                    /* platform TLS — no tiers */

	if (ctx == NULL)
		return NULL;

	ctx->parent_fetch = parent_fetch;
	ctx->url = nsurl_ref(url);
	ctx->only_2xx = only_2xx;
	ctx->fd = -1;

	if (post_multipart != NULL) {
		/* v1 refusal — reported as FETCH_ERROR from the first poll
		 * (callbacks cannot fire from setup). */
		ctx->multipart = true;
	} else if (post_urlenc != NULL) {
		ctx->post = strdup(post_urlenc);
		if (ctx->post == NULL) {
			nsurl_unref(ctx->url);
			free(ctx);
			return NULL;
		}
		ctx->postlen = strlen(ctx->post);
		ctx->is_post = true;
	}

	/* Join llcache's header lines into the transport's "Name: Value\n"
	 * blob, adding User-Agent (curl.c's CURLOPT_USERAGENT twin) and the
	 * urlenc Content-Type (real curl adds it for POSTFIELDS) when the
	 * caller did not. */
	for (i = 0; headers != NULL && headers[i] != NULL; i++) {
		hlen += strlen(headers[i]) + 1;
		if (strncasecmp(headers[i], "user-agent:", 11) == 0)
			have_ua = true;
		if (strncasecmp(headers[i], "content-type:", 13) == 0)
			have_ct = true;
	}
	if (!have_ua)
		hlen += strlen("User-Agent: ") + strlen(user_agent_string()) + 1;
	if (ctx->is_post && !have_ct)
		hlen += strlen("Content-Type: application/x-www-form-urlencoded") + 1;

	ctx->req_headers = malloc(hlen + 1);
	if (ctx->req_headers == NULL) {
		free(ctx->post);
		nsurl_unref(ctx->url);
		free(ctx);
		return NULL;
	}
	w = ctx->req_headers;
	for (i = 0; headers != NULL && headers[i] != NULL; i++) {
		size_t n = strlen(headers[i]);
		memcpy(w, headers[i], n);
		w += n;
		*w++ = '\n';
	}
	if (!have_ua)
		w += sprintf(w, "User-Agent: %s\n", user_agent_string());
	if (ctx->is_post && !have_ct)
		w += sprintf(w, "Content-Type: application/x-www-form-urlencoded\n");
	*w = 0;

	RING_INSERT(gf_ring, ctx);

	return ctx;
}

static bool fetch_gucos_http_start(void *ctx)
{
	struct fetch_gucos_http_ctx *c = ctx;

	c->started = true;
	if (c->aborted || c->multipart)
		return true;                    /* the poll reaps/reports */

	/* Kernel default deadlines (30s headers / 120s body idle) bound the
	 * transfer; expiry surfaces as ETIMEDOUT -> FETCH_TIMEDOUT. */
	c->fd = __http_open(c->is_post ? "POST" : "GET",
			nsurl_access(c->url), c->req_headers,
			c->post, (int)c->postlen, 0, 0);
	if (c->fd < 0) {
		/* Report from the poll: returning false here would re-queue
		 * the job forever (fetch_dispatch_job's retry loop). */
		c->open_errno = errno ? errno : EIO;
	}
	return true;
}

static void fetch_gucos_http_abort(void *ctx)
{
	struct fetch_gucos_http_ctx *c = ctx;
	/* Flag only; the poll performs the cleanup (data.c discipline —
	 * the ring must not lose entries under the iterating poll). */
	c->aborted = true;
}

static void fetch_gucos_http_free(void *ctx)
{
	struct fetch_gucos_http_ctx *c = ctx;

	if (c->fd >= 0)
		close(c->fd);                   /* aborts the kernel transfer */
	nsurl_unref(c->url);
	free(c->req_headers);
	free(c->post);
	free(c);
}

/* Consume the status leg: parse the flattened blob, honour the #359
   synthetic final-url line, and emit one FETCH_HEADER per real line.
   Returns with c->finished set on any terminal outcome. */
static void fetch_gucos_http_process_status(struct fetch_gucos_http_ctx *c)
{
	fetch_msg msg;
	int status = 0;
	int hl = __http_status(c->fd, &status, gf_hdrblob, HDR_BLOB_CAP);
	char *p, *final_url = NULL, *final_url_nl = NULL;

	if (hl < 0) {
		if (errno == EAGAIN || errno == EINTR)
			return;                 /* not yet — next poll */
		if (errno == ETIMEDOUT) {
			msg.type = FETCH_TIMEDOUT;
			msg.data.error = "timed out waiting for response";
			fetch_gucos_http_send(&msg, c);
			c->finished = true;
			return;
		}
		fetch_gucos_http_error(c, strerror(errno));
		return;
	}
	gf_hdrblob[hl < HDR_BLOB_CAP ? hl : HDR_BLOB_CAP] = 0;
	c->have_status = true;
	c->http_code = status;

	/* Pull the synthetic final-url line out of the blob (prepended by
	 * the kernel, but scan every line — cheap robustness).
	 *
	 * The value is terminated IN PLACE, which costs the blob the
	 * newline separating that line from the next.  Because the kernel
	 * PREPENDS the synthetic line, that newline is the very first one:
	 * leaving it a NUL severs the blob from every real header, and the
	 * emit loop below then walks a one-line string and emits NOTHING
	 * (ticket #368 — the cause of the Windows-1252 mojibake, and, worse,
	 * of llcache never seeing cache-control/expires/etag/last-modified).
	 * So remember where the terminator went and put the newline back the
	 * moment the value has been read. */
	for (p = gf_hdrblob; p != NULL && *p != 0; ) {
		char *nl = strchr(p, '\n');
		if (strncasecmp(p, FINAL_URL_KEY, sizeof(FINAL_URL_KEY) - 1) == 0) {
			final_url = p + sizeof(FINAL_URL_KEY) - 1;
			while (*final_url == ' ' || *final_url == '\t')
				final_url++;
			if (nl != NULL) {
				*nl = 0;        /* value ends at the line */
				final_url_nl = nl;
			}
			p = nl ? nl + 1 : NULL;
			break;                  /* the kernel emits exactly one */
		}
		p = nl ? nl + 1 : NULL;
	}

	/* Redirect (#359): the transport already followed it — when the
	 * response's real URL differs, tell llcache and DROP the body we
	 * hold; the refetch of the final URL resolves everything (links,
	 * cache identity) against the right base.  A no-op difference can
	 * cost one extra round trip, never a loop (the refetch's final URL
	 * equals its request URL).
	 *
	 * The stored http code must be a REDIRECT code: llcache_fetch_redirect
	 * switches on it and errors NSERROR_BAD_REDIRECT on anything else —
	 * but the status we hold is the FINAL response's (the transport
	 * followed opaquely; the intermediate 3xx codes are unknowable).
	 * 303 (See Other) is the honest stand-in: llcache replays the final
	 * URL as a GET, which matches what the platform fetch itself did for
	 * the dominant 301/302/303 chains (a 307/308 POST-preserving chain
	 * would be replayed as GET — the recorded cost of the opaque-follow
	 * ceiling). */
	if (final_url != NULL && *final_url != 0 &&
	    strcmp(final_url, nsurl_access(c->url)) != 0) {
		NSLOG(netsurf, INFO, "FETCH_REDIRECT '%s' (transport-followed)",
		      final_url);
		fetch_set_http_code(c->parent_fetch, 303);
		msg.type = FETCH_REDIRECT;
		msg.data.redirect = final_url;
		fetch_gucos_http_send(&msg, c);   /* consumes final_url here */
		if (final_url_nl != NULL)
			*final_url_nl = '\n';
		c->finished = true;
		return;
	}

	/* The value has been read and compared; put the newline back so the
	 * emit loop below sees the WHOLE blob and not just its first line
	 * (#368).  final_url stops being a terminated string at this point,
	 * so drop it — nothing after here may use it. */
	if (final_url_nl != NULL) {
		*final_url_nl = '\n';
		final_url = NULL;
	}

	fetch_set_http_code(c->parent_fetch, status);

	/* 304 on a GET: llcache revalidation (curl.c parity). */
	if (status == 304 && !c->is_post) {
		msg.type = FETCH_NOTMODIFIED;
		fetch_gucos_http_send(&msg, c);
		c->finished = true;
		return;
	}

	/* only_2xx consumers (curl.c parity). */
	if (c->only_2xx && (status < 200 || status > 299)) {
		fetch_gucos_http_error(c, messages_get("Not2xx"));
		return;
	}

	/* One FETCH_HEADER per remaining blob line — llcache parses plain
	 * "Name: Value" (the data.c shape; no status line needed).  The
	 * synthetic line was consumed above and must never leak. */
	for (p = gf_hdrblob; p != NULL && *p != 0; ) {
		char *nl = strchr(p, '\n');
		size_t ll = nl ? (size_t)(nl - p) : strlen(p);
		if (ll > 0 &&
		    strncasecmp(p, FINAL_URL_KEY, sizeof(FINAL_URL_KEY) - 1) != 0) {
			msg.type = FETCH_HEADER;
			msg.data.header_or_data.buf = (const uint8_t *)p;
			msg.data.header_or_data.len = ll;
			fetch_gucos_http_send(&msg, c);
			if (c->aborted)
				return;
		}
		p = nl ? nl + 1 : NULL;
	}
}

/* Advance one fetch as far as it goes without blocking. */
static void fetch_gucos_http_progress(struct fetch_gucos_http_ctx *c)
{
	fetch_msg msg;

	if (c->multipart) {
		/* todos/0433's residual — loud, not silent (v1 fence). */
		fetch_gucos_http_error(c,
			"multipart POST is not supported yet (todos/0433)");
		return;
	}
	if (!c->started)
		return;                         /* queued; start not called yet */
	if (c->open_errno != 0) {
		fetch_gucos_http_error(c, c->open_errno == ENOSYS
			? "no network transport (fetch disabled)"
			: strerror(c->open_errno));
		return;
	}

	if (!c->have_status) {
		fetch_gucos_http_process_status(c);
		if (c->finished || c->aborted || !c->have_status)
			return;
	}

	/* Body: consume until EAGAIN (next poll), EOF, or error. */
	for (;;) {
		int n = (int)read(c->fd, gf_rdbuf, READ_CHUNK);
		if (n > 0) {
			msg.type = FETCH_DATA;
			msg.data.header_or_data.buf = (const uint8_t *)gf_rdbuf;
			msg.data.header_or_data.len = (size_t)n;
			fetch_gucos_http_send(&msg, c);
			if (c->aborted)
				return;
			continue;
		}
		if (n == 0) {
			msg.type = FETCH_FINISHED;
			fetch_gucos_http_send(&msg, c);
			c->finished = true;
			return;
		}
		if (errno == EAGAIN || errno == EINTR)
			return;                 /* dry — next poll */
		if (errno == ETIMEDOUT) {
			msg.type = FETCH_TIMEDOUT;
			msg.data.error = "timed out reading body";
			fetch_gucos_http_send(&msg, c);
			c->finished = true;
			return;
		}
		fetch_gucos_http_error(c, strerror(errno));
		return;
	}
}

static void fetch_gucos_http_poll(lwc_string *scheme)
{
	struct fetch_gucos_http_ctx *c, *keep = NULL;

	(void)scheme;   /* one ring serves http AND https (data.c shape) */

	while (gf_ring != NULL) {
		c = gf_ring;
		RING_REMOVE(gf_ring, c);

		if (c->locked) {                /* re-entrant poll: skip */
			RING_INSERT(keep, c);
			continue;
		}

		if (!c->aborted && !c->finished)
			fetch_gucos_http_progress(c);

		if (c->finished || c->aborted) {
			/* fetch_free runs ops.free -> closes the fd, frees c;
			 * only this poll ever frees, so the ring stays sound
			 * (fetch.c's other fetch_free callers are fetchers
			 * freeing their own handles). */
			fetch_remove_from_queues(c->parent_fetch);
			fetch_free(c->parent_fetch);
		} else {
			RING_INSERT(keep, c);
		}
	}
	gf_ring = keep;
}

/* Registered from gucos/main.c right after netsurf_init() — byte-equivalent
   to an #ifdef hunk in fetcher_init() (fetcher_add is a plain table insert
   with per-scheme initialise), but OUTSIDE the vendored-tree patch fence,
   and provably absent from the nsmonkey build (this TU is only in
   gucos/bin.json's sources). */
nserror gucos_http_fetcher_register(void)
{
	nserror ret;
	const struct fetcher_operation_table fetcher_ops = {
		.initialise = fetch_gucos_http_initialise,
		.acceptable = fetch_gucos_http_can_fetch,
		.setup = fetch_gucos_http_setup,
		.start = fetch_gucos_http_start,
		.abort = fetch_gucos_http_abort,
		.free = fetch_gucos_http_free,
		.poll = fetch_gucos_http_poll,
		.finalise = fetch_gucos_http_finalise,
	};

	ret = fetcher_add(lwc_string_ref(corestring_lwc_http), &fetcher_ops);
	if (ret != NSERROR_OK)
		return ret;

	return fetcher_add(lwc_string_ref(corestring_lwc_https), &fetcher_ops);
}
