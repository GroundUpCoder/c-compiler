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
 * $Id: parse.c,v 1.103 2007/11/24 17:35:28 nishida Exp $
 */

#include "mgp.h"
#ifdef HAVE_FCNTL_H
# include <fcntl.h>
#endif

static struct ctrl *parse_text __P((char *, u_int));
static void read_rc __P((FILE *, char *));
static void read_file __P((FILE *, char *, u_int *, u_int *, int));
static void secondpass __P((void));
static void thirdpass __P((void));
static void debug __P((void));
static int define_font __P((struct ctrl *));
static struct ctrl *find_font __P((char *));
static char* clear_esc __P((char*));

/*image*/
extern int findImage __P((char *, char *));

/* lex/yacc variables */
extern int n_errors;
extern struct ctrl *root;
extern char *yyfilename;
extern int yylineno;
extern void lex_init(char *);
extern int yyparse (void);

static int filterval = 0;

void
load_file(filename)
	char *filename;
{
	FILE *fp;
	u_int page;
	u_int line;
	char rc[MAXPATHLEN];
	char *dir;

	page = 1;
	line = 0;

	if((dir = getenv("MGPRC"))!=0) {
		fp = fopen(dir,"r");
		if(fp != NULL) {
          read_rc(fp,dir);
		} else {
          fprintf(stderr,"cannot open MGPRC File '%s'!\n",dir);
		}
	} else {
      dir = getenv("HOME");
      if (dir) {
		snprintf(rc, sizeof(rc), "%s/%s", dir, RCFILE);
		fp = fopen(rc, "r");
		if (fp) {
			read_rc(fp, rc);
			fclose(fp);	
		}
      }
    }
	
	if ((fp = fopen(filename, "r")) == NULL) {
		fprintf(stderr, "can't open %s\n", filename);
		exit(-1);
	}
	read_file(fp, filename, &page, &line, 1);
	fclose(fp);
	secondpass();
	thirdpass();
	
	if (parse_debug)
		debug();
}

void
cleanup_file()
{
	u_int line;
	u_int page;

	for (line = 0; line < MAXLINE; line ++) {
		if (default_control[line]) {
			ctlfree(default_control[line]);
			default_control[line] = NULL;
		}
		if (init_control[line]) {
			ctlfree(init_control[line]);
			init_control[line] = NULL;
		}
	}
	for (page = 0; page < MAXPAGE; page ++) {
		for (line = 0; line < MAXLINE; line ++) {
			if (!page_control[page][line])
				continue;
			ctlfree(page_control[page][line]);
			page_control[page][line] = NULL;
		}
		memset(&page_attribute[page], 0, sizeof(page_attribute[page]));
	}
	for (line = 0; line < MAXTAB + MAXSTYLE; line++) {
		if (!tab_control[line])
			continue;
		ctlfree(tab_control[line]);
		tab_control[line] = NULL;
	}
	for (line = 0; line < MAXFONTDEF; line++) {
		if (!fontdef_control[line])
			continue;
		ctlfree(fontdef_control[line]);
		fontdef_control[line] = NULL;
	}
}

/*
 * clear the given data from escape sequences, so identifying
 * a character by its hexadecimal value is possible by using \xHH
 */
static char*
clear_esc(s)
	char* s;
{
	char* p;
	int len;
	int i;
	int j;
	int k;
	int error = 0;
	int unicode = 0;
	int chars;
	unsigned int code;

	i = j = 0;
	len = strlen(s);
	p = (char*)malloc(len + 1);

	while (i < len)
	{
		code = 0x0;

		/*
		 * expecting either beginning of unicode or
		 * an ascii-character (may be an escape sequence)
		 */
		if (!unicode) {
			/* beginning of unicode */
			if (s[i] == 0x1b && s[i+1] == '$' &&
				'@' <= s[i+2] && s[i+2] < 'C') {
				unicode = 1;

				for (chars = 0; chars < 3; chars++)
					p[j++] = s[i++];

				continue;
			}

			/* backslash */
			if (s[i] == 0x5c) {
				i++;
	
				/* any escape sequence */
				if (s[i] != 0x5c) {

					 /* hexadecimal token: \xHH */
					if ((s[i] == 'x' || s[i] == 'X') && i+2 < len) {
						i++;
	
						if (isxdigit(s[i]) && isxdigit(s[i+1])) {
							for (k = 2; k > 0; k--, i++) {
								code <<= 4;
	
								if (isdigit(s[i]))
									code += s[i] - 48;
								else
									code += tolower(s[i]) - 87;
							}
						} else
							error = 1;
					} else
						error = 1;
				}
			}
			if (error)
				return (char*) NULL;

			if (code == 0x0)
				p[j++] = s[i++];
			else
				p[j++] = code;
		} else {
			/*
			 * expecting either the end of unicode or
			 * a part of a unicode character
			 */

			/* end of unicode */
			if (s[i] == 0x1b && s[i+1] == '(' &&
				(s[i+2] == 'B' || s[i+2] == 'J')) {
				unicode = 0;

				for (chars = 0; chars < 3; chars++)
					p[j++] = s[i++];
				
				continue;
			}

			/* just take the unicode character */
			p[j++] = s[i++];
		}
	}
	p[j] = 0x0;
	strcpy(s, p);
	free(p);

	return s;
}
	
static struct ctrl *
parse_text(p, page)
	char *p;
	u_int page;
{
	struct ctrl sentinel;
	struct ctrl *cp;

	assert(p);

	cp = &sentinel;

	cp->ct_next = ctlalloc1(CTL_TEXT);
	if (!cp->ct_next) {
		ctlfree(cp);
		return NULL;
	}
	cp = cp->ct_next;
	cp->ct_page = page;
	cp->ctc_value = strdup(p);

	return sentinel.ct_next;
}

/*
 * read ~/.mgprc: there's no percentage sign
 */
