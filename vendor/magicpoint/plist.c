/*
 * plist.c — gucOS port stub (todos/0119).
 *
 * Upstream plist.c implements the page-list popup (one X child window per
 * page, raised while Control is held) and the page-guide bar, both drawn
 * with X server fonts. This port has neither child windows nor X fonts,
 * so the whole surface is stubbed to no-ops; navigation (keys, page
 * numbers, 'g') covers the same ground. Restore from upstream 1.13a if a
 * freetype-drawn page guide is ever wanted.
 */
#include "mgp.h"

void pl_on(struct render_state *state) { (void)state; }
void pl_off(struct render_state *state) { (void)state; }
void pl_pdraw(struct render_state *state, int page, GC gc) {
	(void)state; (void)page; (void)gc;
}
void pl_title(u_int page) { (void)page; }

char *
page_title(int page)
{
	(void)page;
	return "";
}

void pg_on(void) { }
void pg_clean(void) { }
void pg_draw(struct render_state *state) { (void)state; }
void pg_off(void) { }
