#!/usr/bin/env node
// NetSurf supported-subset probe battery (netsurf-bughunt lane, Leg 2).
//
// Authors small custom pages that stay INSIDE the engine's supported subset
// and drives each one in a real /bin/netsurf window, asserting the VISUAL
// outcome off wmctl shots. Every probe targets something claimed or
// reasonably expected to work that the shipped demos do not exercise:
//
//   link     click an <a href> block -> the second page renders
//   wheel    mouse wheel scrolls a tall page (a deep marker becomes visible)
//   hover    a:hover restyles (background flips under a hovering pointer)
//   enter    keydown for Enter reaches JS with e.key === 'Enter'
//            (the todo demo's comment claims it arrives null — stale?)
//   img      a small PNG <img> renders at load (0411's in-budget boundary)
//   timer    setTimeout fires once; a clearTimeout'd timer never fires
//   setattr  setAttribute('style', ...) restyles the element (the .style
//            property is a documented stub; the attribute is the workaround
//            a page author reaches for)
//
// Pages are planted through the tty (base64 -d), so nothing here touches
// the image bake. Shots land as viewable PNGs in the out dir (arg 2,
// default /tmp/nsprobe). Exit 1 if any probe fails — findings, not a gate.
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePpm, encodePng } = require('../lib/png.js');

const OUT = process.argv[2] || '/tmp/nsprobe';
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- the probe pages ---- */
const GREEN = '#0a5510', RED = '#a01000', PURPLE = '#7700aa',
      NAVY = '#123456', MAGENTA = '#ff00ff', GRAY = '#808080';
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// A 10x10 solid-magenta PNG asset for the img probe, generated right here.
const dotPng = (() => {
  const px = Buffer.alloc(10 * 10 * 3);
  for (let i = 0; i < px.length; i += 3) { px[i] = 255; px[i + 1] = 0; px[i + 2] = 255; }
  return encodePng(10, 10, px);
})();

const page = (title, style, body, script) =>
  `<!DOCTYPE html><html><head><title>${title}</title><style>${style}</style></head>` +
  `<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

/* files: path -> Buffer; open: the path to open; title: the wmctl wait
 * title; drive: wmctl lines after the window is up (shot is appended);
 * settle: seconds to sleep before the shot; expect: color predicates over
 * the whole content area. */
const PROBES = [
  {
    name: 'link',
    files: {
      '/root/p-link/index.html': page('LinkA', `a#go{display:block;width:300px;height:120px;background:${GRAY}}`,
        `<a id="go" href="b.html">go to page B</a>`),
      '/root/p-link/b.html': page('LinkB', `#big{width:400px;height:300px;background:${PURPLE}}`,
        `<div id="big">page B</div>`),
    },
    open: '/root/p-link/index.html', title: 'LinkA',
    drive: ['wmctl click $S 60 60',
            /* navigation has no page-side marker this rig can wait on
             * (the status bar is not agent-addressable), so settle */
            'sleep 2'],
    expect: [{ color: rgb(PURPLE), what: 'page B rendered after clicking the link' }],
  },
  {
    name: 'linkjs',
    files: {
      '/root/p-linkjs/index.html': page('LinkJS',
        `#ran{width:250px;height:80px;background:${GRAY}}#ran.on{background:${NAVY}}` +
        `a#go{display:block;width:300px;height:100px;background:#cccccc}`,
        `<div id="ran">ran</div><a id="go" href="b.html">handled link</a>`,
        `var ran=document.getElementById('ran');` +
        `document.getElementById('go').addEventListener('click',function(e){` +
        `ran.className='on';e.preventDefault();});`),
      '/root/p-linkjs/b.html': page('LinkJSB', `#big{width:400px;height:300px;background:${PURPLE}}`,
        `<div id="big">page B</div>`),
    },
    open: '/root/p-linkjs/index.html', title: 'LinkJS',
    drive: ['wmctl click $S 60 130', 'sleep 2'],
    expect: [{ color: rgb(NAVY), what: 'the click handler on the <a> ran (className painted)' },
             { notColor: rgb(PURPLE), what: 'preventDefault() suppressed the link navigation' }],
  },
  {
    name: 'wheel',
    files: {
      '/root/p-wheel/index.html': page('Wheel',
        `#spacer{height:1400px;background:#eeeeee}#marker{height:300px;background:${NAVY}}`,
        `<div id="spacer">tall spacer</div><div id="marker">marker</div>`),
    },
    open: '/root/p-wheel/index.html', title: 'Wheel',
    drive: ['wmctl wheel $S -3', 'wmctl wheel $S -3', 'wmctl wheel $S -3',
            'wmctl wheel $S -3', 'wmctl wheel $S -3', 'wmctl wheel $S -3', 'sleep 1'],
    expect: [{ color: rgb(NAVY), what: 'the deep marker scrolled into view' }],
  },
  {
    name: 'hover',
    files: {
      '/root/p-hover/index.html': page('Hover',
        `a#h{display:block;width:300px;height:120px;background:${GRAY}}a#h:hover{background:${GREEN}}`,
        `<a id="h" href="#">hover here</a>`),
    },
    open: '/root/p-hover/index.html', title: 'Hover',
    drive: ['wmctl hover $S 60 60', 'sleep 1'],
    expect: [{ color: rgb(GREEN), what: 'a:hover restyled the link block' }],
  },
  {
    name: 'enter',
    files: {
      '/root/p-enter/index.html': page('Enter',
        `#flag{width:250px;height:80px;background:${GRAY}}#flag.yes{background:${GREEN}}#flag.no{background:${RED}}`,
        `<p><input id="t" value="press enter"></p><div id="flag">flag</div>`,
        `var t=document.getElementById('t'),flag=document.getElementById('flag');` +
        `t.addEventListener('keydown',function(e){flag.className=(e.key==='Enter')?'yes':'no';` +
        `console.log('enter probe key '+e.key);});`),
    },
    open: '/root/p-enter/index.html', title: 'Enter',
    drive: ['wmctl click $S 60 30', 'wmctl key $S 0 13', 'sleep 1'],
    expect: [{ color: rgb(GREEN), what: "keydown delivered e.key === 'Enter'" },
             { notColor: rgb(RED), what: 'Enter did NOT arrive as a wrong/null key' }],
  },
  {
    name: 'img',
    files: {
      '/root/p-img/index.html': page('Img', `img{border:0}`,
        `<p>small png below</p><img src="dot.png" width="100" height="100">`),
      '/root/p-img/dot.png': dotPng,
    },
    open: '/root/p-img/index.html', title: 'Img',
    drive: ['sleep 1'],
    expect: [{ color: rgb(MAGENTA), what: 'the small PNG rendered at load' }],
  },
  {
    name: 'timer',
    files: {
      '/root/p-timer/index.html': page('Timer',
        `#a{width:200px;height:60px;background:${GRAY}}#a.on{background:${GREEN}}` +
        `#b{width:200px;height:60px;background:${GRAY}}#b.on{background:${RED}}`,
        `<div id="a">a</div><div id="b">b</div>`,
        `var a=document.getElementById('a'),b=document.getElementById('b');` +
        `setTimeout(function(){a.className='on';},400);` +
        `var dead=setTimeout(function(){b.className='on';},700);clearTimeout(dead);`),
    },
    open: '/root/p-timer/index.html', title: 'Timer',
    drive: ['sleep 2'],
    expect: [{ color: rgb(GREEN), what: 'the setTimeout fired and restyled' },
             { notColor: rgb(RED), what: 'the cleared timeout never fired' }],
  },
  {
    name: 'setattr',
    files: {
      '/root/p-setattr/index.html': page('Setattr',
        `#box{width:250px;height:100px;background:${GRAY}}` +
        `#ran{width:250px;height:60px;background:${GRAY}}#ran.on{background:${NAVY}}` +
        `#hit{width:200px;height:60px;background:#cccccc}`,
        `<div id="box">box</div><div id="ran">ran</div><div id="hit">click to restyle</div>`,
        `var box=document.getElementById('box');var ran=document.getElementById('ran');` +
        `document.getElementById('hit').addEventListener('click',function(e){` +
        /* className FIRST (the proven restyle channel), setAttribute second:
         * if only the first paints, setAttribute is the isolated failure */
        `ran.className='on';` +
        `box.setAttribute('style','background: ${GREEN}');});`),
    },
    open: '/root/p-setattr/index.html', title: 'Setattr',
    drive: ['wmctl click $S 60 210', 'sleep 1'],
    expect: [{ color: rgb(NAVY), what: 'the click handler ran (className flip painted)' },
             { color: rgb(GREEN), what: "setAttribute('style') restyled the box" }],
  },
];

