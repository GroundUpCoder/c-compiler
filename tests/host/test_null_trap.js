#!/usr/bin/env node
'use strict';
// #709: the custom null-use trap is opt-in, source-attributed, and preserves
// C evaluation/exemption semantics. This is intentionally an exported API
// test as well as a real V8 execution test.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const CC = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const HOST = require(path.join(ROOT, 'host.js'));

function compile(src, compilerOptions, postPassObserver) {
  const name = '/null-trap.c';
  const files = new Map([[name, src]]);
  const fsShim = { readFileSync(p) { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); } };
  const pp = CC.createDefaultPPRegistry();
  pp.fileReader = p => files.has(p) ? files.get(p) : null;
  const opts = { compilerOptions: compilerOptions || {}, warningFlags: {}, writeErr: s => { throw new Error(s); } };
  const units = CC.parseAllUnits(fsShim, pp, [name], opts);
  const linked = CC.linkTranslationUnits(units, opts.compilerOptions);
  assert.deepStrictEqual(linked.errors, []);
  if (postPassObserver) opts.postPassObserver = postPassObserver;
  return CC.generateCode(units, 'a.wasm', opts);
}

function names(bytes) {
  return WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'name')
    .map(b => Buffer.from(b).toString('utf8')).join('\n');
}

function sectionSizes(bytes) {
  const b = Buffer.from(bytes), out = new Map(); let i = 8;
  const u = () => { let v = 0, s = 0, x; do { x = b[i++]; v |= (x & 127) << s; s += 7; } while (x & 128); return v >>> 0; };
  while (i < b.length) {
    const id = b[i++], n = u(), end = i + n; let key = id;
    if (id === 0) { const z = u(); key = 'custom:' + b.subarray(i, i + z).toString(); }
    out.set(key, n); i = end;
  }
  return out;
}

function decodeWasm(bytes) {
  const b = Buffer.from(bytes), sections = [], custom = new Map();
  const readU = p => { let v = 0, s = 0, x; do { x = b[p.i++]; v |= (x & 127) << s; s += 7; } while (x & 128); return v >>> 0; };
  const readS = p => { let v = 0, s = 0, x; do { x = b[p.i++]; v |= (x & 127) << s; s += 7; } while (x & 128); if (s < 32 && (x & 64)) v |= (~0 << s); return v | 0; };
  const readStr = p => { const n = readU(p), s = b.subarray(p.i, p.i + n).toString(); p.i += n; return s; };
  let p = { i: 8 };
  while (p.i < b.length) {
    const id = b[p.i++], size = readU(p), start = p.i, end = start + size;
    const sec = { id, start, end }; sections.push(sec);
    if (id === 0) { const q = { i: start }, name = readStr(q); sec.name = name; sec.payload = q.i; custom.set(name, sec); }
    p.i = end;
  }
  const one = id => sections.find(s => s.id === id);
  const funcImports = WebAssembly.Module.imports(new WebAssembly.Module(b)).filter(x => x.kind === 'function').length;
  const types = [];
  { const s = one(1), q = { i: s.start }, n = readU(q);
    const readFuncType = () => {
      assert.strictEqual(b[q.i++], 0x60, 'structural fixture unexpectedly emitted a non-function type');
      const pn = readU(q), params = []; for (let j = 0; j < pn; j++) params.push(b[q.i++]);
      const rn = readU(q), results = []; for (let j = 0; j < rn; j++) results.push(b[q.i++]);
      types.push({ params, results });
    };
    for (let i = 0; i < n; i++) {
      if (b[q.i] === 0x4e) { q.i++; const members = readU(q); for (let j = 0; j < members; j++) readFuncType(); }
      else readFuncType();
    }
  }
  const funcTypes = [];
  { const s = one(3), q = { i: s.start }, n = readU(q); for (let i = 0; i < n; i++) funcTypes.push(readU(q)); }
  const exports = new Map();
  { const s = one(7), q = { i: s.start }, n = readU(q); for (let i = 0; i < n; i++) {
      const name = readStr(q), kind = b[q.i++], idx = readU(q); exports.set(name, { kind, idx });
  } }
  const names = new Map();
  { const s = custom.get('name'), q = { i: s.payload }; while (q.i < s.end) {
      const kind = b[q.i++], len = readU(q), end = q.i + len;
      if (kind === 1) { const n = readU(q); for (let i = 0; i < n; i++) names.set(readU(q), readStr(q)); }
      q.i = end;
  } }
  const bodies = new Map();
  { const s = one(10), q = { i: s.start }, n = readU(q); for (let i = 0; i < n; i++) {
      const size = readU(q), bodyStart = q.i, end = bodyStart + size, lrun = readU(q);
      for (let j = 0; j < lrun; j++) { readU(q); q.i++; }
      bodies.set(funcImports + i, { start: q.i, end, bytes: b.subarray(q.i, end) }); q.i = end;
  } }
  const table = new Map();
  { const s = one(9), q = { i: s.start }, n = readU(q); for (let i = 0; i < n; i++) {
      const flags = readU(q); assert.strictEqual(flags, 0, 'fixture element segment is not active table-0 form');
      assert.strictEqual(b[q.i++], 0x41); const slot = readS(q); assert.strictEqual(b[q.i++], 0x0b);
      const count = readU(q); for (let j = 0; j < count; j++) table.set(slot + j, readU(q));
  } }
  const sourceMap = { files: [], entries: [] };
  { const s = custom.get('c.sourcemap'), q = { i: s.payload }, nf = readU(q); for (let i = 0; i < nf; i++) sourceMap.files.push(readStr(q));
    const n = readU(q); let off = 0, file = 0, line = 0; for (let i = 0; i < n; i++) {
      if (i === 0) { off = readU(q); file = readU(q); line = readU(q); }
      else { off += readU(q); file += readS(q); line += readS(q); }
      sourceMap.entries.push({ off, file, line });
    }
  }
  return { b, funcImports, types, funcTypes, exports, names, bodies, table, sourceMap };
}

