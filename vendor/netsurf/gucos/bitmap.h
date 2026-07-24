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

#ifndef NETSURF_GUCOS_BITMAP_H
#define NETSURF_GUCOS_BITMAP_H

#include <stdbool.h>

extern struct gui_bitmap_table *gucos_bitmap_table;

bool gucos_bitmap_get_opaque(void *bitmap);

#endif