static void
read_rc(fp, filename)
	FILE *fp;
	char *filename;
{
	char buf[BUFSIZ];
#if 0
	struct ctrl *cp;
#endif
	int lineno;

	if (2 <= parse_debug)
		fprintf(stderr, "read_rc(%s):\n", filename);

	lineno = 0;
	while (fgets(buf, sizeof(buf), fp) != NULL) {
		lineno++;
		if (buf[strlen(buf) - 1] == '\n')
			buf[strlen(buf) - 1] = '\0';
		if (buf[0] == '#' || !buf[0])
			continue;

		yyfilename = filename;
		yylineno = lineno;

		lex_init(buf);
		if (yyparse() || n_errors) {
			fprintf(stderr, "%s:%d: fatal syntax error detected\n",
				filename, lineno);
			exit(-1);
		}

		if (!root) {
			fprintf(stderr, "%s:%d: something bad happened\n",
				filename, lineno);
			exit(-1);
		}
		if (2 <= parse_debug) {
			fprintf(stderr, "%s:%d: %s\n", filename, lineno, buf);
			debug1(root);
		}

		switch (root->ct_op) {
#if 0
		case CTL_DEFFONT:
			/* safety check */
			for (cp = root; cp; cp = cp->ct_next) {
				if (cp->ct_op == CTL_FONT) {
					fprintf(stderr,
"%s:%d: %%font used in %%deffont, which is disallowed\n",
						filename, lineno);
					exit(-1);
				}
			}

			if (define_font(root) < 0) {
				fprintf(stderr, "%s:%d: could not define "
					"font \"%s\"\n", filename, lineno,
					root->ctc_value);
				exit(-1);
			}
			break;
#endif
#ifdef VFLIB
		case CTL_VFCAP:
			vfcap_name = root->ctc_value;
			break;
#endif
#ifdef FREETYPE
		case CTL_TFDIR:
			freetypefontdir = root->ctc_value;
			break;
		case CTL_TFONT0:
			freetypefont0 = root->ctc_value;
			break;
		case CTL_TMFONT0:
			freetypemfont0 = root->ctc_value;
			break;
#endif
		case CTL_NOOP:
			/* done in grammar.y */
			break;
		default:
			fprintf(stderr, "%s:%d: operator disallowed:\n\t",
				filename, lineno);
			debug0(root);
			exit(-1);
		}
	}
}

static void
read_file(fp, filename, page, line, preamble)
	FILE *fp;
	char *filename;
	u_int *page;
	u_int *line;
	int preamble;
{
	char buf[BUFSIZ];
	char buf2[BUFSIZ];
	struct ctrl **ch;
	struct ctrl *cp;
	struct ctrl *p;
	int line_cont;
	char *infilename;
	struct ctrl *filtermode;
	int filterfd = -1;
	char filtername[MAXPATHLEN];
	pid_t filterpid = -1;
	void (*filtersig)() = (void (*)())NULL;
	int lineno;
	static char *searchpath[] = {
		"",	/*mgp_fname*/
#ifdef MGPLIBDIR
		MGPLIBDIR "/",
#endif
		NULL,
	};

	if (2 <= parse_debug)
		fprintf(stderr, "read_file(%s):\n", filename);

	filtername[0] = '\0';
	lineno = 0;

	if (!preamble)
		goto page;

	/*
	 * default analysis in preamble
	 */
	while (fgets(buf, sizeof(buf), fp) != NULL) {
		lineno++;
		if (buf[strlen(buf) - 1] == '\n')
			buf[strlen(buf) - 1] = '\0';

		if (buf[0] == '#')
			continue;
		if (buf[0] != '%') {
			fprintf(stderr, "%s:%d: no text allowed in preamble; "
				"ignored\n", filename, lineno);
			continue;
		}
		if (buf[1] == '%')
			continue;

		yyfilename = filename;
		yylineno = lineno;
		lex_init(buf + 1);
		if (yyparse() || n_errors) {
			fprintf(stderr, "%s:%d: fatal syntax error detected\n",
				filename, lineno);
			exit(-1);
		}
		if (!root) {
			fprintf(stderr, "%s:%d: something bad happened\n",
				filename, lineno);
			exit(-1);
		}
		if (2 <= parse_debug)
			debug1(root);

		switch (root->ct_op) {
		case CTL_PAGE:
			goto page;

		case CTL_INCLUDE:
		    {
			FILE *infp;

			infilename = root->ctc_value;
			searchpath[0] = mgp_fname;
			infp = fsearchopen(infilename, "r", searchpath);
			if (infp == NULL) {
				fprintf(stderr, "%s:%d: can't open "
					"include file \"%s\"\n",
					filename, lineno, infilename);
				exit(-1);
			}
			read_file(infp, infilename, page, line, 1);
			fclose(infp);
			continue;
		    }

		case CTL_DEFAULT:
			ch = &default_control[root->cti_value - 1];
			if (*ch)
				ctlappend(*ch, root->ct_next);
			else
				*ch = root->ct_next;
			break;

		case CTL_TAB:
		    {
			int i = root->cti_value;
			if (i < 0) {
				fprintf(stderr, "%s:%d: "
					"invalid tab index %d\n",
					filename, lineno, root->cti_value);
				exit(-1);
			}
			if (i >= MAXTAB) {	/*XXX*/
				/* must be a string */
				/* find a free entry */
				for (i = MAXTAB ; i < MAXTAB + MAXSTYLE ; i++) {
					if (!tab_control[i])
						continue;
					if (strcmp(tab_control[i]->ctc_value,
						    root->ctc_value) == 0) {
						ctlfree(tab_control[i]);
						tab_control[i] = NULL;
						break;
					}
				}

				for (i = MAXTAB ; i < MAXTAB + MAXSTYLE ; i++) {
					if (!tab_control[i])
						break;
				}
				if (i == MAXTAB + MAXSTYLE) {
					fprintf(stderr, "%s:%d: "
						"too many styles\n",
						filename, lineno);
					exit(-1);
				}
			}
			ch = &tab_control[i];
			if (*ch)
				ctlappend(*ch, root->ct_next);
			else if (i < MAXTAB)
				*ch = root->ct_next;
			else
				*ch = root; /* keep name as well */
		    }
			break;

		case CTL_DEFFONT:
			/* safety check */
			for (cp = root; cp; cp = cp->ct_next) {
				if (cp->ct_op == CTL_FONT) {
					fprintf(stderr,
"%s:%d: %%font used in %%deffont, which is disallowed\n",
						filename, lineno);
					exit(-1);
				}
			}

			if (define_font(root) < 0) {
				fprintf(stderr, "%s:%d: could not define "
					"font \"%s\"\n", filename, lineno,
					root->ctc_value);
				exit(-1);
			}
			break;

		default:
			fprintf(stderr, "%s:%d: invalid operator\n",
				filename, lineno);
			exit(-1);
		}
	}

	/*
	 * page analysis
	 */
page:
	line_cont = 0;
	filtermode = NULL;
command:
	while (fgets(buf, sizeof(buf), fp) != NULL) {
		lineno++;
		if (filtermode && strncmp(buf, "%endfilter", 10) != 0) {
			write(filterfd, buf, strlen(buf));
			continue;
		}
	    {
		char *p, *q, *s;
		int cnt;   /* counter for backslashes at the end of a line */

		p = buf + strlen(buf);
		if (buf < p && p[-1] == '\n') {
			p--;
			*p = '\0'; 
		}
		while (buf < p && p - buf < sizeof(buf) && p[-1] == '\\') {

			/*
			 * check for quoted backslashes at the end of a line:
			 * if it is so, then do NOT ignore the line break and
			 * continue as usual
			 */
			s = p;
			cnt = 0;
			while (buf < s && s[-1] == '\\') {
				s--;
				cnt++;
			}

			if (cnt % 2 == 0)
				break;

			p--;
			if (fgets(buf2, sizeof(buf) - (p - buf), fp) == NULL)
				break;
			q = buf2;
			/* ignore blanks */
			while (*q && isspace(*q))
				q++;
			strncpy(p, q, sizeof(buf) - (p - buf));
			p[sizeof(buf) - (p - buf) -1] = '\0';
			p += strlen(p);
			if (buf < p && p[-1] == '\n') {
				p--;
				*p = '\0'; 
			}
		}
	    }
		if (buf[0] == '#')
			continue;

		if (buf[0] == '%') {
			/* this is directive */
			int pb;
			int ct;
			int prevfiltermode;

			if (buf[1] == '%')
				continue;

			prevfiltermode = filtermode ? 1 : 0;

			yyfilename = filename;
			yylineno = lineno;
			lex_init(buf + 1);
			if (yyparse() || n_errors) {
				fprintf(stderr,
					"%s:%d: fatal syntax error detected !!!\n",
					filename, lineno);
				exit(-1);
			}
			if (!root) {
				fprintf(stderr,
					"%s:%d: something bad happened\n",
					filename, lineno);
				exit(-1);
			}
			if (2 <= parse_debug)
				debug1(root);

			cp = root;

			pb = ct = 0;
			for (p = cp; p; p = p->ct_next) {
				switch (p->ct_op) {
				case CTL_PAGE:
					pb++;
					break;
				case CTL_NODEF:
					page_attribute[*page].pg_flag
						|= PGFLAG_NODEF;
					break;
				case CTL_CONT:
					ct++;
					break;
				case CTL_FILTER:
					filtermode = p;
					break;
				case CTL_ENDFILTER:
					filtermode = NULL;
					break;
				case CTL_EMBED:
					embed_file(fp, p, &lineno);
					goto command;
				}
			}

			/* filter */
			if (!prevfiltermode && filtermode) {
				int filtertmp;
				int pipefd[2];

				if (mgp_flag & FL_NOFORK) {
					int i;
					if (mgp_flag & FL_VERBOSE) {
					    fprintf(stderr, "%s:%d: %%filter ",
						filename, lineno);
					    for (i = 0; i < cp->cta_argc; i++) {
						fprintf(stderr, "%c%s",
						    (i == 0) ? '"' : ' ',
						    cp->cta_argv[i]);
						}
						fprintf(stderr, "\": "
						    "directive skipped\n");
					}
					filterfd = open("/dev/null", O_WRONLY);
					strcpy(filtername, "/dev/null");
					continue;
				}

				/* gucOS port: %filter needs fork/exec of an
				 * arbitrary pipeline — always skip (the
				 * FL_NOFORK branch above handles reporting
				 * when -U was given too). */
				fprintf(stderr, "%s:%d: %%filter is not "
				    "supported in this port; skipped\n",
				    filename, lineno);
				filterfd = open("/dev/null", O_WRONLY);
				strcpy(filtername, "/dev/null");
				continue;
			} else if (prevfiltermode && !filtermode
			 && filtername[0]) {
				FILE *filterfp;
				int estat;

				if (mgp_flag & FL_NOFORK) {
					close(filterfd);
					filtername[0] = '\0';
					continue;
				}

				close(filterfd);
				waitpid(filterpid, &estat, 0);
				signal(SIGCHLD, filtersig);
				filterfp = fopen(filtername, "r");
				if (filterfp == NULL) {
					fprintf(stderr, "%s:%d: cant read "
						"filter output\n",
						filename, lineno);
					exit(-1);
				}
				read_file(filterfp, filtername, page, line, 0);
				fclose(filterfp);
				unlink(filtername);
				filtername[0] = '\0';
				continue;
			}

			if (pb) {
				/* Seen pagebreak. */
				page_attribute[*page].pg_linenum = *line;
				*page = *page + 1;
				*line = 0;
				continue;
			}
			if (ct)
				line_cont = 1;

			if (cp) {
				/*
				 * append to the currently existing
				 * page struct.
				 */
				ch = &page_control[*page][*line];

#if 0
				if (!line_cont &&
				    (/* cp->ct_op == CTL_IMAGE || */
				     cp->ct_op == CTL_BAR)) {
					struct ctrl *cp1;
					cp1 = ctlalloc1(CTL_LINESTART);
					if (cp1) {
						if (!*ch)
							*ch = cp1;
						else
							ctlappend(*ch, cp1);
					}
				}
#endif

				if (!*ch)
					*ch = cp;
				else
					ctlappend(*ch, cp);

				/*
				 * special case: %image and %bar has to be
				 * treated as independent item
				 */
				if (cp->ct_op == CTL_IMAGE
				 || cp->ct_op == CTL_ANIM
				 || cp->ct_op == CTL_BAR) {
					line_cont = 0;
					*line = *line + 1;
				}
			}
		} else {
			/* this is data */

			/*
			 * escape # and % by backslash (at the beginning
			 * of a line)
			 */
			if (buf[0] == 0x5c && (buf[1] == 0x23 ||
						buf[1] == 0x25))
				memcpy(&buf[0], &buf[1], strlen(buf));

			/*
			 * clear escape sequences
			 */
#if 1
			if (clear_esc(buf) == NULL) {
				fprintf(stderr, "%s:%d: unknown escape"
						" sequence\n",
						filename, lineno);
				exit(-1);
			}
#endif

			cp = parse_text(buf, *page);
			if (cp) {
				ch = &page_control[*page][*line];
				if (!*ch)
					*ch = cp;
				else
					ctlappend(*ch, cp);
			}
			line_cont = 0;

			*line = *line + 1;
		}
	}

	/* Treat as we've seen pagebreak.  See the above comment for detail. */
	page_attribute[*page].pg_linenum = *line;
#if 0
	*page = *page + 1;
	*line = 0;
#endif

	maxpage = *page;
}