// Boundary-aware decoder for the MVP instructions emitted by the small
// structural fixture. Unknown opcodes fail loud; extending the fixture cannot
// silently turn this back into a byte-pattern search.
function decodeInstructions(body) {
  const b = body.bytes, out = []; let i = 0;
  const u = () => { let v = 0, s = 0, x; do { assert(i < b.length, 'truncated ULEB'); x = b[i++]; v |= (x & 127) << s; s += 7; } while (x & 128); return v >>> 0; };
  const s = () => { let v = 0, sh = 0, x; do { assert(i < b.length, 'truncated SLEB'); x = b[i++]; v |= (x & 127) << sh; sh += 7; } while (x & 128); if (sh < 32 && (x & 64)) v |= (~0 << sh); return v | 0; };
  const blockType = () => {
    const x = b[i];
    if (x === 0x40 || x === 0x7f || x === 0x7e || x === 0x7d || x === 0x7c) { i++; return x; }
    return s();
  };
  while (i < b.length) {
    const rel = i, opcode = b[i++], ins = { opcode, rel, off: body.start + rel };
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) ins.blockType = blockType();
    else if (opcode === 0x0c || opcode === 0x0d || opcode === 0x10 ||
             (opcode >= 0x20 && opcode <= 0x24)) ins.imm = u();
    else if (opcode >= 0x28 && opcode <= 0x3e) ins.imm = { align: u(), offset: u() };
    else if (opcode === 0x41) ins.imm = s();
    else if (opcode === 0x00 || opcode === 0x05 || opcode === 0x0b ||
             opcode === 0x0f || opcode === 0x1a ||
             (opcode >= 0x45 && opcode <= 0x4f) ||
             (opcode >= 0x67 && opcode <= 0x78)) { /* no immediate */ }
    else throw new Error('fixture decoder: unsupported opcode 0x' + opcode.toString(16) + ' at +' + rel);
    ins.end = body.start + i; out.push(ins);
  }
  return out;
}

async function run(src, options) {
  const bytes = compile(src, options);
  const instance = await WebAssembly.instantiate(bytes, { c: {} });
  try { return { value: instance.instance.exports.main(), bytes }; }
  catch (error) { return { error, bytes }; }
}

