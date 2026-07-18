/*
 * Copyright (C) 1997 and 1998 WIDE Project.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the project nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE PROJECT AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE PROJECT OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */
/*
 * $Id: mgp.c,v 1.154 2008/02/13 14:16:58 nishida Exp $
 */

static char *mgp_version = "1.13a (20080214)";

#include "mgp.h"
#ifdef USE_SETLOCALE
#ifdef HAVE_LOCALE_H
#include <locale.h>
#endif
#endif
#include <fcntl.h>
#include "fswatch.h"	/* gucOS FS_WATCH (ticket #75): deck live-reload */
#ifdef TTY_KEYINPUT
#include <termios.h>
#endif

Window plwin[MAXPAGE];
Pixmap maskpix;
XFontStruct *plfs;
XFontStruct *plkfs;

u_int pg_mode;
u_long pl_fh, pl_fw;
time_t t_start;
u_int t_fin;
u_int tbar_mode;
int zoomin = 0;

static int rakugaki = 0;
static int rakugaki_x = -1;
static int rakugaki_y = -1;
static int rakugaki_color = 0;
static XColor rakugaki_fore;
static XColor rakugaki_back;
static char *rakugaki_forecolors[] = {
	"red", "green", "blue", "yellow", "black", "white",
};
static char *rakugaki_backcolors[] = {
	"black", "black", "black", "black", "gray", "gray",
};
static int demointerval = 0;	/* XXX define option for this */
static int fsw_deck_fd = -1;	/* FS_WATCH fd on the deck (ticket #75) */

u_long depth_mask;

char *back_clname = DEFAULT_BACK;

#ifdef VFLIB
char *vfcap_name = VFCAP;
#endif

#ifdef FREETYPE
char *freetypefontdir = FREETYPEFONTDIR;
char *freetypefont0 = "/usr/share/fonts/mono.ttf";	/* gucOS port: last-resort
	 * default — any deck renders with the baked mono face even without
	 * %deffont/%tfont (override with %tfont0) */
char *freetypemfont0 = NULL;	/* font name to be used as a last resort */

int unicode_map[65536];
#endif
int latin_unicode_map[3][256]; /* currently we have iso8859-2-4 map */

static char *tsfile = NULL;
static char *dumpdir = NULL;

char *gsdevice = DEFAULT_GSDEV;
char *htmlimage;


static char *xgeometry = NULL;	/*default: full screen*/
#ifdef TTY_KEYINPUT
static struct termios saveattr, curattr;
volatile int ttykey_enable;
#endif
static pid_t mypid;

static void genhtml __P((int));
static void mgp_usage __P((char *));
static void mgp_show_version __P((char *));
static void beep __P((void));
static void main_loop __P((u_int));
static void rakugaki_update __P((struct render_state *, XEvent *));
static void rakugaki_updatecolor __P((Cursor));
static RETSIGTYPE waitkids __P((int));
static int wantreload __P((void));

/*image*/
extern char *expandPath __P((char *));

#ifdef TTY_KEYINPUT
static void
susp(int sig)
{
	sigset_t mask;

	if (ttykey_enable) {
		if (sig == SIGTTIN || sig == SIGTTOU) {
			ttykey_enable = 0;
			return;
		}
		tcsetattr(0, TCSANOW, &saveattr);
	}
	signal(sig, SIG_DFL);
	sigemptyset(&mask);
	sigaddset(&mask, sig);
	sigprocmask(SIG_UNBLOCK, &mask, NULL);
	kill(mypid, sig);
	/* resumed */
	signal(sig, susp);
	if (ttykey_enable) {
		if (tcgetpgrp(0) != mypid)
			ttykey_enable = 0;
		else
			tcsetattr(0, TCSANOW, &curattr);
	}
}

void
try_enable_ttykey()
{

	if (ttykey_enable)
		return;
	if (tcgetpgrp(0) != mypid)
		return;

	ttykey_enable = 1;

	signal(SIGTTIN, susp);
	signal(SIGTTOU, susp);
	signal(SIGTSTP, susp);
	curattr = saveattr;
	curattr.c_lflag |= ISIG;
	curattr.c_lflag &= ~(ECHO|ICANON|IEXTEN);
	curattr.c_iflag &= ~(IXON|IXOFF);
	curattr.c_cc[VMIN] = 1;
	curattr.c_cc[VTIME] = 0;
	/* This call might cause STGTTOU */
	tcsetattr(0, TCSANOW, &curattr);
}
#endif

void
cleanup(int sig)
{
	sigset_t mask;

#ifdef USE_M17N
	if (! (mgp_flag & FL_NOM17N))
		/* finalize M17N library */
		M17N_fini();
#endif
	cleandir();		/* clean up embedded files and its dir */
#ifdef TTY_KEYINPUT
	if (ttykey_enable)
		tcsetattr(0, TCSANOW, &saveattr);
#endif
	/* gucOS port: no fork()ed kids and no own pgroup — the upstream
	 * kill(0, SIGTERM) would signal the invoking shell's group. */
	if (tsfile)
		unlink(tsfile);
	if (sig > 0) {
		signal(sig, SIG_DFL);
		sigemptyset(&mask);
		sigaddset(&mask, sig);
		sigprocmask(SIG_UNBLOCK, &mask, NULL);
		kill(mypid, sig);
	}

	finish_win(); /* finish X connection */
	exit(-sig);
}

