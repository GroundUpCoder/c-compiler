/* events.js — loaded with <script src="events.js">.
 *
 * Every assertion this page makes is about something that did not work
 * before todos/0289:
 *
 *   * a `{capture: true}` listener fired in NO phase, and — because the
 *     per-node registration was keyed by event NAME alone — registering
 *     one silently killed every later bubble listener for that type on
 *     that element.  So `outer` here carries BOTH, which used to be the
 *     worst case: total silence.
 *   * `event.eventPhase` therefore never reported 1 (capturing).
 *   * `keydown` was dispatched at the document ROOT whatever had focus, so
 *     a listener on the <input> never ran, and Enter arrived with
 *     `event.key === null` (no NS_KEY_CR case in the special-key table).
 *   * `keyup`, `input`, `change`, `focus`, `blur` and `submit` were never
 *     dispatched at all.
 *
 * Footgun worth knowing while writing pages for this engine: a global whose
 * name collides with a Window IDL attribute is silently swallowed
 * (`status`, `length`, `name`, `top`, `self`, `parent`, `frames`).  Hence
 * `orderBox` and `keysBox` below.
 */

/* The load-check pill: this file running at all is what it reports. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var orderBox = document.getElementById('order');
var keysBox = document.getElementById('keys');
var trail = [];

/* DOM phase numbers, spelled out: 1 capturing, 2 at target, 3 bubbling. */
function phaseName(n) {
	if (n === 1) return 'capture';
	if (n === 2) return 'target';
	if (n === 3) return 'bubble';
	return 'phase' + n;
}

function note(id, e) {
	var step = id + ':' + phaseName(e.eventPhase);
	trail.push(step);
	orderBox.value = trail.join(' ');
	console.log('events order ' + step);
}

function watch(id) {
	var el = document.getElementById(id);
	/* capture FIRST, then bubble, on the same element and the same type:
	 * the exact pair that used to leave the element completely deaf. */
	el.addEventListener('click', function (e) { note(id, e); }, true);
	el.addEventListener('click', function (e) { note(id, e); }, false);
}

watch('outer');
watch('middle');
watch('inner');

/* Registered LAST, and on the OUTERMOST box, so it runs after every other
 * listener the click visits: only then is the trail complete. */
document.getElementById('outer').addEventListener('click', function (e) {
	/* A click is a MouseEvent now, so it has coordinates.  Reported so
	 * the gate can check them against what it injected. */
	console.log('events click at ' + e.pageX + ',' + e.pageY +
		' detail ' + e.detail);
	console.log('events trail ' + trail.join(' '));
	trail = [];
});

/* ---- keyboard, focus and form events ---------------------------------- */

var keyTrail = [];
function keyNote(what) {
	keyTrail.push(what);
	keysBox.value = keyTrail.join(' ');
	console.log('events ' + what);
}

var text = document.getElementById('text');

/* On the INPUT, not on document: keydown is delivered to the focused
 * element now, so this is where a real page would put it. */
text.addEventListener('keydown', function (e) {
	keyNote('keydown:' + e.key);
});
text.addEventListener('keyup', function (e) {
	keyNote('keyup:' + e.key);
});
text.addEventListener('input', function () {
	keyNote('input:' + text.value);
});
text.addEventListener('change', function () {
	keyNote('change:' + text.value);
});
text.addEventListener('focus', function () { keyNote('focus:text'); });
text.addEventListener('blur', function () { keyNote('blur:text'); });

document.getElementById('check').addEventListener('change', function (e) {
	keyNote('change:check');
});

/* A cancelable submit: this is the one place preventDefault() really stops
 * the browser doing something. */
document.getElementById('form').addEventListener('submit', function (e) {
	keyNote('submit');
	e.preventDefault();
});

/* window.addEventListener used to register a callback that could never be
 * invoked: the Window is not a node, so it is not in the propagation chain
 * at all, and nothing else looked at its listener list. */
window.addEventListener('load', function () {
	console.log('events window load listener ran');
});

console.log('events ready');
