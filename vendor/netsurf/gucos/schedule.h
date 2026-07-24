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

#ifndef NETSURF_GUCOS_SCHEDULE_H
#define NETSURF_GUCOS_SCHEDULE_H

#include "utils/errors.h"

/** the gui_misc_table schedule op */
nserror gucos_schedule(int tival, void (*callback)(void *p), void *p);

/**
 * Run any pending scheduled callbacks.
 *
 * \return The number of milliseconds untill the next scheduled event
 *         or -1 for no event.
 */
int gucos_schedule_run(void);

#endif
