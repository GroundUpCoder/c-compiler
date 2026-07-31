// #317 evidence: fileman's listbox now asks for WS_VSCROLL, so the #275
// built-in bar appears on an overflowing directory and scrolls. Shots land
// in logs/2026-07-31/0317-fileman-vscroll/.
//
//   node tools/os-drive.mjs tools/os-drive-scripts/fileman-vscroll-shots.mjs
export default async function (drive) {
  const M = 'logs/2026-07-31/0317-fileman-vscroll/';
  await drive.vt(2);
  await drive.pause(2000);                       // late EV_SCREEN settle
  await drive.sh('fileman /bin & echo L""AUNCH-OK');
  await drive.waitOut('LAUNCH-OK', 15000);
  await drive.run('wmctl wait win "File Manager - /bin" 15000');
  await drive.run('wmctl wait text LISTBOX:0 zcat 15000');   // listing filled
  const tree = await drive.run('wmctl tree');
  const m = tree.match(/class=LISTBOX id=\d+ rect=(\d+),(\d+) (\d+)x(\d+)/);
  if (!m) throw new Error('no LISTBOX in tree:\n' + tree);
  const [lx, ly, lw, lh] = m.slice(1).map(Number);
  console.log(`[317] listbox rect ${lx},${ly} ${lw}x${lh}`);
  const barX = lx + lw - 10;                     // EDIT_SB_W=16 bar, center column
  const downY = ly + lh - 10;                    // down-arrow center
  await drive.vt(2);
  await drive.pause(1000);                       // paint settle (no repaint marker)
  await drive.shot(M + '01-fileman-bin-scrollbar.png');
  // Scroll: ten down-arrow clicks = ten rows; the thumb must track.
  await drive.sh('SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//"); ' +
    `for i in 1 2 3 4 5 6 7 8 9 10; do wmctl click $SID ${barX} ${downY}; done; ` +
    'echo S""CROLL-OK');
  await drive.waitOut('SCROLL-OK', 20000);
  await drive.vt(2);
  await drive.pause(1000);                       // paint settle (no repaint marker)
  await drive.shot(M + '02-fileman-bin-scrolled.png');
  // Narrow resize: rows re-fit to the new width (names elide, the
  // size/date tail stays right-flush inside the gutter) — the
  // by-construction bound, not a /bin-width coincidence.
  await drive.sh('wmctl resize $SID 300 360 && echo R""SZ-OK');
  await drive.waitOut('RSZ-OK', 15000);
  await drive.vt(2);
  await drive.pause(1000);                       // paint settle (no repaint marker)
  await drive.shot(M + '03-fileman-bin-narrow.png');
  console.log('[317] shots done');
}
