/* plasma.js — loaded with <script src="plasma.js">.
 *
 * The classic demoscene plasma: per pixel, three sine fields and a radial
 * term sum into a palette index.  Canvas 2D has no drawing primitives here
 * (Lane D), so every frame is rasterised in JavaScript into an ImageData
 * buffer — which is exactly the point this page makes: a raw pixel buffer
 * plus setInterval is real-time graphics.
 *
 * Speed notes (measured in duktape on this engine):
 *   * a naive 3-lookup inner loop runs ~148 ms per 320x200 frame;
 *   * hoisting the x-only / y-only / diagonal terms into per-frame 1-D
 *     arrays cuts the inner loop to adds + two table reads;
 *   * putImageData itself is native and costs ~nothing next to the JS.
 * The tick interval below is chosen so the timer never runs the thread
 * flat out; the honest frame rate lands near 6 fps and the fps box states
 * whatever it really is.
 *
 * PALETTE RULE (load-bearing): the in-OS gate counts the load-check pill's
 * red/green over the WHOLE window, so no palette entry may enter either
 * band.  buildPalette() clamps: where r > 150 it keeps g >= 48, and where
 * g > 100 it keeps r >= 48.  Do not remove the clamp.
 *
 * Footgun: globals colliding with Window IDL attributes are silently
 * swallowed (`status`, `length`, `frames`, …) — hence `fpsBox`.
 */

/* The load-check pill: this file running at all is what it reports. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var cv = document.getElementById('c');
var ctx = cv.getContext('2d');
var W = cv.width, H = cv.height;
var img = ctx.createImageData(W, H);
var px = img.data;
var fpsBox = document.getElementById('fps');

/* ---- tables ---- */
var SIN = [];                      /* 0..1023 -> 0..190, one full wave */
var i, x, y;
for (i = 0; i < 1024; i++) {
	SIN[i] = Math.round(95 + 95 * Math.sin(i * Math.PI / 512));
}
var RAD = [];                      /* radial index per pixel, built once */
for (y = 0; y < H; y++) {
	for (x = 0; x < W; x++) {
		var dx = x - (W >> 1), dy = y - (H >> 1);
		RAD[y * W + x] = (Math.sqrt(dx * dx + dy * dy) * 5) & 1023;
	}
}

/* ---- palettes ---- */
/* Each is 256 entries of [r,g,b] built from sine waves, then clamped away
 * from the pill's red band (r>150 needs g>=48) and green band (g>100
 * needs r>=48) — see the header note. */
function wave(i, lo, hi, phase) {
	return Math.round(lo + (hi - lo) * (0.5 + 0.5 * Math.sin((i / 256 + phase) * Math.PI * 2)));
}
function buildPalette(mk) {
	var p = [];
	for (var j = 0; j < 256; j++) {
		var c = mk(j);
		if (c[0] > 150 && c[1] < 48) c[1] = 48;
		if (c[1] > 100 && c[0] < 48) c[0] = 48;
		p[j] = c;
	}
	return p;
}
var PALETTES = [
	/* ember: deep red through orange to pale gold */
	buildPalette(function (j) { return [wave(j, 60, 255, 0), wave(j, 20, 190, 0.08), wave(j, 10, 90, 0.2)]; }),
	/* ocean: navy through cyan */
	buildPalette(function (j) { return [wave(j, 8, 90, 0.5), wave(j, 40, 200, 0.15), wave(j, 90, 255, 0)]; }),
	/* violet dusk */
	buildPalette(function (j) { return [wave(j, 50, 220, 0), wave(j, 15, 90, 0.3), wave(j, 90, 240, 0.12)]; }),
	/* full spectrum, phase-shifted channels */
	buildPalette(function (j) { return [wave(j, 30, 240, 0), wave(j, 30, 240, 0.33), wave(j, 30, 240, 0.67)]; }),
];
var pal = 0;

/* ---- the frame ---- */
var FX = [], FY = [], FD = [];     /* per-frame 1-D terms, hoisted */
var t = 0;
var nframes = 0;
var timer = null;

function paint() {
	var d = px, P = PALETTES[pal], o = 0, v, c, ry;
	for (x = 0; x < W; x++) FX[x] = SIN[(x * 6 + t * 5) & 1023];
	for (y = 0; y < H; y++) FY[y] = SIN[(y * 9 + t * 3) & 1023];
	for (i = 0; i < W + H; i++) FD[i] = SIN[(i * 4 + t * 7) & 1023];
	var tr = t * 6;
	for (y = 0; y < H; y++) {
		ry = FY[y];
		for (x = 0; x < W; x++) {
			v = (FX[x] + ry + FD[x + y] + SIN[(RAD[o >> 2] + tr) & 1023]) & 255;
			c = P[v];
			d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
			o += 4;
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
		timer = setInterval(tick, 150);
	}
}

function nextPalette() {
	pal = (pal + 1) % PALETTES.length;
	console.log('plasma palette ' + pal);
	paint();
}

cv.addEventListener('mousedown', function (e) {
	/* Take the gesture so a press on the picture is never a page-drag. */
	e.preventDefault();
});
cv.addEventListener('click', nextPalette);
document.getElementById('pal').addEventListener('click', nextPalette);

document.getElementById('stop').addEventListener('click', function () {
	if (timer === null) {
		start();
		console.log('plasma running');
	} else {
		clearInterval(timer);
		timer = null;
		console.log('plasma stopped');
	}
});

paint();
start();
console.log('plasma ready ' + W + 'x' + H);
