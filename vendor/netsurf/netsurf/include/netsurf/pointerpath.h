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
 * Build-time kill switches for the pointer-path patches (gucOS todos/0419 +
 * todos/0420, "the pointer path"; convention restored by todos/0431).
 *
 * Two switches, because the merge carried two independent behaviours:
 *
 * `-DNETSURF_NO_CLICK_CANCEL` restores the pre-0419 behaviour exactly: the
 * result of dispatching the DOM `click` is thrown away, so a listener's
 * `preventDefault()` cannot stop the clicked element's activation behaviour
 * — a cancelled click on a link still navigates, and on a submit button
 * still submits.
 *
 * `-DNETSURF_NO_DYNAMIC_PSEUDO` restores the pre-0420 behaviour exactly:
 * node_is_hover() and node_is_active() answer "no match" the way the
 * upstream `\todo Support hovering` stubs did, and no mouse action tracks
 * the chains or restyles anything — a `:hover` or `:active` rule can never
 * apply.
 *
 * They exist so the gate can show the RED: `vendor/netsurf/smoke-js.mjs`
 * legs 14 and 15 build these variants from the same tree and require the
 * pristine behaviour back — the cancelled link navigates anyway, and a
 * pointer parked on a `:hover` subject repaints nothing.  A page that
 * passes with and without the change proves nothing; this is what stops
 * that.  (The Lane B bridge and the Lane C event coverage carry the same
 * kind of switch — `-DNETSURF_NO_LIVE_RECONVERT`, `-DNETSURF_NO_UI_EVENTS`
 * — for the same reason.)
 *
 * All four switches are independent: a build may compile out any subset.
 */

#ifndef NETSURF_POINTERPATH_H
#define NETSURF_POINTERPATH_H

#ifdef NETSURF_NO_CLICK_CANCEL
#define NETSURF_CLICK_CANCEL 0
#else
#define NETSURF_CLICK_CANCEL 1
#endif

#ifdef NETSURF_NO_DYNAMIC_PSEUDO
#define NETSURF_DYNAMIC_PSEUDO 0
#else
#define NETSURF_DYNAMIC_PSEUDO 1
#endif

#endif
