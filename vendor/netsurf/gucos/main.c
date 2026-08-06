/*
 * Copyright 2011 Daniel Silverstone <dsilvers@digital-scurf.org>
 * Copyright 2014 Vincent Sanders <vince@netsurf-browser.org>
 *
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
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * \file
 * gucOS NetSurf frontend entry: registers the gucOS operation tables,
 * initialises the core, opens the initial browsing context, and runs
 * the event loop — scheduled callbacks fire from the timeout-bounded
 * park in SDL_WaitEventTimeout, which sleeps in the kernel's unified
 * WAIT on the OS input ring (an idle browser burns no cycles).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <limits.h>
#include <signal.h>
#include <unistd.h>

#include <SDL.h>

#include "utils/config.h"
#include "utils/sys_time.h"
#include "utils/log.h"
#include "utils/messages.h"
#include "utils/filepath.h"
#include "utils/file.h"
#include "utils/nsoption.h"
#include "utils/nsurl.h"
#include "netsurf/misc.h"
#include "netsurf/netsurf.h"
#include "netsurf/browser_window.h"
#include "netsurf/url_db.h"
#include "netsurf/cookie_db.h"

#include "monkey/filetype.h"

#include "gucos/gui.h"
#include "gucos/bitmap.h"
#include "gucos/clipboard.h"
#include "gucos/fetch.h"
#include "gucos/font.h"
#include "gucos/schedule.h"

/** maximum number of languages in language vector */
#define LANGV_SIZE 32
/** maximum length of all strings in language vector */
#define LANGS_SIZE 4096

/** resource search path vector */
char **respaths;

/**
 * Cause an abnormal program termination.
 */
static void die(const char * const error)
{
	fprintf(stderr, "netsurf: %s\n", error);
	exit(EXIT_FAILURE);
}

/**
 * obtain language from environment: GNU LANGUAGE then POSIX LC_ALL,
 * LC_MESSAGES, LANG (the monkey frontend's logic).
 */
static const char *get_language(void)
{
	const char *lang;

	lang = getenv("LANGUAGE");
	if ((lang != NULL) && (lang[0] != '\0')) {
		return lang;
	}

	lang = getenv("LC_ALL");
	if ((lang != NULL) && (lang[0] != '\0')) {
		return lang;
	}

	lang = getenv("LC_MESSAGES");
	if ((lang != NULL) && (lang[0] != '\0')) {
		return lang;
	}

	lang = getenv("LANG");
	if ((lang != NULL) && (lang[0] != '\0')) {
		return lang;
	}

	return NULL;
}

/**
 * provide a string vector of languages in preference order, always
 * ending with the C language (the monkey frontend's logic).
 */
static const char * const *get_languagev(void)
{
	static const char *langv[LANGV_SIZE];
	int langidx = 0; /* index of next entry in vector */
	static char langs[LANGS_SIZE];
	char *curp; /* next language parameter in langs string */
	const char *lange; /* language from environment variable */
	int lang_len;
	char *cln; /* colon in lange */

	/* return cached vector */
	if (langv[0] != NULL) {
		return &langv[0];
	}

	curp = &langs[0];

	lange = get_language();

	if (lange != NULL) {
		lang_len = strlen(lange) + 1;
		if (lang_len < (LANGS_SIZE - 2)) {
			memcpy(curp, lange, lang_len);
			while ((curp[0] != 0) &&
			       (langidx < (LANGV_SIZE - 2))) {
				cln = strchr(curp, ':');
				if (cln == NULL) {
					langv[langidx++] = curp;
					curp += lang_len;
					break;
				} else {
					if ((cln - curp) > 1) {
						/* only place non empty entries in vector */
						langv[langidx++] = curp;
					}
					*cln++ = 0; /* null terminate */
					lang_len -= (cln - curp);
					curp = cln;
				}
			}
		}
	}

	/* ensure C language is present */
	langv[langidx++] = curp;
	*curp++ = 'C';
	*curp++ = 0;
	langv[langidx] = NULL;

	return &langv[0];
}

