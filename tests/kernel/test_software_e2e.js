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
//   - the minBase BOUNDARY: software.c gates listing on `g_base < minBase`.
//     mkpkg stamps every package that declares no explicit minBase with the
//     CURRENT image version, so minBase == base is the NORMAL case for a
//     freshly shipped package — had that comparison been `<=`, every such
//     package would have listed permanently greyed as "needs newer OS" on the
//     exact version that introduced it. Both sides of the boundary are pinned
//     here against a synthetic two-entry repo (minBase == base -> [available]
//     with Install enabled; minBase == base + 1 -> [needs newer OS], disabled).
//   - FAT-fixture leg (win32 Lane 0): packages folded into the sealed /usr
//     (os-release PACKAGES=) render [built-in] with Install DISABLED,
//     `gucman list --all`/`info` print built-in, and an install-over-the-top
//     round-trips [installed] -> remove -> [built-in]; the minimal-image
//     session doubles as the negative control (no PACKAGES=, all [available])
//
// The punes Install button's agent address is BUTTON:n with
// n = 1 + sortedIndex(punes): button creation order is Refresh first, then
// one action button per card in sorted-name order. The tree dump taken in
// the session re-verifies that prediction post-hoc.
//
// Run: node tests/kernel/test_software_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
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
  const repo = ensurePackages(['punes']);
  const idx = repo.index;
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-software-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const names = Object.keys(idx.packages).sort();
  const pv = idx.packages.punes.version;
  // header chrome buttons precede the cards in tree order: Refresh, then the
  // "Install to Desktop" toggle (Q5/#90), then one Install/Remove per card.
  const punesBtn = 2 + names.indexOf('punes');

  const goodPort = await startServer(repo.dir);
  console.log(`[software] repo :${goodPort}, ${names.length} packages, punes=BUTTON:${punesBtn}`);

  // ---- the minBase boundary repo ----
  // A synthetic two-entry index, one package on each side of software.c's
  // `g_base < minBase` gate. `base` is DERIVED from os/image.json (the version
  // the booted blob stamps into os-release VERSION_ID) — a literal here would
  // silently stop testing the boundary at the next image bump.
  const PATH = require('path');
  const CCROOT = PATH.resolve(__dirname, '../..');
  const base = JSON.parse(fs.readFileSync(PATH.join(CCROOT, 'os/image.json'), 'utf-8')).version | 0;
  // The property that makes the boundary load-bearing rather than academic:
  // mkpkg defaults an undeclared minBase to the CURRENT image version, so a
  // freshly shipped package sits exactly ON the boundary. Pin it against the
  // real index so the synthetic entries below keep testing the real case.
  const onBoundary = names.filter((n) => idx.packages[n].minBase === base);
  check('mkpkg stamps undeclared minBase with the current image version ' +
        `(${onBoundary.length}/${names.length} catalog packages sit ON the boundary)`,
    onBoundary.length > 0, JSON.stringify(names.map((n) => [n, idx.packages[n].minBase])));
  const bEqual = 'zz-base-equal', bNewer = 'zz-base-newer';
  const bdir = fs.mkdtempSync(PATH.join(os.tmpdir(), 'gucos-minbase-'));
  const payload = (u) => ({ format: 'tar+gzip', url: u, size: 1, sha256: '0'.repeat(64) });
  fs.writeFileSync(PATH.join(bdir, 'index.json'), JSON.stringify({
    packages: {
      [bEqual]: { version: '1', summary: 'minBase == the running base',
                  minBase: base, deps: [], payload: payload('pool/e.pkg.tar.gz') },
      [bNewer]: { version: '1', summary: 'minBase == the running base + 1',
                  minBase: base + 1, deps: [], payload: payload('pool/n.pkg.tar.gz') },
    },
  }));
  const bPort = await startServer(bdir);
  console.log(`[software] minBase boundary repo :${bPort} (base=v${base})`);

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
      () => 'wmctl down $SWID 632 420 && wmctl up $SWID 632 420'),
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
    // -- the minBase boundary, both sides, in the SAME live storefront --
    'echo ==boundary',
    `echo http://127.0.0.1:${bPort} > /etc/gucman/repos`,
    'wmctl click Refresh',
    // two cards only, so both are above the fold — no scrolling needed
    `wmctl wait label '${bEqual} 1 [available]'`,
    `wmctl wait label '${bNewer} 1 [needs newer OS]'`,
    'echo ==btree',
    'wmctl tree',
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
  check('header carries the Install-to-Desktop toggle (Q5/#90)',
    /class=BUTTON [^\n]*text='Install to Desktop'/.test(cat), cat.slice(0, 400));
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

  const watch = between(out, 'watch', 'boundary');
  check('CLI install beside the storefront succeeds', watch.includes('CLI-INST-RC=0'), watch);
  check('CLI remove beside the storefront succeeds', watch.includes('CLI-REM-RC=0'));

  // ---- the minBase boundary ----
  // `g_base < minBase` (software.c model_refresh). ON the boundary is the
  // NORMAL case for a newly shipped package, so it must list [available] with
  // a live Install button; one past it must list [needs newer OS] with the
  // button disabled. `<=` would flip the first of these — the one-character
  // failure this pins.
  const btree = between(out, 'btree', 'done');
  const cardBtn = (tree, name) => {
    const lines = tree.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/ class=PkgCard /.test(lines[i]) && lines[i].includes(`text='${name} `)) {
        for (let j = i + 1; j < lines.length; j++)
          if (/ class=BUTTON /.test(lines[j])) return lines[j];
        return null;
      }
    }
    return null;
  };
  check(`minBase == base (v${base}): card lists [available], NOT "needs newer OS"`,
    btree.includes(`${bEqual} 1 [available]`) && !btree.includes(`${bEqual} 1 [needs newer OS]`),
    btree.slice(0, 600));
  check('minBase == base: Install button ENABLED',
    (() => { const b = cardBtn(btree, bEqual); return !!b && /en=1/.test(b) && /text='Install'/.test(b); })(),
    cardBtn(btree, bEqual));
  check(`minBase == base + 1 (v${base + 1}): card lists [needs newer OS]`,
    btree.includes(`${bNewer} 1 [needs newer OS]`), btree.slice(0, 600));
  check('minBase == base + 1: Install button DISABLED',
    (() => { const b = cardBtn(btree, bNewer); return !!b && /en=0/.test(b); })(),
    cardBtn(btree, bNewer));

  check('session reached the end', out.includes('==done'));

  // ---- FAT-fixture leg (win32 Lane 0): a package folded into the sealed
  // /usr (os-release PACKAGES=) has no install-DB record, but it is NOT
  // available — its card reads [built-in] with the Install button DISABLED,
  // `gucman list --all` / `info` print built-in, and an install-over-the-top
  // keeps plain installed semantics (remove returns to built-in, never to
  // available). The minimal-image session above stays the negative control:
  // no PACKAGES= line, everything [available]. Boots the default fat image
  // (boot.js installs the prebaked os/os-system.img fixture; a cold
  // standalone run bakes it privately — run the suite prebake first).
  const fat = freshImage('os-software-fat-');
  const fatScript = [
    'echo ==fatboot',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'software &',
    'wmctl wait win Software',
    // catalog-loaded barrier (startup auto-fetch), then scroll punes into
    // view — same SB_LINEDOWN trick as the minimal leg (wait label needs
    // a VISIBLE card).
    `wmctl wait label '${names[0]} ${idx.packages[names[0]].version} [built-in]'`,
    'SWID=$(wmctl list | grep "Software$" | sed "s/[^0-9].*//")',
    ...Array.from({ length: Math.max(0, names.indexOf('punes') - 2) },
      () => 'wmctl down $SWID 632 420 && wmctl up $SWID 632 420'),
    `wmctl wait label 'punes ${pv} [built-in]'`,
    'echo ==fattree',
    'wmctl tree',
    // the CLI surfaces agree with the cards
    'echo ==fatcli',
    'gucman list --all 2>/dev/null | grep "^punes"; echo LIST-RC=$?',
    'gucman info punes 2>/dev/null | grep "installed:"; echo INFO-RC=$?',
    // install-over-the-top: a DB record on top of the baked twin flips the
    // card to plain [installed]; remove replays the record and lands back
    // at [built-in] — the sealed base twin never leaves the system
    'echo ==fatover',
    'gucman install punes >/dev/null 2>&1; echo OVER-RC=$?',
    `wmctl wait label 'punes ${pv} [installed]'`,
    'gucman remove punes >/dev/null 2>&1; echo OVERRM-RC=$?',
    `wmctl wait label 'punes ${pv} [built-in]'`,
    'echo ==fatdone',
  ];
  const rf = driveBoot(fatScript, { image: fat.image, timeout: 420000 });
  const fout = String(rf.stdout || '');

  const ftree = between(fout, 'fattree', 'fatcli');
  check('fat: punes card shows [built-in]', ftree.includes(`punes ${pv} [built-in]`),
    ftree.slice(0, 400));
  check('fat: no card shows [available] (every catalog package is baked)',
    !ftree.includes('[available]'));
  {
    // the BUTTON right after punes's card line is its action button:
    // label Install, DISABLED (a sealed /usr/opt package is not installable)
    const lines = ftree.split('\n');
    let btn = null;
    for (let i = 0; i < lines.length; i++) {
      if (/ class=PkgCard /.test(lines[i]) && lines[i].includes(`text='punes `)) {
        for (let j = i + 1; j < lines.length && !btn; j++)
          if (/ class=BUTTON /.test(lines[j])) btn = lines[j];
        break;
      }
    }
    check('fat: punes Install button is disabled',
      btn !== null && /en=0/.test(btn) && /text='Install'/.test(btn), btn);
  }
  const fcli = between(fout, 'fatcli', 'fatover');
  check('fat: gucman list --all prints built-in',
    /^punes\s+\S+\s+built-in\s/m.test(fcli) && fcli.includes('LIST-RC=0'), fcli);
  check('fat: gucman info prints installed: built-in',
    /installed:\s*built-in/.test(fcli) && fcli.includes('INFO-RC=0'), fcli);
  const fover = between(fout, 'fatover', 'fatdone');
  check('fat: install-over-the-top succeeds (plain installed semantics)',
    fover.includes('OVER-RC=0'), fover);
  check('fat: remove-over-the-top succeeds (card returned to built-in)',
    fover.includes('OVERRM-RC=0'));
  check('fat session reached the end', fout.includes('==fatdone'));

  fs.rmSync(fat.dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bdir, { recursive: true, force: true });
  console.log(failures ? `\nsoftware e2e: ${failures} FAILED` : '\nsoftware e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