/*
 * rather simple rewrites.
 */
static void
secondpass()
{
	u_int page;
	u_int l, text;
	struct ctrl **ch;
	struct ctrl *cp;
	struct ctrl *cp1;

	/*
	 * add CTL_PAUSE to the last line of a page.
	 * we don't add one at the last page, intentionally.
	 */
	for (page = 1; page < maxpage; page++) {
		l = page_attribute[page].pg_linenum;

		ch = &page_control[page][l + 1];
		cp = ctlalloc1(CTL_PAUSE);
		if (cp) {
			cp->cti_value = 1;	/* 1 indicates page end */
			if (!*ch)
				*ch = cp;
			else
				ctlappend(*ch, cp);
		}
		page_attribute[page].pg_linenum++;
	}

	/*
	 * split GAP into VGAP and HGAP.
	 */
	for (page = 1; page <= maxpage; page++) {
		text = 1;
		for (l = 0; l <= page_attribute[page].pg_linenum; l++) {
			for (cp = page_control[page][l];
			     cp;
			     cp = cp->ct_next) {
				if (cp->ct_op == CTL_GAP) {
					cp->ct_op = CTL_VGAP;
					cp1 = ctlalloc1(CTL_HGAP);
					cp1->cti_value = cp->cti_value;
					cp1->ct_next = cp->ct_next;
					cp->ct_next = cp1->ct_next;
				}

				/*
				 * check if this page contains only texts
				 */
				if (cp->ct_op == CTL_BIMAGE || cp->ct_op == CTL_BGRAD ||
					cp->ct_op == CTL_IMAGE  || 
#ifdef MNG
					cp->ct_op == CTL_ANIM   || 
#endif /* MNG */
					(cp->ct_op == CTL_PAUSE 
					 	&& l != page_attribute[page].pg_linenum)) {
						text = 0; 
					}
				}
		}
		page_attribute[page].pg_text = text;
	}


	/* CTL_PREFIX in tab_control should be CTL_TABPREFIX. */
	for (l = 0; l < MAXTAB + MAXSTYLE; l++) {
		for (cp = tab_control[l]; cp; cp = cp->ct_next) {
			if (cp->ct_op == CTL_PREFIX)
				cp->ct_op = CTL_TABPREFIX;
			if (cp->ct_op == CTL_PREFIXN)
				cp->ct_op = CTL_TABPREFIXN;
		}
	}
}