/**
 * Create an array of valid paths to search for resources.
 */
static char **gucos_init_resource(const char *resource_path)
{
	const char * const *langv;
	char **pathv; /* resource path string vector */
	char **respath; /* resource paths vector */

	pathv = filepath_path_to_strvec(resource_path);

	langv = get_languagev();

	respath = filepath_generate(pathv, langv);

	filepath_free_strvec(pathv);

	return respath;
}

static void gucos_quit(void)
{
	urldb_save_cookies(nsoption_charp(cookie_jar));
	urldb_save(nsoption_charp(url_file));
	monkey_fetch_filetype_fin();
}

/**
 * Set option defaults for the gucos frontend
 */
static nserror set_defaults(struct nsoption_s *defaults)
{
	/* Set defaults for absent option strings */
	nsoption_setnull_charp(cookie_file, strdup("~/.netsurf/Cookies"));
	nsoption_setnull_charp(cookie_jar, strdup("~/.netsurf/Cookies"));
	nsoption_setnull_charp(url_file, strdup("~/.netsurf/URLs"));

	/* JavaScript ON by default (core default is off, upstream's
	 * frontend-by-frontend choice).  Two rails bound it, and both are
	 * live: dukky's per-entry execution watchdog aborts any script still
	 * running after JS_EXEC_TIMEOUT_MS (10 s), and this is a *default* —
	 * nsoption_init copies it into the working set, which the Choices file
	 * and then the command line are read OVER (see gucos_main below), so
	 * `enable_javascript:0` in Choices is still the admin off-switch and
	 * `--enable_javascript=0` still wins for one run. */
	nsoption_set_bool(enable_javascript, true);

	/* The CORE select menu, drawn in the content — the frontend supplies
	 * no create_form_select_menu, so without this a <select> click
	 * reached neither menu (todos/0422).  Same default-override
	 * semantics as enable_javascript above: Choices and the command
	 * line are read over it.  NB the option also SIZES the closed
	 * widget — layout.c adds SCROLLBAR_WIDTH to the box when it is
	 * on — so flipping it changes page layout, not just the popup. */
	nsoption_set_bool(core_select_menu, true);

	/* Size the memory cache for the gucOS target instead of inheriting
	 * upstream's 2010-era desktop default (12 MB core -> 3 MB image
	 * cache after desktop/netsurf.c's /4 split).  #176's premise check
	 * measured the TRUE semantics of this ceiling first: it never gates
	 * rendering — image_cache_redraw() decodes lazily with no size
	 * refusal, so a 17 MB decoded PNG renders at load even under the
	 * 3 MB ceiling (the "large image never renders" sighting was the
	 * todos/0410 post-DONE-reformat bug, fixed separately).  What the
	 * ceiling DOES gate is retention: any bitmap set that exceeds it is
	 * re-decoded on every expose/scroll after the ~10 s background
	 * clean, so one modern image blows the whole cache and browsing
	 * image-heavy pages (real since #182 brought networking) churns
	 * full re-decodes.  64 MB core -> 16 MB image cache retains a
	 * screenful of large images.  Cost: a ceiling, not a preallocation
	 * — idle RSS is unchanged, and the worst case (+52 MB over the old
	 * config, only while content actually fills it) is comfortably
	 * inside the browser process's growable wasm heap.  Same override
	 * semantics as enable_javascript above: Choices
	 * `memory_cache_size:N` and the command line are read over it. */
	nsoption_set_int(memory_cache_size, 64 * 1024 * 1024);

	return NSERROR_OK;
}

/**
 * Ensures output logging stream is correctly configured
 */
static bool nslog_stream_configure(FILE *fptr)
{
	/* set log stream to be non-buffering */
	setbuf(fptr, NULL);

	return true;
}

static struct gui_misc_table gucos_misc_table = {
	.schedule = gucos_schedule,

	.quit = gucos_quit,
};

