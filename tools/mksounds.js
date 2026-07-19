#!/usr/bin/env node
// mksounds.js — synthesize the event-sound WAVs (todos/0094) into os/sounds/.
//
// The OS ships a small Win95-style sound scheme (startup chime, error chord,
// ding, exclamation chimes); real Windows media files are copyrighted, so the
// clips are synthesized here — pure deterministic math, so re-running always
// reproduces byte-identical files. The outputs are COMMITTED (the
// vendor/fonts ttfs / *.res sidecar precedent): the image bake (os/image.json
// `bin` entries) reads os/sounds/*.wav like any other repo blob, no build
// step. Re-run only when changing a clip, then re-commit.
//
// Format: 22050 Hz mono s16 PCM — small (~44 KB/s), and the kernel mixer
// (todos/0017) resamples to the 48k output ring anyway. Keep every clip
// comfortably under ~5s: PlaySound pushes a clip into the per-device source
// ring (256 KB) in one shot and lets the kernel drain it.
//
// Run: node tools/mksounds.js
'use strict';
const fs = require('fs');
const path = require('path');

const RATE = 22050;
const OUT_DIR = path.join(__dirname, '..', 'os', 'sounds');

function wavEncode(samples) {
  // samples: Float32-ish array in [-1, 1] -> RIFF/WAVE PCM16 mono.
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);                    // PCM
  buf.writeUInt16LE(1, 22);                    // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);             // byte rate
  buf.writeUInt16LE(2, 32);                    // block align
  buf.writeUInt16LE(16, 34);                   // bits
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32000), 44 + i * 2);
  }
  return buf;
}

// A struck-bell partial: sine with exponential decay and a soft attack.
// `at` seconds into the clip, frequency f, amplitude a, decay time constant d.
function bell(out, at, f, a, d, attack) {
  const start = Math.floor(at * RATE);
  const atk = Math.max(1, Math.floor((attack || 0.004) * RATE));
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / RATE;
    const env = Math.exp(-t / d) * (i - start < atk ? (i - start) / atk : 1);
    if (env < 1e-4 && i - start > atk) break;
    // fundamental + two soft inharmonic partials = glassy chime timbre
    out[i] += a * env * (Math.sin(2 * Math.PI * f * t) +
                         0.35 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / (d * 0.4)) +
                         0.18 * Math.sin(2 * Math.PI * f * 5.40 * t) * Math.exp(-t / (d * 0.25)));
  }
}

// A softer pad tone: sine + one octave harmonic, slow attack, linear-ish release.
function pad(out, at, f, a, dur, attack) {
  const start = Math.floor(at * RATE);
  const len = Math.floor(dur * RATE);
  const atk = Math.max(1, Math.floor(attack * RATE));
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / RATE;
    let env = i < atk ? i / atk : 1;
    const rel = len - i;
    const relN = Math.floor(0.25 * RATE);
    if (rel < relN) env *= rel / relN;
    out[start + i] += a * env * (Math.sin(2 * Math.PI * f * t) +
                                 0.25 * Math.sin(2 * Math.PI * f * 2 * t));
  }
}

function clip(dur) { return new Float32Array(Math.floor(dur * RATE)); }

// SystemStart — the boot chime: a rising D-major arpeggio over a low pad
// (nostalgic, unhurried; ~2.2s with the tail).
function startup() {
  const out = clip(2.2);
  pad(out, 0.0, 146.83, 0.16, 2.0, 0.30);            // D3 pad
  pad(out, 0.0, 220.0, 0.10, 2.0, 0.40);             // A3
  bell(out, 0.00, 293.66, 0.22, 0.9, 0.010);         // D4
  bell(out, 0.18, 440.0, 0.20, 0.9, 0.010);          // A4
  bell(out, 0.36, 587.33, 0.20, 1.0, 0.010);         // D5
  bell(out, 0.54, 739.99, 0.18, 1.2, 0.010);         // F#5
  bell(out, 0.90, 1174.66, 0.10, 1.2, 0.015);        // D6 shimmer
  return out;
}

// SystemHand — the error chord: a stern low minor cluster, quick decay.
function chord() {
  const out = clip(1.0);
  bell(out, 0.0, 220.0, 0.28, 0.35, 0.003);          // A3
  bell(out, 0.0, 261.63, 0.24, 0.35, 0.003);         // C4
  bell(out, 0.0, 329.63, 0.20, 0.30, 0.003);         // E4
  bell(out, 0.0, 110.0, 0.20, 0.40, 0.003);          // A2 weight
  return out;
}

// SystemDefault / SystemAsterisk / SystemQuestion — one bright ding.
function ding() {
  const out = clip(0.8);
  bell(out, 0.0, 880.0, 0.30, 0.28, 0.003);          // A5
  bell(out, 0.0, 1318.5, 0.10, 0.20, 0.003);         // E6 sparkle
  return out;
}

// SystemExclamation — two-note descending chime.
function chimes() {
  const out = clip(1.0);
  bell(out, 0.00, 1046.5, 0.24, 0.30, 0.004);        // C6
  bell(out, 0.16, 783.99, 0.24, 0.40, 0.004);        // G5
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const FILES = {
  'startup.wav': startup(),
  'chord.wav': chord(),
  'ding.wav': ding(),
  'chimes.wav': chimes(),
};
for (const [name, samples] of Object.entries(FILES)) {
  const buf = wavEncode(samples);
  fs.writeFileSync(path.join(OUT_DIR, name), buf);
  console.log(`${name}: ${(buf.length / 1024).toFixed(1)} KB, ${(samples.length / RATE).toFixed(2)}s`);
}
