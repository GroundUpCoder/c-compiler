// Shared contract corpus: the same source is compiled and executed in Node
// and Chromium. #772's main fixture additionally lives as an ordinary .m file.
(function(root) {
  const positive = [
    ['typed-inheritance', `
      #ifndef __OBJC__
      #error Objective-C mode macro missing
      #endif
      #define DECL interface

      @ DECL Base { @public int x; @private int secret; }
      + (id)alloc;
      - (int)value;
      - (void)set:(int)n;
      @end
      @implementation Base
      + (id)alloc { return guc_objc_alloc(self); }
      - (int)value { return self->x + secret; }
      - (void)set:(int)n { int x = n; self; secret = x; }
      @end
      @interface Sub : Base { @public double y; }
      @end
      @implementation Sub @end
      int main(void) {
        Sub *s = [Sub alloc]; Base *b = s;
        s->x = 4; s->y = 2.5;
        [b set:7];
        int result = [s value] == 11 && b->x == 4 && s->y == 2.5;
        guc_objc_dispose(s); return !result;
      }`],
    ['mixed-signatures-and-recursion', `
      @interface Math
      + (double)mix:(int)i pointer:(int *)p float:(float)f double:(double)d wide:(long long)w;
      + (int)fib:(int)n;
      @end
      @implementation Math
      + (double)mix:(int)i pointer:(int *)p float:(float)f double:(double)d wide:(long long)w { return i + *p + f + d + w; }
      + (int)fib:(int)n { return n < 2 ? n : [self fib:n-1] + [self fib:n-2]; }
      @end
      int main(void) { int p=3; Class c=Math; const id dynamic=Math; if ([dynamic fib:5] != 5) return 2; return [c mix:2 pointer:&p float:1.25f double:2.5 wide:8LL] != 16.75 || [Math fib:8] != 21; }`],
    ['nested-keywords-selector-and-c-array', `
      @interface A
      + (id)make;
      - (int)add:(int)x :(int)y;
      - (SEL)which;
      @end
      @implementation A
      + (id)make { return guc_objc_alloc(self); }
      - (int)add:(int)x :(int)y { return x+y; }
      - (SEL)which { return _cmd; }
      @end
      int main(void) { id a=[A make]; int v[2]={3,5}; int n=[a add:v[0] :[a add:1 :v[1]]];
        int ok=n==9 && [a which]==@selector(which) && @selector(add::)==@selector(add::) && @selector(add::)!=@selector(which);
        guc_objc_dispose(a); return !ok; }`],
  ];
  positive.push(['function-pointer-and-lifetime', `
    typedef int (*Callback)(int);
    @interface Box { @public struct { int values[3]; long double number; } data; }
    + (id)alloc;
    - (Callback)callback:(Callback)f;
    - (long double)extended:(long double)x;
    @end
    @implementation Box
    + (id)alloc { return guc_objc_alloc(self); }
    - (Callback)callback:(Callback)f { return f; }
    - (long double)extended:(long double)x { data.number=x; return data.number; }
    @end
    int plus(int n) { return n+7; }
    int main(void) {
      for(int i=0;i<1000;i++) {
        Box *b=[Box alloc]; if(!b || b->data.values[1] || b->data.number) return 1;
        b->data.values[1]=42;
        Callback f=[b callback:plus];
        if(f(3)!=10 || [b extended:1.25L]!=1.25L || [nil callback:plus]!=0 || [nil extended:8.0L]!=0.0L) return 2;
        guc_objc_dispose(b);
      }
      return 0;
    }`]);
  const negative = [
    ['category', '@interface A (Extra) @end', /categories/],
    ['property', '@interface A @property int x; @end', /unsupported class form/],
    ['arc-pool', 'int main(void) { @autoreleasepool { } return 0; }', /unsupported expression/],
    ['object-string', 'int main(void) { id s = @"hello"; return 0; }', /unsupported expression/],
    ['missing-interface', '@implementation A @end', /preceding interface/],
    ['missing-method', '@interface A - (int)x; @end @implementation A @end', /no implementation/],
    ['unknown-superclass', '@interface A : Missing @end', /preceding interface/],
    ['bad-override', '@interface A - (int)x; @end @interface B : A - (double)x; @end', /incompatible Objective-C override/],
    ['root-super', '@interface A - (int)x; @end @implementation A - (int)x { return [super x]; } @end', /super requires/],
    ['protected-ivar', '@interface A { int x; } @end @implementation A @end int main(void){ A *a=0; return a->x; }', /protected/],
    ['private-in-subclass', '@interface A { @private int x; } @end @implementation A @end @interface B:A - (int)y; @end @implementation B - (int)y { return x; } @end', /private/],
    ['unknown-selector', 'int main(void) { return [nil absent]; }', /no declared signature/],
    ['arity', '@interface A - (int)x:(int)n; @end @implementation A - (int)x:(int)n {return n;} @end int main(void){return [nil x:1 :2];}', /no declared signature/],
    ['object-value', '@interface A @end @implementation A @end A object;', /through pointers/],
    ['ambiguous-id', '@interface A + (double)x; - (int)x; @end @implementation A + (double)x {return 1;} - (int)x {return 2;} @end int main(void){return [nil x];}', /ambiguous signature/],
    ['packed-class', '#pragma pack(1)\n@interface A { int x; } @end', /packed class/],
    ['nonobject-receiver', 'int main(void) { int *p=0; return [p value]; }', /object pointer/],
    ['bitfield', '@interface A { int x:3; } @end', /bitfield/],
  ];
  const api = { positive, negative };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ObjcCases = api;
})(globalThis);