/**
 * Set by the SIGCHLD handler, cleared by the loop's poll.
 *
 * term's flag-then-park pattern (todos/0433): a SIGCHLD claimed at an
 * import return between the poll and the park clears the kernel's
 * pending bit, so without the flag the park would sleep out its whole
 * timeout — or forever, on a -1 deadline — with the picker already
 * dead.  A signal still PENDING at the park makes the kernel WAIT
 * return at once, so both claim orders re-enter the poll promptly.
 */
static volatile sig_atomic_t gucos_sigchld;

static void gucos_on_sigchld(int sig)
{
	(void) sig;
	gucos_sigchld = 1;
}

/**
 * The event loop: fire due scheduled callbacks (fetch/layout progress
 * all rides on them), translate input, repaint damage, then park in
 * the kernel WAIT until input arrives or the next callback is due.
 */
static void gucos_run(void)
{
	int schedtm;

	while (!gucos_done) {
		gucos_schedule_run();

		if (gucos_sigchld) {
			/* clear BEFORE reaping: a child dying mid-poll
			 * re-raises the flag and the next pass re-polls */
			gucos_sigchld = 0;
			gucos_pickers_poll();
		}

		gucos_process_events();
		if (gucos_done) {
			break;
		}

		gucos_redraw_all();

		if (SDL_PollEvent(NULL)) {
			/* events already queued: another pass, no park */
			continue;
		}

		/* Park on the input ring, bounded by the next scheduled
		 * callback — READ HERE, not from the gucos_schedule_run()
		 * above.  Everything between the two can schedule work:
		 * a click's JS listener that mutates the DOM schedules the
		 * live re-conversion at 0, and a deadline sampled before
		 * gucos_process_events() would still say -1 ("nothing
		 * scheduled, sleep until input") and park on it — losing
		 * the re-box until some unrelated later event happened to
		 * wake the loop.  todos/0316. */
		schedtm = gucos_schedule_next();

		if (gucos_sigchld) {
			/* a picker died after this pass's poll: go
			 * straight back around instead of parking on it */
			continue;
		}

		/* already due: a 1 ms park rather than a spin — the next
		 * gucos_schedule_run() fires it (its comparison is strictly
		 * greater, so a callback due this very microsecond needs
		 * the clock to move on) */
		SDL_WaitEventTimeout(NULL, schedtm == 0 ? 1 : schedtm);
	}
}

/**
 * true when an argument starts with an RFC 3986 scheme (ALPHA
 * *( ALPHA / DIGIT / "+" / "-" / "." ) ":") — which is what makes
 * scheme-only urls like data: and about: reachable from the command
 * line (a bare "://" test missed them).
 */
static bool arg_has_scheme(const char *arg)
{
	size_t i;

	if (!isalpha((unsigned char)arg[0])) {
		return false;
	}
	for (i = 1; arg[i] != '\0'; i++) {
		if (arg[i] == ':') {
			return true;
		}
		if (!isalnum((unsigned char)arg[i]) &&
		    (arg[i] != '+') && (arg[i] != '-') && (arg[i] != '.')) {
			return false;
		}
	}
	return false;
}

/**
 * turn a command line argument into a url to open: an url scheme is
 * used as-is, anything else is a filesystem path.
 */
static nserror gucos_url_from_arg(const char *arg, nsurl **url_out)
{
	if (arg_has_scheme(arg)) {
		return nsurl_create(arg, url_out);
	}

	if (arg[0] == '/') {
		return netsurf_path_to_nsurl(arg, url_out);
	}

	/* relative path: make it absolute against the cwd */
	{
		char buf[PATH_MAX];
		size_t used;

		if (getcwd(buf, sizeof(buf)) == NULL) {
			return NSERROR_BAD_PARAMETER;
		}
		used = strlen(buf);
		if (used + 1 + strlen(arg) + 1 > sizeof(buf)) {
			return NSERROR_BAD_PARAMETER;
		}
		buf[used] = '/';
		strcpy(buf + used + 1, arg);
		return netsurf_path_to_nsurl(buf, url_out);
	}
}