int
main(argc, argv)
	int argc;
	char **argv;
{
	int i, j;              /* counters */
	int tmp_argc;          /* number of current arguments */
	char **tmp_argv;       /* manipulated 'argv' */
	int opt;
	extern char *optarg;
	extern int optind;
	char *progname;
	int start_page = 1;
	char buf[BUFSIZ], *p, *p2;
	extern char *Paths[];
	extern unsigned int NumPaths;
#ifdef VFLIB
	char *vfont_name = VFONT;
#endif
	char *ep;

#ifdef USE_SETLOCALE
	setlocale(LC_CTYPE, "");
#endif
	progname = argv[0];

	/* secure by default.  If you need fork/exec, use -U */
	mgp_flag |= FL_NOFORK;

	if ((p = getenv("MGPWDIR")) != NULL) {
		mgpwdir = p;
	}

	/*
	 * check for the argument '--title' to set the window's title:
	 * go through the whole 'argv' and cut off this option since it
	 * will not be accepted by getopt()
	 * default title is 'MagicPoint'
	 */
	tmp_argv=(char**)malloc(argc*sizeof(char*));
	tmp_argc=argc;
	i=j=0;
	while (i < argc)
	{
		if (strcmp(argv[i], "--title") == 0)
		{
			tmp_argc--;
			if (++i < argc)
			{
				mgp_wname=strdup(argv[i]);
				tmp_argc--;
			}
		}
		else
			tmp_argv[j++]=strdup(argv[i]);
		i++;
	}
	/* set title to default if not set by user */
	if (argc-1 <= tmp_argc)
		mgp_wname=strdup("MagicPoint");

	argv=tmp_argv;
	argc=tmp_argc;

#define ACCEPTOPTS	"Bd:vVob:c:eg:f:hlGp:qt:Q:PSUT:D:CORw:X:x:nF:E:"
	while ((opt = getopt(argc, argv, ACCEPTOPTS)) != -1) {
#undef ACCEPTOPTS
		switch (opt) {
		case 'B':
			mgp_flag |= FL_BIMAGE;
			break;

		case 'd':
			mgp_flag |= FL_DEMO;
			if (isdigit(optarg[0])) demointerval = atoi(optarg);
			else optind --;
			break;

		case 'V':
			mgp_flag |= FL_VERBOSE;
			verbose++;
			break;

		case 'l':
			mgp_flag |= FL_OUTLINE;
			break;

		case 'G':
			pg_mode = 1;
			break;

		case 'o':
			mgp_flag |= FL_OVER;
			break;

#ifdef VFLIB
		case 'c':
			vfcap_name = optarg;
			break;

		case 'f':
			vfont_name = optarg;
			break;
#endif /*VFLIB*/

		case 'b':
			back_clname = optarg;
			break;

		case 'p':
			ep = NULL;
			start_page = atoi(optarg);
			if (start_page <= 0) {
				mgp_usage(progname);
				/*NOTREACHED*/
			}
			break;

		case 'e':
			mgp_flag |= FL_GLYPHEDGE;
			break;

		case 'g':
			xgeometry = optarg;
			mgp_flag |= FL_OVER;	/* -g implies -o */
			break;

		case 'q':
			mgp_flag |= FL_NOBEEP;
			break;

		case 't':
			t_fin = atoi(optarg);
			tbar_mode = 1;
			break;

		case 'Q':
			b_quality[caching] = atoi(optarg);
			quality_flag = 1;
			break;

		case 'P':
			parse_debug++;
			break;

		case 'S':
			mgp_flag |= FL_NOFORK;
			break;
		case 'U':
			mgp_flag &= ~FL_NOFORK;
			break;

		case 'T':
			tsfile = optarg;
			break;

		case 'D':
			dumpdir = optarg;
			break;

		case 'C':
			mgp_flag |= FL_PRIVATE;
			break;

		case 'O':
			mgp_flag |= FL_NODECORATION | FL_OVER;  /* -O implies -o */
			break;

		case 'R':
			mgp_flag |= FL_NOAUTORELOAD;
			break;

		case 'w':
			mgpwdir = optarg;
			break;

		case 'X':
			gsdevice = optarg;
			break;

		case 'x':
			if (strcmp(optarg, "vflib") == 0)
				mgp_flag |= FL_NOVFLIB;
			else if (strcmp(optarg, "freetype") == 0)
				mgp_flag |= FL_NOFREETYPE;
			else if (strcmp(optarg, "xft") == 0)
				mgp_flag |= FL_NOXFT;
			else if (strcmp(optarg, "m17n") == 0)
				mgp_flag |= FL_NOM17N;
			else {
				fprintf(stderr, "unknown rendering engine %s\n",
					optarg);
				mgp_usage(progname);
				/*NOTREACHED*/
			}
			break;
		case 'v':
			mgp_show_version(progname);
			/*NOTREACHED*/

		case 'n':
			mgp_flag |= FL_NOSTDIN;
			break;

		case 'F':
			mgp_flag |= FL_FRDCACHE;
			p = optarg;
			if ((p2 = strsep(&p, ",")))
				cache_mode = atoi(p2);
			if ((p2 = strsep(&p, ",")))
				cache_effect = atoi(p2);
			if ((p2 = strsep(&p, ",")))
				cache_value = atoi(p2);
			break;

		case 'E':
			htmlimage = optarg;
			break;

		case 'h':
		default:
			mgp_usage(progname);
			/*NOTREACHED*/
		}
	}

	argc -= optind;
	argv += optind;

	mypid = getpid();
	signal(SIGHUP, cleanup);
	signal(SIGINT, cleanup);
	signal(SIGQUIT, cleanup);
	signal(SIGTERM, cleanup);

	if (argc != 1) {
		mgp_usage(progname);
		/*NOTREACHED*/
	}
	mgp_fname = argv[0];

	/* FS_WATCH live-reload (ticket #75): a PATH-keyed watch on the deck
	 * — the ONE auto-reload source (wantreload() drains it; the upstream
	 * ctime poll is gone). Path-keyed means an editor's tmp+rename-over
	 * save still lands on this watch and the watch survives the
	 * replacement; the settled park in frame_loop wakes and reloads
	 * immediately, on ANY page. -R skips the watch entirely; no kernel
	 * watch (ENOSYS) leaves the fd at -1 = no auto-reload (ctrl-r
	 * still reloads by hand). */
	if (!(mgp_flag & FL_NOAUTORELOAD))
		fsw_deck_fd = fsw_open(mgp_fname, 0);

	init_win1(xgeometry);
	strlcpy(buf, mgp_fname, sizeof(buf));
	if ((p = rindex(buf, '/'))) {
		*p = '\0';
        	Paths[NumPaths++]= expandPath(buf);
	}
	loadPathsAndExts();
	load_file(mgp_fname);
	if (parse_error)
		exit(-1);
	init_win2();
#ifdef VFLIB
	vfc_setfont(vfont_name);
#endif

	signal(SIGCHLD, waitkids);

#ifdef USE_M17N
	if (! (mgp_flag & FL_NOM17N))
		/* initaiize M17N library */
		M17N_init();
#endif

	if (dumpdir) {
		fprintf(stderr, "mgp: -D html dump needs external converters; "
		    "not supported in this port\n");
		cleanup(-1);
	} else if (mgp_flag & FL_DEMO) {
		struct render_state state;

		memset(&state, 0, sizeof(struct render_state));
		state.target = window;	/*XXX*/
		state.width = window_width;
		state.height = window_height;
		while (start_page <= maxpage) {
			state_goto(&state, start_page, 0);
			draw_page(&state, NULL);
			start_page++;
			sleep(demointerval);	/*XXX*/
		}
	} else {
		init_win3();
		main_loop(start_page);
		/* gucOS port: main_loop() registered frame_loop() with the
		 * runtime and returned; events drive everything from here. */
		return 0;
	}

	cleanup(0);	/* never returns */
	exit(0);	/* avoid warnings */
	/*NOTREACHED*/
}

