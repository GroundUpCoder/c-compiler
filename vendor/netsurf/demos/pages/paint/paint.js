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
 * is Lane D — so the brush is rasterised by hand into an ImageData buffer
 * and handed to putImageData, which is canvas's repainting channel.
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
var readoutBox = document.getElementById('readout');

var BRUSH = 5;                     /* half-width of the square brush */
var INKS = [[0, 0, 0], [32, 96, 200], [48, 128, 48]];
var ink = 0;
var drawing = false;
var strokes = 0;
var dots = 0;

function clearPad() {
	var i;
	for (i = 0; i < W * H * 4; i += 4) {
		img.data[i] = 255;
		img.data[i + 1] = 255;
		img.data[i + 2] = 255;
		img.data[i + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
}

/* Rasterise one square brush dab centred on a canvas pixel. */
function dab(cx, cy) {
	var c = INKS[ink];
	var x, y, o;
	for (y = cy - BRUSH; y <= cy + BRUSH; y++) {
		if (y < 0 || y >= H) continue;
		for (x = cx - BRUSH; x <= cx + BRUSH; x++) {
			if (x < 0 || x >= W) continue;
			o = (y * W + x) * 4;
			img.data[o] = c[0];
			img.data[o + 1] = c[1];
			img.data[o + 2] = c[2];
			img.data[o + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	dots++;
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
	dab(p.x, p.y);
});

/* The move listener sits on the DOCUMENT, not the pad: a drag that leaves
 * the canvas should keep painting the part that is still inside it, and
 * the release that ends it must be seen wherever it happens. */
document.addEventListener('mousemove', function (e) {
	var p = toCanvas(e);
	if (!drawing) return;
	report('move', p, e);
	if (inPad(p)) dab(p.x, p.y);
});

document.addEventListener('mouseup', function (e) {
	var p = toCanvas(e);
	if (!drawing) return;
	drawing = false;
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

/* A probe the gate can use to read a canvas pixel back: getImageData is the
 * only way to ask this engine what is on a canvas. */
function padPixelAt(x, y) {
	var d = ctx.getImageData(x, y, 1, 1).data;
	return d[0] + ',' + d[1] + ',' + d[2];
}
window.padPixelAt = padPixelAt;

clearPad();
console.log('paint ready ' + W + 'x' + H);
