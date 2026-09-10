// #781: source contracts shared by Node, Chromium, and the in-OS compiler.
(function(root) {
  const prelude = `#include <Foundation/Foundation.h>
#include <stdlib.h>
#include <unistd.h>
    static int deaths;
    @interface Fault : NSObject @end
    @interface ChildFault : Fault @end
    @implementation Fault - (void)dealloc { deaths++; [super dealloc]; } @end
    @implementation ChildFault @end
  `;
  const positive = [
    ['typed-ownership', `int main(void) {
      ChildFault *p=[ChildFault new]; int caught=0;
      @try { @throw p; }
      @catch(Fault *e) { caught=e==p; [p release]; if(deaths) return 2; }
      @catch(id e) { return 3; }
      return !caught || deaths!=1;
    }`],
    ['arbitrary-root', `@interface Root {@public unsigned count;} + (id)new; - (id)retain; - (void)release; @end
      @implementation Root + (id)new {Root *p=guc_objc_alloc(self);p->count=1;return p;}
        - (id)retain {count++;return self;} - (void)release {if(!--count){deaths++;guc_objc_dispose(self);}} @end
      int main(void) {Root *p=[Root new];int n=0;@try {@throw p;} @catch(Root *e) {[p release];n=e==p&&!deaths;}return !n||deaths!=1;}`],
    ['class-throw', `int main(void) {int caught=0;@try {@throw [Fault class];} @catch(id e) {caught=e==(id)[Fault class];}return !caught;}`],
    ['nil', `int main(void) { int n=0;
      @try { @throw nil; } @catch(Fault *e) {return 1;} @catch(id e) {n=e==nil;}
      return !n;
    }`],
    ['lexical-rethrow', `int main(void) { Fault *p=[Fault new]; int caught=0;
      @try { @try { @throw p; } @catch(id e) {
        [p release]; @try { @throw [Fault new]; } @catch(id q) { [q release]; }
        e=nil; @throw;
      }} @catch(Fault *e) {caught=e==p && deaths==1;}
      return !caught || deaths!=2;
    }`],
    // Named-local result uses the independent no-elide native comparison.
    ['finally-snapshot', `struct Pair { int a,b; };
      int final;
      struct Pair f(void) { struct Pair p={1,2}; @try {return p;} @finally {p.a=9;final++;} }
      int main(void) {struct Pair p=f(); return p.a!=1 || p.b!=2 || final!=1;}`],
    ['finally-return-forms', `struct Pair {int a,b;}; int calls,final; struct Pair global={1,2};
      struct Pair comma(void) {struct Pair p={1,2}; @try {return (calls++,p);} @finally {if(calls==1) final++;p.a=9;} }
      struct Pair fromGlobal(void) {@try {return global;} @finally {global.a=9;}}
      struct Pair literal(void) {@try {return (struct Pair){global.a,2};} @finally {global.a=8;}}
      int main(void) {struct Pair a=comma(),b=fromGlobal(),c=literal();return a.a!=1||a.b!=2||b.a!=1||c.a!=9||calls!=1||final!=1;}`],
    ['c-catch-consume', `int caught;
      int consume(Fault *p,int mode) { __try {@throw p;} __catch {
        [p release];if(deaths!=caught) return 4; caught++;if(mode) return 7;
      } return 9; }
      int main(void) {if(consume([Fault new],1)!=7||deaths!=1) return 1;
        int value=consume([Fault new],0);if(value!=9)return 20+value;if(deaths!=2)return 40+deaths;return caught!=2;}`],
    ['c-catch-replacement', `int main(void) {Fault *p=[Fault new],*q=[Fault new];
      @try { __try {@throw p;} __catch {[p release];@throw q;} }
      @catch(id e) {if(e!=q||deaths!=1)return 1;[q release];}return deaths!=2;}`],
    ['finally-override', `int f(void) { @try {return 1;} @finally {return 2;} }
      int main(void) {return f()!=2;}`],
    ['foreign-rethrow', `__exception Foreign(int);
      int main(void) {int n=0;
        __try { @try { __throw Foreign(7); } @catch(id x) {return 1;}
          @catch(...) {n=1; @throw;} @finally {n+=2;}
        } __catch Foreign(x) {n+=x;}
        return n!=10;
      }`],
    ['export-internal-propagates', `void exported(void) {@throw nil;} __export exported=exported;
      int main(void) {int n=0;@try {exported();} @catch(id e) {n=1;} return !n;}`],
    ['handler-address', `int main(void) {Fault *p=[Fault new];
      @try {@try {@throw p;} @catch(Fault *e) {Fault **address=&e; *address=nil; @throw;}}
      @catch(id e) {if(e!=p)return 1;[p release];} return deaths!=1;}`],
    ['throwing-release-replaces', `id replacement; int explode;
      @interface Explosive : Fault @end
      @implementation Explosive - (void)release {int fire=explode;explode=0;[super release];if(fire) @throw replacement;} @end
      int main(void) {Explosive *p=[Explosive new];Fault *q=[Fault new];replacement=[Fault new];int n=0;
        @try {@try {@throw p;} @catch(id e) {[p release];explode=1;
          @try {@throw q;} @finally {[q release];}
        }} @catch(id e) {n=e==replacement && deaths==2;[replacement release];}
        return !n||deaths!=3;
      }`],
    ['catch-drop-before-finally', `int n;int main(void) {Fault *p=[Fault new];
      @try {@throw p;} @catch(id e) {[p release];if(deaths)return 1;} @finally {n=deaths;}
      return n!=1;}`],
    ['lexical-finalizer-rethrow', `int main(void) {Fault *p=[Fault new],*q=[Fault new];int n=0;
      @try {@try {@throw p;} @catch(id e) {[p release];
        @try {@try {@throw q;} @catch(id e){[q release];e=nil;}}
        @finally {@throw;}
      }} @catch(id e){n=e==p&&deaths==1;} return !n||deaths!=2;}`],
    ['backward-catchall-goto', `__exception Foreign();int main(void) {int n=0;for(int i=0;i<2;i++){
      @try{if(i)__throw Foreign();else @throw nil;} @catch(...){again:if(++n<3)goto again;}
    }return n!=4;}`],
    ['backward-handler-goto', `int main(void) {int n=0;
      @try {@throw nil;} @catch(id e) {again: if(++n<3)goto again;}
      @finally {loop: if(++n<6)goto loop;} return n!=6;}`],
    ['pool-pop-cancelled', `int f(void) {@autoreleasepool {[[Fault new] autorelease];@try {return 3;} @finally {@throw nil;}}}
      int main(void) {NSAutoreleasePool *p=[NSAutoreleasePool new];int n=0;
        @try {f();} @catch(id e){n=deaths;} [p drain];return n||deaths!=1;}`],
    ['multi-payload-foreign', `__exception Foreign(int,double,long long);
      int main(void){int n=0;__try {@try{__throw Foreign(3,4.5,1234567890123LL);} @catch(...) {@throw;}}
      __catch Foreign(a,b,c){n=a==3&&b==4.5&&c==1234567890123LL;} return !n;}`],
    ['finally-exits', `int trace;
      int main(void) {
        for(int i=0;i<3;i++) { @try {
          if(i==0) continue; if(i==1) break;
        } @finally {trace=trace*10+i+1;} }
        @try {goto done;} @finally {trace=trace*10+3;}
        return 2;
        done: return trace!=123;
      }`],
    ['finally-replacement-ownership', `int main(void) {
      Fault *p=[Fault new],*q=[Fault new]; int caught=0;
      @try { @try { @throw p; } @finally { [p release]; @throw q; } }
      @catch(Fault *e) {caught=e==q && deaths==1; [q release];}
      return !caught || deaths!=2;
    }`],
    ['finally-cancel-ownership', `int f(void) {
      Fault *p=[Fault new];
      @try {@throw p;} @finally {[p release];return 7;}
      return 9;
    }
    int main(void) {return f()!=7 || deaths!=1;}`],
    ['finally-cannot-reenter', `int n;
      int main(void) {
        @try { @try {n=1;} @catch(id e) {return 2;} @finally {n++;@throw nil;} }
        @catch(id e) {n++;} return n!=3;
      }`],
    ['pool-finally-order', `int f(void) {
      @autoreleasepool { [[Fault new] autorelease];
        @try {return 1;} @finally {if(deaths) return 2;}
      }
    }
    int main(void) {int result=f(); return result!=1 ? 10+result : deaths!=1 ? 20+deaths : 0;}`],
    ['pool-exception-escape', `int main(void) {
      NSAutoreleasePool *outer=[NSAutoreleasePool new];
      @try { @autoreleasepool { [[Fault new] autorelease]; @throw nil; } }
      @catch(id e) {if(deaths) return 1;}
      [outer drain]; return deaths!=1;
    }`],
    ['c-catch-longjmp', `#include <setjmp.h>
      __exception Foreign();
      int main(void) {jmp_buf b;if(setjmp(b)==7)return 0;__try {__throw Foreign();} __catch {longjmp(b,7);}return 1;}`],
    ['setjmp-inside', `#include <setjmp.h>
      int main(void) {jmp_buf b; int n=0;
        @try {if(setjmp(b)==0) longjmp(b,3); else n=1;}
        @finally {n++;} return n!=2;
      }`],
  ].map(([name,source])=>[name,prelude+source]);
  const negative = [
    ['bare-outside', 'int main(void){ @throw; }', /rethrow|@throw/],
    ['scalar-throw', 'int main(void){ @throw 42; }', /object/],
    ['scalar-catch', 'int main(void){ @try {} @catch(int x) {} }', /object/],
    ['try-alone', 'int main(void){ @try {} }', /catch|finally/],
    ['static-catch', 'int main(void){ @try {} @catch(static id e) {} }', /storage class/],
    ['reserved-tag', '__exception __guc_objc_exception(unsigned int); int main(void){return 0;}', /reserved/],
    ['case-entry', 'int main(void){switch(1){@try{case 1:break;}@finally{}}}', /cannot enter/],
    ['catch-entry', 'int main(void){goto entry;@try{}@catch(id e){entry:;}}', /cannot enter/],
    ['finally-entry', 'int main(void){goto entry;@try{}@finally{entry:;}}', /cannot enter/],
    ['entry', 'int main(void){ goto x; @try {x:;} @finally {} }', /cannot enter/],
  ];
  const asyncSource = (action, frame) => prelude + `#include <emscripten.h>
    __import void ehHostError(void);
    void fail(void *p) {${action}}
    void bad(void *p) {write(2,"BAD",3);}
    ${frame ? '__import void __sdl_set_animation_frame_func(void(*)(void)); void frame(void) {}' :
      'void keep(void) {} __export __no_exit_runtime=keep;'}
    int main(void) {emscripten_async_call(fail,0,0);emscripten_async_call(bad,0,20);
      ${frame ? '__sdl_set_animation_frame_func(frame);' : ''} return 0;}`;
  const fatal = [
    ...[false,true].map(frame=>({name:'async-uncaught-'+(frame?'frame':'keep'),
      source:asyncSource('@throw nil;',frame),pattern:/uncaught Objective-C exception/,exit:134,asyncLifecycle:true})),
    {name:'async-trap',source:asyncSource('__builtin_trap();',false),trap:true,asyncLifecycle:true},
    {name:'async-host-error',source:asyncSource('ehHostError();',false),hostError:true,asyncLifecycle:true},
    {name:'retain-throws-no-record-leak',source:prelude+`@interface Reject : Fault @end
      @implementation Reject - (id)retain {@throw nil;} @end
      int main(void) {Reject *p=[Reject new];for(int i=0;i<20000;i++) {@try {@throw p;} @catch(id e) {if(e)return 1;}}[p release];return deaths!=1;}`,cap:true,exit:0},
    {name:'frame-uncaught',source:prelude+`__import void __sdl_set_animation_frame_func(void (*)(void));
      void frame(void) {@throw nil;} int main(void) {__sdl_set_animation_frame_func(frame);return 0;}`,pattern:/uncaught Objective-C exception/,exit:134},
    {name:'host-error-identity',source:prelude+`__import void ehHostError(void);
      int main(void) {@try {ehHostError();} @catch(id e) {write(2,"BAD",3);} @catch(...) {@throw;}return 0;}`,hostError:true},
    {name:'host-cancellation',source:prelude+`int main(void) {@try {while(1)getpid();} @catch(...) {write(2,"BAD",3);} @finally {write(2,"BAD",3);}return 0;}`,ceiling:true},
    {name:'uncaught',source:prelude+`int main(void) {@throw nil;}`,pattern:/uncaught Objective-C exception/,exit:134},
    {name:'exit-bypass',source:prelude+`int main(void) {__try {@try {exit(23);} @catch(...) {write(2,"BAD",3);return 2;} @finally {write(2,"BAD",3);}} __catch {write(2,"BAD",3);return 3;} return 1;}`,exit:23},
    {name:'longjmp-crossing',source:prelude+`#include <setjmp.h>
      int main(void) {jmp_buf b;if(setjmp(b)==0) {@try {longjmp(b,1);} @catch(...) {write(2,"BAD",3);} @finally {write(2,"BAD",3);}}return 1;}`,pattern:/longjmp crosses an Objective-C exception scope/,exit:134},
    {name:'trap-bypass',source:prelude+`int main(void) {@try {__builtin_trap();} @catch(...) {write(2,"BAD",3);} @finally {write(2,"BAD",3);}return 0;}`,trap:true},
    {name:'record-oom',source:prelude+`int main(void) {while(malloc(1)){} @try {@throw nil;} @catch(...) {write(2,"BAD",3);}return 1;}`,cap:true,pattern:/Objective-C exception record allocation failed/,exit:134},
    {name:'load-uncaught',source:prelude+`@interface Loader : NSObject @end
      @implementation Loader + (void)load {@throw nil;} @end
      int main(void) {write(2,"BAD",3);return 0;}`,pattern:/uncaught Objective-C exception/,exit:134},
  ];
  const crossFiles={
    '/tests/shared.h':`#include <Foundation/Foundation.h>
      extern int deaths; @interface CrossFault : NSObject @end
      @interface CrossChild : CrossFault @end
      void toss(void *); int consume(void *);`,
    '/tests/thrower.m':`#include "shared.h"
      int deaths;
      @implementation CrossFault - (void)dealloc {deaths++;[super dealloc];} @end
      @implementation CrossChild @end
      void toss(void *object) {@throw (id)object;}`,
    '/tests/consumer.c':`void toss(void*);void releaseObject(void*);int deathCount(void);
      int consume(void *p) {__try {toss(p);} __catch {releaseObject(p);if(deathCount())return 2;return 7;}return 1;}`,
    '/tests/cross-main.m':`#include "shared.h"
      void releaseObject(void *p) {[(id)p release];} int deathCount(void){return deaths;}
      int main(void) {if(consume([CrossChild new])!=7||deaths!=1)return 1;
        CrossFault *p=[CrossChild new];int n=0;@try {toss(p);} @catch(CrossFault *e) {n=e==p;[p release];}
        return !n||deaths!=2;}`,
  };
  const cross=[['cross-forward',['cross-main.m','thrower.m','consumer.c']],['cross-reverse',['consumer.c','thrower.m','cross-main.m']]];
  const options=[{noInline:false,gcSections:false},{noInline:false,gcSections:true},{noInline:true,gcSections:false},{noInline:true,gcSections:true},{forceIrreducibleLowering:true}];
  async function run(C,host,foundation,files,environment,onRecord=()=>{},onBytes=()=>{}) {
    const records=[];
    const text=s=>typeof s==='string'?s:new TextDecoder().decode(s);
    const programs=[...positive.map(([name,source])=>({name,source})),...fatal,
      ...cross.map(([name,inputs])=>({name,inputs}))];
    for(const opts of options) for(const test of programs) {
      const record={name:test.name,options:opts,status:'running'};
      records.push(record);await onRecord(record);
      try {
        let {bytes}=foundation.compile(C,{...files,...crossFiles,'/tests/exception.m':test.source},test.inputs||['exception.m'],opts);
        if(test.cap) bytes=foundation.capMemory(bytes);
        await onBytes(record,bytes);
        let stdout='',stderr='';
        const sentinel=new Error('foreign host identity'),env=environment();
        if(test.hostError) {
          env.sdl=(host.createNullSDL||root.createNullSDL)();
          env.sdl.c.ehHostError=()=>{throw sentinel;};
        }
        if(test.ceiling) env.maxWallMs=1;
        try {record.exit=await host({bytes,args:[test.name],...env,writeOut:s=>{stdout+=text(s);},writeErr:s=>{stderr+=text(s);}});}
        catch(error) {
          if(test.hostError && error===sentinel) record.hostIdentity=true;
          else if(test.ceiling && error.wallClockExceeded) record.cancelled=true;
          else if(test.trap && error instanceof WebAssembly.RuntimeError) record.trap=String(error);
          else throw error;
        }
        if(test.asyncLifecycle) await new Promise(resolve=>setTimeout(resolve,40));
        Object.assign(record,{stdout,stderr});
        if(/BAD/.test(stdout+stderr) || (test.hostError ? !record.hostIdentity : test.ceiling ? !record.cancelled : test.trap ? !record.trap : record.exit!==(test.exit||0)) || (test.pattern&&!test.pattern.test(stderr)))
          throw Error('unexpected outcome '+JSON.stringify(record));
        record.status='pass';
      } catch(error) {record.status='fail';record.error=error.stack||String(error);await onRecord(record);throw error;}
      await onRecord(record);
    }
    for(const [name,source,expected] of negative) {
      const record={name,status:'running'};records.push(record);await onRecord(record);
      let error='';try{foundation.compile(C,{...files,'/tests/exception.m':source},['exception.m']);}catch(e){error=e.message;}
      record.error=error;record.status=expected.test(error)?'pass':'fail';await onRecord(record);
      if(record.status!=='pass') throw Error(name+': '+error);
    }
    return records;
  }
  const api={positive,negative,fatal,crossFiles,cross,options,run};
  if(typeof module!=='undefined') module.exports=api; else root.ObjCExceptions=api;
})(typeof globalThis!=='undefined'?globalThis:this);
