/* paint.js — loaded with <script src="paint.js">.
 *
 * The demo Lane C exists for.  Everything here rests on ONE thing that did
 * not work before it: a mouse event that carries a coordinate.
 *
 *   * `mousedown`, `mousemove` and `mouseup` are dispatched at all — before
 *     Lane C the ONLY UI events the browser ever fired were `click`,
 *     `keydown` and window `load`.
 *   * they are real MouseEvents, so `pageX`/`pageY` are numbers.  A plain
 *     Event has no coordinate properties at all, which is why this page
 *     could not be written before and was deliberately not shipped.
 *
 * Canvas 2D still has no drawing primitives (no fillRect, no paths) — that
 * is Lane D — so this file carries its own rasteriser over one ImageData
 * buffer: rect/gradient fills, filled circles, thick lines, per-column
 * ridge fills.  putImageData is canvas's repainting channel, and a raw
 * pixel buffer draws anything: the whole opening scene below is made of
 * exactly these calls.
 *
 * Why there is a scene at all: the first shipped version of this page
 * opened as a blank white pad, and a click painted one 10px dot.  A user
 * who clicked (and never dragged) saw nothing happen and reported the
 * page as broken — the engine was fine, the demo was not.  The pad now
 * opens with the scene, a click stamps a full paint splat, and a drag
 * paints a continuous stroke.
 *
 * PALETTE RULE (load-bearing): the demos e2e counts the load-check pill's
 * two colours over the WHOLE window (demos.js PILL).  Nothing rasterised
 * here may match either band: where r > 150, keep g >= 48 (the red band
 * needs g < 40 and b < 40); where g > 100, keep r >= 48 or b >= 32 (the
 * green band needs r < 40 and b < 30).  Every colour below obeys this.
 *
 * Footgun worth knowing while writing pages for this engine: a global whose
 * name collides with a Window IDL attribute is silently swallowed (`status`,
 * `length`, `name`, `top`, `self`, `parent`, `frames`, `external`).  Hence
 * `readoutBox` below rather than `status`.
 */

/* The load-check pill: this file running at all is what it reports. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var pad = document.getElementById('pad');
var ctx = pad.getContext('2d');
var W = pad.width, H = pad.height;
var img = ctx.createImageData(W, H);
var px = img.data;
var readoutBox = document.getElementById('readout');

var INKS = [[16, 16, 16], [32, 96, 200], [48, 128, 48]];
var ink = 0;
var drawing = false;
var last = null;                   /* previous stroke point, canvas coords */
var strokes = 0;
var dots = 0;

/* Deterministic LCG so the scene and the splats are reproducible: the
 * kernel e2e compares screenshots across phases, and Math.random would
 * make "repaint the scene" paint a DIFFERENT scene. */
var rngState = 1;
function rnd(n) {
	/* Park–Miller: 16807 * 2^31 < 2^53, so the product stays exact in a
	 * JS double (a bigger multiplier silently loses its low bits). */
	rngState = (rngState * 16807) % 2147483647;
	return rngState % n;
}

/* ---- the rasteriser ----------------------------------------------------
 * All of it writes the one `px` buffer; present() blits it.  Coordinates
 * clamp, so callers never bounds-check. */

function present() {
	ctx.putImageData(img, 0, 0);
}

function fillRect(x0, y0, w, h, r, g, b) {
	var x1 = x0 + w, y1 = y0 + h, x, y, o;
	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > W) x1 = W;
	if (y1 > H) y1 = H;
	for (y = y0; y < y1; y++) {
		o = (y * W + x0) * 4;
		for (x = x0; x < x1; x++) {
			px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
			o += 4;
		}
	}
}

/* Vertical gradient across rows [y0,y1): per-row colour, flat inner loop
 * (the fast pattern — per-pixel math in the row loop only). */
function vgrad(y0, y1, c0, c1) {
	var n = y1 - y0, y, x, o, t, r, g, b;
	for (y = y0; y < y1; y++) {
		t = (y - y0) / n;
		r = (c0[0] + (c1[0] - c0[0]) * t) | 0;
		g = (c0[1] + (c1[1] - c0[1]) * t) | 0;
		b = (c0[2] + (c1[2] - c0[2]) * t) | 0;
		o = y * W * 4;
		for (x = 0; x < W; x++) {
			px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
			o += 4;
		}
	}
}