/*
 * rather complex rewrites.  ordering is VERY important.
 */
static void
thirdpass()
{
	u_int page;
	u_int line;
	u_int l;
	struct ctrl **ch;
	struct ctrl *cp;
	struct ctrl *cp1;
	struct ctrl *cp2;
	struct ctrl *cpt;
	char *p;
	struct ctrl *carryover[MAXPAGE];

    {
	/*
	 * there are several control items that are to be carried
	 * over to the next line.  make them explicit so that there'll
	 * be no bogus control items to be used when we go back a page.
	 */
	struct ctrl *tmpstr[10];
	struct ctrl *tmpint[10];
	struct ctrl *tmplong[10];
	struct ctrl *tmpvoid[10];
	struct ctrl *tmparea[10];
	struct ctrl sentinel;
	int i;

	memset(carryover, 0, sizeof(carryover));
	memset(tmpstr, 0, sizeof(tmpstr));
	memset(tmpint, 0, sizeof(tmpint));
	memset(tmplong, 0, sizeof(tmplong));
	memset(tmpvoid, 0, sizeof(tmpvoid));
	memset(tmparea, 0, sizeof(tmparea));

	/* default value for page 1 */
	tmpstr[0] = ctlalloc1(CTL_PREFIX);
	tmpstr[0]->ctc_value = strdup("");
#if defined(VFLIB) && defined(VFONT)
	tmpstr[1] = ctlalloc1(CTL_VFONT);
	tmpstr[1]->ctc_value = strdup(VFONT);		/*XXX*/
#else
	tmpstr[1] = ctlalloc1(CTL_NOOP);
	tmpstr[1]->ctc_value = strdup("");
#endif
	tmpstr[2] = ctlalloc1(CTL_XFONT2);
	tmpstr[2]->ctc2_value1 = strdup(DEFAULT_X_FONT);
	tmpstr[2]->ctc2_value2 = strdup("iso8859-1");
#ifdef FREETYPE
	tmpstr[3] = ctlalloc1(CTL_TFONT);
	tmpstr[3]->ctc2_value1 = strdup(freetypefont0 ? freetypefont0 :"arial.ttf");
	tmpstr[3]->ctc2_value2 = strdup("iso8859-1");
#else
	tmpstr[3] = ctlalloc1(CTL_NOOP);	/* CTL_TFONT */
	tmpstr[3]->ctc_value = strdup("");
#endif
#ifdef FREETYPE_CHARSET16
	tmpstr[4] = ctlalloc1(CTL_TMFONT);	/* CTL_TMFONT */
	tmpstr[4]->ctc_value = strdup("wadalab-gothic.ttf");
#else
	tmpstr[4] = ctlalloc1(CTL_NOOP);	/* CTL_TMFONT */
	tmpstr[4]->ctc_value = strdup("");
#endif
	tmpstr[5] = ctlalloc1(CTL_XFONT2);
	tmpstr[5]->ctc2_value1 = strdup("k14");
	tmpstr[5]->ctc2_value2 = strdup("jisx0208.1983-*");
#ifdef USE_M17N
	if (! (mgp_flag & FL_NOM17N)) {
		tmpstr[6] = ctlalloc1(CTL_M17N);
		tmpstr[6]->ctc2_value1 = strdup("fontset");
		tmpstr[6]->ctc2_value2 = NULL;
		tmpstr[7] = ctlalloc1(CTL_M17N);
		tmpstr[7]->ctc2_value1 = strdup("family");
		tmpstr[7]->ctc2_value2 = NULL;
		tmpstr[8] = ctlalloc1(CTL_M17N);
		tmpstr[8]->ctc2_value1 = strdup("language");
		tmpstr[8]->ctc2_value2 = NULL;
	} else
#endif
	{
		tmpstr[6] = ctlalloc1(CTL_NOOP);	
		tmpstr[6]->ctc_value = strdup("");
		tmpstr[7] = ctlalloc1(CTL_NOOP);	
		tmpstr[7]->ctc_value = strdup("");
		tmpstr[8] = ctlalloc1(CTL_NOOP);	
		tmpstr[8]->ctc_value = strdup("");
	}

	tmplong[0] = ctlalloc1(CTL_FORE);
	get_color(DEFAULT_FORE, &tmplong[0]->ctl_value);
	tmplong[1] = ctlalloc1(CTL_BACK);
	get_color(DEFAULT_BACK, &tmplong[1]->ctl_value);
	tmplong[2] = ctlalloc1(CTL_CCOLOR);
	get_color(DEFAULT_FORE, &tmplong[2]->ctl_value);
	tmpint[0] = ctlalloc1(CTL_SIZE);
	tmpint[0]->ctf_value = DEFAULT_CHARSIZE;
	tmpint[1] = ctlalloc1(CTL_HGAP);
	tmpint[1]->cti_value = DEFAULT_HGAP;
	tmpint[2] = ctlalloc1(CTL_VGAP);
	tmpint[2]->cti_value = DEFAULT_VGAP;
	tmpint[3] = ctlalloc1(CTL_QUALITY);
	tmpint[3]->cti_value = DEFAULT_BQUALITY;
#ifdef USE_XFT2
	tmpint[4] = ctlalloc1(CTL_OPAQUE);
	tmpint[4]->cti_value = DEFAULT_OPAQUE;
#endif
	tmpvoid[0] = ctlalloc1(CTL_LEFT);
	tmparea[0] = ctlalloc1(CTL_AREA);
	tmparea[0]->ctar_width = 100;
	tmparea[0]->ctar_height = 100;
	tmparea[0]->ctar_xoff = 0;
	tmparea[0]->ctar_yoff = 0;

	/* for page 1 */
	cp = &sentinel;
	for (i = 0; i < 10; i++) {
		if (!tmpstr[i])
			continue;
		cp->ct_next = ctlalloc1(tmpstr[i]->ct_op);
		if (ctl_words[tmpstr[i]->ct_op].ctl_vtype == T_STR2) {
			if (tmpstr[i]->ctc2_value1) {
				cp->ct_next->ctc2_value1 =
					strdup(tmpstr[i]->ctc2_value1);
			} else
				cp->ct_next->ctc2_value1 = NULL;
			if (tmpstr[i]->ctc2_value2) {
				cp->ct_next->ctc2_value2 =
					strdup(tmpstr[i]->ctc2_value2);
			} else
				cp->ct_next->ctc2_value2 = NULL;
		} else {
			if (tmpstr[i]->ctc_value) {
				cp->ct_next->ctc_value =
					strdup(tmpstr[i]->ctc_value);
			} else
				cp->ct_next->ctc_value = NULL;
		}
		cp = cp->ct_next;
	}
	for (i = 0; i < 10; i++) {
		if (!tmplong[i])
			continue;
		cp->ct_next = ctlalloc1(tmplong[i]->ct_op);
		cp->ct_next->ctl_value = tmplong[i]->ctl_value;
		cp = cp->ct_next;
	}
	for (i = 0; i < 10; i++) {
		if (!tmpint[i])
			continue;
		cp->ct_next = ctlalloc1(tmpint[i]->ct_op);
		cp->ct_next->ct_val = tmpint[i]->ct_val;
		cp = cp->ct_next;
	}
	for (i = 0; i < 10; i++) {
		if (!tmpvoid[i])
			continue;
		cp->ct_next = ctlalloc1(tmpvoid[i]->ct_op);
		cp = cp->ct_next;
	}
	for (i = 0; i < 10; i++) {
		if (!tmparea[i])
			continue;
		cp->ct_next = ctlalloc1(tmparea[i]->ct_op);
		cp->ct_next->ctar_width = tmparea[i]->ctar_width;
		cp->ct_next->ctar_height = tmparea[i]->ctar_height;
		cp->ct_next->ctar_xoff = tmparea[i]->ctar_xoff;
		cp->ct_next->ctar_yoff = tmparea[i]->ctar_yoff;
		cp = cp->ct_next;
	}
	carryover[0] = sentinel.ct_next;

	/*
	 * parse through the pages, remember what kind of directives are there.
	 */
	for (page = 1; page <= maxpage; page++) {
		for (l = 0; l <= page_attribute[page].pg_linenum; l++) {
			for (cp = page_control[page][l];
			     cp;
			     cp = cp->ct_next) {
				switch (cp->ct_op) {
				case CTL_PREFIX: tmpstr[0] = cp; break;
				case CTL_VFONT: tmpstr[1] = cp; break;
				case CTL_TFONT: tmpstr[3] = cp; break;
#ifdef FREETYPE_CHARSET16
				case CTL_TMFONT: tmpstr[4] = cp; break;
#endif
				case CTL_XFONT2:
					if (strcmp(cp->ctc2_value2,
							"iso8859-1") == 0) {
						tmpstr[2] = cp;
						break;
					}
				    {
					struct ctrl **cpe;	/*empty cp*/
					cpe = (struct ctrl **)NULL;
					for (i = 5; i < 10; i++) {
					    if (!tmpstr[i]) {
						if (!cpe)
						    cpe = &tmpstr[i];
						continue;
					    }
					    if (strcmp(cp->ctc2_value2,
						tmpstr[i]->ctc2_value2) == 0) {
						    tmpstr[i] = cp;
						    goto xfont_ok;
					    }
					}
					if (cpe)
					    *cpe = cp;
				    xfont_ok:
					break;
				    }

				case CTL_FORE: tmplong[0] = cp; break;
				case CTL_BACK: tmplong[1] = cp; break;
				case CTL_CCOLOR: tmpint[2] = cp; break;

				case CTL_SIZE: tmpint[0] = cp; break;
				case CTL_HGAP: tmpint[1] = cp; break;
				case CTL_VGAP: tmpint[2] = cp; break;
				case CTL_QUALITY: tmpint[3] = cp; break;
				case CTL_OPAQUE: tmpint[4] = cp; break;

				case CTL_LEFT: tmpvoid[0] = cp; break;
				case CTL_RIGHT: tmpvoid[0] = cp; break;
				case CTL_CENTER: tmpvoid[0] = cp; break;
				case CTL_LEFTFILL: tmpvoid[0] = cp; break;

				case CTL_AREA: tmparea[0] = cp; break;
				}
			}
		}

		cp = &sentinel;
		for (i = 0; i < 10; i++) {
			if (!tmpstr[i])
				continue;
			cp->ct_next = ctlalloc1(tmpstr[i]->ct_op);
			if (ctl_words[tmpstr[i]->ct_op].ctl_vtype == T_STR2) {
				if (tmpstr[i]->ctc2_value1) {
					cp->ct_next->ctc2_value1 =
						strdup(tmpstr[i]->ctc2_value1);
				} else
					cp->ct_next->ctc2_value1 = NULL;
				if (tmpstr[i]->ctc2_value2) {
					cp->ct_next->ctc2_value2 =
						strdup(tmpstr[i]->ctc2_value2);
				} else
					cp->ct_next->ctc2_value2 = NULL;
			} else {
				if (tmpstr[i]->ctc_value) {
					cp->ct_next->ctc_value =
						strdup(tmpstr[i]->ctc_value);
				} else
					cp->ct_next->ctc_value = NULL;
			}
			cp = cp->ct_next;
		}
		for (i = 0; i < 10; i++) {
			if (!tmplong[i])
				continue;
			cp->ct_next = ctlalloc1(tmplong[i]->ct_op);
			cp->ct_next->ctl_value = tmplong[i]->ctl_value;
			cp = cp->ct_next;
		}
		for (i = 0; i < 10; i++) {
			if (!tmpint[i])
				continue;
			cp->ct_next = ctlalloc1(tmpint[i]->ct_op);
			cp->ct_next->ct_val = tmpint[i]->ct_val;
			cp = cp->ct_next;
		}
		for (i = 0; i < 10; i++) {
			if (!tmpvoid[i])
				continue;
			cp->ct_next = ctlalloc1(tmpvoid[i]->ct_op);
			cp = cp->ct_next;
		}
		for (i = 0; i < 10; i++) {
			if (!tmparea[i])
				continue;
			cp->ct_next = ctlalloc1(tmparea[i]->ct_op);
			cp->ct_next->ctar_width = tmparea[i]->ctar_width;
			cp->ct_next->ctar_height = tmparea[i]->ctar_height;
			cp->ct_next->ctar_xoff = tmparea[i]->ctar_xoff;
			cp->ct_next->ctar_yoff = tmparea[i]->ctar_yoff;
			cp = cp->ct_next;
		}

		carryover[page] = sentinel.ct_next;
	}
    }

	/* add default directives to each line */
	for (page = 1; page <= maxpage; page++) {
		if (page_attribute[page].pg_flag & PGFLAG_NODEF)
			continue;
		line = page_attribute[page].pg_linenum;
		for (l = 0; l <= line; l++) {
			int contseen;
			contseen = 0;	
			ch = &page_control[page][l];
			/* 
			 * if this line contains CTL_CONT, we don't add 
			 * default directive to this line 
			 */
			for (cp = page_control[page][l]; cp; cp = cp->ct_next) {
				if (cp->ct_op == CTL_CONT) {
					contseen++;
					break;
				}
			}
			if (default_control[l] && !contseen) {
				ctlinsert(ch, ctlcopy(default_control[l]));
			}
		}
	}

	/*
	 * add carryover directives to each page.
	 * default directive has priority over the carryover items,
	 * so carryover items should appear earlier than default directive.
	 */
	for (page = 1; page <= maxpage; page++) {
		ch = &page_control[page][0];
		if (carryover[page - 1])
			ctlinsert(ch, carryover[page - 1]);
	}

	/*
	 * add CTL_LINEEND and CTL_LINESTART to each lines that contain
	 * CTL_TEXT/CTL_IMAGE/CTL_BAR/CTL_ICON.
	 * note that we must carefully handle CTL_CONT.
	 */
    {
	int textseen;
	int contseen;
	for (page = 1; page <= maxpage; page++) {
		line = page_attribute[page].pg_linenum;
		for (l = 0; l <= line; l++) {
			textseen = 0;
			for (cp = page_control[page][l];
			     cp;
			     cp = cp->ct_next) {
				if (cp->ct_op == CTL_TEXT
				 || cp->ct_op == CTL_IMAGE
				 || cp->ct_op == CTL_BAR
#ifdef MNG
				 || cp->ct_op == CTL_ANIM
#endif /* MNG */
				 || cp->ct_op == CTL_ICON) {
					textseen++;
					break;
				}
			}

			if (!textseen)
				continue;

			/*
			 * check if the line #l includes CONT directive.
			 * if it has, don't add LINESTART to the line #l.
			 */
			contseen = 0;
			for (cp = page_control[page][l];
			     cp;
			     cp = cp->ct_next) {
				if (cp->ct_op == CTL_CONT) {
					contseen++;
					break;
				}
			}
			if (!contseen) {
				cp = ctlalloc1(CTL_LINESTART);
				if (cp) {
				    for (ch = &page_control[page][l];
					 ch && *ch;
					 ch = &((*ch)->ct_next)) {
					if ((*ch)->ct_op == CTL_TEXT
					 || (*ch)->ct_op == CTL_IMAGE
					 || (*ch)->ct_op == CTL_BAR
#ifdef MNG
					 || (*ch)->ct_op == CTL_ANIM
#endif /* MNG */
					 || (*ch)->ct_op == CTL_ICON) {
					    break;
					}
				    }
				    ctlinsert(ch,  cp);
				}
			}

			/*
			 * check if the line #(l+1) includes CONT directive.
			 * if it has, don't add LINEEND to the line #l.
			 */
			contseen = 0;
			if (l + 1 <= line) {
				for (cp = page_control[page][l + 1];
				     cp;
				     cp = cp->ct_next) {
					if (cp->ct_op == CTL_CONT) {
						contseen++;
						break;
					}
				}
			}
			if (!contseen) {
				cp2 = NULL;
				for (cp1 = page_control[page][l];
				     cp1;
				     cp1 = cp1->ct_next) {
					if (cp1->ct_op == CTL_TEXT
					 || cp1->ct_op == CTL_IMAGE
					 || cp1->ct_op == CTL_BAR
#ifdef MNG
					 || cp1->ct_op == CTL_ANIM
#endif /* MNG */
					 || cp1->ct_op == CTL_ICON) {
					    cp2 = cp1;
					}
				}
				/* cp2 has the last TEXT/IMAGE/whatever */
				if (cp2) {
					cp = ctlalloc1(CTL_LINEEND);
					if (cp)
						ctlinsert(&(cp2->ct_next),  cp);
				}
			}
		}
		if (contseen){
			/* we have extra cont in the last line */
			for (cp2 = page_control[page][line-1];
				cp2->ct_next; cp2 = cp2->ct_next); 
			cp = ctlalloc1(CTL_LINEEND);
			if (cp) ctlinsert(&(cp2->ct_next),  cp);
		}
	}
    }

	/* insert CTL_TAB */
	for (page = 1; page <= maxpage; page++) {
		line = page_attribute[page].pg_linenum;
		for (l = 0; l <= line; l++) {
			int tab_depth = 0;
			/*
			 * if we don't have CTL_LINESTART, we don't add
			 * directives here.
			 */
			cp = page_control[page][l];
			while (cp && cp->ct_op != CTL_LINESTART)
				cp = cp->ct_next;
			if (!cp)
				continue;

			/* cp2: CTL_LINESTART */
			cp2 = cp1 = cp;
			while (cp && cp->ct_op != CTL_TEXT) {
				cp1 = cp;
				cp = cp->ct_next;
			}
			if (!cp)
				continue;
			if (cp1->ct_next != cp)
				continue;
			p = cp->ctc_value;
			if (p && *p == '\t') {
				p++;
				tab_depth++;
				while (*p == '\t') {
					tab_depth++;
					p++;
				}
				if (p) {
					char *tmp;

					tmp = cp->ctc_value;
					p = cp->ctc_value = strdup(p);
					free(tmp);
				}
			}

#if 0
			/* insert CTL_TAB items into CTL_LINESTART */
			if (tab_control[tab_depth]) {
				ctlinsert(&cp1->ct_next,
				    ctlcopy(tab_control[tab_depth]));
			}
#else
			if (tab_control[tab_depth]) {
				ch = &page_control[page][l];
				for (cpt = tab_control[tab_depth]; cpt; cpt = cpt->ct_next){
					/* Thses ctrl items should be in CTL_LINESTART */
					if (cpt->ct_op == CTL_IMAGE || cpt->ct_op == CTL_TABPREFIX ||
							cpt->ct_op == CTL_ICON){
						ctlinsert(&cp1->ct_next, ctlcopy1(cpt));
						cp1 = cp1->ct_next; 
					} else
					/* other ctrl items should be in the head of the ctrls */
						ctlinsert(ch, ctlcopy1(cpt));
				}
			}
#endif

			/* special: style escape */
			if (p && *p == '&') {
				char *p0;
				char *tmp;
				int i;

				p0 = p;
				while (*p && !isspace(*p))
					p++;

				tmp = cp->ctc_value;
				if (!*p)
					cp->ctc_value = strdup(p);
				else {
					*p++ = '\0';
					while (*p && isspace(*p))
						p++;
					cp->ctc_value = strdup(p);
				}

				for (i = MAXTAB; i < MAXTAB + MAXSTYLE ; i++) {
					if (tab_control[i]
					 && strcmp(p0 + 1, tab_control[i]->ctc_value) == 0)
						break;
				}
				if (i == MAXTAB + MAXSTYLE) {
					fprintf(stderr, "style %s not found\n",
						p0 + 1);
				} else {
					ctlinsert(&cp1->ct_next,
					    ctlcopy(tab_control[i]->ct_next));
				}
				free(tmp);
			}
		}
	}

	/* find where to put PREFIX. */
	for (page = 1; page <= maxpage; page++) {
		line = page_attribute[page].pg_linenum;
		for (l = 0; l <= line; l++) {
			for (cp = page_control[page][l]; cp; cp = cp->ct_next) {
				if (cp->ct_op == CTL_LINESTART)
					break;
			}
			if (!cp)
				continue;
			cp1 = cp;	/* cp1: CTL_LINESTART */

			for (cp = cp1; cp->ct_next; cp = cp->ct_next) {
				if (cp->ct_next->ct_op == CTL_TEXT
				 || cp->ct_next->ct_op == CTL_IMAGE
#ifdef MNG
				 || cp->ct_next->ct_op == CTL_ANIM
#endif /* MNG */
				 || cp->ct_next->ct_op == CTL_ICON) {
					break;
				}
			}
			if (!cp)
				continue;

			cp2 = ctlalloc1(CTL_PREFIXPOS);
			if (!cp2)
				continue;

			cp2->ct_next = cp->ct_next;
			cp->ct_next = cp2;
		}
	}

	/*
	 * CTL_FONT must be replaced with appropriate font def defined by
	 * CTL_DEFFONT.
	 */
	for (page = 1; page <= maxpage; page++) {
		for (l = 0; l <= page_attribute[page].pg_linenum; l++) {
			for (cp = page_control[page][l];
			     cp;
			     cp = cp->ct_next) {
				if (cp->ct_op == CTL_FONT) {
					cp->ct_op = CTL_NOOP;
					cp1 = find_font(cp->ctc_value);
					if (!cp1) {
						fprintf(stderr,
			"page %d line %d: font def for \"%s\" not found: ignored\n",
							page, l, cp->ctc_value);
						continue;
					}
					ctlinsert(&cp->ct_next,
						ctlcopy(cp1->ct_next));
				}
			}
		}
	}

	/*
	 * CTL_XFONT is now obsolete, use CTL_XFONT2.
	 */
	for (page = 1; page <= maxpage; page++) {
		for (l = 0; l <= page_attribute[page].pg_linenum; l++) {
			for (cp = page_control[page][l];
			     cp;
			     cp = cp->ct_next) {
				if (cp->ct_op == CTL_XFONT) {
					p = cp->ctc_value;
					cp->ct_op = CTL_XFONT2;
					cp->ctc2_value1 = p;
					cp->ctc2_value2 = strdup("iso8859-1");
				}
			}
		}
	}
}