/* ---- plant + drive ---- */
const only = process.env.NSPROBE_ONLY ? process.env.NSPROBE_ONLY.split(',') : null;
const RUN = PROBES.filter((p) => !only || only.includes(p.name));
const script = [];
for (const p of RUN) {
  const dirs = new Set(Object.keys(p.files).map((f) => path.posix.dirname(f)));
  for (const d of dirs) script.push(`mkdir -p "${d}"`);
  for (const [f, content] of Object.entries(p.files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    script.push(`echo ${buf.toString('base64')} | base64 -d > "${f}"`);
  }
}
for (const p of RUN) {
  script.push(
    `netsurf "${p.open}" &`,
    `wmctl wait win "${p.title}" 60000`,
    `S=$(wmctl list | grep "\t${p.title}$" | sed "s/[^0-9].*//")`,
    ...p.drive,
    `wmctl shot $S /root/shot-${p.name}.ppm && echo shot-${p.name}-ok`,
    /* close by sid and wait on the SID, not the title — the link probe's
     * navigation changed its window title mid-run */
    `wmctl close $S`, `wmctl wait gone $S 8000`,
  );
}

const { dir, image } = freshImage('os-nsprobe-');
const r = driveBoot(script, { image, timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
for (const p of RUN)
  check(`${p.name}: window came up and was shot`, r.stdout.includes(`shot-${p.name}-ok`));

const back = driveBoot('cat ' + PROBES.map((p) => `/root/shot-${p.name}.ppm`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 128 * 1024 * 1024 });
let off = 0;
for (const p of RUN) {
  const s = parsePpm(back.stdout, off);
  off = s.next;
  fs.writeFileSync(path.join(OUT, `probe-${p.name}.png`), encodePng(s.w, s.h, s.rgb));
  const count = (want, tol) => {
    let n = 0;
    for (let i = 0; i < s.rgb.length; i += 3)
      if (Math.abs(s.rgb[i] - want[0]) <= tol && Math.abs(s.rgb[i + 1] - want[1]) <= tol &&
          Math.abs(s.rgb[i + 2] - want[2]) <= tol) n++;
    return n;
  };
  for (const e of p.expect) {
    if (e.color) check(`${p.name}: ${e.what}`, count(e.color, 12) > 200,
                       `${count(e.color, 12)} px of ${JSON.stringify(e.color)}`);
    else if (e.notColor) check(`${p.name}: ${e.what}`, count(e.notColor, 12) < 50,
                               `${count(e.notColor, 12)} px of ${JSON.stringify(e.notColor)}`);
  }
}
console.log('shots in ' + OUT);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
