/*
 * Copyright 2011 Daniel Silverstone <dsilvers@digital-scurf.org>
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

#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

#include "utils/log.h"
#include "utils/utils.h"
#include "utils/ring.h"

#include "monkey/dispatch.h"

typedef struct cmdhandler {
	struct cmdhandler *r_next, *r_prev;
	char *cmd;
	handle_command_fn fn;
} monkey_cmdhandler_t;

static monkey_cmdhandler_t *handler_ring = NULL;

nserror
monkey_register_handler(const char *cmd, handle_command_fn fn)
{
	monkey_cmdhandler_t *ret = calloc(1, sizeof(*ret));
	if (ret == NULL) {
		NSLOG(netsurf, INFO, "Unable to allocate handler");
		return NSERROR_NOMEM;
	}
	ret->cmd = strdup(cmd);
	ret->fn = fn;
	RING_INSERT(handler_ring, ret);
	return NSERROR_OK;
}

void
monkey_free_handlers(void)
{
	while (handler_ring != NULL) {
		monkey_cmdhandler_t *handler = handler_ring;
		RING_REMOVE(handler_ring, handler);
		free(handler->cmd);
		free(handler);
	}
}

/* Input is read with read(2) into this buffer rather than with fgets(3),
 * and that is not a style choice.  The poll loop select()s on fd 0 and
 * calls in here when it reports readable — but stdio buffers, so one
 * fgets() of a burst of commands pulled ALL of them out of the pipe into
 * the FILE buffer, leaving the fd with nothing.  select() then never
 * reported readable again and every command after the first was silently
 * lost.  (setbuf(stdin, NULL) in main.c does not save this on every libc.)
 *
 * Nothing hit it while every driver sent one command and waited for a
 * marker; a driver that has to express a GESTURE — press, move, move,
 * release — cannot do that, because the intermediate moves have no marker
 * of their own.  So: read the fd directly, keep the remainder here, and
 * let the caller drain complete lines with monkey_input_pending(). */
#define MONKEY_INBUF (PATH_MAX * 4)
static char monkey_inbuf[MONKEY_INBUF];
static size_t monkey_inbuf_used = 0;
static bool monkey_input_eof = false;

/* Exported interface documented in monkey/dispatch.h */
bool monkey_input_pending(void)
{
	return memchr(monkey_inbuf, '\n', monkey_inbuf_used) != NULL;
}

/**
 * Pull the next complete line out of the buffer, refilling it first if
 * there is not one yet.
 *
 * \param line  buffer of at least PATH_MAX bytes for the line
 * \return true if a line was produced, false at end of input
 */
static bool monkey_next_line(char *line)
{
	char *nl;
	size_t len;

	while ((nl = memchr(monkey_inbuf, '\n', monkey_inbuf_used)) == NULL) {
		ssize_t got;

		if (monkey_input_eof ||
		    monkey_inbuf_used == sizeof(monkey_inbuf)) {
			return false;
		}
		got = read(0, monkey_inbuf + monkey_inbuf_used,
			   sizeof(monkey_inbuf) - monkey_inbuf_used);
		if (got <= 0) {
			monkey_input_eof = true;
			return false;
		}
		monkey_inbuf_used += (size_t)got;
	}

	len = (size_t)(nl - monkey_inbuf);
	if (len >= PATH_MAX) {
		len = PATH_MAX - 1;
	}
	memcpy(line, monkey_inbuf, len);
	line[len] = '\0';

	monkey_inbuf_used -= (size_t)(nl - monkey_inbuf) + 1;
	memmove(monkey_inbuf, nl + 1, monkey_inbuf_used);

	return true;
}

void
monkey_process_command(void)
{
	char buffer[PATH_MAX];
	int argc = 0;
	char **argv = NULL;
	char *p, *r = NULL;
	handle_command_fn fn = NULL;
	char **nargv;

	if (monkey_next_line(buffer) == false) {
		/* end of input or read error so issue QUIT */
		snprintf(buffer, PATH_MAX, "QUIT");
	}

	argv = malloc(sizeof *argv);
	if (argv == NULL) {
		return;
	}
	argc = 1;
	*argv = buffer;
  
	for (p = r = buffer; *p != '\0'; p++) {
		if (*p == ' ') {
			nargv = realloc(argv, sizeof(*argv) * (argc + 1));
			if (nargv == NULL) {
				/* reallocation of argument vector failed, try using what is
				 * already processed.
				 */
				break;
			} else {
				argv = nargv;
			}
			argv[argc++] = r = p + 1;
			*p = '\0';
		}
	}
  
	RING_ITERATE_START(monkey_cmdhandler_t, handler_ring, handler) {
		if (strcmp(argv[0], handler->cmd) == 0) {
			fn = handler->fn;
			RING_ITERATE_STOP(handler_ring, handler);
		}
	} RING_ITERATE_END(handler_ring, handler);
  
	if (fn != NULL) {
		fn(argc, argv);
	}

	free(argv);
}