static void
genhtml(start_page)
	int start_page;
{
	struct render_state state;
	char buf[BUFSIZ];
	int fd;
	FILE *html;
	FILE *txt;
	int page;
	char *childdebug;
	char *convdb[][3] = {{ "jpg", "cjpeg", "djpeg" },
				{ "png", "pnmtopng", "pngtopnm" },
				{ NULL, NULL, NULL }};
	int inum = 0;

	/* check image type */
	if (htmlimage) {
		for (inum = 0; *convdb[inum] != NULL; inum++) {
			if (strcmp(*convdb[inum], htmlimage) == 0)
				break;
		}
		if (*convdb[inum] == NULL) {
			fprintf(stderr, "unknwon image type %s.\n", htmlimage);
			/* print out valid image types */
			fprintf(stderr, "Valid image types: ");
			for (inum = 0; *convdb[inum] != 0; inum++) {
				fprintf(stderr, "%s ", *convdb[inum] );
			}
			fprintf(stderr,"\n");
			cleanup(-1);
		}
	}

	/* check if we can write to the directory */
	sprintf(buf, "%s/%ld", dumpdir, (long)time((time_t *)NULL));
	fd = open(buf, O_WRONLY | O_CREAT, 0644);
	if (fd < 0) {
		fprintf(stderr, "bad dump directory %s.\n", dumpdir);
		cleanup(-1);
	}
	close(fd);
	unlink(buf);

	memset(&state, 0, sizeof(struct render_state));
	state.target = window;	/*XXX*/
	state.width = window_width;
	state.height = window_height;
	childdebug = parse_debug ? "" : "2>&-";
	for (page = start_page; page <= maxpage; page++) {
		fprintf(stderr, "generating page %d... ", page);
		state_goto(&state, page, 0);
		draw_page(&state, NULL);


#define EXT convdb[inum][0]

		/*
		 * dump out image
		 */
		fprintf(stderr, "(full image)");
		sprintf(buf, "xwintoppm -silent -name MagicPoint | "
			"%s %s > %s/mgp%05d.%s",
			convdb[inum][1], childdebug, dumpdir, page, EXT);
		if (system(buf) < 0){	/*XXX security hole*/
			fprintf(stderr, "system() failed for %s", buf);
			exit(-1);
		}
		fprintf(stderr, "(thumbnail)");
		sprintf(buf, "%s %s/mgp%05d.%s | "
			"pnmscale 0.25 | %s %s > %s/mgp%05d.idx.%s",
			convdb[inum][2], dumpdir, page, EXT, convdb[inum][1], childdebug,
			dumpdir, page, EXT);
		if (system(buf) < 0){	/*XXX security hole*/
			fprintf(stderr, "system() failed for %s", buf);
			exit(-1);
		}

		/*
		 * dump out html file
		 */
		fprintf(stderr, "(html)");
		sprintf(buf, "%s/mgp%05d.html", dumpdir, page);
		html = fopen(buf, "w");
		if (!html)
			continue;
		fprintf(html,
"<HTML>\n"
"<HEAD><TITLE>MagicPoint presentation foils</TITLE></HEAD>\n"
"<BODY>\n");
		fprintf(html,
		    "<A HREF=\"index.html\">[index]</A> "
		    "<A HREF=mgp%05d.txt>[text page]</A> ", page);
		if (1 < page) {
		    fprintf(html,
			"<A HREF=mgp%05d.html>[&lt;&lt;start]</A>  "
			"<A HREF=mgp%05d.html>[&lt;prev]</A> ",
				1, page - 1);
		} else
			fprintf(html, "[&lt;&lt;start] [&lt;prev] ");
		if (page < maxpage) {
		    fprintf(html,
			"<A HREF=mgp%05d.html>[next&gt;]</A> "
			"<A HREF=mgp%05d.html>[last&gt;&gt;]</A>\n",
				page + 1, maxpage);
		} else
			fprintf(html, "[next&gt;] [last&gt;&gt;]\n");
		fprintf(html, "<BR>Page %d: %s<BR>\n", page, page_title(page));
		fprintf(html, "<HR>\n");
		if (window_width < 0 || window_height < 0) {
			fprintf(html, "<IMG SRC=\"mgp%05d.%s\" "
				"ALT=\"Page %d\">\n",
				page, EXT, page);
		} else {
			fprintf(html, "<IMG SRC=\"mgp%05d.%s\" "
				"WIDTH=%d HEIGHT=%d ALT=\"Page %d\"><BR>\n",
				page, EXT, window_width, window_height,
				page);
		}
		fprintf(html, "<HR>Generated by "
		    "<A HREF=\"http://member.wide.ad.jp/wg/mgp/\">MagicPoint</A>\n"
		    "</BODY></HTML>\n");
		fclose(html);

		/*
		 * dump out text file
		 */
		fprintf(stderr, "(txt)\n");
		sprintf(buf, "%s/mgp%05d.txt", dumpdir, page);
		txt = fopen(buf, "w");
		if (!txt)
			continue;
		state_goto(&state, page, 0);
		state_init(&state);
		while (1) {
			if (state.phase == P_NONE || state.phase == P_END)
				break;
			if (!state.cp) {
				state_next(&state);
				continue;
			}
			switch (state.cp->ct_op) {
			case CTL_PAUSE:
				if (state.cp->cti_value)
					goto txtdone;
				break;
			case CTL_TEXT:
				if (state.cp->ctc_value) {
#ifdef USE_M17N
					if (! (mgp_flag & FL_NOM17N)) {
						M17N_write_text (txt, state.cp);
					} else
#endif
					fprintf(txt, "%s", state.cp->ctc_value);
				}
				break;
			case CTL_LINEEND:
				fprintf(txt, "\n");
				break;
			}

			state_next(&state);
		}
txtdone:;
		fclose(txt);
	}

	fprintf(stderr, "generating top page... ");
	sprintf(buf, "%s/index.html", dumpdir);
	html = fopen(buf, "w");
	if (!html) {
		fprintf(stderr, "could not generate top page\n");
		cleanup(-1);
	}
	fprintf(stderr, "\n");
	fprintf(html,
"<HTML>\n"
"<HEAD><TITLE>MagicPoint presentation foils</TITLE></HEAD>\n"
"<BODY>\n");
	for (page = start_page; page <= maxpage; page++) {
		if (window_width < 0 || window_height < 0) {
			fprintf(html, "<A HREF=\"mgp%05d.html\">"
				"<IMG SRC=\"mgp%05d.idx.%s\" "
				"ALT=\"Page %d\"></A>\n",
				page, page, EXT, page);
		} else {
			fprintf(html, "<A HREF=\"mgp%05d.html\">"
				"<IMG SRC=\"mgp%05d.idx.%s\" "
				"WIDTH=%d HEIGHT=%d "
				"ALT=\"Page %d\"></A>\n",
				page, page, EXT, window_width / 4,
				window_height / 4, page);
		}
	}
	fprintf(html, "<HR>\n");
	fprintf(html, "Generated by "
		"<A HREF=\"http://member.wide.ad.jp/wg/mgp/\">"
		"MagicPoint</A>\n");
	fprintf(html, "<BR>\n</BODY></HTML>\n");
	fclose(html);
}