void
debug0(p)
	struct ctrl *p;
{
	int i;

	fprintf(stderr, "%p: ", p);
	fprintf(stderr, " %s ", ctl_words[p->ct_op].ctl_string);

	switch (ctl_words[p->ct_op].ctl_vtype) {
	case T_STR:
		fprintf(stderr, "\"%s\"", p->ctc_value);
		break;
	case T_STR2:
		fprintf(stderr, "\"%s\" \"%s\"",
			p->ctc2_value1, p->ctc2_value2);
		break;
	case T_INT:
		fprintf(stderr, "%d", p->cti_value);
		break;
	case T_LONG:
		fprintf(stderr, "#%lx", p->ctl_value);
		break;
	case T_DOUBLE:
	        fprintf(stderr, "#%g", p->ctf_value);
	        break;
	case T_VOID:
		break;
	case T_SP:
		break;
	default:
		fprintf(stderr, "(UNDEFINED TYPE)");
	}

	if (ctl_words[p->ct_op].ctl_vtype != T_SP)
		goto done;

	switch (p->ct_op) {
	case CTL_PAUSE:
		fprintf(stderr, "(%s)",
			p->cti_value ? "page end" : "normal");
		break;
	case CTL_TAB:
		if (p->cti_value > MAXTAB)
			fprintf(stderr, "\"%s\"", p->ctc_value);
		else
			fprintf(stderr, "%d", p->cti_value);
		break;
	case CTL_SYSTEM:
	case CTL_XSYSTEM:
	case CTL_TSYSTEM:
	case CTL_FILTER:
		fprintf(stderr, "argc=%d term=%s flag=%d",
			p->cta_argc,
			p->cta_argv[p->cta_argc] ? "bad" : "good",
			p->cta_flag);
		for (i = 0; i < p->cta_argc; i++)
			fprintf(stderr, "%s ", p->cta_argv[i]);
		break;
	case CTL_BAR:
		fprintf(stderr, "color=#%lx width=%d start=%d length=%d",
			p->ctb_color, p->ctb_width,
			p->ctb_start, p->ctb_length);
		break;
	case CTL_BIMAGE:
	case CTL_IMAGE:
		fprintf(stderr, "file=%s colors=%d x=%d y=%d zoom=%d",
			p->ctm_fname, p->ctm_numcolor,
			p->ctm_ximagesize, p->ctm_yimagesize,
			p->ctm_zoomflag);
		break;
	case CTL_BGRAD:
		fprintf(stderr, "w=%d h=%d nc=%d dir=%d zoom=%d colors=%d",
			p->ctd_width, p->ctd_height,
			p->ctd_numcolor, p->ctd_dir,
			p->ctd_zoomflag, p->ctd_g_colors);
		break;
	case CTL_ICON:
		fprintf(stderr, "type=%s color=%x siz=%d",
			p->ctic_value, (int)p->ctic_color, (int) p->ctic_size);
		break;
	case CTL_VALIGN:
		fprintf(stderr, ((p->cti_value == VL_CENTER) ? "center"
				 : ((p->cti_value == VL_TOP) ? "top"
				    : ((p->cti_value == VL_BOTTOM) ? "bottom"
				       : "???"))));
		break;
	case CTL_AREA:
		fprintf(stderr, "xoff=%d w=%d yoff=%d h=%d",
			p->ctar_xoff, p->ctar_width,
			p->ctar_yoff, p->ctar_height);
		break;
	default:
		fprintf(stderr, "???");
	}

done:
	fprintf(stderr, "\n");
}

