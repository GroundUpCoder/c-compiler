// #775 acceptance for the agreed static-type and aggregate contracts.
(function(root) {
  const positive = [
    ['static-receiver-signatures', `
      @interface IntegerBox - (int)value; @end
      @interface DoubleBox - (double)value; @end
      @implementation IntegerBox - (int)value { return 17; } @end
      @implementation DoubleBox - (double)value { return 2.5; } @end
      int main(void) {
        IntegerBox *a=guc_objc_alloc(IntegerBox);
        DoubleBox *b=guc_objc_alloc(DoubleBox);
        int ok=[a value]==17 && [b value]==2.5;
        guc_objc_dispose(a); guc_objc_dispose(b); return !ok;
      }`],
    ['aggregate-nested-sibling-override-and-nil', `
      struct Pair { int x; double y; };
      @interface Base
      - (struct Pair)make:(int)x;
      - (struct Pair)add:(struct Pair)a to:(struct Pair)b;
      @end
      @interface Sub : Base - (struct Pair)make:(int)x; @end
      @implementation Base
      - (struct Pair)make:(int)x { struct Pair p={x,x+0.5}; return p; }
      - (struct Pair)add:(struct Pair)a to:(struct Pair)b {
        struct Pair p={a.x+b.x,a.y+b.y}; a.x=999; b.y=999; return p;
      }
      @end
      @implementation Sub
      - (struct Pair)make:(int)x { struct Pair p=[super make:x]; p.x+=10; return p; }
      @end
      int combine(struct Pair a, struct Pair b) { return a.x+b.x; }
      int main(void) {
        Sub *s=guc_objc_alloc(Sub); Base *b=s;
        struct Pair a=[b make:2], c=[b make:3];
        struct Pair sum=[b add:[b make:4] to:[b make:5]];
        if(a.x!=12 || a.y!=2.5 || c.x!=13 || c.y!=3.5 || sum.x!=29 || sum.y!=10) return 1;
        if(combine([b make:6],[b make:7])!=33) return 2;
        sum=[b add:a to:c];
        if(a.x!=12 || c.y!=3.5 || sum.x!=25) return 3;
        int effects=0; Base *n=nil;
        struct Pair zero=[n make:++effects];
        unsigned char *bytes=(unsigned char *)&zero;
        for(unsigned int i=0;i<sizeof zero;i++) if(bytes[i]) return 4;
        if(effects!=1) return 5;
        guc_objc_dispose(s); return 0;
      }`],
  ];
  positive.push(['variadic-promotions-aggregate-and-nil', `
    #include <stdarg.h>
    struct Pair { int x; double y; };
    @interface V
    - (struct Pair)sum:(int)n, ...;
    - (double)float:(float)x count:(int)n, ...;
    @end
    @implementation V
    - (double)float:(float)x count:(int)n, ... {
      va_list ap; va_start(ap,n); double y=va_arg(ap,double); va_end(ap); return x+y;
    }
    - (struct Pair)sum:(int)n, ... {
      va_list ap; va_start(ap,n);
      struct Pair p=va_arg(ap,struct Pair);
      for(int i=0;i<n;i++) { p.x+=va_arg(ap,int); p.y+=va_arg(ap,double); }
      va_end(ap); return p;
    }
    @end
    int main(void) {
      V *v=guc_objc_alloc(V); struct Pair a={7,1.5};
      struct Pair b=[v sum:2,a,(char)3,2.5f,(short)4,4.0];
      if(b.x!=14 || b.y!=8 || a.x!=7) return 1;
      if([v float:1.25f count:1,2.5f]!=3.75) return 3;
      int effect=0; V *n=nil;
      struct Pair z=[n sum:1,a,++effect,3.0];
      unsigned char *bytes=(unsigned char *)&z;
      for(unsigned i=0;i<sizeof z;i++) if(bytes[i]) return 2;
      guc_objc_dispose(v); return effect!=1;
    }`]);
  positive.push(['object-pointer-storage', `
    @interface Object @end @implementation Object @end
    typedef const id ReadonlyObject;
    struct Stored { id object; Object *typed; };
    id identity(id x) {return x;}
    int main(void) {
      Object *x=guc_objc_alloc(Object); ReadonlyObject y=x;
      struct Stored s={identity(y),x};
      int ok=sizeof(id)==4 && sizeof(Object*)==4 && sizeof s==8 && s.object==s.typed;
      guc_objc_dispose(x); return !ok;
    }`]);
  positive.push(['load-and-initialize', `
    int sequence, loads, initialized, childSeen;
    @interface Parent + (void)load; + (void)initialize; + (int)value; @end
    @interface Child:Parent @end
    @interface Unused:Parent + (void)load; @end
    @implementation Parent
    + (void)load {loads++; sequence=1;}
    + (void)initialize {
      if(self==Parent) { initialized++; if([Child value]!=7) childSeen=-10; }
      else if(self==Child) {initialized+=10; childSeen++;}
    }
    + (int)value {return 7;}
    @end
    @implementation Child @end
    @implementation Unused
    + (void)load {loads++; if(sequence!=1) sequence=-10;}
    @end
    int main(void) {
      if(loads!=2 || initialized || sequence!=1) return 1;
      Class c=Parent; if([c value]!=7 || initialized!=11 || childSeen!=1) return 2;
      if([Child value]!=7 || initialized!=11) return 3;
      return 0;
    }`]);
  positive.push(['protocol-qualified-object-types', `
    @protocol P;
    @class A;
    @protocol P - (int)value; @end
    @protocol Q<P> @end
    @interface A <Q> - (int)value; @end
    @interface Other - (double)value; @end
    @implementation A - (int)value {return 9;} @end
    @implementation Other - (double)value {return 1.5;} @end
    typedef const __unsafe_unretained id<Q> Qualified;
    struct Holder { Qualified object; A<P> *typed; };
    id<P> identity(id<P> x) {return x;}
    int main(void) {
      A *a=guc_objc_alloc(A); struct Holder h={a,a};
      id<P> p=identity(h.object); id<P> q=p ? p : p;
      int ok=[p value]==9 && [q value]==9 && [h.typed value]==9;
      guc_objc_dispose(a); return !ok;
    }`]);
  const negative = [
    ['owning-qualifier', 'int main(void) { __weak id object; return 0; }', /owning qualifiers/],
    ['void-pointer-receiver', 'int main(void){ void *p=0; return [p x]; }', /object pointer/],
    ['late-ambiguous-id', `
      @interface A - (int)value; @end
      int use(id x) { return [x value]; }
      @interface B - (double)value; @end
      @implementation A - (int)value {return 1;} @end
      @implementation B - (double)value {return 2;} @end
      int main(void) {return 0;}
    `, /ambiguous signature/],
    ['ambiguous-instance-id-site', `
      @interface A - (int)value; @end
      @interface B - (double)value; @end
      @implementation A - (int)value {return 1;} @end
      @implementation B - (double)value {return 2;} @end
      int main(void) { id object=nil; return [object value]; }
    `, /ambiguous signature/],
  ];
  const header = `
    struct Value { int x; double y; };
    @interface Base { @public int value; }
    - (struct Value)get; - (SEL)selector;
    @end
    @interface Sub : Base - (struct Value)get; @end
    id make(void); SEL otherSelector(void);
  `;
  const crossTU = {
    'base.m': '#include "shared.h"\n' + `
      @implementation Base
      - (struct Value)get {struct Value v={value,2.5}; return v;}
      - (SEL)selector {return _cmd;} @end
      id make(void) {Sub *s=guc_objc_alloc(Sub); s->value=41; return s;}
      SEL otherSelector(void) {return @selector(selector);}
    `,
    'sub.m': '#include "shared.h"\n' + `
      @implementation Sub
      - (struct Value)get {struct Value v=[super get]; v.x++; return v;}
      @end
    `,
    'main.m': '#include "shared.h"\n' + `
      int main(void) { Sub *s=make(); struct Value v=[s get];
        int ok=v.x==42 && v.y==2.5 && [s selector]==otherSelector()
          && otherSelector()==@selector(selector) && @selector(get)!=otherSelector();
        guc_objc_dispose(s); return !ok;
      }
    `,
    'shared.h': header,
  };
  const api = { positive, negative, crossTU };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ObjcRound2 = api;
})(globalThis);
