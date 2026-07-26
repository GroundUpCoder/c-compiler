/* stopwatch.js — loaded with <script src="stopwatch.js">. */

/* The load-check pill: this file running at all is what it reports.  Both
   edits happen while the parser is still live, so they arrive through the
   normal load-time box construction rather than through the live
   re-conversion bridge this page is otherwise about. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var readout = document.getElementById('elapsed');
var stateBox = document.getElementById('state');
var lapList = document.getElementById('laps');
var goButton = document.getElementById('go');

var TICK_MS = 100;

var running = false;
var ticks = 0;        /* TICK_MS units elapsed */
var ticker = null;

/* The time base is the setInterval cadence, NOT Date.now(): in this build
 * Date.now() has ONE-SECOND resolution, because duktape's platform probe
 * does not recognise our target and falls through to its "unknown OS"
 * branch (duk_config.h -> DUK_USE_DATE_NOW_TIME, i.e. plain time()).  Our
 * libc's gettimeofday does have microsecond resolution, so this is a
 * one-line duk_custom.h fix for whoever owns the bindings — until then a
 * sub-second readout has to count ticks. */
function readClock() {
	return ticks * TICK_MS;
}

function format(ms) {
	/* tenths of a second, always one decimal place */
	var tenths = Math.floor(ms / 100);
	return Math.floor(tenths / 10) + '.' + (tenths % 10);
}

function tick() {
	ticks = ticks + 1;
	paint();
}

function paint() {
	/* THE mutation under test: character data inside a <div>.  Nothing
	 * about this element is special to the layout engine, so making it
	 * visible needs a genuine re-box of the document. */
	readout.textContent = format(readClock());
}

function setRunning(on) {
	running = on;
	stateBox.textContent = on ? 'running' : 'stopped';
	goButton.textContent = on ? 'Stop' : 'Start';
}

goButton.addEventListener('click', function () {
	if (running) {
		if (ticker !== null) {
			clearInterval(ticker);
			ticker = null;
		}
		setRunning(false);
	} else {
		setRunning(true);
		ticker = setInterval(tick, TICK_MS);
	}
	paint();
});

document.getElementById('lap').addEventListener('click', function () {
	/* A structural insertion rather than a text edit: same bridge, the
	 * other mutation class. */
	var row = document.createElement('li');
	row.textContent = format(readClock()) + ' s';
	lapList.appendChild(row);
});

document.getElementById('zero').addEventListener('click', function () {
	ticks = 0;
	while (lapList.firstChild) {
		lapList.removeChild(lapList.firstChild);
	}
	paint();
});

/* Run on load so the page is alive without a click, which is what lets the
 * kernel e2e prove a timer-driven repaint with zero user input. */
setRunning(true);
ticker = setInterval(tick, TICK_MS);

console.log('stopwatch ready');
