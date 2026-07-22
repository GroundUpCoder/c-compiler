// Spike runner: instantiate ksvc.wasm with a MINIMAL kernel-side env
// (Node fs stands in for kfs — same sync read-only surface) and
// rasterize one glyph. Proves: no host.js/runModule needed.
const fs = require('fs');
const path = require('path');
const bytes = fs.readFileSync(path.join(__dirname, 'ksvc.wasm'));
const wmod = new WebAssembly.Module(bytes);

let instance = null;
const mem = () => instance.exports.memory;
const u8 = () => new Uint8Array(mem().buffer);
function readCStr(p) { const b = u8(); let e = p; while (b[e]) e++; return Buffer.from(b.subarray(p, e)).toString('utf8'); }
const trap = n => () => { throw new Error('ksvc env: unexpected import called: ' + n); };

const fds = new Map(); let nextFd = 100;
const env = {
  __open_impl: (p, flags) => {
    try { const fd = nextFd++; let pth = readCStr(p); if (pth.startsWith('/etc/') || pth.startsWith('/usr/')) pth = path.join(__dirname, 'fakeroot', pth); fds.set(fd, { h: fs.openSync(pth, 'r'), pos: 0 }); return fd; }
    catch (e) { return -1; }
  },
  read: (fd, buf, n) => {
    const f = fds.get(fd); if (!f) return -1;
    const got = fs.readSync(f.h, u8(), buf, n, f.pos); f.pos += got; return got;
  },
  close: fd => { const f = fds.get(fd); if (!f) return -1; fs.closeSync(f.h); fds.delete(fd); return 0; },
  lseek: (fd, off, wh) => {
    const f = fds.get(fd); if (!f) return -1n;
    const size = fs.fstatSync(f.h).size;
    const base = wh === 0 ? 0 : wh === 1 ? f.pos : size;
    f.pos = base + Number(off); return BigInt(f.pos);
  },
  write: (fd, buf, n) => { process.stderr.write(Buffer.from(u8().subarray(buf, buf + n))); return n; },
  access: trap('access'), remove: trap('remove'), mkdir: trap('mkdir'), pipe: trap('pipe'),
  __spawn: trap('__spawn'), __spawn_wait: trap('__spawn_wait'), __spawn_kill: trap('__spawn_kill'),
  getpid: () => 0, __exit: s => { throw new Error('ksvc __exit(' + s + ')'); },
  vsnprintf: (buf, size, fmtp, app) => {
    const fmt = readCStr(fmtp);
    if (fmt !== '%s') throw new Error('spike vsnprintf: unhandled fmt ' + JSON.stringify(fmt));
    const dv2 = new DataView(mem().buffer);
    const va = dv2.getUint32(app, true);
    const sp = dv2.getUint32(va, true);
    const str = readCStr(sp);
    const bytes2 = Buffer.from(str);
    const n2 = Math.min(bytes2.length, size - 1);
    if (size > 0) { u8().set(bytes2.subarray(0, n2), buf); u8()[buf + n2] = 0; }
    return bytes2.length;
  }, __vsscanf_impl: trap('__vsscanf_impl'),
  __strtod_impl: trap('__strtod_impl'), __strtof_impl: trap('__strtof_impl'),
  __time_now: () => BigInt(Math.floor(Date.now() / 1000)),
  __clock: () => Math.floor(performance.now()),
  __timezone_offset: () => 0, __clock_ns_hi: () => 0, __clock_ns_lo: () => 0,
  __on_sigdisp: trap('__on_sigdisp'), __on_sigmask: trap('__on_sigmask'),
  __sig_pause: trap('__sig_pause'), __setitimer: trap('__setitimer'), __getitimer: trap('__getitimer'),
};
instance = new WebAssembly.Instance(wmod, { c: env });
const E = instance.exports;

console.log('ksvc_init ->', E.ksvc_init());
// Stage the font path string via alloca
const fontPath = path.join(__dirname, '../../../vendor/fonts/NotoSansMono-Regular.ttf');
const pb = Buffer.from(fontPath + '\0');
const pp = E.alloca(pb.length);
u8().set(pb, pp);
console.log('load_face ->', E.ksvc_spike_load_face(pp));
const wp = E.alloca(8);
const bmp = E.ksvc_spike_glyph('A'.charCodeAt(0), wp, wp + 4);
const dv = new DataView(mem().buffer);
const w = dv.getInt32(wp, true), h = dv.getInt32(wp + 4, true);
console.log('glyph A ->', bmp, w + 'x' + h);
console.log('fc_load ->', E.ksvc_spike_chain());
for (const cp of ['R'.charCodeAt(0), 'B'.charCodeAt(0)]) {   // B = embolden probe
  const wp2 = E.alloca(8);
  const g = E.ksvc_spike_glyph(cp, wp2, wp2 + 4);
  const d2 = new DataView(mem().buffer);
  const gw = d2.getInt32(wp2, true), gh = d2.getInt32(wp2 + 4, true);
  console.log(String.fromCharCode(cp), '->', gw + 'x' + gh);
  const b2 = u8();
  for (let y = 0; y < gh; y++) {
    let row = '';
    for (let x = 0; x < gw; x++) { const v = b2[g + y * gw + x]; row += v > 160 ? '#' : v > 64 ? '+' : v > 16 ? '.' : ' '; }
    console.log(row);
  }
}
if (bmp && w > 0) {
  const b = u8();
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) { const v = b[bmp + y * w + x]; row += v > 160 ? '#' : v > 64 ? '+' : v > 16 ? '.' : ' '; }
    console.log(row);
  }
}