function fillCircle(cx, cy, rad, r, g, b) {
	var y0 = cy - rad, y1 = cy + rad, y, x, o, dx, dy, hw;
	if (y0 < 0) y0 = 0;
	if (y1 >= H) y1 = H - 1;
	for (y = y0; y <= y1; y++) {
		dy = y - cy;
		hw = Math.sqrt(rad * rad - dy * dy) | 0;
		var xa = cx - hw, xb = cx + hw;
		if (xa < 0) xa = 0;
		if (xb >= W) xb = W - 1;
		o = (y * W + xa) * 4;
		for (x = xa; x <= xb; x++) {
			px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
			o += 4;
		}
	}
}

/* Thick line: filled discs stamped along the segment, one per pixel of
 * length — a continuous round-capped stroke. */
function line(x0, y0, x1, y1, rad, r, g, b) {
	var dx = x1 - x0, dy = y1 - y0;
	var n = Math.max(Math.abs(dx), Math.abs(dy)) | 0;
	if (n === 0) { fillCircle(x0, y0, rad, r, g, b); return; }
	for (var i = 0; i <= n; i++) {
		fillCircle((x0 + dx * i / n) | 0, (y0 + dy * i / n) | 0, rad, r, g, b);
	}
}

/* ---- the opening scene: sunset over water ----------------------------- */

/* One mountain ridge: crest height per column from three sines, filled
 * down to `base`.  Drawn back-to-front, so nearer ridges overpaint. */
function ridge(base, amp, f1, f2, phase, r, g, b) {
	var x, y, top, o;
	for (x = 0; x < W; x++) {
		top = base - (amp * (0.55 + 0.3 * Math.sin(x * f1 + phase)
			+ 0.15 * Math.sin(x * f2 + phase * 2.7))) | 0;
		o = (top * W + x) * 4;
		for (y = top; y < base; y++) {
			px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
			o += W * 4;
		}
	}
}

function drawScene() {
	var HORIZON = 320, SUNX = 352, SUNY = 232, x, y, i;
	rngState = 7;                  /* same scene every time, on purpose */

	/* Sky: night indigo down to sunset orange, in two gradient bands. */
	vgrad(0, 200, [22, 26, 74], [92, 52, 108]);
	vgrad(200, HORIZON, [92, 52, 108], [228, 122, 66]);

	/* Stars in the dark band: single pixels, a few with a cross flare. */
	for (i = 0; i < 90; i++) {
		x = rnd(W); y = rnd(150);
		fillRect(x, y, 1, 1, 226, 226, 244);
		if (i % 9 === 0) {
			fillRect(x - 1, y, 3, 1, 168, 168, 210);
			fillRect(x, y - 1, 1, 3, 168, 168, 210);
		}
	}

	/* The sun: banded glow discs, then the core. */
	fillCircle(SUNX, SUNY, 64, 240, 138, 78);
	fillCircle(SUNX, SUNY, 50, 250, 168, 96);
	fillCircle(SUNX, SUNY, 38, 255, 208, 130);
	fillCircle(SUNX, SUNY, 28, 255, 236, 176);

	/* Mountains: far haze ridge, then a nearer darker one. */
	ridge(HORIZON, 92, 0.018, 0.043, 1.1, 66, 48, 92);
	ridge(HORIZON, 46, 0.026, 0.061, 4.0, 38, 30, 60);

	/* Water: deepening blue, with the sun's broken reflection. */
	vgrad(HORIZON, H, [58, 44, 92], [14, 18, 44]);
	for (y = HORIZON; y < H; y += 1) {
		var wdt = 3 + rnd(1 + ((y - HORIZON) >> 3));
		var off = rnd(9) - 4;
		if (rnd(10) < 7) {
			fillRect(SUNX + off - wdt, y, wdt * 2, 1, 244, 172, 96);
		}
	}
	/* Faint horizontal wave glints. */
	for (i = 0; i < 60; i++) {
		x = rnd(W); y = HORIZON + 6 + rnd(H - HORIZON - 12);
		fillRect(x, y, 6 + rnd(26), 1, 84, 78, 128);
	}

	/* Foreground headland, bottom left. */
	for (x = 0; x < 240; x++) {
		var top = H - 58 + ((x * x) >> 11) - (18 * Math.sin(x * 0.02) | 0);
		if (top < H) fillRect(x, top, 1, H - top, 10, 12, 26);
	}

	/* Birds: two-stroke glyphs against the sunset. */
	for (i = 0; i < 5; i++) {
		x = 60 + rnd(300); y = 120 + rnd(90);
		line(x - 6, y + 3, x, y, 1, 20, 18, 30);
		line(x, y, x + 6, y + 3, 1, 20, 18, 30);
	}

	present();
}