void
debug1(p)
	struct ctrl *p;
{
	while (p) {
		fprintf(stderr, "\t");
		debug0(p);
		p = p->ct_next;
	}
}

static void
debug()
{
	int page, line;

	for (line = 0; line < MAXLINE; line ++) {
		if (!default_control[line])
			continue;
		fprintf(stderr, "def line %d:\n", line);
		debug1(default_control[line]);
	}
	for (page = 0; page < MAXPAGE; page ++) {
		for (line = 0; line < MAXLINE; line ++) {
			if (!page_control[page][line])
				continue;
			fprintf(stderr, "page %d line %d:\n", page, line);
			debug1(page_control[page][line]);
		}
	}
}

int
chkfile(p)
	char *p;
{
	char buf[BUFSIZ];

	buf[0] = '\0';
	if (findImage(p, buf) >= 0) {
		if (parse_debug)
			fprintf(stderr, "File %s found\n", p);
		return 0;
	}
	fprintf(stderr, "File %s not found\n", p);
	parse_error++;
	return -1;
}

/*------------------------------------------------------------*/

struct ctrl *
ctllastitem(this)
	struct ctrl *this;
{
	struct ctrl *p;

	assert(this);
	p = this;
	while (p && p->ct_next)
		p = p->ct_next;

	return p;
}