int main(int argc, char **argv)
{
	char *messages;
	char *options;
	char buf[PATH_MAX];
	nserror ret;
	nsurl *url;
	struct browser_window *bw;
	struct netsurf_table gucos_table = {
		.misc = &gucos_misc_table,
		.window = gucos_window_table,
		.clipboard = gucos_clipboard_table,
		.fetch = gucos_fetch_table,
		.bitmap = gucos_bitmap_table,
		.layout = gucos_layout_table,
	};

	ret = netsurf_register(&gucos_table);
	if (ret != NSERROR_OK) {
		die("NetSurf operation table failed registration");
	}

	/* Prep the search paths */
	respaths = gucos_init_resource(
		"${HOME}/.netsurf/:${NETSURFRES}:"GUCOS_RESPATH);

	/* initialise logging. Not fatal if it fails but not much we
	 * can do about it either. */
	nslog_init(nslog_stream_configure, &argc, argv);

	/* user options setup */
	ret = nsoption_init(set_defaults, &nsoptions, &nsoptions_default);
	if (ret != NSERROR_OK) {
		die("Options failed to initialise");
	}
	options = filepath_find(respaths, "Choices");
	nsoption_read(options, nsoptions);
	free(options);
	nsoption_commandline(&argc, argv, nsoptions);

	messages = filepath_find(respaths, "Messages");
	ret = messages_add_from_file(messages);
	if (ret != NSERROR_OK) {
		NSLOG(netsurf, INFO, "Messages failed to load");
	}
	free(messages);

	if (!SDL_Init(SDL_INIT_VIDEO)) {
		die("SDL video init failed");
	}

	/* fonts are load-bearing for layout: no faces, no browser */
	if (gucos_font_init() == false) {
		die("No usable fonts (is /usr/share/fonts/mono.ttf present?)");
	}

	/* common initialisation */
	ret = netsurf_init(NULL);
	if (ret != NSERROR_OK) {
		die("NetSurf failed to initialise");
	}

	/* http/https over the kernel HTTP transport (#182, httpfetch.c).
	 * fetcher_add is a plain table insert, so registering here is
	 * byte-equivalent to a fetcher_init() hunk — without patching the
	 * vendored core.  Must precede the first browser_window_create
	 * (the initial URL may be http). */
	ret = gucos_http_fetcher_register();
	if (ret != NSERROR_OK) {
		die("http fetcher failed to register");
	}

	filepath_sfinddef(respaths, buf, "mime.types", "/etc/");
	monkey_fetch_filetype_init(buf);

	urldb_load(nsoption_charp(url_file));
	urldb_load_cookies(nsoption_charp(cookie_file));

	/* open the initial browsing context: about:welcome redirects to
	 * resource:welcome.html — the baked gucOS start page under
	 * /usr/share/netsurf/ (a user drop-in at ~/.netsurf/welcome.html
	 * wins, the respath order) */
	if (argc > 1) {
		ret = gucos_url_from_arg(argv[1], &url);
	} else {
		ret = nsurl_create("about:welcome", &url);
	}
	if (ret != NSERROR_OK) {
		die("bad initial url");
	}

	ret = browser_window_create(BW_CREATE_HISTORY | BW_CREATE_FOREGROUND,
				    url, NULL, NULL, &bw);
	nsurl_unref(url);
	if (ret != NSERROR_OK) {
		die("Failed to create browser window");
	}

	/* file-picker children (todos/0433): SIGCHLD is the wake, the
	 * loop's poll is the reap */
	signal(SIGCHLD, gucos_on_sigchld);

	gucos_run();

	netsurf_exit();

	gucos_font_fini();

	/* finalise options */
	nsoption_finalise(nsoptions, nsoptions_default);

	/* finalise logging */
	nslog_finalise();

	/* Free resource paths */
	for (char **s = respaths; *s != NULL; s++) {
		free(*s);
	}
	free(respaths);

	SDL_Quit();

	return 0;
}
