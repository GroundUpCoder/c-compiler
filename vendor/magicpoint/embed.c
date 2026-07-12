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
 * $Id: embed.c,v 1.7 1999/01/05 03:37:31 itojun Exp $
 */

#include "mgp.h"
#include <dirent.h>

char *mgpwdir = DEFAULT_MGPWDIR;
char mgpwdirname[BUFSIZ] = "";

char *
allocpy(p)
	char *p;
{
	char *q;

	q = (char *)malloc(strlen(p) + 1);
	if (q == NULL) {
		fprintf(stderr, "malloc: %s\n", strerror(errno));
		cleanup(-1);
	}
	return strcpy(q, p);
}

char *
embed_fname(fname)
	char *fname;
{
	char buf[BUFSIZ];

	if (strncmp(fname, EMBEDDIR, strlen(EMBEDDIR)) != 0)
		return fname;
	fname += strlen(EMBEDDIR);
	if (*mgpwdirname == '\0') {	/* not initialized yet */
		sprintf(mgpwdirname, "%s/mgp.%d", mgpwdir, getpid());
		if (mkdir(mgpwdirname, 0700) < 0) {
			fprintf(stderr, "%s: %s\n", mgpwdirname,
				strerror(errno));
			cleanup(-1);
		}
	}
	sprintf(buf, "%s/%s", mgpwdirname, fname);
	return allocpy(buf);
}

void
embed_file(fp, p, lineno)
	FILE *fp;	/* stream to get data */
	struct ctrl *p;
	int *lineno;
{
	char buf[BUFSIZ];
	FILE *pp;
	struct stat st;
	int len;

	if (stat(mgpwdirname, &st) < 0) {
		fprintf(stderr, "no EMBED directory found\n");
		cleanup(-1);
	}

#ifdef UUDECODEOPT
# define UUDECODE_ALL	UUDECODE " " UUDECODEOPT
#else
#define UUDECODE_ALL	UUDECODE
#endif
	if ((pp = popen(UUDECODE_ALL, "w")) == NULL) {
		fprintf(stderr, "popen: %s\n", strerror(errno));
		cleanup(-1);
	}
	sprintf(buf, "%s/%s", mgpwdirname, p->ctc_value);
	if (access(buf, F_OK) == 0) {
		fprintf(stderr, "embedded filename duplicated: %s\n",
			p->ctc_value);
		cleanup(-1);
	}
	fprintf(pp, "begin 600 %s/%s\n", mgpwdirname, p->ctc_value);
	while (fgets(buf, sizeof(buf), fp)) {
		(*lineno)++;
		if (strncasecmp(buf, "%endembed", 9) == 0)
			break;
		fputs(buf, pp);
	}
	fprintf(pp, "end\n");
	pclose(pp);
	len = strlen(p->ctc_value);
	if (len > 3 && strncmp(p->ctc_value + len - 3, ".gz", 3) == 0) {
		sprintf(buf, "%s %s/%s", GUNZIP, mgpwdirname, p->ctc_value);
		system(buf);
	}
	return;
}

void
cleandir()		/* called by signal and quitting the mgp */ 
{
	DIR *dp;
	struct dirent *dep;
	char fname[BUFSIZ];

	if (*mgpwdirname == '\0')
		return;
	if ((dp = opendir(mgpwdirname)) == NULL) {
		fprintf(stderr, "%s: %s\n", mgpwdirname, strerror(errno));
		return;
	}
	while ((dep = readdir(dp))) {
		if (strcmp(dep->d_name, ".") == 0 ||
		    strcmp(dep->d_name, "..") == 0)
			continue;
		sprintf(fname, "%s/%s", mgpwdirname, dep->d_name);
		if (unlink(fname)) {
			fprintf(stderr, "unlink of %s: %s", fname,
				strerror(errno));
		}
	}
	closedir(dp);
	rmdir(mgpwdirname);
}
