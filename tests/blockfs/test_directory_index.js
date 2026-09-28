'use strict';
// IBFS coherence and complexity regressions, ported from wasm-posix d81420bc.
const assert = require('node:assert/strict');
const fsNative = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const B = require('../../host.js').BLOCK_FS;
const { NodeFileStore } = require('../../os/os-common.js');
const enc = new TextEncoder();
function file(fs,path){const fd=fs.open(path,0x42,0o600);assert.notEqual(fd,null,`${path}: ${fs._lastError}`);fs.close(fd);}
function names(fs,path){const h=fs.opendir(path),out=[];let e;while((e=fs.readdir(h)))if(e.name!=='.'&&e.name!=='..')out.push(e.name);fs.closedir(h);return out;}
class Disk {
  constructor(){this.bytes=new Uint8Array(1<<20);}
  getSize(){return this.bytes.length;}
  read(out,{at}){out.set(this.bytes.subarray(at,at+out.length));return out.length;}
  write(bytes,{at}){this.bytes.set(bytes,at);return bytes.length;}
  truncate(n){const next=new Uint8Array(n);next.set(this.bytes.subarray(0,n));this.bytes=next;}
  flush(){}
}
for(const [label,stores] of [
  ['memory',()=>{const s=new B.MemoryByteStore(1<<20);return [s,s];}],
  ['sync aliases',()=>{const d=new Disk();return [new B.SyncAccessHandleStore(d),new B.SyncAccessHandleStore(d)];}],
]) for(const create of [B.create,B.createV4]){
  const [store,alias]=stores(),a=create(store),b=create(alias);
  assert.equal(a.mkdir('/d',0o755),0);assert.equal(a.mkdir('/other',0o755),0);
  // Extent growth, names that differ in UTF-8 length, and writes through both mounts.
  for(let i=0;i<300;i++)file(i%2?a:b,`/d/f${String(i).padStart(4,'0')}`);
  for(const n of ['α','日本語','😀','a'])file(a,'/d/'+n);
  assert.equal(names(b,'/d').length,304);
  assert.ok(b.stat('/d/日本語'));
  const before=B.directoryIndexStats(store).builds;
  for(let i=0;i<100;i++){assert.ok(b.stat('/d/f0299'));assert.equal(a.stat('/d/missing'),null);}
  assert.equal(B.directoryIndexStats(store).builds,before,'warm lookup must not reparse directories');
  assert.equal(a.rename('/d/f0001','/d/z0001'),0);
  assert.equal(b.stat('/d/f0001'),null);assert.ok(b.stat('/d/z0001'));
  assert.equal(b.rename('/d/z0001','/other/moved'),0);assert.equal(a.stat('/d/z0001'),null);
  assert.equal(a.link('/other/moved','/d/hard'),0);assert.equal(b.unlink('/other/moved'),0);assert.ok(a.stat('/d/hard'));
  assert.equal(a.symlink('/d/hard','/other/sym'),0);assert.ok(b.stat('/other/sym'));
  assert.equal(b.rename('/d/f0002','/d/f0003'),0);assert.equal(a.stat('/d/f0002'),null);
  // A listing already in progress must own its snapshot.
  const h=a.opendir('/d');a.readdir(h);a.readdir(h);const first=a.readdir(h).name;
  const snapshot=[first,...names(a,'/d').filter(n=>n!==first)];
  file(b,'/d/new-after-snapshot');assert.equal(b.unlink('/d/α'),0);
  const actual=[first];let e;while((e=a.readdir(h)))actual.push(e.name);a.closedir(h);
  assert.deepEqual(actual,snapshot);
  // Same-length raw name replacement: inode size and timestamps do not change.
  const ino=a._walkPath('/d').ino,bytes=store.getBytes(ino.extentOffset,ino.dataSize);
  const offset=Buffer.from(bytes).indexOf(Buffer.from('f0299'));
  assert.ok(offset>=0);alias.setBytes(ino.extentOffset+offset,enc.encode('g0299'));
  assert.equal(a.stat('/d/f0299'),null);assert.ok(b.stat('/d/g0299'));
  // Raw inode-id change within a cached entry exercises setUint32 notifications.
  const target=a._walkPath('/d/f0000').inoId;
  alias.setUint32(ino.extentOffset+offset-6,target);
  assert.equal(a._walkPath('/d/g0299').inoId,target);
  if(create===B.createV4){const ro=B.createV4(new B.ReadOnlyStore(alias),{readonly:true});assert.ok(ro.stat('/d/hard'));assert.equal(a.unlink('/d/hard'),0);assert.equal(ro.stat('/d/hard'),null);}
  console.log(`PASS index coherence: ${label}, ${create===B.create?'v3':'v4'}`);
}
// Custom stores without write notifications must remain read-through.
{
 const backing=new B.MemoryByteStore(1<<20),s={};
 for(const k of ['getUint32','setUint32','getBytes','setBytes','size','resize','flush'])s[k]=backing[k].bind(backing);
 const a=B.create(s),b=B.create(s);file(a,'/old');assert.ok(b.stat('/old'));a.rename('/old','/new');assert.equal(b.stat('/old'),null);assert.ok(b.stat('/new'));
 assert.equal(B.directoryIndexStats(s).enabled,false);
 console.log('PASS untracked custom stores stay uncached');
}
{
 const s=new B.MemoryByteStore(4<<20),fs=B.create(s);
 for(let i=0;i<160;i++){fs.mkdir('/d'+i,0o755);file(fs,`/d${i}/file`);}
 for(let i=0;i<160;i++)assert.ok(fs.stat(`/d${i}/file`));
 const stats=B.directoryIndexStats(s);assert.ok(stats.directories<=stats.maxDirectories);assert.ok(stats.entries<=stats.maxEntries);assert.ok(stats.bytes<=stats.maxBytes);
 console.log('PASS bounded retention and reads after eviction');
}
// Partial backing-store writes must invalidate before an exception escapes.
{
 const disk=new Disk(),s=new B.SyncAccessHandleStore(disk),fs=B.create(s);
 fs.mkdir('/d',0o755);file(fs,'/d/old');file(fs,'/d/new');assert.ok(fs.stat('/d/old'));
 const ino=fs._walkPath('/d').ino,bytes=s.getBytes(ino.extentOffset,ino.dataSize);
 const offset=Buffer.from(bytes).indexOf(Buffer.from('old'));
 const replacement=fs._walkPath('/d/new').inoId,write=disk.write.bind(disk);
 disk.write=(bytes,opts)=>{write(bytes,opts);throw Error('injected write failure');};
 assert.throws(()=>s.setUint32(ino.extentOffset+offset-6,replacement),/injected write failure/);
 disk.write=write;
 assert.equal(fs._walkPath('/d/old').inoId,replacement);
 console.log('PASS partial writes cannot leave a stale index');
}
// Separate native descriptors and hard-link aliases share invalidation, while
// a replaced pathname opens a different inode with its own independent domain.
{
 const dir=fsNative.mkdtempSync(path.join(os.tmpdir(),'ibfs-native-'));
 const image=path.join(dir,'image'),alias=path.join(dir,'alias');
 const s=new NodeFileStore(fsNative,image,true);s.resize(1<<20);
 fsNative.linkSync(image,alias);
 const other=new NodeFileStore(fsNative,alias,false);
 try {
  const a=B.createV4(s),b=B.createV4(other);
  file(a,'/old');assert.ok(b.stat('/old'));
  a.rename('/old','/new');assert.equal(b.stat('/old'),null);assert.ok(b.stat('/new'));
  const before=B.directoryIndexStats(other).builds;
  for(let i=0;i<100;i++)assert.ok(b.stat('/new'));
  assert.equal(B.directoryIndexStats(other).builds,before);
  const fresh=new NodeFileStore(fsNative,image,true);fresh.resize(1<<20);
  try {const c=B.createV4(fresh);file(c,'/separate');assert.equal(c.stat('/new'),null);assert.ok(a.stat('/new'));assert.equal(a.stat('/separate'),null);}finally{fresh.close();}
  console.log('PASS native file aliases, warm retention, and pathname replacement');
 } finally {other.close();s.close();fsNative.rmSync(dir,{recursive:true,force:true});}
}
