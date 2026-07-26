/* todo.js — loaded with <script src="todo.js">. */

/* The load-check pill: this file running at all is what it reports.  Both
   edits happen while the parser is still live, so they arrive through the
   normal load-time box construction rather than through the live
   re-conversion bridge this page is otherwise about. */
var jswatch = document.getElementById('jswatch');
jswatch.className = 'ran';
jswatch.textContent = 'script ran';

var entry = document.getElementById('task');
var itemList = document.getElementById('items');
var counter = document.getElementById('count');
var made = 0;

function refreshCount() {
	var n = 0;
	var kid = itemList.firstChild;
	while (kid) {
		n = n + 1;
		kid = kid.nextSibling;
	}
	/* An ATTRIBUTE mutation, not a text one: the class decides the
	 * colour, so this only looks right if the re-box re-selects
	 * styles rather than reusing the cached ones. */
	counter.className = n === 0 ? 'empty' : 'some';
	counter.textContent = n === 0 ? 'nothing to do' :
			(n === 1 ? '1 thing to do' : n + ' things to do');
}

function addTask(text) {
	if (text === '' || text === null) {
		return;
	}
	var row = document.createElement('li');
	var label = document.createElement('span');
	label.textContent = text;
	var drop = document.createElement('button');
	drop.textContent = 'Done ' + text;
	drop.addEventListener('click', function () {
		/* Removal is the mutation here; the listener stays attached
		 * across every re-box because it lives on the DOM node, not
		 * on the box that was thrown away. */
		itemList.removeChild(row);
		refreshCount();
		console.log('todo removed ' + text);
	});
	row.appendChild(label);
	row.appendChild(document.createTextNode(' '));
	row.appendChild(drop);
	itemList.appendChild(row);
	refreshCount();
	console.log('todo added ' + text);
}

document.getElementById('add').addEventListener('click', function () {
	addTask(entry.value);
	entry.value = '';
});

/* Two starting rows so the page is useful (and drivable) before anything
 * is typed. */
addTask('read the design doc');
addTask('re-box the document');

console.log('todo ready');
