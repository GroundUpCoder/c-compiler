#!/usr/bin/env node
// Sound scheme end-to-end (todos/0094): a REAL win32 C program (compiled
// against os/win32/lib.json) runs as a worker_thread under the kernel and
// exercises PlaySound (os/win32/winmm.c over the os/sounds.h core) +
// MessageBeep/MessageBox (user32) against the 0017 kernel mixer. The app
// seeds its own scheme store + WAVs into its private in-process fs (no
// opts.fs kernel — the standalone fs path), so every phase is hermetic.
//
// Phase freqs are DISTINCT so kernel.audioList() tells the phases apart:
//   alias play = 22050, SystemDefault fallback = 8000, SND_FILENAME =
//   11025, SND_MEMORY = 16000, SystemHand (MessageBeep/MessageBox) = 32000.
// Nothing pumps between asserts, so a live stream's queued bytes sit still;
// PlaySound's stop path (clear + destroy) reclaims WITHOUT a pump (the
// empty-ring immediate-reclaim rule), which is what the []-asserts prove.
//
// Run: node tests/kernel/test_sounds_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const APP_C = `
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Write a minimal PCM16 mono WAV: 100 frames of a constant at freq hz. */
static int wav_make(unsigned char *buf, int freq) {
    const int n = 100;
    memcpy(buf, "RIFF", 4);
    *(unsigned int *)(buf + 4) = 36 + n * 2;
    memcpy(buf + 8, "WAVEfmt ", 8);
    *(unsigned int *)(buf + 16) = 16;
    *(unsigned short *)(buf + 20) = 1;         /* PCM */
    *(unsigned short *)(buf + 22) = 1;         /* mono */
    *(unsigned int *)(buf + 24) = freq;
    *(unsigned int *)(buf + 28) = freq * 2;
    *(unsigned short *)(buf + 32) = 2;
    *(unsigned short *)(buf + 34) = 16;
    memcpy(buf + 36, "data", 4);
    *(unsigned int *)(buf + 40) = n * 2;
    for (int i = 0; i < n; i++) *(short *)(buf + 44 + i * 2) = 8192;
    return 44 + n * 2;
}

static void wav_write(const char *path, int freq) {
    unsigned char buf[512];
    int n = wav_make(buf, freq);
    FILE *f = fopen(path, "wb");
    fwrite(buf, 1, n, f);
    fclose(f);
}

static void scheme_write(const char *path, int mute) {
    FILE *f = fopen(path, "w");
    fprintf(f, "# test scheme\\n");
    if (mute) fprintf(f, "mute\\ton\\n");
    fprintf(f, "SystemStart\\t/usr/share/sounds/a.wav\\n");
    fprintf(f, "SystemDefault\\t/usr/share/sounds/b.wav\\n");
    fprintf(f, "SystemHand\\t/usr/share/sounds/d.wav\\n");
    fprintf(f, "SystemQuestion\\tnone\\n");
    fclose(f);
}

static void phase(const char *name, int val) {
    printf("%s=%d\\n", name, val);
    fflush(stdout);
    usleep(700000);                            /* let the test observe */
}