static void
mgp_show_version(name)
	char *name;
{
	char *p;

	if ((p = strrchr(name, '/')))
		p ++;
	else
		p = name;
	fprintf(stderr, "%s version %s\n", p, mgp_version);
	exit(0);
}

static void
mgp_usage(name)
	char *name;
{
	fprintf(stderr, "Usage: %s [opts] mgpfile\n", name);

	fprintf(stderr, "\t-b <color>: Specify background color\n");
#ifdef VFLIB
	fprintf(stderr, "\t-c <vfcap>: Specify vfontcap file\n");
#endif /*VFLIB*/
	fprintf(stderr, "\t-d: Demo mode - go through the presentation\n");
#ifdef VFLIB
	fprintf(stderr, "\t-f <font>: Specify default vflib font\n");
#endif /*VFLIB*/
	fprintf(stderr, "\t-g <geometry>: Set window geometry\n");
	fprintf(stderr, "\t-h: Display this help message\n");
#ifdef VFLIB
	fprintf(stderr, "\t-l: Do not use outline font on vflib\n");
#endif /*VFLIB*/
	fprintf(stderr, "\t-n: Disables control key input from tty\n");
	fprintf(stderr, "\t-o: Do not override the window manager\n");
	fprintf(stderr, "\t-p <page>: Start at the specified page\n");
	fprintf(stderr, "\t-q Do not beep on errors\n");
	fprintf(stderr, "\t-t <timeslot>: Enable presentation timer\n");
	fprintf(stderr, "\t-v: Show version number and quit\n");
	fprintf(stderr, "\t-w <dir>: Specify a working directory\n");
	fprintf(stderr, "\t-x <engine>: Disable specified rendering engine\n");

	fprintf(stderr, "\t-B: Ignore background image\n");
	fprintf(stderr, "\t-C: Use private colormap\n");
	fprintf(stderr, "\t-D <dir>: Generate html pages for the presentation\n");
	fprintf(stderr, "\t-E <name>: Use this image format in html (jpg or png)\n");
	fprintf(stderr, "\t-F<mode>,<effect>,<value>: Use forwarding caches\n");
	fprintf(stderr, "\t-G: Page guide is on\n");
	fprintf(stderr, "\t-O: Obey to the window manager\n");
	fprintf(stderr, "\t-Q <quality>: Set background image quality(0-100)\n");
	fprintf(stderr, "\t-R: Do not perform automatic reload\n");
	fprintf(stderr, "\t-S: Do not process directives that forks process (default)\n");
	fprintf(stderr, "\t-U: Do process directives that forks process\n\t    or allow to use non-ASCII filenames (unsecure mode)\n");
	fprintf(stderr, "\t-T <timestampfile>: Update timestampfile on page refresh\n");
	fprintf(stderr, "\t-P: print stderr from image conversion tools (by default it's discarded)\n");
	fprintf(stderr, "\t-V: Be verbose\n");
	fprintf(stderr, "\t-X <gsdevice>: ghostscript device to use\n");
	fprintf(stderr, "\t--title <title>: Set window title\n");

	exit(0);
}

