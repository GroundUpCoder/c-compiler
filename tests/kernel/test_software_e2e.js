#!/usr/bin/env node
// Software storefront acceptance (ticket #81), headless: the GUI front-end
// over gucman proves a REAL install/remove round-trip — state changes are
// asserted on the filesystem (install DB + planted binary), never on UI
// needles alone.
//
//   - honest failure first: with the repo pointed at a dead port, the
//     storefront shows its "Cannot reach the package repository" notice and
//     the status line carries gucman's own error (no hang, no fake catalog)
//   - Refresh against a real serve.js repo renders the catalog from the
//     live index.json: EVERY package in the index appears as a card
//     ("<name> <version> [available]" — agent-visible window text)
//   - one click on punes's Install button runs `gucman install punes` for
//     real: the card flips to [installed] only after the DB record exists,
//     and the shell then proves /opt/punes/punes + the /usr/local/bin
//     symlink + the DB record
//   - one click on Remove reverses it: card back to [available], /opt tree
//     + symlink + DB record gone
//   - FS_WATCH liveness: a CLI `gucman install` / `remove` beside the open
//     storefront flips the card with no clicks at all
//
// The punes Install button's agent address is BUTTON:n with
// n = 1 + sortedIndex(punes): button creation order is Refresh first, then
// one action button per card in sorted-name order. The tree dump taken in
// the session re-verifies that prediction post-hoc.
//
// Run: node tests/kernel/test_software_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage } = require('./lib/drive.js');

// The stock section() helper ends at the NEXT `==` line — but `wmctl tree`
// prints its own `== pid N` app headers, so tree sections need explicit
// start/end markers instead.
function between(out, a, b) {
  const s = out.indexOf('==' + a);
  if (s < 0) return '';
  const e = out.indexOf('==' + b, s);
  return out.slice(s, e < 0 ? out.length : e);
}
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

async function main() {
  const idx = ensurePackages(['punes']);
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-software-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const names = Object.keys(idx.packages).sort();
  const pv = idx.packages.punes.version;
  const punesBtn = 1 + names.indexOf('punes');   // Refresh, then card order

  const goodPort = await startServer(require('path').join(
    require('path').resolve(__dirname, '../..'), 'dist', 'packages'));
  console.log(`[software] repo :${goodPort}, ${names.length} packages, punes=BUTTON:${punesBtn}`);

  const script = [
    // -- honest failure: dead repo, real error surfaced, no hang --
    'echo ==deadrepo',
    'mkdir -p /etc/gucman',
    'echo http://127.0.0.1:9 > /etc/gucman/repos',
    'software &',
    'wmctl wait win Software',
    `wmctl wait label 'Cannot reach the package repository'`,
    'echo ==deadtree',
    'wmctl tree',
    // -- the real repo: catalog from the live index --
    'echo ==catalog',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'wmctl click Refresh',
    // catalog-loaded barrier = the FIRST card (always above the fold);
    // punes sits below the 5-card fold since the Phase D font packages
    // joined the pool, and `wait label` needs a VISIBLE card — scroll it
    // into view by clicking the SCROLLBAR's down arrow (SB_LINEDOWN,
    // card-granular; focus-independent, unlike VK_DOWN — the Refresh
    // click leaves keyboard focus on that button).
    `wmctl wait label '${names[0]} ${idx.packages[names[0]].version} [available]'`,
    'SWID=$(wmctl list | grep "Software$" | sed "s/[^0-9].*//")',
    ...Array.from({ length: Math.max(0, names.indexOf('punes') - 2) },
      () => 'wmctl down $SWID 552 376 && wmctl up $SWID 552 376'),
    `wmctl wait label 'punes ${pv} [available]'`,
    'echo ==cattree',
    'wmctl tree',
    // -- one-click install: REAL state change through gucman --
    'echo ==install',
    `wmctl click BUTTON:${punesBtn}`,
    `wmctl wait label 'punes ${pv} [installed]'`,
    'test -x /opt/punes/punes && echo OPT-BINARY-OK',
    'readlink /usr/local/bin/punes',
    'test -e /var/lib/gucman/punes.json && echo DB-OK',
    'echo ==insttree',
    'wmctl tree',
    // -- one-click remove: reversed for real --
    'echo ==remove',
    `wmctl click BUTTON:${punesBtn}`,
    `wmctl wait label 'punes ${pv} [available]'`,
    'test ! -e /opt/punes && echo OPT-GONE',
    'test ! -e /usr/local/bin/punes && echo LINK-GONE',
    'test ! -e /var/lib/gucman/punes.json && echo DB-GONE',
    // -- FS_WATCH liveness: CLI installs flip the open storefront --
    'echo ==watch',
    'gucman install punes >/dev/null 2>&1; echo CLI-INST-RC=$?',
    `wmctl wait label 'punes ${pv} [installed]'`,
    'gucman remove punes >/dev/null 2>&1; echo CLI-REM-RC=$?',
    `wmctl wait label 'punes ${pv} [available]'`,
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');

  const dead = between(out, 'deadtree', 'catalog');
  check('dead repo: notice visible',
    /vis=1 en=1[^\n]*text='Cannot reach the package repository'/.test(dead), dead.slice(0, 400));
  check('dead repo: status carries gucman\'s own error',
    /text='gucman: .*(index\.json|connect|refused|HTTP)/i.test(dead), dead);

  const cat = between(out, 'cattree', 'install');
  for (const n of names)
    check(`catalog card: ${n} ${idx.packages[n].version}`,
      cat.includes(`${n} ${idx.packages[n].version} [available]`));
  check('catalog: notice hidden', !/vis=1[^\n]*text='Cannot reach/.test(cat),
    cat.slice(0, 200));
  // re-verify the BUTTON:n prediction: the first BUTTON after punes's card
  // line is the (punesBtn+1)th BUTTON line overall (tree order)
  {
    const lines = cat.split('\n');
    let btns = 0, afterPunes = -1;
    for (const l of lines) {
      if (afterPunes < 0 && / class=PkgCard /.test(l) && l.includes(`text='punes `)) afterPunes = btns;
      if (/ class=BUTTON /.test(l)) btns++;
    }
    check('BUTTON:n prediction matches the tree', afterPunes === punesBtn,
      `predicted ${punesBtn}, tree says ${afterPunes}`);
  }

  const inst = between(out, 'install', 'insttree');
  check('install: /opt/punes/punes executable (REAL state)', inst.includes('OPT-BINARY-OK'), inst);
  check('install: /usr/local/bin symlink planted', inst.includes('/opt/punes/punes'));
  check('install: DB record exists', inst.includes('DB-OK'));
  const itree = between(out, 'insttree', 'remove');
  check('install: card shows [installed]', itree.includes(`punes ${pv} [installed]`));
  check('install: button flipped to Remove', /class=BUTTON [^\n]*text='Remove'/.test(itree), itree.slice(0, 300));
  check('install: status line is gucman\'s own banner',
    itree.includes(`text='gucman: installed punes ${pv}'`), itree);

  const rem = between(out, 'remove', 'watch');
  check('remove: /opt tree gone (REAL state)', rem.includes('OPT-GONE'), rem);
  check('remove: symlink gone', rem.includes('LINK-GONE'));
  check('remove: DB record gone', rem.includes('DB-GONE'));

  const watch = between(out, 'watch', 'done');
  check('CLI install beside the storefront succeeds', watch.includes('CLI-INST-RC=0'), watch);
  check('CLI remove beside the storefront succeeds', watch.includes('CLI-REM-RC=0'));
  check('session reached the end', out.includes('==done'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nsoftware e2e: ${failures} FAILED` : '\nsoftware e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
