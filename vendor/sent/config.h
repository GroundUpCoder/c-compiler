/* See LICENSE file for copyright and license details.
 *
 * gucOS port (todos/0119): fontfallbacks are file paths on ONE freetype
 * face (user override first, then the baked default — term.c's pair);
 * shortcuts are SDL keycodes (SDL3 keycodes ARE the character for
 * printables); the farbfeld filter pipeline is gone — images load
 * natively (.png via libpng, .ff direct) in sent.c.
 */

#define VERSION "1-gucos"   /* upstream config.mk's VERSION, folded in */

static const char *fontpaths[] = {
	"/etc/fonts/mono.ttf",
	"/usr/share/fonts/mono.ttf",
};
#define NUMFONTSCALES 42
#define FONTSZ(x) ((int)(10.0 * powf(1.1288, (x)))) /* x in [0, NUMFONTSCALES-1] */

static const char *colors[] = {
	"#000000", /* foreground color */
	"#FFFFFF", /* background color */
};

static const float linespacing = 1.4;

/* how much screen estate is to be used at max for the content */
static const float usablewidth = 0.75;
static const float usableheight = 0.75;

/* initial window size (resizable; maximize for the full-screen present) */
#define INIT_WIDTH  800
#define INIT_HEIGHT 500

static Mousekey mshortcuts[] = {
	/* button         function        argument */
	{ 1,              advance,        {.i = +1} }, /* left */
	{ 3,              advance,        {.i = -1} }, /* right */
};

static Shortcut shortcuts[] = {
	/* keycode        function        argument */
	{ SDLK_ESCAPE,    quit,           {0} },
	{ 'q',            quit,           {0} },
	{ SDLK_RIGHT,     advance,        {.i = +1} },
	{ SDLK_LEFT,      advance,        {.i = -1} },
	{ SDLK_RETURN,    advance,        {.i = +1} },
	{ SDLK_SPACE,     advance,        {.i = +1} },
	{ SDLK_BACKSPACE, advance,        {.i = -1} },
	{ 'l',            advance,        {.i = +1} },
	{ 'h',            advance,        {.i = -1} },
	{ 'j',            advance,        {.i = +1} },
	{ 'k',            advance,        {.i = -1} },
	{ SDLK_DOWN,      advance,        {.i = +1} },
	{ SDLK_UP,        advance,        {.i = -1} },
	{ SDLK_PAGEDOWN,  advance,        {.i = +1} },
	{ SDLK_PAGEUP,    advance,        {.i = -1} },
	{ 'n',            advance,        {.i = +1} },
	{ 'p',            advance,        {.i = -1} },
	{ 'r',            reload,         {0} },
};
