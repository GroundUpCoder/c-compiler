/* counter.js — loaded with <script src="counter.js">. */

/* The load-check pill: this file running at all is what it reports. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var out = document.getElementById('n');

function show(v) {
	/* Writing a form control's value is the repainting mutation channel. */
	out.value = v;
}

function bump(by) {
	var v = parseInt(out.value, 10);
	if (isNaN(v)) {
		v = 0;
	}
	show(by === 0 ? 0 : v + by);
}

document.getElementById('inc').addEventListener('click', function () { bump(1); });
document.getElementById('dec').addEventListener('click', function () { bump(-1); });
document.getElementById('zero').addEventListener('click', function () { bump(0); });

console.log('counter ready');
