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
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * \file
 * Build-time kill switch for the DOM UI event coverage (gucOS todos/0289,
 * "NetSurf Lane C").
 *
 * `-DNETSURF_NO_UI_EVENTS` restores the pre-Lane-C behaviour exactly: the
 * only UI events the browser dispatches are `click` — as a plain Event, so
 * with no coordinates — and `keydown`, at the document root rather than at
 * the focused element, with no `key` name for Enter/Tab/Backspace; and a
 * capture-phase listener registers in no phase it can ever be invoked in.
 *
 * It exists so the gate can show the RED: `vendor/netsurf/smoke-js.mjs`
 * leg 11 builds this variant from the same tree and requires the paint and
 * events demo pages to receive nothing at all, while their scripts still
 * demonstrably run.  A demo that passes with and without the change proves
 * nothing; this is what stops that.  (The Lane B bridge carries the same
 * kind of switch, `-DNETSURF_NO_LIVE_RECONVERT`, for the same reason.)
 *
 * The two are independent: a build may compile out either, both or
 * neither.
 */

#ifndef NETSURF_UIEVENTS_H
#define NETSURF_UIEVENTS_H

#ifdef NETSURF_NO_UI_EVENTS
#define NETSURF_UI_EVENTS 0
#else
#define NETSURF_UI_EVENTS 1
#endif

#endif
