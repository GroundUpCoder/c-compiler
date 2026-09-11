const path = require('path');
const root = '/Users/jku/git/c-compiler-small-callbacks';
const C = require(path.join(root,'compiler.js'));
const {compile} = require(path.join(root,'tests/foundation/corpus.js'));
const source = '#include <sys/stat.h>\n#include <stdio.h>\n__import void observe(unsigned,unsigned,unsigned,unsigned);\nint main(void){struct stat a,b;if(stat("/a",&a)||stat("/usr/b",&b)) return 2;observe(a.st_dev,a.st_ino,b.st_dev,b.st_ino);return a.st_dev==b.st_dev && a.st_ino==b.st_ino ? 42:0;}';
const {bytes}=compile(C,{'/tests/stat.c':source},['stat.c']);
(async()=>{for(const name of ['/tmp/784-before-host.js',path.join(root,'host.js')]) {
 const H=require(name), B=H.BLOCK_FS;
 const a=B.createV4(new B.MemoryByteStore(1<<20)),b=B.createV4(new B.MemoryByteStore(1<<20));
 a.close(a.open('/a',577,0o755)); b.close(b.open('/b',577,0o755));
 const mount=new B.MountFS({'/':a,'/usr':b});let output='';
 const code=await H({bytes,args:['stat'],blockFsFactory:ctx=>({c:{...B.BlockFS.prototype.toWasmEnv.call(mount,ctx),observe:(...values)=>{output=JSON.stringify(values);}}}),writeOut:bytes=>{output+=new TextDecoder().decode(bytes);},writeErr:()=>{}});
 console.log(JSON.stringify({host:name,code,output}));
 if(code!==42) throw Error('collision did not reproduce');
}})().catch(e=>{console.error(e);process.exitCode=1;});
