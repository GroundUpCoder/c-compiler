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

function compile(src, compilerOptions) {
  const name = '/null-trap.c';
  const files = new Map([[name, src]]);
  const fsShim = { readFileSync(p) { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); } };
  const pp = CC.createDefaultPPRegistry();
  pp.fileReader = p => files.has(p) ? files.get(p) : null;
  const opts = { compilerOptions: compilerOptions || {}, warningFlags: {}, writeErr: s => { throw new Error(s); } };
  const units = CC.parseAllUnits(fsShim, pp, [name], opts);
  const linked = CC.linkTranslationUnits(units, opts.compilerOptions);
  assert.deepStrictEqual(linked.errors, []);
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

  const nonNull = await run('int main(void){int x=4;volatile int*p=&x;*p+=3;return *p==7?0:1;}',
    { trapNullDereference: true });
  assert.strictEqual(nonNull.value, 0, 'non-null volatile/RMW control failed');
  assert(CC.WAST.lastPassStats.inline.refused.noinline > 0,
    'generated trap thunk did not exercise the hard noinline refusal');

  // Final post-runPasses structure: tie the serialized sections and name
  // bytes to the exact remapped WCall target retained in the final module.
  const structural = compile(
    'struct S{int x;};__attribute__((noinline)) static int dead(void){return 1;}' +
    '__attribute__((noinline)) static int f(struct S*p){return p->x;}int main(void){return f(0);}',
    { trapNullDereference: true, emitNames: true });
  const wm = CC.WAST.lastPostPass;
  const traps = wm.funcDefs.map((d, i) => ({ d, idx: i + wm.funcImports.length }))
    .filter(x => x.d.fnMeta && x.d.fnMeta.generatedNullTrap);
  assert.strictEqual(traps.length, 1, 'expected one final generated thunk');
  assert.strictEqual(traps[0].d.fnMeta.noinline, true, 'generated thunk lost noinline metadata');
  assert(traps[0].d.wast.length === 1 && traps[0].d.wast[0] instanceof CC.WAST.WUnreachable,
    'final thunk body is not exactly unreachable');
  const trapName = wm.funcNames.find(n => n.idx === traps[0].idx);
  assert(trapName && trapName.name.includes('__cc_null_dereference[/null-trap.c:1:member]'),
    'final remapped thunk name missing');
  const callers = wm.funcDefs.filter(d => d.wast && d.wast.some(n => n instanceof CC.WAST.WCall && n.funcIdx === traps[0].idx));
  assert.strictEqual(callers.length, 1, 'final caller does not directly target remapped thunk exactly once');
  assert(wm.passStats.inline.refused.noinline >= 2, 'post-pass noinline refusal telemetry missing');
  const tableMin = wm.tableLayout ? wm.tableLayout.size : 1 + wm.funcImports.length + wm.funcDefs.length;
  assert(tableMin > traps[0].idx, 'final table layout does not retain the thunk slot');
  const ss = sectionSizes(structural);
  assert(ss.get(3) > 0 && ss.get(9) > 0 && ss.get(10) > 0 && ss.get('custom:name') > 0,
    'serialized function/element/code/name sections missing');
  assert(names(structural).includes(trapName.name), 'serialized name section lost the final thunk name');
  assert(CC.WAST.lastModule.sourceMapEntries.some(e => e.entries && e.entries.length),
    'enabled -g build lost call-site source-map entries');

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