static void
beep()
{
	if (!(mgp_flag & FL_NOBEEP))
		XBell(display, 0);
}

/*
 * gucOS port (todos/0119): the blocking XNextEvent/select main loop is now
 * a frame callback. draw_one() returns 2 ("would block") instead of
 * sleeping on the X fd; main_loop() seeds the render state and registers
 * frame_loop() with the runtime; handle_xevent() is upstream's per-event
 * switch with `goto reload/repaint` folded into fl_reload()/fl_repaint()
 * and quit turned into a flag (cleanup(0) exits).
 */
static struct render_state fl_state;
static u_int fl_number = 0;
static u_int fl_shift = 0;
static u_int fl_control = 0;
static int fl_quit = 0;
static time_t fl_last_idle;
static Cursor pen_curs;

static void fl_reload __P((void));
static void fl_repaint __P((void));
static void handle_xevent __P((XEvent *));
static void frame_loop __P((void));

static void
main_loop(start_page)
	u_int start_page;
{
	memset(&fl_state, 0, sizeof(struct render_state));
	fl_state.target = window;	/*XXX*/
	fl_state.width = window_width;
	fl_state.height = window_height;
	if (!pen_curs) {
		pen_curs = XCreateFontCursor(display, XC_pencil);
		rakugaki_updatecolor(pen_curs);
	}
	state_goto(&fl_state, start_page, 0);
	if (pg_mode) {
		pg_on();
		pg_draw(&fl_state);
		XFlush(display);
	}
	sdlx_frame_hook(frame_loop);
}

static void
fl_repaint()
{
	struct ctrl *lastcp;

	lastcp = fl_state.cp;
	fl_state.repaint = 1;
	state_goto(&fl_state, fl_state.page, 1);
	draw_page(&fl_state, lastcp);
	fl_state.repaint = 0;
	fl_number = 0;
}

static void
fl_reload()
{
	pl_off(&fl_state);
	cached_page = 0;
	reset_background_pixmap();
	draw_reinit(&fl_state);
	cleanup_file();
	load_file(mgp_fname);
	if (maxpage < fl_state.page)
		fl_state.page = 1;
	state_goto(&fl_state, fl_state.page, 1);
	fl_repaint();
}