void
ctlappend(to, this)
	struct ctrl *to;
	struct ctrl *this;
{
	struct ctrl *p;

	assert(to);
	assert(this);
	p = ctllastitem(to);
	p->ct_next = this;
}

void
ctlinsert(here, this)
	struct ctrl **here;
	struct ctrl *this;
{
	struct ctrl *p;
	struct ctrl *q;

	assert(here); assert(this);
	p = *here;
	*here = this;
	q = ctllastitem(this);
	q->ct_next = p;
}

struct ctrl *
ctlalloc1(op)
	u_int op;
{
	struct ctrl *p;

	p = (struct ctrl *)malloc(sizeof(struct ctrl));
	if (!p) {
		perror("malloc");
		exit(-1);
	}
	memset(p, 0, sizeof(struct ctrl));
	p->ct_op = op;
	p->ct_next = NULL;	/*just to make sure*/
	return p;
}

void
ctlfree(this)
	struct ctrl *this;
{
	struct ctrl *p;
	struct ctrl *q;

	assert(this);
	p = this;
	do {
		q = p->ct_next;
		free(p);
		p = q;
	} while (p);
}

struct ctrl *
ctlcopy(this)
	struct ctrl *this;
{
	struct ctrl *dst0;
	struct ctrl *dst;
	struct ctrl *src;

