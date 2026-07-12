// The 0167/0171-style launch -> close -> probe loop, as an os-drive script —
// the committed replacement for the bespoke scratch files that investigation
// hand-built. Launches doom, closes it via wmctl, then immediately types a
// pipeline probe racing hush's reap of the background job (the 0171 wedge
// window: a typed line straddling hush's cooked window -> lineedit's raw
// switch lost its head to the canonical edit buffer).
//
//   node tools/os-drive.mjs [--under-load] tools/os-drive-scripts/doom-close-probe.mjs [iters]
export default async function (drive, args) {
  const iters = parseInt(args[0] || '5', 10);
  for (let i = 0; i < iters; i++) {
    await drive.sh('doom &');
    // window listed = surface created + composited at least once
    await drive.run('wmctl wait win "DOOM Shareware" 60000', { timeout: 70000 });
    await drive.pause(1500);                    // let the demo actually run a beat
    await drive.sh(`wmctl close $(wmctl list | grep "DOOM Shareware$" | sed "s/[^0-9].*//") && echo C""LOSED-${i}`);
    await drive.waitOut(`CLOSED-${i}`, 20000);
    // the probe: a pipeline typed right into the reap window
    await drive.sh(`ps | grep -c "doom$" ; echo P""ROBE-${i}-END`);
    await drive.waitOut(`PROBE-${i}-END`, 15000);
    console.log(`[probe] iter ${i} clean`);
  }
  console.log(`[probe] ${iters}/${iters} clean`);
}
