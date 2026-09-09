#!/usr/bin/env node
'use strict';
// #780: real C, with signals delivered only after observing a registered
// kernel waiter. The C handler makes the operation ready through real syscalls.
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process');
const ROOT=path.resolve(__dirname,'../..');
const K=require('../../kernel.js'),{BLOCK_FS}=require('../../host.js');
fs.mkdirSync(path.join(ROOT,'build'),{recursive:true});
const dir=fs.mkdtempSync(path.join(ROOT,'build/restart-c-'));
const source=String.raw`
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <poll.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/un.h>
static int p[2],mode,client;
static struct sockaddr_un addr;
static volatile sig_atomic_t handled,handler_ok;
static void handler(int sig) {
 char buf[512]; (void)sig; handled++;
 if(mode==1) handler_ok=write(p[1],"R",1)==1;
 else if(mode==2) handler_ok=read(p[0],buf,sizeof buf)==sizeof buf;
 else if(mode==3) handler_ok=connect(client,(struct sockaddr*)&addr,sizeof addr)==0;
 else handler_ok=1;
}
#define REQUIRE(x) do { if(!(x)) { printf("FAIL line=%d errno=%d\n",__LINE__,errno); return 1; } } while(0)
static void arm(const char *name,int restart) {
 struct sigaction sa; memset(&sa,0,sizeof sa);sa.sa_handler=handler;sa.sa_flags=restart?SA_RESTART:0;
 sigaction(SIGUSR1,&sa,0);handled=handler_ok=0;
 printf("ARM %s %d\n",name,restart);fflush(stdout);
}
int main(void) {
 for(int restart=0;restart<=1;restart++) {
  char c=0; REQUIRE(pipe(p)==0); mode=1;
  REQUIRE(read(p[0],&c,0)==0);
  arm("read",restart);errno=0;int n=read(p[0],&c,1),e=errno;
  REQUIRE(handled==1 && handler_ok);
  if(restart) REQUIRE(n==1); else {REQUIRE(n==-1 && e==EINTR); REQUIRE(read(p[0],&c,1)==1);}
  REQUIRE(c=='R');close(p[1]);REQUIRE(read(p[0],&c,1)==0);close(p[0]);
  REQUIRE(pipe(p)==0);mode=2;char data[512];memset(data,'a',sizeof data);int filled=0;
  struct pollfd f={p[1],POLLOUT,0};
  while(poll(&f,1,0)==1 && (f.revents&POLLOUT)) {REQUIRE(write(p[1],data,sizeof data)==sizeof data);filled+=sizeof data;}
  REQUIRE(filled>=512);arm("write",restart);errno=0;n=write(p[1],"X",1);e=errno;
  REQUIRE(handled==1 && handler_ok);
  if(restart) REQUIRE(n==1);else {REQUIRE(n==-1 && e==EINTR);REQUIRE(write(p[1],"X",1)==1);}
  close(p[1]);int total=0,xs=0;
  while((n=read(p[0],data,sizeof data))>0){total+=n;for(int i=0;i<n;i++){if(data[i]=='X')xs++;else REQUIRE(data[i]=='a');}}
  REQUIRE(n==0 && total==filled-512+1 && xs==1);close(p[0]);
  mode=3;int listener=socket(AF_UNIX,SOCK_STREAM,0);client=socket(AF_UNIX,SOCK_STREAM,0);
  REQUIRE(listener>=0 && client>=0);memset(&addr,0,sizeof addr);addr.sun_family=AF_UNIX;
  snprintf(addr.sun_path,sizeof addr.sun_path,"/tmp/restart%d.sock",restart);
  REQUIRE(bind(listener,(struct sockaddr*)&addr,sizeof addr)==0);REQUIRE(listen(listener,2)==0);
  arm("accept",restart);errno=0;n=accept(listener,0,0);e=errno;
  REQUIRE(handled==1 && handler_ok);
  if(restart) REQUIRE(n>=0);else {REQUIRE(n==-1 && e==EINTR);n=accept(listener,0,0);REQUIRE(n>=0);}
  REQUIRE(write(client,"S",1)==1);REQUIRE(read(n,&c,1)==1 && c=='S');
  close(n);close(client);close(listener);unlink(addr.sun_path);
 }
 mode=4;arm("select",1);struct timeval tv={30,0};errno=0;
 int n=select(0,0,0,0,&tv),e=errno;REQUIRE(n==-1 && e==EINTR && handled==1 && handler_ok);
 puts("RESTART-C-PASS");return 0;
}
`;
fs.writeFileSync(path.join(dir,'test.c'),source);
cp.execFileSync(process.execPath,[path.join(ROOT,'compiler.js'),path.join(dir,'test.c'),'-o',path.join(dir,'test.wasm')]);
const wasm=fs.readFileSync(path.join(dir,'test.wasm'));
const kfs=BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(4<<20));kfs.mkdir('/tmp',0o777);
let output='',signaled=0,halt;
const done=new Promise(resolve=>{halt=resolve;});
const observed=[];
const kernel=new K.Kernel({fs:kfs,createWorker:K.nodeCreateWorker({hostPath:path.join(ROOT,'host.js'),kernelPath:path.join(ROOT,'kernel.js')}),
 loadImage:p=>p==='/bin/init'?wasm:null,
 onOutput:(pid,fd,bytes)=>{output+=Buffer.from(bytes).toString();},
 onHalt:status=>halt(status)});
// Examine complete output once per tick; one signal per ordered ARM marker.
let parsed=0;
const poll=setInterval(()=>{
 const arms=output.split('\n').filter(l=>l.startsWith('ARM '));
 if(arms.length<=parsed)return;
 const pcb=[...kernel._procs.values()].find(p=>p.pid===1);
 if(!pcb || !pcb.waiter)return;
 const name=arms[parsed].split(' ')[1],op=pcb.waiter.op;
 const eligible=name==='accept'?op==='accept':name==='select'?op==='select':name==='read'?(op==='piperead'||op==='select'):(op==='pipewrite'||op==='select');
 if(!eligible)return;
 observed.push({phase:arms[parsed],waiter:op});parsed++;signaled++;
 kernel.kill(1,10);
},1);
const watchdog=setTimeout(()=>{fs.writeFileSync(path.join(dir,'output.log'),output);console.error('restart timeout',observed,output);process.exit(1);},30000);
(async()=>{
 await kernel.boot({path:'/bin/init',argv:['init'],envp:[],cwd:'/'});
 const status=await done;clearInterval(poll);clearTimeout(watchdog);
 fs.writeFileSync(path.join(dir,'output.log'),output);fs.writeFileSync(path.join(dir,'waiters.json'),JSON.stringify(observed,null,2));
 console.log(output);assert.equal(status,0);assert.equal(signaled,7);assert(output.includes('RESTART-C-PASS'));
 assert.equal(kernel.processCount(),0);console.log('restart C: seven observed blocked intervals; artifacts '+dir);
})().catch(e=>{console.error(e);process.exit(1);});