int main(void) {
    mkdir("/usr", 0755); mkdir("/usr/share", 0755); mkdir("/usr/share/sounds", 0755);
    mkdir("/root", 0755); mkdir("/root/.config", 0755);
    wav_write("/usr/share/sounds/a.wav", 22050);
    wav_write("/usr/share/sounds/b.wav", 8000);
    wav_write("/usr/share/sounds/c.wav", 11025);
    wav_write("/usr/share/sounds/d.wav", 32000);
    scheme_write("/usr/share/sounds/scheme", 0);

    /* P1: alias -> 22050 stream */
    phase("P1", PlaySoundA("SystemStart", NULL, SND_ALIAS | SND_ASYNC));
    /* P2: SND_NOSTOP while P1's clip is still queued -> refused */
    phase("P2", PlaySoundA("SystemStart", NULL, SND_ALIAS | SND_ASYNC | SND_NOSTOP));
    /* P3: explicit 'none' alias -> TRUE, stops the current sound, plays nothing */
    phase("P3", PlaySoundA("SystemQuestion", NULL, SND_ALIAS | SND_ASYNC));
    /* P4: unknown alias -> SystemDefault fallback (8000) */
    phase("P4", PlaySoundA("NoSuchEvent", NULL, SND_ALIAS | SND_ASYNC));
    /* P5: unknown alias + SND_NODEFAULT -> FALSE (and current stopped) */
    phase("P5", PlaySoundA("NoSuchEvent", NULL, SND_ALIAS | SND_ASYNC | SND_NODEFAULT));
    /* P6: SND_FILENAME (11025) */
    phase("P6", PlaySoundA("/usr/share/sounds/c.wav", NULL, SND_FILENAME | SND_ASYNC));
    /* P7: PlaySound(NULL) stops it */
    phase("P7", PlaySoundA(NULL, NULL, 0));
    /* P8: SND_MEMORY (16000) */
    {
        unsigned char mem[512];
        wav_make(mem, 16000);
        phase("P8", PlaySoundA((LPCSTR)mem, NULL, SND_MEMORY | SND_ASYNC));
    }
    phase("P9", PlaySoundA(NULL, NULL, 0));
    /* P10: user mute store silences an alias play (TRUE, no stream); the
       'mute on' line rides the same store file the applet writes */
    scheme_write("/root/.config/sounds", 1);
    phase("P10", PlaySoundA("SystemStart", NULL, SND_ALIAS | SND_ASYNC));
    /* P11: unmute; MessageBeep(MB_ICONHAND) -> SystemHand (32000) */
    scheme_write("/root/.config/sounds", 0);
    phase("P11", MessageBeep(MB_ICONHAND));
    phase("P12", PlaySoundA(NULL, NULL, 0));
    /* P13: SND_SYNC returns only after the clip's duration cap */
    phase("P13", PlaySoundA("/usr/share/sounds/c.wav", NULL, SND_FILENAME));
    /* P15-P18 (CS3, cfgstore.h overlay): a user store holding ONLY one
       override key. Pre-CS3 the mere existence of ~/.config/sounds hid the
       baked scheme whole-file; the per-key overlay must keep serving every
       baked key the user didn't override, while the override wins. */
    {
        FILE *f = fopen("/root/.config/sounds", "w");
        fprintf(f, "SystemQuestion\\t/usr/share/sounds/c.wav\\n");
        fclose(f);
    }
    /* P15: a baked-only alias still reaches through the user file
       (SND_NODEFAULT so a miss is FALSE, not a SystemDefault fallback —
       which would ALSO miss pre-CS3, but keep the verdict sharp) */
    phase("P15", PlaySoundA("SystemStart", NULL, SND_ALIAS | SND_ASYNC | SND_NODEFAULT));
    phase("P16", PlaySoundA(NULL, NULL, 0));
    /* P17: the user override WINS over the baked value (baked says none,
       the user maps it to c.wav) */
    phase("P17", PlaySoundA("SystemQuestion", NULL, SND_ALIAS | SND_ASYNC | SND_NODEFAULT));
    phase("P18", PlaySoundA(NULL, NULL, 0));
    /* P19 (blocks): MessageBox with the error icon beeps SystemHand */
    printf("P19\\n");
    fflush(stdout);
    MessageBox(NULL, "boom", "Error", MB_OK | MB_ICONHAND);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-e2e-'));
fs.writeFileSync(path.join(tmp, 'app.c'), APP_C);
fs.writeFileSync(path.join(tmp, 'app.json'), JSON.stringify({
  bin: true, name: 'sndapp',
  deps: [path.join(ROOT, 'os/win32/lib.json')],
  sources: ['app.c'],
}));
const wasm = path.join(tmp, 'app.wasm');
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), path.join(tmp, 'app.json'), '-o', wasm],
  { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/sndapp' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve();
    if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 20);
  })();
});
const waitFor = (fn, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return resolve();
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for condition'));
    setTimeout(poll, 20);
  })();
});
// One live (non-dying) stream at freq f, with the whole 200-byte clip queued.
const oneLive = (f) => {
  const l = kernel.audioList().filter((s) => !s.dying);
  return l.length === 1 && l[0].freq === f && l[0].queued === 200;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — sounds e2e did not finish in 120s\noutput so far:\n' + out);
  process.exit(1);
}, 120000);