function clearPad() {
	fillRect(0, 0, W, H, 255, 255, 255);
	present();
}

/* A click's stamp: a full splat — core disc, darker rim, satellite
 * droplets — so ONE click paints something substantial. */
function splat(cx, cy) {
	var c = INKS[ink];
	var dk = [(c[0] * 3) >> 2, (c[1] * 3) >> 2, (c[2] * 3) >> 2];
	fillCircle(cx, cy, 21, dk[0], dk[1], dk[2]);
	fillCircle(cx, cy, 17, c[0], c[1], c[2]);
	for (var i = 0; i < 7; i++) {
		var a = i * 0.9 + rnd(20) / 10;
		var d = 26 + rnd(16);
		fillCircle((cx + Math.cos(a) * d) | 0, (cy + Math.sin(a) * d) | 0,
			2 + rnd(4), c[0], c[1], c[2]);
	}
	dots++;
	present();
}

/* A drag's stroke segment: a thick round-capped line from the previous
 * point, so sparse mousemoves still paint a CONTINUOUS stroke. */
function strokeTo(p) {
	var c = INKS[ink];
	if (last === null) last = p;
	line(last.x, last.y, p.x, p.y, 6, c[0], c[1], c[2]);
	last = p;
	dots++;
	present();
}

/* The canvas is pinned to the document origin by paint.css, so a page
 * coordinate is already a canvas pixel.  Kept as a named function so the
 * one assumption this page makes about layout has one place to live. */
function toCanvas(e) {
	return { x: e.pageX, y: e.pageY };
}

function inPad(p) {
	return p.x >= 0 && p.x < W && p.y >= 0 && p.y < H;
}

/* Report every coordinate the DOM delivered, on the page AND on the
 * console.  A demo has to assert its own output rather than assume a
 * binding works — and these lines are exactly what the gate reads, so
 * "the coordinates are real" is checked against the numbers that were
 * injected, not eyeballed off a screenshot. */
function report(what, p, e) {
	readoutBox.value = what + ' ' + p.x + ',' + p.y;
	console.log('paint ' + what + ' page ' + p.x + ',' + p.y +
		' client ' + e.clientX + ',' + e.clientY +
		' buttons ' + e.buttons);
}

pad.addEventListener('mousedown', function (e) {
	var p = toCanvas(e);
	report('down', p, e);
	if (!inPad(p)) return;
	/* Take the gesture: without this the browser turns press-and-move
	 * over a non-text box into a page-scroll drag, and every later
	 * motion is swallowed before the page can see it.  Exactly the
	 * preventDefault() a real drawing canvas needs. */
	e.preventDefault();
	drawing = true;
	strokes++;
	last = p;
	splat(p.x, p.y);
});

/* The move listener sits on the DOCUMENT, not the pad: a drag that leaves
 * the canvas should keep painting the part that is still inside it, and
 * the release that ends it must be seen wherever it happens. */
document.addEventListener('mousemove', function (e) {
	var p = toCanvas(e);
	if (!drawing) return;
	report('move', p, e);
	if (inPad(p)) strokeTo(p);
	else last = null;              /* re-entering starts a fresh segment */
});

document.addEventListener('mouseup', function (e) {
	var p = toCanvas(e);
	if (!drawing) return;
	drawing = false;
	last = null;
	report('up', p, e);
	console.log('paint stroke ' + strokes + ' done, ' + dots + ' dabs');
});

document.getElementById('swatch0').addEventListener('click', function () {
	ink = 0;
	console.log('paint ink 0');
});
document.getElementById('swatch1').addEventListener('click', function () {
	ink = 1;
	console.log('paint ink 1');
});
document.getElementById('swatch2').addEventListener('click', function () {
	ink = 2;
	console.log('paint ink 2');
});
document.getElementById('erase').addEventListener('click', function () {
	clearPad();
	dots = 0;
	readoutBox.value = 'cleared';
	console.log('paint cleared');
});
document.getElementById('scene').addEventListener('click', function () {
	drawScene();
	readoutBox.value = 'scene';
	console.log('paint scene drawn');
});

/* A probe the gate can use to read a canvas pixel back: getImageData is the
 * only way to ask this engine what is on a canvas. */
function padPixelAt(x, y) {
	var d = ctx.getImageData(x, y, 1, 1).data;
	return d[0] + ',' + d[1] + ',' + d[2];
}
window.padPixelAt = padPixelAt;

console.log('paint scene start');
drawScene();
console.log('paint scene drawn');
console.log('paint ready ' + W + 'x' + H);
