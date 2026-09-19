'use strict';
// #796: retired inputs fail on both compiler entry paths; C remains runnable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../../compiler.js');
const common = require('../../os/os-common.js');
const {compile} = require('../lib/compile-c.js');
(async () => {
  const source = '#ifdef __OBJC__\n#error leaked language mode\n#endif\nint main(void){return 0;}';
  const rejected = C.tokenize('retired.m', source, C.createDefaultPPRegistry());
  assert.match(rejected.errors[0].message, /Objective-C support has been retired/);
  assert.throws(() => compile(C, {'/tests/retired.m':source}, ['retired.m']), /support has been retired/);
  const {bytes} = compile(C, {'/tests/main.c':source}, ['main.c']);
  assert.equal(await require('../../host.js')({bytes,fs,args:['main']}),0);
  for (const text of ['@interface A @end', 'int main(void){id x=nil;return 0;}'])
    assert.throws(() => compile(C, {'/tests/main.c':text}, ['main.c']));
  assert.equal(common.srclibDriftPackages().foundation, undefined);
  const root=path.resolve(__dirname,'../..'), archive=path.join(root,'old/objc');
  const manifest=JSON.parse(fs.readFileSync(path.join(archive,'manifest.json'),'utf8'));
  for(const entry of manifest.files) {
    const data=fs.readFileSync(path.join(archive,entry.path));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),entry.sha256,entry.path);
  }
  console.log('PASS language retirement, C execution, package retirement and archive integrity');
})().catch(error=>{console.error(error);process.exitCode=1;});
