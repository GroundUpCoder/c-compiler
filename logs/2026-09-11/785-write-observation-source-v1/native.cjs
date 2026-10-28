'use strict';
const cp = require('child_process'), fs = require('fs'), path = require('path');
async function bounded(p, ms, label) {
  let timer; try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
function watch(child, command) {
  const row = { pid: child.pid, command, exitObserved: false, closeObserved: false };
  let resolve; const done = new Promise(r => { resolve = r; });
  child.on('error', e => { row.error = String(e); });
  child.on('exit', (code, signal) => { Object.assign(row, { exitObserved: true, code, signal, at: new Date().toISOString() }); });
  child.on('close', (code, signal) => { Object.assign(row, { closeObserved: true, closeCode: code, closeSignal: signal }); resolve(); });
  return { child, row, done };
}
async function stop(w, errors) {
  if (!w || w.row.closeObserved) return;
  try { w.row.termRequested = w.child.kill('SIGTERM'); await bounded(w.done, 5000, 'native TERM completion'); }
  catch (e) { errors.push(String(e));
    if (!w.row.closeObserved) { w.row.killRequested = w.child.kill('SIGKILL'); try { await bounded(w.done, 5000, 'native KILL completion'); } catch (e) { errors.push(String(e)); } }
  }
}
function instrumentSpawns() {
  const original = cp.spawn, children = [];
  cp.spawn = function (file, args, options) { const child = original.apply(this, arguments); children.push(watch(child, [file, ...(Array.isArray(args) ? args : [])])); return child; };
  return { children, restore() { cp.spawn = original; } };
}
module.exports = { bounded, watch, stop, instrumentSpawns };