static void
frame_loop()
{
	XEvent e;
	int r;
	u_int prevpage;
	int steps = 0;

	for (;;) {
		if (!t_start && 1 < fl_state.page)
			t_start = time(NULL);

		r = draw_one(&fl_state, &e);
		if (r == False) {
			if (++steps > 200000)
				return;		/* runaway guard */
			continue;
		}
		if (r == 2) {
			/* page settled and no events pending: do the old
			 * 2-second idle-tick duties, then yield the frame */
			time_t now = time(NULL);
			if (now - fl_last_idle >= 2) {
				fl_last_idle = now;
				if (t_fin)
					timebar(&fl_state);
				if ((fl_state.cp
				     && fl_state.cp->ct_op == CTL_PAUSE)
				    || fl_state.page == maxpage) {
					if (wantreload())
						fl_reload();
				}
			}
			/* IDLE-POWER Stage 2 (todos/0161): a settled page has
			 * nothing to draw until input arrives — park on the OS
			 * input ring instead of returning into a 60Hz frame
			 * callback that re-enters just to find no event. The 2s
			 * cap keeps the timebar/wantreload idle duties above on
			 * their upstream cadence; a waking event stays queued
			 * (peek) for the XCheckMaskEvent in draw_one. The deck
			 * watch fd (FS_WATCH, ticket #75) joins the park: a
			 * settled save — including a tmp+rename-over — wakes
			 * it and reloads right here, on any page (wantreload()
			 * drains the same fd). */
			sdlx_wait_event_fd(fsw_deck_fd, 2000);
			if (wantreload())
				fl_reload();
			return;
		}

		/* r == True: got an event in e */
		if (t_fin)
			timebar(&fl_state);
		if ((fl_state.cp && fl_state.cp->ct_op == CTL_PAUSE)
		    || (fl_state.page == maxpage)) {
			if (tsfile) {
				int fd;
				fd = open(tsfile, O_WRONLY|O_TRUNC|O_CREAT,
				    0644);
				if (fd < 0) {
				    fprintf(stderr, "timestamp file %s "
					"write failed; "
					"timestamp turning off\n",
					tsfile);
				    tsfile = NULL;
				} else {
				    if (write(fd, &fl_state, sizeof(fl_state)) < 0)
					fprintf(stderr,
					    "timestamp file write failed\n");
				    close(fd);
				}
			}

			if (wantreload()) {
				draw_reinit(&fl_state);
				cleanup_file();
				load_file(mgp_fname);
				if (maxpage < fl_state.page)
					fl_state.page = 1;
				state_goto(&fl_state, fl_state.page, 1); /*repaint*/
			}
		}

		prevpage = fl_state.page;
		handle_xevent(&e);
		if (fl_quit)
			cleanup(0);	/* never returns */

		/* page may have changed... */
		if (pg_mode)
			pg_draw(&fl_state);
		if (prevpage != fl_state.page) {
			pl_pdraw(&fl_state, prevpage, gc_pl);
			pl_pdraw(&fl_state, fl_state.page, gc_plrev);
			pl_title(fl_state.page);
		}

		if (fl_state.phase == P_END) {
			if (fl_state.page < maxpage)
				state_goto(&fl_state, fl_state.page + 1, 0);
		}
	}
}

