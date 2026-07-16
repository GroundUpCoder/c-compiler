// 0221 visual pass: the restructured Presentations folder + the new
// "POSIX on WebAssembly" talk deck, in the real browser boot. Desktop
// dblclick on the Presentations icon -> fileman AT it (two subfolders),
// navigate into each, Open the decks in the mgp viewer, page a few slides,
// and the right-click-Edit -> notepad flow. Shots land in os/media/.
//
//   node tools/os-drive.mjs tools/os-drive-scripts/posix-deck-shots.mjs
export default async function (drive) {
  const M = 'os/media/0221-';
  // Boot lands on VT2 (desktop). Verified flows run via wmctl from VT1.
  await drive.vt(2);
  await drive.pause(2000);                       // late EV_SCREEN settle

  // Desktop dblclick the Presentations DIR icon (dirs-first => cell 0,0;
  // wm.c grid: 16px margin, 84x64 cells, click center +42/+32).
  await drive.sh('DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//"); ' +
    'wmctl dblclick $DSID 58 48 && echo D""BL-OK');
  await drive.waitOut('DBL-OK', 15000);
  await drive.run('wmctl wait win "File Manager - /root/Desktop/Pr" 15000');
  await drive.vt(2);
  await drive.pause(1000);                       // listing paint settle
  await drive.shot(M + '01-presentations-folder.png');

  // Into the talk subfolder, Open the deck in the viewer.
  await drive.sh('wmctl settext EDIT:0 "/root/Desktop/Presentations/POSIX on WebAssembly" && ' +
    'wmctl click Go && echo N""AV-OK');
  await drive.waitOut('NAV-OK', 15000);
  await drive.run('wmctl wait text LISTBOX:0 posix-on-wasm.mgp 15000');
  await drive.vt(2);
  await drive.pause(800);
  await drive.shot(M + '02-talk-subfolder.png');
  await drive.sh('SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//"); ' +
    'wmctl click $SID 200 100; wmctl key $SID 74 1073741898; ' + // HOME row 0
    'wmctl click Open && echo O""PEN-OK');
  await drive.waitOut('OPEN-OK', 15000);
  await drive.run('wmctl wait win MagicPoint 20000');
  await drive.vt(2);
  await drive.pause(2500);                       // title page freetype render
  await drive.shot(M + '03-posix-deck-title.png');
  // space x6 -> the "gucOS: DO" slide (page 7)
  await drive.sh('MSID=$(wmctl list | grep MagicPoint | sed "s/[^0-9].*//"); ' +
    'for i in 1 2 3 4 5 6; do wmctl key $MSID 0 32; sleep 0.8; done; echo P""G-OK');
  await drive.waitOut('PG-OK', 30000);
  await drive.vt(2);
  await drive.pause(1000);
  await drive.shot(M + '04-posix-deck-do-slide.png');
  await drive.sh('wmctl key $MSID 0 113 && echo Q""UIT-OK');   // q quits
  await drive.waitOut('QUIT-OK', 10000);
  await drive.run('wmctl wait nowin MagicPoint 10000');

  // Nested tutorial still opens: deck 01 from its subfolder.
  await drive.sh('wmctl settext EDIT:0 "/root/Desktop/Presentations/MagicPoint Tutorial" && ' +
    'wmctl click Go && echo N""AV2-OK');
  await drive.waitOut('NAV2-OK', 15000);
  await drive.run('wmctl wait text LISTBOX:0 01-welcome.mgp 15000');
  await drive.sh('wmctl click $SID 200 100; wmctl key $SID 74 1073741898; ' +
    'wmctl click Open && echo O""PEN2-OK');
  await drive.waitOut('OPEN2-OK', 15000);
  await drive.run('wmctl wait win MagicPoint 20000');
  await drive.vt(2);
  await drive.pause(2500);
  await drive.shot(M + '05-tutorial-still-opens.png');
  await drive.sh('MSID=$(wmctl list | grep MagicPoint | sed "s/[^0-9].*//"); ' +
    'wmctl key $MSID 0 113; echo Q""UIT2-OK');
  await drive.waitOut('QUIT2-OK', 10000);
  await drive.run('wmctl wait nowin MagicPoint 10000');

  // Right-click Edit on the talk deck -> notepad shows the TEXT.
  await drive.sh('wmctl settext EDIT:0 "/root/Desktop/Presentations/POSIX on WebAssembly" && ' +
    'wmctl click Go && echo N""AV3-OK');
  await drive.waitOut('NAV3-OK', 15000);
  await drive.run('wmctl wait text LISTBOX:0 posix-on-wasm.mgp 15000');
  await drive.sh('wmctl click $SID 100 30 3 && echo R""C-OK'); // right-click row 0
  await drive.waitOut('RC-OK', 10000);
  await drive.run('wmctl wait label Edit 10000');
  await drive.sh('wmctl click Edit && echo E""D-OK');
  await drive.waitOut('ED-OK', 10000);
  await drive.run('wmctl wait win "posix-on-wasm.mgp - Notepad" 20000');
  await drive.vt(2);
  await drive.pause(1500);
  await drive.shot(M + '06-edit-in-notepad.png');
  console.log('[0221] visual pass complete, 6 shots in os/media/');
}
