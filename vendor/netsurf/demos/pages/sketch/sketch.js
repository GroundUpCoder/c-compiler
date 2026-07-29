/* sketch.js — loaded with <script src="sketch.js">.
 *
 * Two upstream gaps shape this page, deliberately:
 *   * canvas 2D has NO drawing primitives here (no fillRect, no paths, no
 *     text) -- every pixel below is rasterised in JavaScript into an
 *     ImageData buffer.
 *   * click events carry no coordinates yet (they are dispatched as plain
 *     Events, not MouseEvents), so the pattern is driven by buttons rather
 *     than by drawing where the pointer went.
 *
 * Footgun worth knowing while writing pages for this engine: a global whose
 * name collides with a Window IDL attribute is silently swallowed -- `var
 * frames = document.getElementById('frames')` leaves `frames` undefined,
 * because Window.frames is a generated no-op stub with a no-op setter, and
 * the script then dies at the first use.  Hence `fpsBox` below.
 */

/* The load-check pill: this file running at all is what it reports. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var cv = document.getElementById('c');
var ctx = cv.getContext('2d');
var W = cv.width, H = cv.height;
var img = ctx.createImageData(W, H);
var fpsBox = document.getElementById('fps');

var pattern = 0;
var NPATTERNS = 3;
var t = 0;
var nframes = 0;
var timer = null;

function paint() {
	var d = img.data;
	var i = 0, x, y, r, g, b;
	for (y = 0; y < H; y++) {
		for (x = 0; x < W; x++) {
			if (pattern === 0) {			/* travelling bars */
				r = (x + t * 3) & 0xff;
				/* spans the full height without a byte wrap
				 * (y*2 seamed at row 128 on the 192-tall canvas) */
				g = (y * 5 >> 2) & 0xff;
				b = 0x60;
			} else if (pattern === 1) {		/* moving checks */
				var on = (((x + t) >> 4) + ((y + t) >> 4)) & 1;
				r = on ? 0xf0 : 0x20;
				g = on ? 0x40 : 0x20;
				b = on ? 0x40 : 0xa0;
			} else {				/* radial rings */
				var dx = x - (W >> 1), dy = y - (H >> 1);
				var q = (dx * dx + dy * dy) >> 5;
				r = ((q + t) * 8) & 0xff;
				g = 0x30;
				b = 0xff - r;
			}
			d[i++] = r;
			d[i++] = g;
			d[i++] = b;
			d[i++] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	nframes++;
	fpsBox.value = nframes + ' frames';
}

function tick() {
	t += 2;
	paint();
}

function start() {
	if (timer === null) {
		timer = setInterval(tick, 200);
	}
}

document.getElementById('next').addEventListener('click', function () {
	pattern = (pattern + 1) % NPATTERNS;
	console.log('sketch pattern ' + pattern);
	paint();
});

document.getElementById('stop').addEventListener('click', function () {
	if (timer === null) {
		start();
		console.log('sketch running');
	} else {
		clearInterval(timer);
		timer = null;
		console.log('sketch stopped');
	}
});

paint();
start();
console.log('sketch ready');