static void
handle_xevent(e)
	XEvent *e;
{
	struct render_state *sp = &fl_state;
	KeySym key;
	u_int i;

	switch (e->type) {
	case EnterNotify:
		for (i = 1; i <= maxpage; i++) {
			if (e->xany.window == plwin[i]) {
				XClearWindow(display, plwin[i]);
				pl_pdraw(sp, i, gc_plrev);
				pl_title(i);
			}
		}
		XFlush(display);
		break;

	case LeaveNotify:
		for (i = 1; i <= maxpage; i++) {
			if (e->xany.window == plwin[i]) {
				XClearWindow(display, plwin[i]);
				pl_pdraw(sp, i, gc_pl);
				pl_title(0);
			}
		}
		XFlush(display);
		break;

	case ButtonPress:
		if (rakugaki && e->xany.window == window) {
			rakugaki_update(sp, e);
			break;
		}

		for (i = 1; i <= maxpage; i++) {
			if (e->xany.window == plwin[i]) {
				state_goto(sp, i, 0);
				pl_off(sp);
				break;
			}
		}
		if (e->xany.window == window) {
			if (e->xbutton.button == 1) {
				struct render_state tstate;
				tstate = *sp;

				if (!fl_shift && sp->cp
				 && sp->cp->ct_op == CTL_PAUSE) {
					state_next(&tstate);
				} else if (sp->page + 1 < maxpage) {
					state_goto(&tstate,
						sp->page + 1, 0);
				} else {
					beep();
					break;
				}

				if (memcmp(sp, &tstate,
						sizeof(*sp)) != 0) {
					*sp = tstate;
				} else {
					/* cannot make a progress */
					beep();
				}
			} else if (e->xbutton.button == 3) {
				if (sp->page > 1) {
					state_goto(sp,
						sp->page - 1, 0);
				} else
					beep();
			}
		}
		break;

	case ButtonRelease:
		if (rakugaki && e->xany.window == window)
			rakugaki_update(sp, e);
		if (e->xbutton.button == 2)
			goto rakugaki_toggle;
		break;

	case MotionNotify:
		if (!rakugaki)
			break;
		if (e->xany.window == window)
			rakugaki_update(sp, e);
		break;

	case KeyPress:
		key = XLookupKeysym((XKeyEvent *)e, 0);

		switch (key) {
		case XK_q:
		case XK_Escape:
			fl_quit = 1;
			return;

		case XK_f:
		case XK_j:
		case XK_n:
		case XK_Down:
		case XK_Next:
		case XK_space:
		    {
			struct render_state tstate;
			tstate = *sp;

			if (fl_number == 0 && sp->cp && sp->cp->ct_op == CTL_PAUSE) {
				state_next(&tstate);
			} else {
			    if (fl_number == 0)
				fl_number = 1;

			    if (sp->page + fl_number <= maxpage) {
					state_goto(&tstate, sp->page + fl_number, 0);
			    } else {
				beep();
				break;
			    }
			}

			if (memcmp(sp, &tstate, sizeof(*sp)) != 0) {
				*sp = tstate;
			} else {
				/* cannot make a progress */
				beep();
			}
			fl_number = 0;
			break;
		    }

		case XK_b:
		case XK_k:
		case XK_p:
		case XK_Up:
		case XK_Prior:
		case XK_BackSpace:
		case XK_Delete:
			if (fl_number == 0) fl_number = 1;
			if (sp->page - fl_number >= 1) {
				state_goto(sp,
					sp->page - fl_number, 0);
			} else
				beep();
			fl_number = 0;
			break;

		case XK_x:
			if (fl_shift) {
				rakugaki_color++;
				rakugaki_updatecolor(pen_curs);
				XUndefineCursor(display, window);
				XDefineCursor(display, window,
					pen_curs);
				XFlush(display);
			} else {
rakugaki_toggle:
				rakugaki = 1 - rakugaki;
				rakugaki_x = rakugaki_y = -1;

				if (rakugaki) {
					XDefineCursor(display, window,
						pen_curs);
				} else {
					XUndefineCursor(display,
						window);
				}
				XFlush(display);
			}
			break;

		case XK_t:
			if (tbar_mode)
				tbar_mode = 0;
			else {
				if (t_fin)
					tbar_mode = 1;
			}
			break;

		case XK_Control_L:
		case XK_Control_R:
			pl_on(sp);
			fl_control = 1;
			fl_number = 0;
			break;

		case XK_Shift_L:
		case XK_Shift_R:
			fl_shift = 1;
			fl_number = 0;
			break;

		case XK_r:
			if (fl_control)
				fl_reload();
			break;

		case XK_l:	/* used to be control-L */
			fl_repaint();
			break;

		case XK_g:
			if (fl_shift) {
				pg_mode = 1 - pg_mode;
				if (pg_mode) {
					pg_on();
					pg_draw(sp);
				} else
					pg_off();
			} else {
				if (fl_number == 0)
					fl_number = maxpage;
				if (fl_number <= maxpage && fl_number > 0) {
					state_goto(sp, fl_number, 0);
					state_newpage(sp);
					state_init(sp);
				} else
					beep();
			}
			fl_number = 0;
			break;

		case XK_0:
		case XK_1:
		case XK_2:
		case XK_3:
		case XK_4:
		case XK_5:
		case XK_6:
		case XK_7:
		case XK_8:
		case XK_9:
			fl_number = fl_number * 10 + key - XK_0;
			break;

		case XK_c:
			if (verbose)  {
				if (mgp_flag & FL_FRDCACHE)
					printf("turn off forward cache\n");
				else
					printf("turn on forward cache\n");
			}

			mgp_flag ^= FL_FRDCACHE;
		break;

		case XK_a:
			XCopyArea(display, cachewin, window, gc_cache,
					0, 0, window_width, window_height, 0, 0);
			break;

		case XK_w:
			toggle_fullscreen();
			break;

		default:
			fl_number = 0;
			break;
		}

		break;

	case KeyRelease:
		key = XLookupKeysym((XKeyEvent *)e, 0);

		switch (key) {
		case XK_Control_L:
		case XK_Control_R:
			pl_off(sp);
			fl_control = 0;
			break;
		case XK_Shift_L:
		case XK_Shift_R:
			fl_shift = 0;
			break;
		}
		break;

	case Expose:
	    {
		XEvent ahead;

		if (e->xexpose.window != window)
			break;
		if (sp->repaint)
			break;

		/* compress expose event */
		while (XEventsQueued(display, QueuedAfterReading) > 0) {
			XPeekEvent(display, &ahead);
			if (ahead.type != Expose && ahead.type != ConfigureNotify)
				break;
			if (ahead.xexpose.window != window)
				break;
			XNextEvent(display, e);
		}

		if (wantreload()) {
			fl_reload();
			break;
		}
		if ((sp->cp && sp->cp->ct_op == CTL_PAUSE) ||
			(sp->page == maxpage))
			fl_repaint();
		break;
	    }

	case ConfigureNotify:
	    {
		XEvent ahead;

		if ((e->xconfigure.window != window) &&
			((mgp_flag & FL_OVER) ||
			e->xconfigure.window != RootWindow(display, screen)))
			break;
		/* compress expose event */
		while (XEventsQueued(display, QueuedAfterReading) > 0) {
			XPeekEvent(display, &ahead);
			if (ahead.type != Expose && ahead.type != ConfigureNotify)
				break;
			if (ahead.xconfigure.window != window)
				break;
			XNextEvent(display, e);
		}
		if (window_width != e->xconfigure.width
		 || window_height != e->xconfigure.height) {
			struct ctrl *lastcp;

			if (pg_mode)
				pg_off();
			pl_off(sp);
			window_width = e->xconfigure.width;
			window_height = e->xconfigure.height;
			sp->width = e->xconfigure.width;
			sp->height = e->xconfigure.height;
			if (mgp_flag & FL_FRDCACHE) {
				cached_page = 0;
				reset_background_pixmap();
			}
			reset_background_pixmap();
			draw_reinit(sp);	/*notify*/
			lastcp = sp->cp;
			state_goto(sp, sp->page, 1);
			draw_page(sp, lastcp);

		}
		if (pg_mode) {
			pg_on();
			pg_draw(sp);
		}
		if (wantreload())
			fl_reload();
		break;
	    }
	}
}

