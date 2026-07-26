/* index.js — loaded with <script src="index.js">.  This file running at all
   is the thing it reports: flip the load-check pill from red to green.
   Both edits land while the parser is still live, so they arrive through
   the normal load-time box construction — no live re-conversion needed. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

console.log('web demos index ready');
