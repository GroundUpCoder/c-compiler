#!/usr/bin/env node
'use strict';
// #709: the custom null-use trap is opt-in, source-attributed, and preserves
// C evaluation/exemption semantics. This is intentionally an exported API
// test as well as a real V8 execution test.
const assert = require('assert');
const path = require('path');
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
  ]) {
    const r = await run(src, { trapNullDereference: true });
    assert(r.error instanceof WebAssembly.RuntimeError, kind + ' did not trap');
    assert(String(r.error.stack).split('\n')[1].includes('__cc_null_dereference[/null-trap.c:1:' + kind + ']'),
      kind + ' top frame is not the generated source marker: ' + r.error.stack);
  }

  for (const debug of [false, true]) {
    const r = await run(basic, { trapNullDereference: true, emitNames: debug });
    assert(r.error && String(r.error.stack).split('\n')[1].includes('__cc_null_dereference'),
      'generated top frame missing with emitNames=' + debug);
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

  const nonNull = await run('int main(void){int x=4;volatile int*p=&x;*p+=3;return *p==7?0:1;}',
    { trapNullDereference: true });
  assert.strictEqual(nonNull.value, 0, 'non-null volatile/RMW control failed');
  assert(CC.WAST.lastPassStats.inline.refused.noinline > 0,
    'generated trap thunk did not exercise the hard noinline refusal');

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
  console.log('all null-trap checks passed');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