static void
rakugaki_update(state, e)
	struct render_state *state;
	XEvent *e;
{
	int x, y;

	if (e->type == MotionNotify) {
		XMotionEvent *em;
		em = (XMotionEvent *)e;
		x = em->x; y = em->y;
	} else if (e->type == ButtonPress) {
		XButtonPressedEvent *eb;
		eb = (XButtonPressedEvent *)e;
		x = eb->x; y = eb->y;
		if (e->xbutton.button != 1) return;
	} else {
		rakugaki_x = rakugaki_y = -1;
		return;
	}

	if (rakugaki_x < 0 || rakugaki_y < 0)
		XDrawRectangle(display, state->target, gcpen, x, y, 1, 1);
	else {
		XDrawLine(display, state->target, gcpen,
			x, y,
			rakugaki_x, rakugaki_y);
		XDrawLine(display, state->target, gcpen,
			x + 1, y,
			rakugaki_x + 1, rakugaki_y);
		XDrawLine(display, state->target, gcpen,
			x, y + 1,
			rakugaki_x, rakugaki_y + 1);
		XDrawLine(display, state->target, gcpen,
			x + 1, y + 1,
			rakugaki_x + 1, rakugaki_y + 1);
	}
	rakugaki_x = x;
	rakugaki_y = y;
}

static void
rakugaki_updatecolor(cursor)
	Cursor cursor;
{
	XColor junk;
	int maxidx;

	maxidx = sizeof(rakugaki_forecolors)/sizeof(rakugaki_forecolors[0]);
	if (maxidx <= rakugaki_color)
		rakugaki_color %= maxidx;

	XAllocNamedColor(display, DefaultColormap(display, screen),
		rakugaki_forecolors[rakugaki_color], &rakugaki_fore, &junk);
	XAllocNamedColor(display, DefaultColormap(display, screen),
		rakugaki_backcolors[rakugaki_color], &rakugaki_back, &junk);

	/*
	 * due to the design of the cursor, it looks more natural if we swap
	 * the background color and foreground color.
	 */
	XRecolorCursor(display, cursor, &rakugaki_back, &rakugaki_fore);

	XSetForeground(display, gcpen, rakugaki_fore.pixel);
}

static struct {
	pid_t pid;
	void *key;
	Window window_id;
	int flag;
} childtab[64];
static int childidx = 0;

pid_t
checkchild(key)
	void *key;
{
	int i;

	for (i = 0; i < childidx; i++) {
		if (childtab[i].pid == (pid_t)-1)
			continue;
		if (childtab[i].key == key)
			return childtab[i].pid;
	}
	return (pid_t)-1;
}

Window
checkchildwin(key)
	void *key;
{
	int i;

	for (i = 0; i < childidx; i++) {
		if (childtab[i].pid == (pid_t)-1)
			continue;
		if (childtab[i].key == key)
			return childtab[i].window_id;
	}
	return (Window)-1;
}

void
regchild(pid, key, window_id, flag)
	pid_t pid;
	void *key;
	Window window_id;
	int flag;
{
	int i;

	for (i = 0; i < childidx; i++) {
		if (childtab[i].pid == (pid_t)-1) {
			childtab[i].pid = pid;
			childtab[i].key = key;
			childtab[i].window_id = window_id;
			childtab[i].flag = flag;
			return;
		}
	}
	childtab[childidx].pid = pid;
	childtab[childidx].key = key;
	childtab[childidx].flag = flag;
	childtab[childidx].window_id = window_id;
	childidx++;
}

void
purgechild(flag)
	int flag;
{
	int i;

	for (i = 0; i < childidx; i++) {
		if (childtab[i].pid == (pid_t)-1)
			continue;
		if (childtab[i].flag == flag){
			kill(childtab[i].pid, SIGTERM);
		}
	}
}

static RETSIGTYPE
waitkids(sig)
	int sig;
{
	int status;
	int i;
	pid_t pid;

	if (sig != SIGCHLD) {
		fprintf(stderr, "signal different from expected: %d\n", sig);
		cleanup(-1);
	}
	while ((pid_t) 0 < (pid = waitpid(-1, &status, WNOHANG))) {
		for (i = 0; i < childidx; i++) {
			if (childtab[i].pid == pid) {
				childtab[i].pid = (pid_t)-1;
				childtab[i].window_id = (Window)-1;
			}
		}
	}
}

/* gucOS port (ticket #75): the upstream ctime poll is REPLACED by the
 * FS_WATCH drain — the kernel's path-keyed watch is the ONE reload
 * source, so every upstream call site (idle tick, Expose, ConfigureNotify)
 * now reacts to a settled save (including a tmp+rename-over, which the
 * path key survives) instead of stat()ing the deck per tick. The park in
 * frame_loop composes the same fd into the unified WAIT, so a save WAKES
 * a settled slide instead of waiting out the 2s idle cadence. -R keeps
 * its meaning (no watch is opened at all); no kernel watch (ENOSYS)
 * degrades to no auto-reload — ctrl-r still works. */
static int
wantreload()
{
	if (fsw_deck_fd < 0)
		return 0;
	return (fsw_drain(fsw_deck_fd) &
	    (FSW_BIT(FSW_CLOSE_WRITE) | FSW_BIT(FSW_OVERFLOW))) != 0;
}

/*
  remap child window which was invoked by xsystem directive.
  this is an adhoc solution for window-maker.
*/
void
remapchild()
{
	int	i;

	for (i = 0; i < childidx; i++) {
		if (childtab[i].window_id != (Window)0 && childtab[i].window_id != (Window)-1){
			XMapSubwindows(display, window);
			XFlush(display);
			return;
		}
	}
	return;
}