(async function () {
  const basic = 'struct S{int x;}; int main(void){struct S*p=0;return p->x;}\n';
  const omitted = compile(basic, {});
  const explicitFalse = compile(basic, { trapNullDereference: false });
  assert(Buffer.from(omitted).equals(Buffer.from(explicitFalse)),
    'omitted and explicit-false API options must be byte-identical');
  assert(!names(omitted).includes('__cc_null_dereference'), 'default-off emitted trap metadata');

  for (const [kind, src] of [
    ['dereference', 'int main(void){int*p=0;return *p;}'],
    ['member', 'struct S{int x;};int main(void){struct S*p=0;return p->x;}'],
    ['subscript', 'int main(void){int*p=0;return p[2];}'],
    ['indirect-call', 'int main(void){int(*p)(void)=0;return p();}'],
    ['member', 'struct T{int x;};struct S{struct T*t;};int main(void){struct S s={0};return s.t->x;}'],
    ['member', 'struct S{unsigned x:3;};int main(void){struct S*p=0;p->x++;return 0;}'],
    ['dereference', 'struct S{int x;};int main(void){struct S*p=0;struct S x=*p;return x.x;}'],
    ['dereference', 'struct S{int x;};int main(void){struct S*p=0;struct S x={4};*p=x;return 0;}'],
    ['dereference', 'int main(void){volatile int*p=0;return *p;}'],
    ['member', 'struct S{int x;};int main(void){struct S*p=0;int*q=&p->x;return q!=0;}'],
    ['indirect-call', 'int main(void){int(*p)(int,...)=0;return p(1,2);}'],
  ]) {
    const r = await run(src, { trapNullDereference: true });
    assert(r.error instanceof WebAssembly.RuntimeError, kind + ' did not trap');
    assert(String(r.error.stack).split('\n')[1].includes('__cc_null_dereference[/null-trap.c:1:' + kind + ']'),
      kind + ' top frame is not the generated source marker: ' + r.error.stack);
  }

  for (const debug of [false, true]) {
    const r = await run('struct S{int x;};__attribute__((noinline)) static int f(struct S*p){return p->x;}int main(void){return f(0);}',
      { trapNullDereference: true, emitNames: debug });
    assert(r.error && String(r.error.stack).split('\n')[1].includes('__cc_null_dereference'),
      'generated top frame missing with emitNames=' + debug);
    if (debug) assert(String(r.error.stack).includes('at f '), 'named C caller missing under -g: ' + r.error.stack);
  }

  // Before-store proof: seed address zero from the host, then ensure the
  // trap fires before the attempted write can alter it.
  {
    const bytes = compile('int main(void){int*p=0;*p=0x11223344;return 0;}', { trapNullDereference: true });
    const x = await WebAssembly.instantiate(bytes, { c: {} });
    new Uint8Array(x.instance.exports.memory.buffer)[0] = 0x5a;
    assert.throws(() => x.instance.exports.main(), WebAssembly.RuntimeError);
    assert.strictEqual(new Uint8Array(x.instance.exports.memory.buffer)[0], 0x5a,
      'null store modified memory before trapping');
  }

  const semantics = await run(
    'struct S{int x;};static int b,i;static int a0=7;static struct S s={7};' +
    'static int*base(void){b++;return &a0;}static struct S*baseS(void){b++;return &s;}' +
    'static int idx(void){i++;return 0;}' +
    'int main(void){int*p=0;int*q=&*p;int *a=&(base()[idx()]);' +
    'if(q!=0||*a!=7||b!=1||i!=1)return 1;struct S*sp=baseS();sp->x+=2;' +
    'return sp->x==9&&b==2?0:2;}',
    { trapNullDereference: true });
  assert.strictEqual(semantics.value, 0, 'single evaluation/order or &*p exemption regressed');

  const lvalues = await run(
    'struct S{int x;unsigned b:3;};static int n;static struct S s={3,1};' +
    'static struct S*base(void){n++;return &s;}' +
    'int main(void){base()->x=4;if(n!=1)return 1;base()->x+=2;if(n!=2)return 2;' +
    'base()->x++;if(n!=3)return 3;base()->b+=2;if(n!=4)return 4;' +
    'struct S t=*base();if(n!=5)return 5;*base()=t;if(n!=6)return 6;' +
    'return s.x==7&&s.b==3?0:7;}', { trapNullDereference: true });
  assert.strictEqual(lvalues.value, 0, 'store/RMW/post-inc/bitfield/aggregate base evaluation was not exactly once');

  const nested = await run(
    'struct T{int x;};struct S{struct T*t;};static int n;static struct T t={8};static struct S s={&t};' +
    'static struct S*base(void){n++;return &s;}int main(void){return base()->t->x==8&&n==1?0:1;}',
    { trapNullDereference: true });
  assert.strictEqual(nested.value, 0, 'nested arrow re-evaluated its base');

  const subscriptOrder = await run(
    'static int seq;static int a[1]={9};static int*base(void){seq=seq*10+1;return a;}' +
    'static int idx(void){if(seq!=1)return 1;seq=seq*10+2;return 0;}' +
    'int main(void){int v=base()[idx()];return v==9&&seq==12?0:1;}',
    { trapNullDereference: true });
  assert.strictEqual(subscriptOrder.value, 0, 'subscript did not evaluate base before index');

  for (const variadic of [false, true]) {
    const dots = variadic ? ',...' : '';
    const order = await run(
      'static int seq;static int target(int x' + dots + '){return x;}' +
      'static int arg(void){seq=seq*10+1;return 7;}' +
      'static int(*callee(void))(int' + dots + '){if(seq!=1)seq=99;else seq=seq*10+2;return target;}' +
      'int main(void){int v=callee()(arg());return v==7&&seq==12?0:1;}',
      { trapNullDereference: true });
    assert.strictEqual(order.value, 0,
      (variadic ? 'variadic' : 'non-variadic') + ' indirect call did not evaluate arguments before callee');
  }

  const nonNull = await run('int main(void){int x=4;volatile int*p=&x;*p+=3;return *p==7?0:1;}',
    { trapNullDereference: true });
  assert.strictEqual(nonNull.value, 0, 'non-null volatile/RMW control failed');
  assert(CC.WAST.lastPassStats.inline.refused.noinline > 0,
    'generated trap thunk did not exercise the hard noinline refusal');

  // Final post-runPasses structure: tie the serialized sections and name
  // bytes to the exact remapped WCall target retained in the final module.
  let observed = null;
  const structural = compile(
    'struct S{int x;};\n' +
    '__attribute__((noinline)) static int dead(void){return 1;}\n' +
    '__attribute__((noinline)) static int f(struct S*p)\n' +
    '{\n' +
    '  return p->x; /* unique checked null-use line */\n' +
    '}\n' +
    'int main(void){return f(0);}\n',
    { trapNullDereference: true, emitNames: true }, x => { observed = x; });
  assert(Object.isFrozen(observed) && Object.isFrozen(observed.traps), 'post-pass observer result is not immutable');
  assert.strictEqual(observed.traps.length, 1, 'expected one observed generated thunk');
  assert.strictEqual(observed.traps[0].noinline, true, 'generated thunk lost noinline metadata');
  assert(observed.noinlineRefused >= 2, 'post-pass noinline refusal telemetry missing');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(CC.WAST, 'lastModule'), false,
    'ordinary compilation API retains the module IR');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(CC.WAST, 'lastPostPass'), false,
    'ordinary compilation API retains post-pass WAST');

  const dw = decodeWasm(structural), trapIdx = observed.traps[0].funcIdx;
  const trapName = dw.names.get(trapIdx);
  assert(trapName && trapName.includes('__cc_null_dereference[/null-trap.c:5:member]'),
    'serialized exact-index thunk name missing');
  const trapType = dw.types[dw.funcTypes[trapIdx - dw.funcImports]];
  assert(trapType && trapType.params.length === 0 && trapType.results.length === 0,
    'serialized thunk does not have the expected () -> () type');
  assert.deepStrictEqual([...dw.bodies.get(trapIdx).bytes], [0x00, 0x0b],
    'serialized thunk code body is not exactly unreachable; end');
  assert.strictEqual(dw.table.get(trapIdx + 1), trapIdx,
    'serialized element segment does not install the thunk at its table slot');
  const fIdx = [...dw.names].find(([, n]) => n === 'f')[0], fbody = dw.bodies.get(fIdx);
  const decoded = decodeInstructions(fbody);
  const calls = decoded.filter(ins => ins.opcode === 0x10 && ins.imm === trapIdx);
  assert.strictEqual(calls.length, 1, 'decoded checked caller does not directly call exact thunk index once');
  const call = calls[0];
  const fileIdx = dw.sourceMap.files.indexOf('/null-trap.c');
  assert(fileIdx >= 0, 'serialized source map lost fixture filename');
  // c.sourcemap entries mark the source location active from that byte until
  // the next entry. Resolve the call's exact absolute offset by predecessor,
  // rather than accepting any same-line entry somewhere in f.
  const active = dw.sourceMap.entries.filter(e => e.off <= call.off).at(-1);
  assert(active && active.file === fileIdx && active.line === 5 &&
         active.off >= fbody.start && active.off <= call.off,
    'source location active at the decoded call is not /null-trap.c:5');

  // RED control for the review finding: raw [call,target] bytes can straddle
  // an i32.const immediate and the following loop opcode. The old includes()
  // logic says "call 3"; boundary decoding correctly finds no call.
  const falsePositive = { start: 100, bytes: Buffer.from([0x41, 0x10, 0x03, 0x40, 0x0b]) };
  assert(falsePositive.bytes.includes(Buffer.from([0x10, 0x03])),
    'negative control no longer exercises the old raw-byte matcher');
  assert.strictEqual(decodeInstructions(falsePositive).filter(i => i.opcode === 0x10).length, 0,
    'boundary decoder falsely treated immediate/opcode bytes as a call');
  const ss = sectionSizes(structural);
  assert(ss.get(3) > 0 && ss.get(9) > 0 && ss.get(10) > 0 && ss.get('custom:name') > 0,
    'serialized function/element/code/name sections missing');
  assert(names(structural).includes(trapName), 'serialized name section lost the final thunk name');

  // Installing the observer is byte-inert, and ordinary compilation leaves
  // no callback/module/WAST singleton behind.
  const withoutObserver = compile(basic, { trapNullDereference: true, emitNames: true });
  let observerCalled = 0;
  const withObserver = compile(basic, { trapNullDereference: true, emitNames: true }, () => observerCalled++);
  assert(Buffer.from(withoutObserver).equals(Buffer.from(withObserver)), 'test observer changed emitted bytes');
  assert.strictEqual(observerCalled, 1, 'test observer did not run exactly once');

  // The real in-OS driver accepts only the custom spelling and keeps the
  // standard sanitizer spelling / misspellings on the loud refusal path.
  const store = new HOST.BLOCK_FS.MemoryByteStore(16 * 1024 * 1024);
  const kfs = HOST.BLOCK_FS.create(store);
  const enc = new TextEncoder();
  const fd = kfs.open('/x.c', 0x1 | 0x40 | 0x200, 0o644);
  const b = enc.encode('int main(void){return 0;}'); kfs.write(fd, b, b.length); kfs.close(fd);
  const driver = COMMON.createCcDriver(CC, kfs);
  assert.strictEqual(driver(['cc', '--trap-null-dereference', '/x.c'], '/').exitCode, 0);
  for (const flag of ['-fsanitize=null', '--trap-null-dereferenc']) {
    const r = driver(['cc', flag, '/x.c'], '/');
    assert.strictEqual(r.exitCode, 1); assert(r.stderr.includes(flag));
  }

  // Actual spawned host CLI, distinct from createCcDriver.
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'cc709-cli-'));
  try {
    const src = path.join(td, 'x.c'), out = path.join(td, 'x.wasm');
    fs.writeFileSync(src, 'int main(void){return 0;}');
    let r = cp.spawnSync(process.execPath, [path.join(ROOT, 'compiler.js'), '--trap-null-dereference', src, '-o', out], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr); assert(fs.existsSync(out), 'supported host CLI flag emitted no artifact');
    for (const flag of ['-fsanitize=null', '--trap-null-dereferenc']) {
      fs.rmSync(out, { force: true });
      r = cp.spawnSync(process.execPath, [path.join(ROOT, 'compiler.js'), flag, src, '-o', out], { encoding: 'utf8' });
      assert.notStrictEqual(r.status, 0, 'host CLI silently accepted ' + flag);
      assert((r.stderr || '').includes(flag), 'host CLI refusal did not name ' + flag + ': ' + r.stderr);
      assert(!fs.existsSync(out), 'host CLI refusal still emitted output for ' + flag);
    }
  } finally { fs.rmSync(td, { recursive: true, force: true }); }
  console.log('all null-trap checks passed');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