(async () => {
  // With an output ring installed, dying streams persist until pumped dry.
  const outInfo = kernel.audioInit({});
  const octl = new Int32Array(outInfo.sab, 0, 4);

  await kernel.boot({ path: '/bin/sndapp', argv: ['sndapp'], envp: ['HOME=/root'], cwd: '/' });

  await waitOut('P1=1');
  await waitFor(() => oneLive(22050));
  check('P1 alias play: one live 22050 stream, clip queued', true);
  const n = kernel.audioPump(16);
  check('P1 the mixer really mixes it (pump produced frames)', n === 16, n);

  await waitOut('P2=0');
  check('P2 SND_NOSTOP while playing refused', out.includes('P2=0'));
  check('P2 kept the current stream', kernel.audioList().some((s) => s.freq === 22050));

  await waitOut('P3=1');
  await waitFor(() => kernel.audioList().length === 0);
  check('P3 `none` alias: TRUE, current stopped, nothing plays', true);

  await waitOut('P4=1');
  await waitFor(() => oneLive(8000));
  check('P4 unknown alias falls back to SystemDefault (8000)', true);

  await waitOut('P5=0');
  await waitFor(() => kernel.audioList().length === 0);
  check('P5 unknown alias + SND_NODEFAULT: FALSE, no stream', true);

  await waitOut('P6=1');
  await waitFor(() => oneLive(11025));
  check('P6 SND_FILENAME plays the file (11025)', true);

  await waitOut('P7=1');
  await waitFor(() => kernel.audioList().length === 0);
  check('P7 PlaySound(NULL) stops the current sound', true);

  await waitOut('P8=1');
  await waitFor(() => oneLive(16000));
  check('P8 SND_MEMORY plays the in-memory image (16000)', true);

  await waitOut('P10=1');
  await waitFor(() => out.includes('P10=1') && kernel.audioList().length === 0);
  check('P10 `mute on` store: TRUE, silent', true);

  await waitOut('P11=1');
  await waitFor(() => oneLive(32000));
  check('P11 MessageBeep(MB_ICONHAND) plays SystemHand (32000)', true);

  await waitOut('P13=1');
  // SND_SYNC destroyed its stream after the duration cap: it is dying with
  // the clip still queued (nothing pumped) — pump drains it dry, reclaim.
  // P15's overlay play may already be a NEW live stream by now, so the
  // condition is "no dying streams left", not an empty list.
  await waitFor(() => {
    kernel.audioPump(4096);
    Atomics.store(octl, K.AU_QUEUED, 0);   // page keeps draining
    return kernel.audioList().every((s) => !s.dying);
  });
  check('P13 SND_SYNC returned; dying stream drains dry + reclaims', true);

  // -- CS3 (cfgstore.h): per-key overlay through a user-override-only store --
  await waitOut('P15=1');
  // The P13 drain loop may have pumped from it — presence at 22050 is the
  // assertion, not the queued byte count.
  await waitFor(() => kernel.audioList().some((s) => !s.dying && s.freq === 22050));
  check('P15 baked-only alias reaches through a customized user store (22050)', true);
  await waitOut('P16=1');
  await waitFor(() => kernel.audioList().length === 0);
  check('P16 stop reclaims', true);
  await waitOut('P17=1');
  await waitFor(() => kernel.audioList().some((s) => !s.dying && s.freq === 11025));
  check('P17 user override wins over the baked `none` (11025)', true);
  await waitOut('P18=1');
  await waitFor(() => kernel.audioList().length === 0);
  check('P18 stop reclaims', true);

  await waitOut('P19');
  // A LIVE stream stays listed however much earlier drain loops pumped from
  // it — presence at 32000 is the assertion, not the queued byte count.
  await waitFor(() => kernel.audioList().some((s) => !s.dying && s.freq === 32000));
  check('P19 MessageBox(MB_ICONHAND) beeps SystemHand (32000)', true);

  kernel.kill(1, 9, null);
  await waitFor(() => {
    kernel.audioPump(4096);
    Atomics.store(octl, K.AU_QUEUED, 0);
    return kernel.audioList().length === 0;
  });
  check('teardown: SIGKILL mid-MessageBox reclaims the stream', true);

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsounds e2e: PASS' : `\nsounds e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  console.error('out=', out);
  console.error('audioList=', JSON.stringify(kernel.audioList()));
  process.exit(1);
});
