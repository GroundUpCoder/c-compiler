/* hello-js.js — loaded with <script src="hello-js.js">.  A src'd script with
   neither async nor defer pauses the parse, so everything here still runs at
   parse time: document.write below lands where the <script> tag sits. */

/* The load-check pill: this file running at all is what it reports. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var powers = [];
for (var i = 1; i <= 8; i *= 2) {
	powers.push(i);
}
document.write('<p>2^0..2^3 doubled: ' + powers.join(', ') +
	       ' &mdash; sum ' + (powers[0] + powers[1] + powers[2] + powers[3]) +
	       '</p>');
document.write('<p>document.write ran at parse time, ' +
	       new Date().getFullYear() + '</p>');
console.log('hello from JavaScript');
console.log('engine reached the end of the script');