	src = this;
	if (!src)
		return NULL;
	dst = dst0 = ctlalloc1(0);
	memcpy(dst, src, sizeof(struct ctrl));
	src = src->ct_next;
	while (src) {
		dst->ct_next = ctlalloc1(0);
		dst = dst->ct_next;
		memcpy(dst, src, sizeof(struct ctrl));
		src = src->ct_next;
	}

	return dst0;
}

struct ctrl *
ctlcopy1(src)
	struct ctrl *src;
{
	struct ctrl *dst;
	if (!src)
		return NULL;
	dst = ctlalloc1(0);
	memcpy(dst, src, sizeof(struct ctrl));
	dst->ct_next = NULL;
	return dst;
}

int
ctlcmp(a, b)
	struct ctrl *a;
	struct ctrl *b;
{
	int i;

	assert(a);
	assert(b);

	if (a->ct_op != b->ct_op)
		return 1;
	if (a->ct_flag != b->ct_flag)
		return 1;

	switch (ctl_words[a->ct_op].ctl_vtype) {
	case T_STR:
		return strcmp(a->ctc_value, b->ctc_value);
	case T_STR2:
		if (strcmp(a->ctc2_value1, b->ctc2_value1) == 0
		 && strcmp(a->ctc2_value2, b->ctc2_value2) == 0) {
			return 0;
		} else
			return 1;
	case T_INT:
		return (a->cti_value == b->cti_value) ? 0 : 1;
	case T_LONG:
		return (a->ctl_value == b->ctl_value) ? 0 : 1;
	case T_DOUBLE:
		return (a->ctf_value == b->ctf_value) ? 0 : 1;
	case T_VOID:
		return 0;
	case T_SP:
		break;
	default:
		fprintf(stderr, "UNDEFINED TYPE in ctlcmp()\n");
		return 1;
	}

	switch (a->ct_op) {
	case CTL_TAB:
	case CTL_PAUSE:
		return (a->cti_value == b->cti_value) ? 0 : 1;
	case CTL_SYSTEM:
	case CTL_XSYSTEM:
	case CTL_TSYSTEM:
	case CTL_FILTER:
		return 1;
	case CTL_IMAGE:
	case CTL_BIMAGE:
		if (a->ctm_numcolor == b->ctm_numcolor
		 && a->ctm_ximagesize == b->ctm_ximagesize
		 && a->ctm_yimagesize == b->ctm_yimagesize
		 && a->ctm_zoomflag == b->ctm_zoomflag)
			return strcmp(a->ctm_fname, b->ctm_fname);
		else
			return 1;
	case CTL_BGRAD:
		if (a->ctd_g_colors == b->ctd_g_colors
		 && a->ctd_numcolor == b->ctd_numcolor
		 && a->ctd_dir == b->ctd_dir
		 && a->ctd_width == b->ctd_width
		 && a->ctd_height == b->ctd_height
		 && a->ctd_zoomflag == b->ctd_zoomflag) {
			for (i = 0; i < a->ctd_g_colors; i++) {
				if (memcmp(a->ctd_colors[0], b->ctd_colors[0],
						sizeof(struct g_color)) != 0)
					return 1;
			}
			return 0;
		} else
			return 1;
	case CTL_BAR:
		if (a->ctb_color == b->ctb_color
		 && a->ctb_width == b->ctb_width
		 && a->ctb_start == b->ctb_start
		 && a->ctb_length == b->ctb_length)
			return 0;
		else
			return 1;
	case CTL_ICON:
		if (strcmp(a->ctic_value, b->ctic_value) == 0
		 && a->ctic_color == b->ctic_color
		 && a->ctic_size == b->ctic_size)
			return 0;
		else
			return 1;
	default:
		assert(0);
	}
}

FILE *
fsearchopen(fname, mode, path)
	char *fname;
	char *mode;
	char **path;
{
	FILE *fp;
	char buf[MAXPATHLEN];
	char *p;
	int i;

	i = -1;
	fp = NULL;
	while (1) {
		p = (i == -1) ? "" : path[i];
		if (!p)
			break;
		strcpy(buf, p);
		if ((p = strrchr(buf, '/'))) {
			p[1] = '\0';
		}
		strcat(buf, fname);
		fp = fopen(buf, mode);
		if (fp)
			break;
		i++;
	}
	return fp;
}

static int
define_font(cp)
	struct ctrl *cp;
{
	int i;

	/* find duplicated def */
	for (i = 0; i < MAXFONTDEF; i++) {
		if (!fontdef_control[i])
			continue;
		if (strcmp(fontdef_control[i]->ctc_value,
				cp->ctc_value) == 0) {
			ctlfree(fontdef_control[i]);
			fontdef_control[i] = NULL;
			goto defineit;
		}
	}

	/* find empty def */
	for (i = 0; i < MAXFONTDEF; i++) {
		if (!fontdef_control[i])
			break;
	}
	if (i == MAXFONTDEF) {
		return -1;
	}

defineit:
	/* define it */
	fontdef_control[i] = cp;
	return 0;
}

static struct ctrl *
find_font(font)
	char *font;
{
	int i;

	/* find duplicated def */
	for (i = 0; i < MAXFONTDEF; i++) {
		if (!fontdef_control[i])
			continue;
		if (strcmp(fontdef_control[i]->ctc_value, font) == 0)
			return fontdef_control[i];
	}
	return NULL;
}
